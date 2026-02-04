use anyhow::Result;
use chrono;
use serde_json::{json, Value};
use sqlx::{postgres::PgPoolOptions, PgPool, Postgres, Transaction};
use std::time::Duration;
use uuid::Uuid;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use rand::Rng;

#[derive(Debug)]
struct Job {
    id: i64,
    instance_id: Uuid,
    job_type: String, // "START" etc
    attempt: i32,
}

// ============================================================
// RetryPolicy: 운영급 재시도 정책
// ============================================================

#[derive(Debug, Clone)]
struct RetryPolicy {
    /// 최대 재시도 횟수 (attempt 0부터 시작, 이 값까지 허용)
    max_attempts: i32,
    /// 초기 지연 시간 (ms)
    initial_delay_ms: u64,
    /// 최대 지연 시간 상한 (ms) - backoff가 이 값을 넘지 않음
    max_delay_ms: u64,
    /// 지수 백오프 배율 (보통 2.0)
    multiplier: f64,
    /// jitter 비율 (0.0 ~ 1.0, 예: 0.1이면 ±10%)
    jitter_factor: f64,
    /// 재시도할 HTTP 상태 코드 목록 (비어있으면 모든 실패에 재시도)
    retry_on_statuses: Vec<u16>,
    /// 타임아웃 발생 시 재시도 여부
    retry_on_timeout: bool,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 5,
            initial_delay_ms: 1000,   // 1초
            max_delay_ms: 60_000,     // 60초 상한
            multiplier: 2.0,
            jitter_factor: 0.1,       // ±10% jitter
            retry_on_statuses: vec![408, 429, 500, 502, 503, 504], // timeout, rate-limit, 5xx
            retry_on_timeout: true,
        }
    }
}

/// HTTP 호출 결과를 나타내는 구조체
#[derive(Debug)]
struct HttpCallResult {
    success: bool,
    status_code: Option<u16>,
    is_timeout: bool,
    body: Value,
    error_message: Option<String>,
}

/// retry_info 표준 포맷 (outbox payload용)
#[derive(Debug, Clone)]
struct RetryInfo {
    attempt: i32,
    max_attempts: i32,
    next_delay_ms: Option<u64>,
    next_run_at: Option<String>,
    will_retry: bool,
    reason: String,
}

impl RetryInfo {
    fn to_json(&self) -> Value {
        json!({
            "attempt": self.attempt,
            "max_attempts": self.max_attempts,
            "next_delay_ms": self.next_delay_ms,
            "next_run_at": self.next_run_at,
            "will_retry": self.will_retry,
            "reason": self.reason
        })
    }
}

impl RetryPolicy {
    /// 환경변수에서 RetryPolicy 로드 (노드별 정책은 추후 process_def에서 로드)
    fn from_env() -> Self {
        let max_attempts = std::env::var("RETRY_MAX_ATTEMPTS")
            .ok().and_then(|v| v.parse().ok()).unwrap_or(5);
        let initial_delay_ms = std::env::var("RETRY_INITIAL_DELAY_MS")
            .ok().and_then(|v| v.parse().ok()).unwrap_or(1000);
        let max_delay_ms = std::env::var("RETRY_MAX_DELAY_MS")
            .ok().and_then(|v| v.parse().ok()).unwrap_or(60_000);
        let multiplier = std::env::var("RETRY_MULTIPLIER")
            .ok().and_then(|v| v.parse().ok()).unwrap_or(2.0);
        let jitter_factor = std::env::var("RETRY_JITTER_FACTOR")
            .ok().and_then(|v| v.parse().ok()).unwrap_or(0.1);

        Self {
            max_attempts,
            initial_delay_ms,
            max_delay_ms,
            multiplier,
            jitter_factor,
            ..Default::default()
        }
    }

    /// 재시도 가능 여부 판단
    fn should_retry(&self, attempt: i32, result: &HttpCallResult) -> bool {
        // 최대 횟수 초과
        if attempt >= self.max_attempts {
            return false;
        }

        // 성공이면 재시도 불필요
        if result.success {
            return false;
        }

        // 타임아웃 체크
        if result.is_timeout {
            return self.retry_on_timeout;
        }

        // HTTP 상태 코드 체크
        if let Some(status) = result.status_code {
            // retry_on_statuses가 비어있으면 모든 실패에 재시도
            if self.retry_on_statuses.is_empty() {
                return true;
            }
            return self.retry_on_statuses.contains(&status);
        }

        // 상태 코드 없는 에러 (네트워크 에러 등) → 재시도
        true
    }

    /// 백오프 지연 시간 계산 (exponential backoff + jitter)
    fn calculate_backoff(&self, attempt: i32) -> u64 {
        // base delay: initial * multiplier^attempt
        let base = self.initial_delay_ms as f64 * self.multiplier.powi(attempt);

        // max_delay 상한 적용
        let capped = base.min(self.max_delay_ms as f64);

        // jitter 적용: ±jitter_factor 범위
        let jitter_range = capped * self.jitter_factor;
        let jitter: f64 = rand::thread_rng().gen_range(-jitter_range..=jitter_range);

        // 최소 100ms 보장
        ((capped + jitter).max(100.0)) as u64
    }

    /// RetryInfo 생성 (outbox payload용)
    fn build_retry_info(&self, attempt: i32, result: &HttpCallResult) -> RetryInfo {
        let will_retry = self.should_retry(attempt, result);
        let next_delay_ms = if will_retry {
            Some(self.calculate_backoff(attempt))
        } else {
            None
        };

        let reason = if result.is_timeout {
            "timeout".to_string()
        } else if let Some(status) = result.status_code {
            format!("http_{}", status)
        } else if let Some(ref msg) = result.error_message {
            msg.clone()
        } else {
            "unknown_error".to_string()
        };

        RetryInfo {
            attempt,
            max_attempts: self.max_attempts,
            next_delay_ms,
            next_run_at: None, // 호출자가 DB insert 후 설정
            will_retry,
            reason,
        }
    }
}

