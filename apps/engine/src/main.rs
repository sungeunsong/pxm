use anyhow::Result;
use mongodb::Client;
use sqlx::postgres::PgPoolOptions;
use std::time::Duration;

pub mod v2;

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();

    let db_type = std::env::var("DB_TYPE").unwrap_or_else(|_| "postgres".to_string());
    let worker_id = std::env::var("ENGINE_WORKER_ID").unwrap_or_else(|_| "engine-1".to_string());
    let poll_ms: u64 = std::env::var("ENGINE_POLL_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(300);

    println!("[engine] Starting. db_type={db_type}, worker_id={worker_id}, poll_ms={poll_ms}");

    let v2_context = if db_type == "mongodb" {
        let mongo_url = std::env::var("MONGODB_URL")
            .unwrap_or_else(|_| "mongodb://127.0.0.1:27017".to_string());
        let db_name = std::env::var("MONGO_DB_NAME").unwrap_or_else(|_| "pxm_db".to_string());

        println!("[engine] Connecting to MongoDB at {mongo_url} (DB: {db_name})...");
        let mut options = mongodb::options::ClientOptions::parse(&mongo_url).await?;
        options.retry_writes = Some(false); // Standalone MongoDB 지원용 강제 비활성화
        let client = Client::with_options(options)?;

        // Replica Set 검사 (트랜잭션 지원 여부 확인)
        let admin_db = client.database("admin");
        let is_replica_set = match admin_db
            .run_command(mongodb::bson::doc! { "isMaster": 1 }, None)
            .await
        {
            Ok(res) => res.contains_key("setName"),
            Err(_) => false,
        };
        println!("[engine] MongoDB replica set status: is_replica_set={is_replica_set}");
        if !is_replica_set && std::env::var("ALLOW_MONGO_STANDALONE").as_deref() != Ok("true") {
            anyhow::bail!(
                "MongoDB adapter requires a replica set for runtime transactions. Set ALLOW_MONGO_STANDALONE=true only for local dev."
            );
        }

        let adapter =
            v2::infrastructure::mongo_adapter::MongoAdapter::new(client, &db_name, is_replica_set);
        let plugin_executor = v2::plugin_executor::PluginExecutorRegistry::new_default()?;

        v2::runtime::V2RuntimeContext {
            tx_manager: Box::new(adapter.clone()),
            job_queue: Box::new(adapter.clone()),
            instance_lock: Box::new(adapter.clone()),
            token_repo: Box::new(adapter.clone()),
            task_repo: Box::new(adapter.clone()),
            exec_log: Box::new(adapter.clone()),
            outbox: Box::new(adapter.clone()),
            def_repo: Box::new(adapter.clone()),
            instance_repo: Box::new(adapter.clone()),
            plugin_executor: Box::new(plugin_executor),
        }
    } else {
        let db_url = std::env::var("DATABASE_URL")?;
        println!("[engine] Connecting to PostgreSQL...");

        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(&db_url)
            .await?;

        let adapter = v2::infrastructure::postgres_adapter::PostgresAdapter::new(pool);
        let plugin_executor = v2::plugin_executor::PluginExecutorRegistry::new_default()?;

        v2::runtime::V2RuntimeContext {
            tx_manager: Box::new(adapter.clone()),
            job_queue: Box::new(adapter.clone()),
            instance_lock: Box::new(adapter.clone()),
            token_repo: Box::new(adapter.clone()),
            task_repo: Box::new(adapter.clone()),
            exec_log: Box::new(adapter.clone()),
            outbox: Box::new(adapter.clone()),
            def_repo: Box::new(adapter.clone()),
            instance_repo: Box::new(adapter.clone()),
            plugin_executor: Box::new(plugin_executor),
        }
    };

    println!("[engine] connected and context initialized.");

    let mut last_reap = std::time::Instant::now();

    loop {
        // 1) V2 엔진 루프 시도
        let v2_processed = v2::runtime::run_v2_once(&v2_context, &worker_id).await?;
        if v2_processed {
            // 잡이 처리되었으므로 즉시 다음 잡을 처리하기 위해 루프 지속
            continue;
        }

        // 2) 대기 중 정기적인 Stale Job 회수
        if last_reap.elapsed() > Duration::from_secs(5) {
            let n2 = v2_context.job_queue.reclaim_stale_jobs().await?;
            if n2 > 0 {
                println!("[engine] reclaimed {n2} stale RUNNING V2 jobs");
            }
            last_reap = std::time::Instant::now();
        }

        tokio::time::sleep(Duration::from_millis(poll_ms)).await;
    }
}
