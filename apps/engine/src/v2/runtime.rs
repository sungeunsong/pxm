//! V2 runtime orchestration skeleton.
//! This module is intentionally isolated from V1 logic.

use anyhow::Result;
use sqlx::PgPool;

use super::contracts::{
    CONTRACT_EDGE_OWNS_CONDITION,
    CONTRACT_GATEWAY_SEMANTICS,
    CONTRACT_INSTANCE_LOCK,
};
use super::repository;

pub async fn run_v2_once(pool: &PgPool, worker_id: &str) -> Result<bool> {
    let maybe_job = repository::fetch_and_mark_running_job(pool, worker_id).await?;
    let Some(job) = maybe_job else {
        return Ok(false);
    };

    // TODO: before any state mutation, acquire instance lock + lease.
    // CONTRACT: instance-level serialization is mandatory.
    let _ = CONTRACT_INSTANCE_LOCK;

    // TODO: route by job type and execute node semantics.
    // - token movement must be explicit
    // - job scheduling must be token-scoped
    // - detailed logs + outbox must both be written
    let _ = job;

    Ok(true)
}

pub fn evaluate_gateway_edges_contract_note() -> &'static str {
    // Keep this string close to implementation to avoid drift.
    CONTRACT_EDGE_OWNS_CONDITION
}

pub fn gateway_semantics_contract_note() -> &'static str {
    CONTRACT_GATEWAY_SEMANTICS
}
