//! Repository layer skeleton for V2 runtime.
//! TODO: wire sqlx queries against v2_* tables.

use anyhow::Result;
use sqlx::PgPool;

use super::types::{EdgeRule, NodeDef, V2Job};

pub async fn fetch_and_mark_running_job(_pool: &PgPool, _worker_id: &str) -> Result<Option<V2Job>> {
    // TODO:
    // 1) SELECT ... FOR UPDATE SKIP LOCKED on v2_engine_jobs
    // 2) mark job RUNNING with lock owner
    // 3) return parsed V2Job
    Ok(None)
}

pub async fn load_definition_graph(
    _pool: &PgPool,
    _definition_id: &str,
) -> Result<(Vec<NodeDef>, Vec<EdgeRule>)> {
    // TODO: load nodes and edges ordered by eval_order.
    Ok((Vec::new(), Vec::new()))
}

pub async fn append_execution_log(
    _pool: &PgPool,
    _instance_id: &str,
    _event_type: &str,
) -> Result<()> {
    // TODO: insert into v2_execution_logs
    Ok(())
}

pub async fn append_outbox_event(
    _pool: &PgPool,
    _instance_id: &str,
    _event_type: &str,
) -> Result<()> {
    // TODO: insert into v2_event_outbox
    Ok(())
}
