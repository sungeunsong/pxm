use anyhow::Result;
use serde_json::json;
use sqlx::{postgres::PgPoolOptions, PgPool, Postgres, Transaction};
use std::time::Duration;
use uuid::Uuid;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;


#[derive(Debug)]
struct Job {
    id: i64,
    instance_id: Uuid,
    job_type: String, // "START" etc
    attempt: i32,
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

            // START 처리 (지금은 가짜 실행)
            if job.job_type == "START" {
                if let Err(e) = handle_start_job(&pool, &worker_id, &job).await {
                    eprintln!("[engine] job {} failed: {e:?}", job.id);
                    // MVP: 실패면 job FAILED로만 표시 (retry는 다음 단계)
                    mark_job_failed(&pool, job.id).await?;
                }
            } else {
                // 아직 다른 타입은 미지원
                println!("[engine] unsupported job_type={}, mark DONE", job.job_type);
                mark_job_done(&pool, job.id).await?;
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

// 2) START 잡 처리: outbox 이벤트 기록 + 완료 처리
async fn handle_start_job(pool: &PgPool, worker_id: &str, job: &Job) -> Result<()> {
    let lease_seconds: f64 = std::env::var("ENGINE_LEASE_SECONDS")
    .ok()
    .and_then(|v| v.parse::<f64>().ok())
    .unwrap_or(20.0);
    let heartbeat_seconds: i64 = std::env::var("ENGINE_HEARTBEAT_SECONDS").ok().and_then(|v| v.parse().ok()).unwrap_or(5);

    // 1) advisory lock + lease 획득 (짧게, 빨리 끝내는 tx)
    {
        let mut tx = pool.begin().await?;

        let locked = try_advisory_lock(&mut tx, job.instance_id).await?;
        if !locked {
            tx.rollback().await?;
            // 다른 워커가 실행 중. 나중에 다시 시도하도록 job을 READY로 돌리고 살짝 미룸
            sqlx::query!(
                r#"
                update engine_jobs
                set status='READY', run_at = now() + interval '1 second', updated_at=now()
                where id=$1 and status='RUNNING'
                "#,
                job.id
            )
            .execute(pool)
            .await?;
            return Ok(());
        }

        let leased = acquire_lease(&mut tx, job.instance_id, worker_id, lease_seconds).await?;
        if !leased {
            tx.rollback().await?;
            // lease 못 잡으면 unlock 하고 job을 READY로 되돌림
            advisory_unlock(pool, job.instance_id).await?;
            sqlx::query!(
                r#"
                update engine_jobs
                set status='READY', run_at = now() + interval '1 second', updated_at=now()
                where id=$1 and status='RUNNING'
                "#,
                job.id
            )
            .execute(pool)
            .await?;
            return Ok(());
        }

        tx.commit().await?;
    }

    // 2) heartbeat 시작
    let cancel = CancellationToken::new();
    let hb = start_heartbeat_task(
        pool.clone(),
        job.instance_id,
        worker_id.to_string(),
        lease_seconds,
        heartbeat_seconds,
        cancel.clone(),
    );

    // 3) 본 실행(기존 로직) + 종료 정리
    let exec_result = (|| async {
        let mut tx: Transaction<Postgres> = pool.begin().await?;

        // instance RUNNING
        sqlx::query!(
            r#"
            update process_instance
            set status = 'RUNNING', updated_at = now()
            where id = $1
            "#,
            job.instance_id
        )
        .execute(&mut *tx)
        .await?;

        emit_outbox(&mut tx, job.instance_id, "INSTANCE_RUNNING", json!({
            "instance_id": job.instance_id,
            "status": "RUNNING",
            "worker_id": worker_id,
        }))
        .await?;

        // start 노드 흉내
        emit_outbox(&mut tx, job.instance_id, "NODE_STARTED", json!({
            "instance_id": job.instance_id,
            "node_id": "start",
            "token_id": "t1",
        }))
        .await?;

        emit_outbox(&mut tx, job.instance_id, "NODE_COMPLETED", json!({
            "instance_id": job.instance_id,
            "node_id": "start",
            "token_id": "t1",
        }))
        .await?;

        // instance COMPLETED
        sqlx::query!(
            r#"
            update process_instance
            set status = 'COMPLETED', updated_at = now()
            where id = $1
            "#,
            job.instance_id
        )
        .execute(&mut *tx)
        .await?;

        emit_outbox(&mut tx, job.instance_id, "INSTANCE_COMPLETED", json!({
            "instance_id": job.instance_id,
            "status": "COMPLETED",
        }))
        .await?;

        // job DONE
        sqlx::query!(
            r#"
            update engine_jobs
            set status = 'DONE', updated_at = now()
            where id = $1
            "#,
            job.id
        )
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok::<_, anyhow::Error>(())
    })().await;

    // 4) 정리: heartbeat 종료 + lease 해제 + advisory unlock
    cancel.cancel();
    let _ = hb.await;

    // lease 해제는 best-effort
    let _ = release_lease(pool, job.instance_id, worker_id).await;
    let _ = advisory_unlock(pool, job.instance_id).await;

    exec_result
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
