use anyhow::Result;
use chrono::Utc;
use rand::Rng;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::v2::ports::{
    ExecutionLogPort, InstanceLockPort, JobQueuePort, OutboxPort, PluginExecutorPort,
    PluginInvocation, ProcessDefinitionRepositoryPort, TaskRepositoryPort, TokenRepositoryPort,
    TransactionManagerPort, Tx, WorkflowInstanceRepositoryPort,
};
use crate::v2::types::{EdgeRule, JobType, NodeDef, TokenStatus, V2Instance, V2Token};

pub struct V2RuntimeContext {
    pub tx_manager: Box<dyn TransactionManagerPort>,
    pub job_queue: Box<dyn JobQueuePort>,
    pub instance_lock: Box<dyn InstanceLockPort>,
    pub token_repo: Box<dyn TokenRepositoryPort>,
    pub task_repo: Box<dyn TaskRepositoryPort>,
    pub exec_log: Box<dyn ExecutionLogPort>,
    pub outbox: Box<dyn OutboxPort>,
    pub def_repo: Box<dyn ProcessDefinitionRepositoryPort>,
    pub instance_repo: Box<dyn WorkflowInstanceRepositoryPort>,
    pub plugin_executor: Box<dyn PluginExecutorPort>,
}

// ============================================================
// V2 RetryPolicy
// ============================================================
#[derive(Debug, Clone)]
pub struct V2RetryPolicy {
    pub max_attempts: i32,
    pub initial_delay_ms: u64,
    pub max_delay_ms: u64,
    pub multiplier: f64,
    pub jitter_factor: f64,
}

impl Default for V2RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 5,
            initial_delay_ms: 1000,
            max_delay_ms: 60_000,
            multiplier: 2.0,
            jitter_factor: 0.1,
        }
    }
}