// ============================================================
// Timer: 타이머 노드 지원
// ============================================================

#[derive(Debug, Clone)]
struct TimerConfig {
    /// 타이머 지연 시간 (ms)
    duration_ms: u64,
    /// 타이머 타입: "delay" (단순 대기), "deadline" (특정 시점까지), "sla" (SLA 초과 알림)
    timer_type: String,
    /// 노드 ID
    node_id: String,
    /// 타이머 만료 시 수행할 액션: "continue" (다음 노드로), "escalate" (에스컬레이션)
    on_expire: String,
}

impl Default for TimerConfig {
    fn default() -> Self {
        Self {
            duration_ms: 5000,  // 기본 5초
            timer_type: "delay".to_string(),
            node_id: "timer".to_string(),
            on_expire: "continue".to_string(),
        }
    }
}

/// timer_info 표준 포맷 (outbox payload용)
#[derive(Debug, Clone)]
struct TimerInfo {
    node_id: String,
    timer_type: String,
    duration_ms: u64,
    scheduled_at: String,
    expire_at: String,
}

impl TimerInfo {
    fn to_json(&self) -> Value {
        json!({
            "node_id": self.node_id,
            "timer_type": self.timer_type,
            "duration_ms": self.duration_ms,
            "scheduled_at": self.scheduled_at,
            "expire_at": self.expire_at
        })
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();

    let db_url = std::env::var("DATABASE_URL")?;
    let worker_id = std::env::var("ENGINE_WORKER_ID").unwrap_or_else(|_| "engine-1".to_string());
    let poll_ms: u64 = std::env::var("ENGINE_POLL_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(300);
    
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&db_url)
        .await?;

    println!("[engine] connected. worker_id={worker_id}, poll_ms={poll_ms}");

    let mut last_reap = std::time::Instant::now();
    
    loop {
        if let Some(job) = fetch_and_mark_running(&pool).await? {
            println!("[engine] got job: {:?}", job);

            match job.job_type.as_str() {
    // START / RETRY / RESUME 는 모두 같은 실행 루트
    "START" | "RETRY" | "RESUME" => {
        if let Err(e) = run_instance_job(&pool, &worker_id, &job).await {
            eprintln!("[engine] job {} failed: {e:?}", job.id);

            // 확장 포인트:
            // - 여기서 fatal error / retryable error 구분 가능
            // - 지금은 단순히 job FAILED 처리
            mark_job_failed(&pool, job.id).await?;
        }
    }

    // TIMER: 타이머 만료 시 실행
    "TIMER" => {
        if let Err(e) = run_timer_job(&pool, &worker_id, &job).await {
            eprintln!("[engine] timer job {} failed: {e:?}", job.id);
            mark_job_failed(&pool, job.id).await?;
        }
    }

    // 그 외는 무시
    _ => {
        println!("[engine] unsupported job_type={}, mark DONE", job.job_type);
        mark_job_done(&pool, job.id).await?;
    }
}
        } else {
            if last_reap.elapsed() > Duration::from_secs(2) {
            let n = reclaim_stale_running_jobs(&pool).await?;
            if n > 0 {
                println!("[engine] reclaimed {n} stale RUNNING jobs");
            }
            last_reap = std::time::Instant::now();
        }

        tokio::time::sleep(Duration::from_millis(poll_ms)).await;
        }
    }
}

async fn run_instance_job(pool: &PgPool, worker_id: &str, job: &Job) -> Result<()> {
    // 1) ctx 읽기 (nodes, edges, cursor, formData)
    let row = sqlx::query!(
        r#"select ctx from process_instance where id = $1"#,
        job.instance_id
    )
    .fetch_one(pool)
    .await?;

    let ctx: Value = row.ctx;
    let cursor = ctx.get("cursor").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let nodes = ctx.get("nodes").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let edges = ctx.get("edges").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let form_data = ctx.get("formData").cloned();

    if let Some(data) = &form_data {
        println!("[engine] 📝 Form data received:");
        println!("{}", serde_json::to_string_pretty(data).unwrap_or_default());
    }

    if cursor.is_empty() {
        eprintln!("[engine] cursor is empty, cannot proceed");
        mark_job_failed(pool, job.id).await?;
        return Ok(());
    }

    // 2) RUNNING 상태로 전환
    {
        let mut tx = pool.begin().await?;
        sqlx::query!(
            r#"update process_instance set status='RUNNING', updated_at=now() where id=$1"#,
            job.instance_id
        )
        .execute(&mut *tx)
        .await?;

        emit_outbox(&mut tx, job.instance_id, "INSTANCE_RUNNING", json!({
            "instance_id": job.instance_id,
            "status": "RUNNING",
            "worker_id": worker_id,
            "job_id": job.id,
            "job_type": job.job_type,
            "attempt": job.attempt,
        }))
        .await?;
        tx.commit().await?;
    }

    // 3) 현재 노드 찾기
    let current_node = nodes.iter().find(|n| {
        n.get("id").and_then(|v| v.as_str()) == Some(&cursor)
    });

    if current_node.is_none() {
        eprintln!("[engine] node not found: {}", cursor);
        mark_job_failed(pool, job.id).await?;
        return Ok(());
    }

    let current_node = current_node.unwrap();
    let node_type = current_node
        .get("data")
        .and_then(|d| d.get("nodeType"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    println!("[engine] executing node: id={}, type={}", cursor, node_type);

    // 4) 노드 타입별 처리
    match node_type {
        "start" => {
            // START 노드 실행
            let mut tx = pool.begin().await?;
            emit_outbox(&mut tx, job.instance_id, "NODE_STARTED", json!({
                "node_id": cursor,
                "node_label": current_node.get("data").and_then(|d| d.get("label")),
            })).await?;
            emit_outbox(&mut tx, job.instance_id, "NODE_COMPLETED", json!({
                "node_id": cursor,
                "node_label": current_node.get("data").and_then(|d| d.get("label")),
            })).await?;
            tx.commit().await?;

            // 다음 노드 찾기
            if let Some(next_id) = find_next_node(&cursor, &edges) {
                set_cursor(pool, job.instance_id, &next_id).await?;
                // 다음 노드 실행을 위한 RESUME job 생성
                create_resume_job(pool, job.instance_id).await?;
            } else {
                // 다음 노드 없음 (고립된 노드)
                eprintln!("[engine] no next node found for: {}", cursor);
            }
            mark_job_done(pool, job.id).await?;
        }

        "service" => {
            // SERVICE 노드 실행 (기존 로직 사용)
            let ok = node_service_http(pool, job, worker_id, &form_data).await?;
            if !ok {
                return Ok(()); // 실패 시 재시도 스케줄됨
            }

            // 다음 노드로
            if let Some(next_id) = find_next_node(&cursor, &edges) {
                set_cursor(pool, job.instance_id, &next_id).await?;
                create_resume_job(pool, job.instance_id).await?;
            }
            mark_job_done(pool, job.id).await?;
        }

        "timer" => {
            // TIMER 노드 실행
            let duration_ms = current_node
                .get("data")
                .and_then(|d| d.get("durationMs"))
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(5000);

            let config = TimerConfig {
                duration_ms,
                timer_type: "delay".to_string(),
                node_id: cursor.clone(),
                on_expire: "continue".to_string(),
            };

            schedule_timer(pool, job.instance_id, &config, worker_id).await?;
            mark_job_done(pool, job.id).await?;
            // 타이머 만료 시 TIMER job이 실행되어 다음 노드로 진행
        }

        "approval" => {
            // 0. 이미 처리된 Task가 있는지 확인 (재진입용: API가 승인 후 RESUME 시킴)
            let completed_task = sqlx::query!(
                r#"select status from tasks where instance_id=$1 and node_id=$2 and status in ('APPROVED', 'REJECTED')"#,
                job.instance_id,
                cursor
            )
            .fetch_optional(pool)
            .await?;

            if let Some(task) = completed_task {
                println!("[engine] ✅ Approval Task is {:?}, moving next.", task.status);
                
                // 승인 완료 이벤트
                let mut tx = pool.begin().await?;
                emit_outbox(&mut tx, job.instance_id, "NODE_COMPLETED", json!({
                    "node_id": cursor,
                    "node_label": current_node.get("data").and_then(|d| d.get("label")),
                    "approval_status": task.status
                })).await?;
                tx.commit().await?;

                if task.status == "REJECTED" {
                    // 반려 시 종료 (또는 반려 처리 로직)
                    println!("[engine] 🛑 Task rejected, stopping instance.");
                    // process_instance를 FAILED 또는 COMPLETED로 바꿀 수 있음 (여기선 그냥 종료)
                    // 만약 반려 경로(edge)가 있다면 거기로 보내야 함 (Phase 5+)
                    mark_job_done(pool, job.id).await?;
                    return Ok(());
                }

                // 승인 시 다음 노드 진행
                if let Some(next_id) = find_next_node(&cursor, &edges) {
                    set_cursor(pool, job.instance_id, &next_id).await?;
                    create_resume_job(pool, job.instance_id).await?;
                }
                mark_job_done(pool, job.id).await?;
                return Ok(());
            }

            // APPROVAL 노드 - Task 생성 및 대기 (Task가 없을 때만 실행)
            let mut tx = pool.begin().await?;
            
            // 1. 노드 시작 이벤트
            emit_outbox(&mut tx, job.instance_id, "NODE_STARTED", json!({
                "node_id": cursor,
                "node_label": current_node.get("data").and_then(|d| d.get("label")),
            })).await?;

            // 2. Task 생성
            let task_id = Uuid::new_v4();
            let assignee = current_node
                .get("data")
                .and_then(|d| d.get("assignee"))
                .and_then(|v| v.as_str())
                .unwrap_or("admin"); // 기본값: admin

            sqlx::query!(
                r#"
                insert into tasks (id, instance_id, node_id, assignee, status, payload)
                values ($1, $2, $3, $4, 'OPEN', $5)
                "#,
                task_id,
                job.instance_id,
                cursor,
                assignee,
                json!({})
            )
            .execute(&mut *tx)
            .await?;

            println!("[engine] 📝 Task created: id={}, assignee={}", task_id, assignee);

            // 3. Task 생성 이벤트 발행
            emit_outbox(&mut tx, job.instance_id, "TASK_CREATED", json!({
                "node_id": cursor,
                "task_id": task_id,
                "assignee": assignee,
                "node_label": current_node.get("data").and_then(|d| d.get("label")),
            })).await?;
            
            // 4. 인스턴스 승인 대기 상태로 전환
            sqlx::query!(
                r#"update process_instance set status='WAITING', updated_at=now() where id=$1"#,
                job.instance_id
            ).execute(&mut *tx).await?;

            // 5. INSTANCE_WAITING 이벤트 발행
            emit_outbox(&mut tx, job.instance_id, "INSTANCE_WAITING", json!({
                "instance_id": job.instance_id,
                "status": "WAITING",
                "node_id": cursor,
                "task_id": task_id,
                "reason": "approval_required"
            })).await?;

            tx.commit().await?;

            mark_job_done(pool, job.id).await?;
            // 여기서 엔진은 멈춤 (API가 Task 승인 후 RESUME job을 만들어줘야 함)
        }

        "gateway" => {
            // GATEWAY 노드 - 조건 분기
            let mut tx = pool.begin().await?;
            emit_outbox(&mut tx, job.instance_id, "NODE_STARTED", json!({
                "node_id": cursor,
                "node_label": current_node.get("data").and_then(|d| d.get("label")),
            })).await?;
            
            // 조건 평가
            let condition = current_node
                .get("data")
                .and_then(|d| d.get("condition"))
                .and_then(|c| c.as_str())
                .unwrap_or("");
            
            let condition_result = if !condition.is_empty() {
                evaluate_condition(condition, &form_data)
            } else {
                true // 조건이 없으면 기본 true
            };
            
            println!("[engine] 🔀 Gateway condition: '{}' => {}", condition, condition_result);
            
            emit_outbox(&mut tx, job.instance_id, "NODE_COMPLETED", json!({
                "node_id": cursor,
                "node_label": current_node.get("data").and_then(|d| d.get("label")),
                "condition_result": condition_result,
            })).await?;
            tx.commit().await?;

            // 조건에 따라 다음 노드 선택
            let next_id = if condition_result {
                // true 경로: sourceHandle이 "true"인 edge
                find_next_node_by_handle(&cursor, &edges, "true")
                    .or_else(|| find_next_node(&cursor, &edges)) // fallback
            } else {
                // false 경로: sourceHandle이 "false"인 edge
                find_next_node_by_handle(&cursor, &edges, "false")
            };
            
            if let Some(next_id) = next_id {
                set_cursor(pool, job.instance_id, &next_id).await?;
                create_resume_job(pool, job.instance_id).await?;
            } else {
                println!("[engine] ⚠️  No next node found for gateway, completing instance");
                complete_instance(pool, job.instance_id).await?;
            }
            mark_job_done(pool, job.id).await?;
        }

        "end" => {
            // END 노드 실행
            let mut tx = pool.begin().await?;
            emit_outbox(&mut tx, job.instance_id, "NODE_STARTED", json!({
                "node_id": cursor,
                "node_label": current_node.get("data").and_then(|d| d.get("label")),
            })).await?;
            emit_outbox(&mut tx, job.instance_id, "NODE_COMPLETED", json!({
                "node_id": cursor,
                "node_label": current_node.get("data").and_then(|d| d.get("label")),
            })).await?;
            tx.commit().await?;

            // 워크플로우 완료
            complete_instance(pool, job.instance_id).await?;
            mark_job_done(pool, job.id).await?;
        }

        _ => {
            eprintln!("[engine] unknown node type: {}", node_type);
            mark_job_failed(pool, job.id).await?;
        }
    }

    Ok(())
}

// 다음 노드 ID 찾기 (edges에서 source가 current_id인 첫 번째 edge의 target)
fn find_next_node(current_id: &str, edges: &[Value]) -> Option<String> {
    edges.iter()
        .find(|e| e.get("source").and_then(|v| v.as_str()) == Some(current_id))
        .and_then(|e| e.get("target").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
}

// sourceHandle로 다음 노드 찾기 (Gateway 노드용)
fn find_next_node_by_handle(current_id: &str, edges: &[Value], handle: &str) -> Option<String> {
    edges.iter()
        .find(|e| {
            e.get("source").and_then(|v| v.as_str()) == Some(current_id)
                && e.get("sourceHandle").and_then(|v| v.as_str()) == Some(handle)
        })
        .and_then(|e| e.get("target").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
}

// 조건 평가 (간단한 구현)
fn evaluate_condition(condition: &str, form_data: &Option<Value>) -> bool {
    if let Some(data) = form_data {
        // 간단한 조건 평가: "fieldName == value" 형식
        // 예: "gender == 남자", "age > 18"
        
        if let Some((field, rest)) = condition.split_once("==") {
            let field = field.trim();
            let expected = rest.trim().trim_matches('"').trim_matches('\'');
            
            if let Some(actual) = data.get(field).and_then(|v| v.as_str()) {
                return actual == expected;
            }
        } else if let Some((field, rest)) = condition.split_once(">") {
            let field = field.trim();
            let threshold: f64 = rest.trim().parse().unwrap_or(0.0);
            
            if let Some(actual) = data.get(field).and_then(|v| v.as_f64()) {
                return actual > threshold;
            }
        } else if let Some((field, rest)) = condition.split_once("<") {
            let field = field.trim();
            let threshold: f64 = rest.trim().parse().unwrap_or(0.0);
            
            if let Some(actual) = data.get(field).and_then(|v| v.as_f64()) {
                return actual < threshold;
            }
        }
    }
    
    // 조건을 평가할 수 없으면 false
    false
}


// RESUME job 생성 (다음 노드 실행)
async fn create_resume_job(pool: &PgPool, instance_id: Uuid) -> Result<()> {
    sqlx::query!(
        r#"
        insert into engine_jobs (instance_id, type, run_at, attempt, status, payload)
        values ($1, 'RESUME', now(), 0, 'READY', '{}'::jsonb)
        "#,
        instance_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

// 인스턴스 완료 처리
async fn complete_instance(pool: &PgPool, instance_id: Uuid) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query!(
        r#"update process_instance set status='COMPLETED', updated_at=now() where id=$1"#,
        instance_id
    )
    .execute(&mut *tx)
    .await?;

    emit_outbox(&mut tx, instance_id, "INSTANCE_COMPLETED", json!({
        "instance_id": instance_id,
        "status": "COMPLETED"
    }))
    .await?;

    tx.commit().await?;
    Ok(())
}


async fn node_start(pool: &PgPool, instance_id: Uuid) -> Result<()> {
    let mut tx = pool.begin().await?;
    emit_outbox(&mut tx, instance_id, "NODE_STARTED", json!({
        "node_id": "start",
        "token_id": "t1"
    })).await?;
    emit_outbox(&mut tx, instance_id, "NODE_COMPLETED", json!({
        "node_id": "start",
        "token_id": "t1"
    })).await?;
    tx.commit().await?;
    Ok(())
}

async fn node_end(pool: &PgPool, instance_id: Uuid) -> Result<()> {
    let mut tx = pool.begin().await?;
    emit_outbox(&mut tx, instance_id, "NODE_STARTED", json!({
        "node_id": "end",
        "token_id": "t1"
    })).await?;
    emit_outbox(&mut tx, instance_id, "NODE_COMPLETED", json!({
        "node_id": "end",
        "token_id": "t1"
    })).await?;
    tx.commit().await?;
    Ok(())
}

async fn set_cursor(pool: &PgPool, instance_id: Uuid, cursor: &str) -> Result<()> {
    // 확장 포인트: cursor를 jsonb가 아닌 토큰 테이블로 이동(병렬 토큰 지원)
    sqlx::query!(
        r#"
        update process_instance
        set ctx = jsonb_set(ctx, '{cursor}', to_jsonb($2::text), true),
            updated_at = now()
        where id = $1
        "#,
        instance_id,
        cursor
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn node_service_http(pool: &PgPool, job: &Job, worker_id: &str, form_data: &Option<Value>) -> Result<bool> {
    let api_base = std::env::var("API_BASE_URL").unwrap_or_else(|_| "http://localhost:3000".to_string());
    let retry_policy = RetryPolicy::from_env();
    let timeout_secs: u64 = std::env::var("HTTP_TIMEOUT_SECS")
        .ok().and_then(|v| v.parse().ok()).unwrap_or(10);

    // 확장 포인트: URL/Method/Headers/Body/Secrets/Mapping을 process_def에서 읽도록
    let url = format!("{}/debug/flaky?key={}&fail=2", api_base, job.instance_id);

    {
        let mut tx = pool.begin().await?;
        emit_outbox(&mut tx, job.instance_id, "NODE_STARTED", json!({
            "node_id": "service_http",
            "token_id": "t1",
            "url": url,
            "attempt": job.attempt,
            "timeout_secs": timeout_secs,
            "has_form_data": form_data.is_some()
        })).await?;
        tx.commit().await?;
    }

    // 네트워크 호출은 트랜잭션 밖에서 (운영급 기본)
    let client = reqwest::Client::new();
    
    // formData가 있으면 POST로, 없으면 GET으로
    let resp = if let Some(data) = form_data {
        println!("[engine] 🌐 Sending HTTP POST with formData");
        client
            .post(&url)
            .json(data)
            .timeout(Duration::from_secs(timeout_secs))
            .send()
            .await
    } else {
        client
            .get(&url)
            .timeout(Duration::from_secs(timeout_secs))
            .send()
            .await
    };

    // HTTP 호출 결과를 구조화
    let call_result: HttpCallResult = match resp {
        Ok(r) => {
            let status_code = r.status().as_u16();
            let body: Value = r.json().await.unwrap_or_else(|_| json!({"ok": false, "message": "invalid json"}));
            let success = body.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
            HttpCallResult {
                success,
                status_code: Some(status_code),
                is_timeout: false,
                body,
                error_message: None,
            }
        }
        Err(e) => {
            let is_timeout = e.is_timeout();
            HttpCallResult {
                success: false,
                status_code: None,
                is_timeout,
                body: json!({ "ok": false, "message": format!("http error: {}", e) }),
                error_message: Some(e.to_string()),
            }
        }
    };

    if call_result.success {
        // 성공: ctx에 결과 저장
        let mut tx = pool.begin().await?;
        sqlx::query!(
            r#"
            update process_instance
            set ctx = jsonb_set(ctx, '{service_http}', $2::jsonb, true),
                updated_at = now()
            where id = $1
            "#,
            job.instance_id,
            call_result.body
        )
        .execute(&mut *tx)
        .await?;

        emit_outbox(&mut tx, job.instance_id, "NODE_COMPLETED", json!({
            "node_id": "service_http",
            "token_id": "t1",
            "response": call_result.body,
            "status_code": call_result.status_code
        })).await?;

        tx.commit().await?;
        return Ok(true);
    }

    // 실패: RetryPolicy를 사용하여 재시도 판단
    schedule_retry_v2(pool, job, worker_id, &retry_policy, &call_result).await?;
    Ok(false)
}

/// 새로운 RetryPolicy 기반 재시도 스케줄러
async fn schedule_retry_v2(
    pool: &PgPool,
    job: &Job,
    worker_id: &str,
    policy: &RetryPolicy,
    result: &HttpCallResult,
) -> Result<()> {
    let retry_info = policy.build_retry_info(job.attempt, result);

    if !retry_info.will_retry {
        // 최종 실패 처리: 재시도 불가
        let mut tx = pool.begin().await?;

        emit_outbox(&mut tx, job.instance_id, "NODE_FAILED", json!({
            "node_id": "service_http",
            "token_id": "t1",
            "final": true,
            "attempt": job.attempt,
            "error": result.body,
            "status_code": result.status_code,
            "retry_info": retry_info.to_json()
        })).await?;

        emit_outbox(&mut tx, job.instance_id, "INSTANCE_FAILED", json!({
            "instance_id": job.instance_id,
            "status": "FAILED",
            "error_summary": format!("max retry exceeded ({})", retry_info.reason),
            "retry_info": retry_info.to_json()
        })).await?;

        sqlx::query!(
            r#"update process_instance set status='FAILED', updated_at=now() where id=$1"#,
            job.instance_id
        ).execute(&mut *tx).await?;

        sqlx::query!(
            r#"update engine_jobs set status='FAILED', updated_at=now() where id=$1"#,
            job.id
        ).execute(&mut *tx).await?;

        tx.commit().await?;
        return Ok(());
    }

    // 재시도 스케줄
    let delay_ms = retry_info.next_delay_ms.unwrap_or(1000);
    let next_attempt = job.attempt + 1;

    let mut tx = pool.begin().await?;

    emit_outbox(&mut tx, job.instance_id, "NODE_FAILED", json!({
        "node_id": "service_http",
        "token_id": "t1",
        "final": false,
        "attempt": job.attempt,
        "error": result.body,
        "status_code": result.status_code,
        "retry_info": retry_info.to_json()
    })).await?;

    // 새로운 RETRY job 생성
    sqlx::query!(
        r#"
        insert into engine_jobs (instance_id, type, run_at, attempt, status, payload)
        values ($1, 'RETRY', now() + ($2 * interval '1 millisecond'), $3, 'READY', $4::jsonb)
        "#,
        job.instance_id,
        delay_ms as f64,
        next_attempt,
        json!({
            "reason": retry_info.reason,
            "from_job_id": job.id,
            "retry_info": retry_info.to_json()
        })
    )
    .execute(&mut *tx)
    .await?;

    emit_outbox(&mut tx, job.instance_id, "RETRY_SCHEDULED", json!({
        "instance_id": job.instance_id,
        "node_id": "service_http",
        "token_id": "t1",
        "attempt": next_attempt,
        "max_attempts": policy.max_attempts,
        "delay_ms": delay_ms,
        "reason": retry_info.reason,
        "worker_id": worker_id,
        "retry_info": retry_info.to_json()
    })).await?;

    // 현재 job DONE 처리
    sqlx::query!(
        r#"update engine_jobs set status='DONE', updated_at=now() where id=$1"#,
        job.id
    ).execute(&mut *tx).await?;

    tx.commit().await?;
    Ok(())
}

// ============================================================
// Timer: 타이머 스케줄링 및 실행
// ============================================================

/// 타이머 job을 스케줄링
async fn schedule_timer(
    pool: &PgPool,
    instance_id: Uuid,
    config: &TimerConfig,
    worker_id: &str,
) -> Result<()> {
    let now = chrono::Utc::now();
    let expire_at = now + chrono::Duration::milliseconds(config.duration_ms as i64);

    let timer_info = TimerInfo {
        node_id: config.node_id.clone(),
        timer_type: config.timer_type.clone(),
        duration_ms: config.duration_ms,
        scheduled_at: now.to_rfc3339(),
        expire_at: expire_at.to_rfc3339(),
    };

    let mut tx = pool.begin().await?;

    // TIMER job 생성
    sqlx::query!(
        r#"
        insert into engine_jobs (instance_id, type, run_at, attempt, status, payload)
        values ($1, 'TIMER', now() + ($2 * interval '1 millisecond'), 0, 'READY', $3::jsonb)
        "#,
        instance_id,
        config.duration_ms as f64,
        json!({
            "node_id": config.node_id,
            "timer_type": config.timer_type,
            "on_expire": config.on_expire,
            "timer_info": timer_info.to_json()
        })
    )
    .execute(&mut *tx)
    .await?;

    // TIMER_SCHEDULED 이벤트 발행
    emit_outbox(&mut tx, instance_id, "TIMER_SCHEDULED", json!({
        "instance_id": instance_id,
        "node_id": config.node_id,
        "token_id": "t1",
        "timer_type": config.timer_type,
        "duration_ms": config.duration_ms,
        "on_expire": config.on_expire,
        "worker_id": worker_id,
        "timer_info": timer_info.to_json()
    })).await?;

    // 인스턴스 상태를 WAITING으로 (타이머 대기 중)
    sqlx::query!(
        r#"update process_instance set status='WAITING', updated_at=now() where id=$1"#,
        instance_id
    ).execute(&mut *tx).await?;

    emit_outbox(&mut tx, instance_id, "INSTANCE_WAITING", json!({
        "instance_id": instance_id,
        "reason": "timer",
        "node_id": config.node_id,
        "timer_info": timer_info.to_json()
    })).await?;

    tx.commit().await?;
    println!("[engine] timer scheduled: node={}, duration={}ms", config.node_id, config.duration_ms);
    Ok(())
}

/// TIMER job 실행 (타이머 만료 시 호출됨)
async fn run_timer_job(pool: &PgPool, worker_id: &str, job: &Job) -> Result<()> {
    // job payload에서 timer 정보 읽기
    let payload: Value = sqlx::query!(
        r#"select payload from engine_jobs where id = $1"#,
        job.id
    )
    .fetch_one(pool)
    .await?
    .payload;

    let node_id = payload.get("node_id")
        .and_then(|v| v.as_str())
        .unwrap_or("timer");
    let on_expire = payload.get("on_expire")
        .and_then(|v| v.as_str())
        .unwrap_or("continue");

    // ctx에서 edges 읽기
    let row = sqlx::query!(
        r#"select ctx from process_instance where id = $1"#,
        job.instance_id
    )
    .fetch_one(pool)
    .await?;

    let ctx: Value = row.ctx;
    let edges = ctx.get("edges").and_then(|v| v.as_array()).cloned().unwrap_or_default();

    let mut tx = pool.begin().await?;

    // NODE_STARTED 이벤트 (타이머 완료)
    emit_outbox(&mut tx, job.instance_id, "NODE_STARTED", json!({
        "node_id": node_id,
        "token_id": "t1",
        "event": "timer_expired"
    })).await?;

    // NODE_COMPLETED 이벤트
    emit_outbox(&mut tx, job.instance_id, "NODE_COMPLETED", json!({
        "node_id": node_id,
        "token_id": "t1",
        "on_expire": on_expire
    })).await?;

    // on_expire에 따른 처리
    match on_expire {
        "continue" => {
            // 다음 노드 찾기
            if let Some(next_id) = find_next_node(node_id, &edges) {
                // cursor를 다음 노드로 업데이트
                sqlx::query!(
                    r#"
                    update process_instance
                    set ctx = jsonb_set(ctx, '{cursor}', to_jsonb($2::text), true),
                        status = 'RUNNING',
                        updated_at = now()
                    where id = $1
                    "#,
                    job.instance_id,
                    next_id
                ).execute(&mut *tx).await?;

                // RESUME job 생성하여 다음 노드 실행
                sqlx::query!(
                    r#"
                    insert into engine_jobs (instance_id, type, run_at, attempt, status, payload)
                    values ($1, 'RESUME', now(), 0, 'READY', $2::jsonb)
                    "#,
                    job.instance_id,
                    json!({
                        "reason": "timer_expired",
                        "from_node": node_id
                    })
                ).execute(&mut *tx).await?;

                emit_outbox(&mut tx, job.instance_id, "INSTANCE_RUNNING", json!({
                    "instance_id": job.instance_id,
                    "status": "RUNNING",
                    "reason": "timer_expired",
                    "worker_id": worker_id
                })).await?;
            } else {
                // 다음 노드 없음 - 워크플로우 완료
                eprintln!("[engine] no next node after timer: {}", node_id);
            }
        }
        "escalate" => {
            // 에스컬레이션: 담당자에게 알림 (여기서는 이벤트만 발행)
            emit_outbox(&mut tx, job.instance_id, "TIMER_ESCALATED", json!({
                "instance_id": job.instance_id,
                "node_id": node_id,
                "reason": "sla_exceeded"
            })).await?;
        }
        _ => {
            // 기본: continue와 동일
        }
    }

    // 현재 TIMER job DONE 처리
    sqlx::query!(
        r#"update engine_jobs set status='DONE', updated_at=now() where id=$1"#,
        job.id
    ).execute(&mut *tx).await?;

    tx.commit().await?;
    println!("[engine] timer job completed: node={}, on_expire={}", node_id, on_expire);
    Ok(())
}

/// 타이머 노드 실행 (워크플로우에서 timer 노드를 만났을 때)
async fn node_timer(pool: &PgPool, instance_id: Uuid, worker_id: &str) -> Result<()> {
    // 확장 포인트: process_def에서 타이머 설정을 읽어오도록
    // 지금은 환경변수 또는 기본값 사용
    let duration_ms: u64 = std::env::var("TIMER_DURATION_MS")
        .ok().and_then(|v| v.parse().ok()).unwrap_or(5000);

    let config = TimerConfig {
        duration_ms,
        timer_type: "delay".to_string(),
        node_id: "timer".to_string(),
        on_expire: "continue".to_string(),
    };

    // NODE_STARTED 이벤트
    {
        let mut tx = pool.begin().await?;
        emit_outbox(&mut tx, instance_id, "NODE_STARTED", json!({
            "node_id": "timer",
            "token_id": "t1",
            "timer_type": config.timer_type,
            "duration_ms": config.duration_ms
        })).await?;
        tx.commit().await?;
    }

    // 타이머 스케줄링
    schedule_timer(pool, instance_id, &config, worker_id).await?;

    Ok(())
}

// ============================================================
// Legacy: 기존 schedule_retry (호환성 유지, 추후 제거 예정)
// ============================================================
#[allow(dead_code)]
async fn schedule_retry(pool: &PgPool, job: &Job, worker_id: &str, error_body: Value) -> Result<()> {
    let max_retry: i32 = std::env::var("MAX_RETRY").ok().and_then(|v| v.parse().ok()).unwrap_or(5);
    let next_attempt = job.attempt + 1;

    if next_attempt > max_retry {
        let mut tx = pool.begin().await?;
        emit_outbox(&mut tx, job.instance_id, "NODE_FAILED", json!({
            "node_id": "service_http",
            "token_id": "t1",
            "final": true,
            "attempt": job.attempt,
            "error": error_body
        })).await?;

        emit_outbox(&mut tx, job.instance_id, "INSTANCE_FAILED", json!({
            "instance_id": job.instance_id,
            "status": "FAILED",
            "error_summary": "max retry exceeded"
        })).await?;

        sqlx::query!(
            r#"update process_instance set status='FAILED', updated_at=now() where id=$1"#,
            job.instance_id
        ).execute(&mut *tx).await?;

        sqlx::query!(
            r#"update engine_jobs set status='FAILED', updated_at=now() where id=$1"#,
            job.id
        ).execute(&mut *tx).await?;

        tx.commit().await?;
        return Ok(());
    }

    let base = 2_i64.pow(next_attempt as u32);
    let jitter_ms: i64 = rand::thread_rng().gen_range(0..250);
    let delay_ms = (base * 1000) + jitter_ms;

    let mut tx = pool.begin().await?;

    emit_outbox(&mut tx, job.instance_id, "NODE_FAILED", json!({
        "node_id": "service_http",
        "token_id": "t1",
        "final": false,
        "attempt": job.attempt,
        "error": error_body
    })).await?;

    sqlx::query!(
        r#"
        insert into engine_jobs (instance_id, type, run_at, attempt, status, payload)
        values ($1, 'RETRY', now() + ($2 * interval '1 millisecond'), $3, 'READY', $4::jsonb)
        "#,
        job.instance_id,
        delay_ms as f64,
        next_attempt,
        json!({
            "reason": "service_http failed",
            "from_job_id": job.id
        })
    )
    .execute(&mut *tx)
    .await?;

    emit_outbox(&mut tx, job.instance_id, "RETRY_SCHEDULED", json!({
        "instance_id": job.instance_id,
        "node_id": "service_http",
        "attempt": next_attempt,
        "delay_ms": delay_ms,
        "worker_id": worker_id
    })).await?;

    sqlx::query!(
        r#"update engine_jobs set status='DONE', updated_at=now() where id=$1"#,
        job.id
    ).execute(&mut *tx).await?;

    tx.commit().await?;
    Ok(())
}



// 1) READY job을 SKIP LOCKED로 가져오고 RUNNING으로 바꿈 (하나의 tx)
async fn fetch_and_mark_running(pool: &PgPool) -> Result<Option<Job>> {
    let mut tx = pool.begin().await?;

    // 잡 1개 잠금 획득
    let row = sqlx::query!(
        r#"
        select id, instance_id, type as "job_type!", attempt
        from engine_jobs
        where status = 'READY' and run_at <= now()
        order by id asc
        for update skip locked
        limit 1
        "#
    )
    .fetch_optional(&mut *tx)
    .await?;

    let Some(r) = row else {
        tx.rollback().await?;
        return Ok(None);
    };

    // RUNNING으로 마킹
    sqlx::query!(
        r#"
        update engine_jobs
        set status = 'RUNNING', updated_at = now()
        where id = $1
        "#,
        r.id
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Some(Job {
        id: r.id,
        instance_id: r.instance_id,
        job_type: r.job_type,
        attempt: r.attempt,
    }))
}

async fn emit_outbox(tx: &mut Transaction<'_, Postgres>, instance_id: Uuid, event_type: &str, payload: serde_json::Value) -> Result<()> {
    sqlx::query!(
        r#"
        insert into event_outbox (instance_id, type, payload)
        values ($1, $2, $3)
        "#,
        instance_id,
        event_type,
        payload
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn mark_job_done(pool: &PgPool, job_id: i64) -> Result<()> {
    sqlx::query!(
        r#"update engine_jobs set status='DONE', updated_at=now() where id=$1"#,
        job_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn mark_job_failed(pool: &PgPool, job_id: i64) -> Result<()> {
    sqlx::query!(
        r#"update engine_jobs set status='FAILED', updated_at=now() where id=$1"#,
        job_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn try_advisory_lock(tx: &mut Transaction<'_, Postgres>, instance_id: Uuid) -> Result<bool> {
    let instance_key = instance_id.to_string();
    let r = sqlx::query!(
        r#"select pg_try_advisory_lock(hashtext($1)) as "locked!""#,
        instance_key
    )
    .fetch_one(&mut **tx)
    .await?;
    Ok(r.locked)
}

async fn advisory_unlock(pool: &PgPool, instance_id: Uuid) -> Result<()> {
    let instance_key = instance_id.to_string();
    sqlx::query!(
        r#"select pg_advisory_unlock(hashtext($1))"#,
        instance_key
    )
    .fetch_one(pool)
    .await?;
    Ok(())
}

async fn acquire_lease(
    tx: &mut Transaction<'_, Postgres>,
    instance_id: Uuid,
    worker_id: &str,
    lease_seconds: f64, // ← 여기 중요
) -> Result<bool> {
    let r = sqlx::query!(
        r#"
        update process_instance
        set lock_owner = $2,
            lock_until = now() + ($3::double precision * interval '1 second'),
            heartbeat_at = now(),
            updated_at = now()
        where id = $1
          and (
            lock_until is null
            or lock_until < now()
            or lock_owner = $2
          )
        returning id
        "#,
        instance_id,
        worker_id,
        lease_seconds
    )
    .fetch_optional(&mut **tx)
    .await?;

    Ok(r.is_some())
}



async fn renew_lease(
    pool: &PgPool,
    instance_id: Uuid,
    worker_id: &str,
    lease_seconds: f64, // ← 여기 중요
) -> Result<()> {
    sqlx::query!(
        r#"
        update process_instance
        set lock_until = now() + ($2::double precision * interval '1 second'),
            heartbeat_at = now(),
            updated_at = now()
        where id = $1 and lock_owner = $3
        "#,
        instance_id,
        lease_seconds,
        worker_id
    )
    .execute(pool)
    .await?;
    Ok(())
}



async fn release_lease(pool: &PgPool, instance_id: Uuid, worker_id: &str) -> Result<()> {
    sqlx::query!(
        r#"
        update process_instance
        set lock_owner = null,
            lock_until = null,
            updated_at = now()
        where id = $1 and lock_owner = $2
        "#,
        instance_id,
        worker_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

fn start_heartbeat_task(
    pool: PgPool,
    instance_id: Uuid,
    worker_id: String,
    lease_seconds: f64,
    heartbeat_seconds: i64,
    cancel: CancellationToken,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(heartbeat_seconds as u64));
        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    break;
                }
                _ = ticker.tick() => {
                    let _ = renew_lease(&pool, instance_id, &worker_id, lease_seconds).await;
                }
            }
        }
    })
}

async fn reclaim_stale_running_jobs(pool: &PgPool) -> Result<i64> {
    let res = sqlx::query!(
        r#"
        update engine_jobs j
        set status = 'READY',
            run_at = now(),
            updated_at = now()
        from process_instance i
        where j.instance_id = i.id
          and j.status = 'RUNNING'
          and (i.lock_until is null or i.lock_until < now())
        returning j.id
        "#
    )
    .fetch_all(pool)
    .await?;

    Ok(res.len() as i64)
}
