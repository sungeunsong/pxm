use anyhow::Result;
use serde_json::json;
use sqlx::{postgres::PgPoolOptions, PgPool, Postgres, Transaction};
use std::time::Duration;
use uuid::Uuid;

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
    let mut tx: Transaction<Postgres> = pool.begin().await?;

    // instance RUNNING으로 바꾸고 outbox 찍기 (DB truth)
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

    // "start" 노드 흉내
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

    // instance COMPLETED로
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
    Ok(())
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