impl V2RetryPolicy {
    pub fn from_env() -> Self {
        let max_attempts = std::env::var("RETRY_MAX_ATTEMPTS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(5);
        let initial_delay_ms = std::env::var("RETRY_INITIAL_DELAY_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(1000);
        let max_delay_ms = std::env::var("RETRY_MAX_DELAY_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(60_000);
        let multiplier = std::env::var("RETRY_MULTIPLIER")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(2.0);
        let jitter_factor = std::env::var("RETRY_JITTER_FACTOR")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.1);

        Self {
            max_attempts,
            initial_delay_ms,
            max_delay_ms,
            multiplier,
            jitter_factor,
        }
    }

    pub fn calculate_backoff(&self, attempt: i32) -> u64 {
        let base = self.initial_delay_ms as f64 * self.multiplier.powi(attempt);
        let capped = base.min(self.max_delay_ms as f64);
        let jitter_range = capped * self.jitter_factor;
        let jitter: f64 = rand::thread_rng().gen_range(-jitter_range..=jitter_range);
        ((capped + jitter).max(100.0)) as u64
    }
}

// ============================================================
// 식 해석기 (Expression Evaluator)
// ============================================================
fn evaluate_condition(condition: &str, context: &Value) -> bool {
    let form_data = context.get("formData");
    if let Some(data) = form_data {
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
    false
}

// ============================================================
// V2 Engine Main Loop Entry
// ============================================================
pub async fn run_v2_once(ctx: &V2RuntimeContext, worker_id: &str) -> Result<bool> {
    // 1) READY(QUEUED) 잡 선점
    let maybe_job = ctx.job_queue.fetch_and_mark_running(worker_id).await?;
    let Some(job) = maybe_job else {
        return Ok(false);
    };

    println!(
        "[v2_engine] 🚀 processing job_id={}, type={:?}, instance_id={}",
        job.id, job.job_type, job.instance_id
    );

    let mut tx = ctx.tx_manager.begin().await?;
    let mut advisory_acquired = false;
    let mut lease_acquired = false;

    let result: Result<(bool, bool)> = async {
        advisory_acquired = ctx
            .instance_lock
            .try_advisory_lock(job.instance_id, tx.as_mut())
            .await?;
        if !advisory_acquired {
            println!(
                "[v2_engine] failed to acquire advisory lock for instance {}",
                job.instance_id
            );
            return Ok((false, false));
        }

        lease_acquired = ctx
            .instance_lock
            .acquire_lease(job.instance_id, worker_id, 30.0, tx.as_mut())
            .await?;
        if !lease_acquired {
            println!(
                "[v2_engine] failed to acquire lease for instance {}",
                job.instance_id
            );
            return Ok((false, false));
        }

        let maybe_instance = ctx
            .instance_repo
            .load_instance(job.instance_id, tx.as_mut())
            .await?;
        let Some(mut instance) = maybe_instance else {
            println!(
                "[v2_engine] instance {} not found, marking job failed",
                job.instance_id
            );
            ctx.job_queue.mark_job_failed(job.id, tx.as_mut()).await?;
            return Ok((true, true));
        };

        if instance.state == "COMPLETED"
            || instance.state == "FAILED"
            || instance.state == "TERMINATED"
        {
            println!(
                "[v2_engine] instance {} is already in terminal state: {}",
                instance.id, instance.state
            );
            ctx.job_queue
                .mark_job_completed(job.id, tx.as_mut())
                .await?;
            return Ok((true, true));
        }

        if instance.state == "CREATED" || instance.state == "WAITING" {
            instance.state = "RUNNING".to_string();
            ctx.instance_repo
                .update_instance(
                    instance.id,
                    &instance.state,
                    instance.context.clone(),
                    tx.as_mut(),
                )
                .await?;
            ctx.outbox
                .append_event(
                    instance.id,
                    None,
                    None,
                    "INSTANCE_RUNNING",
                    json!({
                        "instance_id": instance.id,
                        "state": "RUNNING",
                        "worker_id": worker_id
                    }),
                    tx.as_mut(),
                )
                .await?;
        }

        let (nodes, edges) = ctx
            .def_repo
            .load_definition_graph(instance.process_definition_id)
            .await?;
        let mut active_tokens = Vec::new();

        match job.job_type {
            JobType::Start => {
                let tokens = ctx.token_repo.load_tokens(instance.id, tx.as_mut()).await?;
                let mut start_tokens: Vec<V2Token> = tokens
                    .into_iter()
                    .filter(|t| t.status == TokenStatus::Active || t.node_id == "start")
                    .collect();

                if start_tokens.is_empty() {
                    let start_token = V2Token {
                        id: Uuid::new_v4(),
                        instance_id: instance.id,
                        node_id: "start".to_string(),
                        status: TokenStatus::Active,
                        parent_token_id: None,
                        scope_key: None,
                        created_at: Utc::now(),
                        updated_at: Utc::now(),
                    };
                    ctx.token_repo
                        .create_tokens(&[start_token.clone()], tx.as_mut())
                        .await?;
                    start_tokens.push(start_token);
                }
                active_tokens = start_tokens;
            }
            JobType::Resume => {
                let mut tokens = ctx.token_repo.load_tokens(instance.id, tx.as_mut()).await?;
                if let Some(tid) = job.token_id {
                    active_tokens = tokens.into_iter().filter(|t| t.id == tid).collect();
                } else {
                    let completed_node_id = job
                        .payload
                        .get("completed_node_id")
                        .and_then(|v| v.as_str());
                    if let Some(node_id) = completed_node_id {
                        let mut matched = false;
                        for t in &mut tokens {
                            if t.node_id == node_id && t.status == TokenStatus::Waiting {
                                t.status = TokenStatus::Active;
                                t.updated_at = Utc::now();
                                ctx.token_repo
                                    .update_tokens(&[t.clone()], tx.as_mut())
                                    .await?;
                                active_tokens.push(t.clone());
                                matched = true;
                            }
                        }
                        if !matched {
                            active_tokens = tokens
                                .into_iter()
                                .filter(|t| t.status == TokenStatus::Active)
                                .collect();
                        }
                    } else {
                        active_tokens = tokens
                            .into_iter()
                            .filter(|t| t.status == TokenStatus::Active)
                            .collect();
                    }
                }
            }
            JobType::Timer => {
                let tokens = ctx.token_repo.load_tokens(instance.id, tx.as_mut()).await?;
                if let Some(tid) = job.token_id {
                    let mut timer_tokens: Vec<V2Token> =
                        tokens.into_iter().filter(|t| t.id == tid).collect();
                    for token in &mut timer_tokens {
                        if token.status == TokenStatus::Waiting {
                            token.status = TokenStatus::Active;
                            token.updated_at = Utc::now();
                            ctx.token_repo
                                .update_tokens(&[token.clone()], tx.as_mut())
                                .await?;
                        }
                    }
                    active_tokens = timer_tokens;
                }
            }
            JobType::Retry => {
                let tokens = ctx.token_repo.load_tokens(instance.id, tx.as_mut()).await?;
                if let Some(tid) = job.token_id {
                    let mut retry_tokens: Vec<V2Token> =
                        tokens.into_iter().filter(|t| t.id == tid).collect();
                    for token in &mut retry_tokens {
                        if token.status == TokenStatus::Waiting {
                            token.status = TokenStatus::Active;
                            token.updated_at = Utc::now();
                            ctx.token_repo
                                .update_tokens(&[token.clone()], tx.as_mut())
                                .await?;
                        }
                    }
                    active_tokens = retry_tokens;
                }
            }
            _ => {}
        }

        if !active_tokens.is_empty() {
            execute_token_flow(
                ctx,
                &mut instance,
                active_tokens,
                &nodes,
                &edges,
                job.attempt,
                tx.as_mut(),
            )
            .await?;
        }

        ctx.job_queue
            .mark_job_completed(job.id, tx.as_mut())
            .await?;
        ctx.exec_log
            .append_log(
                job.instance_id,
                job.token_id,
                None,
                "V2_JOB_PROCESSED",
                json!({"job_id": job.id, "job_type": job.job_type.as_str()}),
                tx.as_mut(),
            )
            .await?;

        Ok((true, true))
    }
    .await;

    match result {
        Ok((processed, should_commit)) => {
            if should_commit {
                ctx.tx_manager.commit(tx).await?;
            } else {
                ctx.tx_manager.rollback(tx).await?;
            }
            if lease_acquired {
                let _ = ctx
                    .instance_lock
                    .release_lease(job.instance_id, worker_id)
                    .await;
            }
            if advisory_acquired {
                let _ = ctx.instance_lock.advisory_unlock(job.instance_id).await;
            }
            Ok(processed)
        }
        Err(err) => {
            let _ = ctx.tx_manager.rollback(tx).await;
            if lease_acquired {
                let _ = ctx
                    .instance_lock
                    .release_lease(job.instance_id, worker_id)
                    .await;
            }
            if advisory_acquired {
                let _ = ctx.instance_lock.advisory_unlock(job.instance_id).await;
            }
            Err(err)
        }
    }
}

// ============================================================
// 토큰 전이 루프 엔진 (Explicit Token State Machine)
// ============================================================
async fn execute_token_flow(
    ctx: &V2RuntimeContext,
    instance: &mut V2Instance,
    mut active_tokens: Vec<V2Token>,
    nodes: &[NodeDef],
    edges: &[EdgeRule],
    attempt: i32,
    tx: &mut dyn Tx,
) -> Result<()> {
    while let Some(mut token) = active_tokens.pop() {
        // 노드 명세 조회
        let node = nodes.iter().find(|n| n.node_id == token.node_id);
        let Some(node) = node else {
            println!(
                "[v2_engine] node {} not found in definition, marking token failed",
                token.node_id
            );
            token.status = TokenStatus::Failed;
            token.updated_at = Utc::now();
            ctx.token_repo.update_tokens(&[token], tx).await?;
            continue;
        };

        println!(
            "[v2_engine] flow token {} at node: id={}, type={}",
            token.id, node.node_id, node.node_type
        );

        match node.node_type.as_str() {
            "start" => {
                // 1) 시작 노드 이벤트 발행 및 소모
                ctx.exec_log
                    .append_log(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "NODE_STARTED",
                        json!({}),
                        tx,
                    )
                    .await?;
                ctx.exec_log
                    .append_log(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "NODE_COMPLETED",
                        json!({}),
                        tx,
                    )
                    .await?;

                token.status = TokenStatus::Consumed;
                token.updated_at = Utc::now();
                ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                // 2) 다음 노드들을 찾아서 토큰 전이
                let next_edges: Vec<&EdgeRule> = edges
                    .iter()
                    .filter(|e| e.source_node_id == token.node_id)
                    .collect();

                for edge in next_edges {
                    let new_token = V2Token {
                        id: Uuid::new_v4(),
                        instance_id: instance.id,
                        node_id: edge.target_node_id.clone(),
                        status: TokenStatus::Active,
                        parent_token_id: Some(token.id),
                        scope_key: token.scope_key.clone(),
                        created_at: Utc::now(),
                        updated_at: Utc::now(),
                    };
                    ctx.token_repo
                        .create_tokens(&[new_token.clone()], tx)
                        .await?;
                    active_tokens.push(new_token);
                }
            }

            "gateway" => {
                ctx.exec_log
                    .append_log(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "NODE_STARTED",
                        json!({}),
                        tx,
                    )
                    .await?;

                // Gateway 분기 조건 평가
                let next_edges: Vec<&EdgeRule> = edges
                    .iter()
                    .filter(|e| e.source_node_id == token.node_id)
                    .collect();

                let mut matched_target: Option<String> = None;
                let mut default_target: Option<String> = None;

                for edge in &next_edges {
                    if edge.is_default {
                        default_target = Some(edge.target_node_id.clone());
                    } else if let Some(ref expr) = edge.condition_expr {
                        if evaluate_condition(expr, &instance.context) {
                            matched_target = Some(edge.target_node_id.clone());
                            break;
                        }
                    }
                }

                let final_target = matched_target.or(default_target);

                if let Some(target) = final_target {
                    ctx.exec_log
                        .append_log(
                            instance.id,
                            Some(token.id),
                            Some(&token.node_id),
                            "NODE_COMPLETED",
                            json!({"decision_target": target}),
                            tx,
                        )
                        .await?;

                    token.status = TokenStatus::Consumed;
                    token.updated_at = Utc::now();
                    ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                    let new_token = V2Token {
                        id: Uuid::new_v4(),
                        instance_id: instance.id,
                        node_id: target,
                        status: TokenStatus::Active,
                        parent_token_id: Some(token.id),
                        scope_key: token.scope_key.clone(),
                        created_at: Utc::now(),
                        updated_at: Utc::now(),
                    };
                    ctx.token_repo
                        .create_tokens(&[new_token.clone()], tx)
                        .await?;
                    active_tokens.push(new_token);
                } else {
                    println!("[v2_engine] Gateway failed to find any matching edge, stopping flow");
                    token.status = TokenStatus::Failed;
                    token.updated_at = Utc::now();
                    ctx.token_repo.update_tokens(&[token.clone()], tx).await?;
                }
            }

            "approval" => {
                // 1) 완료된 Task 확인 (재진입 시나리오)
                let completed_task = ctx.task_repo.find_task_by_token(token.id, tx).await?;

                if let Some(task) = completed_task {
                    if task.status == "APPROVED" || task.status == "REJECTED" {
                        println!(
                            "[v2_engine] ✅ Approval Task is {}, moving next.",
                            task.status
                        );

                        ctx.exec_log
                            .append_log(
                                instance.id,
                                Some(token.id),
                                Some(&token.node_id),
                                "NODE_COMPLETED",
                                json!({"approval_status": task.status}),
                                tx,
                            )
                            .await?;

                        token.status = TokenStatus::Consumed;
                        token.updated_at = Utc::now();
                        ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                        if task.status == "REJECTED" {
                            println!("[v2_engine] 🛑 Task rejected, failing instance.");
                            instance.state = "FAILED".to_string();
                            ctx.instance_repo
                                .update_instance(
                                    instance.id,
                                    &instance.state,
                                    instance.context.clone(),
                                    tx,
                                )
                                .await?;

                            ctx.outbox
                                .append_event(
                                    instance.id,
                                    Some(token.id),
                                    Some(&token.node_id),
                                    "INSTANCE_FAILED",
                                    json!({"reason": "task_rejected"}),
                                    tx,
                                )
                                .await?;
                            continue;
                        }

                        // 승인 시 다음 노드 진행
                        let next_edges: Vec<&EdgeRule> = edges
                            .iter()
                            .filter(|e| e.source_node_id == token.node_id)
                            .collect();

                        for edge in next_edges {
                            let new_token = V2Token {
                                id: Uuid::new_v4(),
                                instance_id: instance.id,
                                node_id: edge.target_node_id.clone(),
                                status: TokenStatus::Active,
                                parent_token_id: Some(token.id),
                                scope_key: token.scope_key.clone(),
                                created_at: Utc::now(),
                                updated_at: Utc::now(),
                            };
                            ctx.token_repo
                                .create_tokens(&[new_token.clone()], tx)
                                .await?;
                            active_tokens.push(new_token);
                        }
                        continue;
                    }

                    if task.status == "OPEN" {
                        token.status = TokenStatus::Waiting;
                        token.updated_at = Utc::now();
                        ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                        instance.state = "WAITING".to_string();
                        ctx.instance_repo
                            .update_instance(
                                instance.id,
                                &instance.state,
                                instance.context.clone(),
                                tx,
                            )
                            .await?;
                        continue;
                    }
                }

                // 2) 신규 진입 시나리오: Task 생성 후 대기
                ctx.exec_log
                    .append_log(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "NODE_STARTED",
                        json!({}),
                        tx,
                    )
                    .await?;

                let task_id = Uuid::new_v4();
                let assignee = node
                    .config
                    .get("assignee")
                    .and_then(|v| v.as_str())
                    .unwrap_or("admin");

                let task = ctx
                    .task_repo
                    .find_or_create_task(
                        task_id,
                        instance.id,
                        token.id,
                        &token.node_id,
                        assignee,
                        json!({}),
                        tx,
                    )
                    .await?;

                // 토큰을 WAITING으로 마킹
                token.status = TokenStatus::Waiting;
                token.updated_at = Utc::now();
                ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                // 인스턴스를 WAITING으로 마킹
                instance.state = "WAITING".to_string();
                ctx.instance_repo
                    .update_instance(instance.id, &instance.state, instance.context.clone(), tx)
                    .await?;

                ctx.outbox
                    .append_event(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "TASK_CREATED",
                        json!({
                            "task_id": task.id,
                            "assignee": assignee
                        }),
                        tx,
                    )
                    .await?;

                ctx.outbox
                    .append_event(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "INSTANCE_WAITING",
                        json!({
                            "state": "WAITING",
                            "task_id": task.id
                        }),
                        tx,
                    )
                    .await?;
            }

            "timer" => {
                ctx.exec_log
                    .append_log(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "NODE_STARTED",
                        json!({}),
                        tx,
                    )
                    .await?;

                // 타이머 설정 읽기
                let duration_sec = node
                    .config
                    .get("durationMs")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<f64>().ok())
                    .map(|ms| ms / 1000.0)
                    .unwrap_or(5.0);

                // 토큰을 WAITING으로 마킹
                token.status = TokenStatus::Waiting;
                token.updated_at = Utc::now();
                ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                // 타이머 잡 스케줄링 등록
                ctx.job_queue
                    .enqueue_job(
                        instance.id,
                        Some(token.id),
                        JobType::Timer,
                        duration_sec,
                        0,
                        json!({"node_id": token.node_id}),
                        tx,
                    )
                    .await?;

                ctx.outbox
                    .append_event(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "TIMER_SCHEDULED",
                        json!({"duration_sec": duration_sec}),
                        tx,
                    )
                    .await?;
            }

            "service" => {
                ctx.exec_log
                    .append_log(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "NODE_STARTED",
                        json!({"attempt": attempt}),
                        tx,
                    )
                    .await?;

                let plugin_id = node
                    .config
                    .get("plugin_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("builtin.http_request");

                println!("[v2_engine] Executing plugin: {}", plugin_id);

                let invocation = PluginInvocation {
                    plugin_id: plugin_id.to_string(),
                    instance_id: instance.id,
                    token_id: token.id,
                    node_id: token.node_id.clone(),
                    config: node.config.clone(),
                    context: instance.context.clone(),
                    attempt,
                };

                let call_result = ctx.plugin_executor.execute(invocation).await;

                match call_result {
                    Ok(result) => {
                        ctx.exec_log
                            .append_log(
                                instance.id,
                                Some(token.id),
                                Some(&token.node_id),
                                "NODE_COMPLETED",
                                json!({"status_code": result.status_code, "output": result.output}),
                                tx,
                            )
                            .await?;

                        token.status = TokenStatus::Consumed;
                        token.updated_at = Utc::now();
                        ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                        // 다음 엣지 탐색
                        let next_edges: Vec<&EdgeRule> = edges
                            .iter()
                            .filter(|e| e.source_node_id == token.node_id)
                            .collect();

                        for edge in next_edges {
                            let new_token = V2Token {
                                id: Uuid::new_v4(),
                                instance_id: instance.id,
                                node_id: edge.target_node_id.clone(),
                                status: TokenStatus::Active,
                                parent_token_id: Some(token.id),
                                scope_key: token.scope_key.clone(),
                                created_at: Utc::now(),
                                updated_at: Utc::now(),
                            };
                            ctx.token_repo
                                .create_tokens(&[new_token.clone()], tx)
                                .await?;
                            active_tokens.push(new_token);
                        }
                    }
                    Err(err) => {
                        let retry_policy = V2RetryPolicy::from_env();
                        if attempt < retry_policy.max_attempts {
                            let delay_ms = retry_policy.calculate_backoff(attempt);
                            let delay_sec = delay_ms as f64 / 1000.0;

                            token.status = TokenStatus::Waiting;
                            token.updated_at = Utc::now();
                            ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                            ctx.job_queue
                                .enqueue_job(
                                    instance.id,
                                    Some(token.id),
                                    JobType::Retry,
                                    delay_sec,
                                    attempt + 1,
                                    json!({"node_id": token.node_id, "plugin_id": plugin_id}),
                                    tx,
                                )
                                .await?;

                            ctx.exec_log.append_log(
                                instance.id,
                                Some(token.id),
                                Some(&token.node_id),
                                "NODE_RETRY_SCHEDULED",
                                json!({"attempt": attempt + 1, "delay_sec": delay_sec, "reason": err.to_string()}),
                                tx
                            ).await?;
                        } else {
                            println!("[v2_engine] Service node failed after max retries. Failing instance.");
                            token.status = TokenStatus::Failed;
                            token.updated_at = Utc::now();
                            ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                            instance.state = "FAILED".to_string();
                            ctx.instance_repo
                                .update_instance(
                                    instance.id,
                                    &instance.state,
                                    instance.context.clone(),
                                    tx,
                                )
                                .await?;

                            ctx.outbox
                                .append_event(
                                    instance.id,
                                    Some(token.id),
                                    Some(&token.node_id),
                                    "INSTANCE_FAILED",
                                    json!({"reason": "service_node_failed_max_retries"}),
                                    tx,
                                )
                                .await?;
                        }
                    }
                }
            }

            "end" => {
                ctx.exec_log
                    .append_log(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "NODE_STARTED",
                        json!({}),
                        tx,
                    )
                    .await?;
                ctx.exec_log
                    .append_log(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "NODE_COMPLETED",
                        json!({}),
                        tx,
                    )
                    .await?;

                token.status = TokenStatus::Consumed;
                token.updated_at = Utc::now();
                ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                // 전체 토큰 조회하여 완료 여부 판정
                let all_tokens = ctx.token_repo.load_tokens(instance.id, tx).await?;
                let has_active_or_waiting = all_tokens.iter().any(|t| {
                    t.id != token.id
                        && (t.status == TokenStatus::Active || t.status == TokenStatus::Waiting)
                });

                if !has_active_or_waiting {
                    // 모든 토큰 소모 완료 -> 인스턴스 종료
                    instance.state = "COMPLETED".to_string();
                    ctx.instance_repo
                        .update_instance(instance.id, &instance.state, instance.context.clone(), tx)
                        .await?;

                    ctx.outbox
                        .append_event(
                            instance.id,
                            None,
                            None,
                            "INSTANCE_COMPLETED",
                            json!({"instance_id": instance.id}),
                            tx,
                        )
                        .await?;
                }
            }

            _ => {
                println!("[v2_engine] Unknown node type: {}", node.node_type);
                token.status = TokenStatus::Failed;
                token.updated_at = Utc::now();
                ctx.token_repo.update_tokens(&[token.clone()], tx).await?;
            }
        }
    }
    Ok(())
}
