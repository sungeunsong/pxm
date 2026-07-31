use crate::v2::ports::{
    ExecutionLogPort, InstanceLockPort, JobQueuePort, OutboxPort, ProcessDefinitionRepositoryPort,
    TaskRepositoryPort, TokenRepositoryPort, TransactionManagerPort, Tx,
    WorkflowInstanceRepositoryPort,
};
use crate::v2::types::{
    EdgeRule, JobType, NodeDef, TokenStatus, V2ApprovalBundle, V2ApprovalDefinition,
    V2ApprovalRequest, V2Instance, V2Job, V2Task, V2Token,
};
use anyhow::Result;
use serde_json::Value;
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::any::Any;
use uuid::Uuid;

use async_trait::async_trait;

/// SQLX Postgres Transaction을 랩핑한 구체 구현체
pub struct PostgresTx {
    pub tx: Transaction<'static, Postgres>,
}

impl Tx for PostgresTx {
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }

    fn into_any(self: Box<Self>) -> Box<dyn Any> {
        self
    }
}

/// Postgres 어댑터
#[derive(Clone)]
pub struct PostgresAdapter {
    pool: PgPool,
}

impl PostgresAdapter {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

/// internal 헬퍼: Tx에서 sqlx Transaction을 안전하게 추출
fn get_tx_mut<'a>(tx: &'a mut dyn Tx) -> Result<&'a mut Transaction<'static, Postgres>> {
    let concrete = tx
        .as_any_mut()
        .downcast_mut::<PostgresTx>()
        .ok_or_else(|| anyhow::anyhow!("Failed to downcast Tx to PostgresTx"))?;
    Ok(&mut concrete.tx)
}

#[async_trait]
impl TransactionManagerPort for PostgresAdapter {
    async fn begin(&self) -> Result<Box<dyn Tx>> {
        let tx = self.pool.begin().await?;
        Ok(Box::new(PostgresTx { tx }))
    }

    async fn commit(&self, tx: Box<dyn Tx>) -> Result<()> {
        let concrete_tx = tx
            .into_any()
            .downcast::<PostgresTx>()
            .map_err(|_| anyhow::anyhow!("Failed to downcast Tx to PostgresTx"))?;
        concrete_tx.tx.commit().await?;
        Ok(())
    }

    async fn rollback(&self, tx: Box<dyn Tx>) -> Result<()> {
        let concrete_tx = tx
            .into_any()
            .downcast::<PostgresTx>()
            .map_err(|_| anyhow::anyhow!("Failed to downcast Tx to PostgresTx"))?;
        concrete_tx.tx.rollback().await?;
        Ok(())
    }
}

#[async_trait]
impl JobQueuePort for PostgresAdapter {
    async fn fetch_and_mark_running(&self, worker_id: &str) -> Result<Option<V2Job>> {
        let mut tx = self.pool.begin().await?;

        let row = sqlx::query(
            r#"
            select j.id, j.instance_id, j.token_id, j.type as "job_type", j.attempt, j.payload
            from v2_engine_jobs j
            join v2_process_instances i on i.id = j.instance_id
            where j.status = 'QUEUED'
              and j.run_at <= now()
              and coalesce(i.is_paused, false) = false
            order by j.id asc
            for update skip locked
            limit 1
            "#,
        )
        .fetch_optional(&mut *tx)
        .await?;

        let Some(r) = row else {
            tx.rollback().await?;
            return Ok(None);
        };

        let job_id: i64 = r.get("id");

        sqlx::query(
            r#"
            update v2_engine_jobs
            set status = 'RUNNING', lock_owner = $2, updated_at = now()
            where id = $1
            "#,
        )
        .bind(job_id)
        .bind(worker_id)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;

        Ok(Some(V2Job {
            id: job_id,
            instance_id: r.get("instance_id"),
            token_id: r.get("token_id"),
            job_type: JobType::from_str(&r.get::<String, _>("job_type")),
            attempt: r.get("attempt"),
            payload: r.get("payload"),
        }))
    }

    async fn mark_job_completed(&self, job_id: i64, tx: &mut dyn Tx) -> Result<()> {
        let sqlx_tx = get_tx_mut(tx)?;
        sqlx::query(
            r#"update v2_engine_jobs set status='COMPLETED', updated_at=now() where id=$1"#,
        )
        .bind(job_id)
        .execute(&mut **sqlx_tx)
        .await?;
        Ok(())
    }

    async fn mark_job_failed(&self, job_id: i64, tx: &mut dyn Tx) -> Result<()> {
        let sqlx_tx = get_tx_mut(tx)?;
        sqlx::query(r#"update v2_engine_jobs set status='FAILED', updated_at=now() where id=$1"#)
            .bind(job_id)
            .execute(&mut **sqlx_tx)
            .await?;
        Ok(())
    }

    async fn release_job(&self, job_id: i64, run_after_sec: f64, tx: &mut dyn Tx) -> Result<()> {
        let sqlx_tx = get_tx_mut(tx)?;
        sqlx::query(
            r#"
            update v2_engine_jobs
            set status = 'QUEUED',
                run_at = now() + ($2::double precision * interval '1 second'),
                lock_owner = null,
                updated_at = now()
            where id = $1 and status = 'RUNNING'
            "#,
        )
        .bind(job_id)
        .bind(run_after_sec)
        .execute(&mut **sqlx_tx)
        .await?;
        Ok(())
    }

    async fn enqueue_job(
        &self,
        instance_id: Uuid,
        token_id: Option<Uuid>,
        job_type: JobType,
        run_after_sec: f64,
        attempt: i32,
        payload: Value,
        tx: &mut dyn Tx,
    ) -> Result<()> {
        let sqlx_tx = get_tx_mut(tx)?;
        sqlx::query(
            r#"
            insert into v2_engine_jobs (instance_id, token_id, type, run_at, attempt, status, payload)
            values ($1, $2, $3, now() + ($4::double precision * interval '1 second'), $5, 'QUEUED', $6)
            "#
        )
        .bind(instance_id)
        .bind(token_id)
        .bind(job_type.as_str())
        .bind(run_after_sec)
        .bind(attempt)
        .bind(payload)
        .execute(&mut **sqlx_tx)
        .await?;
        Ok(())
    }

    async fn complete_queued_jobs_for_token(
        &self,
        instance_id: Uuid,
        token_id: Uuid,
        tx: &mut dyn Tx,
    ) -> Result<()> {
        let sqlx_tx = get_tx_mut(tx)?;
        sqlx::query(
            r#"
            update v2_engine_jobs
            set status = 'COMPLETED', updated_at = now()
            where instance_id = $1 and token_id = $2 and status = 'QUEUED'
            "#,
        )
        .bind(instance_id)
        .bind(token_id)
        .execute(&mut **sqlx_tx)
        .await?;
        Ok(())
    }

    async fn reclaim_stale_jobs(&self) -> Result<i64> {
        let stale_seconds = std::env::var("ENGINE_STALE_JOB_SECONDS")
            .ok()
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| *value > 0.0)
            .unwrap_or(60.0);
        let res = sqlx::query(
            r#"
            update v2_engine_jobs j
            set status = 'QUEUED',
                run_at = now(),
                updated_at = now()
            where j.status = 'RUNNING'
              and (
                exists (
                  select 1 from v2_process_instances i
                  where i.id = j.instance_id and i.lock_until < now()
                )
                or (
                  j.updated_at < now() - ($1::double precision * interval '1 second')
                  and not exists (
                    select 1 from v2_process_instances i
                    where i.id = j.instance_id and i.lock_until >= now()
                  )
                )
              )
            "#,
        )
        .bind(stale_seconds)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected() as i64)
    }
}

#[async_trait]
impl InstanceLockPort for PostgresAdapter {
    async fn try_advisory_lock(&self, instance_id: Uuid, tx: &mut dyn Tx) -> Result<bool> {
        let sqlx_tx = get_tx_mut(tx)?;
        let instance_key = instance_id.to_string();
        let r = sqlx::query(r#"select pg_try_advisory_xact_lock(hashtext($1)) as "locked""#)
            .bind(instance_key)
            .fetch_one(&mut **sqlx_tx)
            .await?;
        let locked: bool = r.get("locked");
        Ok(locked)
    }

    async fn advisory_unlock(&self, instance_id: Uuid) -> Result<()> {
        let _ = instance_id;
        Ok(())
    }

    async fn acquire_lease(
        &self,
        instance_id: Uuid,
        worker_id: &str,
        lease_seconds: f64,
        tx: &mut dyn Tx,
    ) -> Result<bool> {
        let sqlx_tx = get_tx_mut(tx)?;
        let r = sqlx::query(
            r#"
            update v2_process_instances
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
            "#,
        )
        .bind(instance_id)
        .bind(worker_id)
        .bind(lease_seconds)
        .execute(&mut **sqlx_tx)
        .await?;
        Ok(r.rows_affected() > 0)
    }

    async fn renew_lease(
        &self,
        instance_id: Uuid,
        worker_id: &str,
        lease_seconds: f64,
    ) -> Result<()> {
        sqlx::query(
            r#"
            update v2_process_instances
            set lock_until = now() + ($2::double precision * interval '1 second'),
                heartbeat_at = now(),
                updated_at = now()
            where id = $1 and lock_owner = $3
            "#,
        )
        .bind(instance_id)
        .bind(lease_seconds)
        .bind(worker_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn release_lease(&self, instance_id: Uuid, worker_id: &str) -> Result<()> {
        sqlx::query(
            r#"
            update v2_process_instances
            set lock_owner = null,
                lock_until = null,
                updated_at = now()
            where id = $1 and lock_owner = $2
            "#,
        )
        .bind(instance_id)
        .bind(worker_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

#[async_trait]
impl TokenRepositoryPort for PostgresAdapter {
    async fn load_tokens(&self, instance_id: Uuid, tx: &mut dyn Tx) -> Result<Vec<V2Token>> {
        let sqlx_tx = get_tx_mut(tx)?;
        let rows = sqlx::query(
            r#"
            select id, instance_id, node_id, status, parent_token_id, scope_key, created_at, updated_at
            from v2_tokens
            where instance_id = $1
            "#
        )
        .bind(instance_id)
        .fetch_all(&mut **sqlx_tx)
        .await?;

        let tokens = rows
            .into_iter()
            .map(|r| V2Token {
                id: r.get("id"),
                instance_id: r.get("instance_id"),
                node_id: r.get("node_id"),
                status: TokenStatus::from_str(&r.get::<String, _>("status")),
                parent_token_id: r.get("parent_token_id"),
                scope_key: r.get("scope_key"),
                created_at: r.get("created_at"),
                updated_at: r.get("updated_at"),
            })
            .collect();

        Ok(tokens)
    }

    async fn create_tokens(&self, tokens: &[V2Token], tx: &mut dyn Tx) -> Result<()> {
        let sqlx_tx = get_tx_mut(tx)?;
        for token in tokens {
            sqlx::query(
                r#"
                insert into v2_tokens (id, instance_id, node_id, status, parent_token_id, scope_key, created_at, updated_at)
                values ($1, $2, $3, $4, $5, $6, $7, $8)
                "#
            )
            .bind(token.id)
            .bind(token.instance_id)
            .bind(&token.node_id)
            .bind(token.status.as_str())
            .bind(token.parent_token_id)
            .bind(&token.scope_key)
            .bind(token.created_at)
            .bind(token.updated_at)
            .execute(&mut **sqlx_tx)
            .await?;
        }
        Ok(())
    }

    async fn update_tokens(&self, tokens: &[V2Token], tx: &mut dyn Tx) -> Result<()> {
        let sqlx_tx = get_tx_mut(tx)?;
        for token in tokens {
            sqlx::query(
                r#"
                update v2_tokens
                set node_id = $2, status = $3, parent_token_id = $4, scope_key = $5, updated_at = now()
                where id = $1
                "#
            )
            .bind(token.id)
            .bind(&token.node_id)
            .bind(token.status.as_str())
            .bind(token.parent_token_id)
            .bind(&token.scope_key)
            .execute(&mut **sqlx_tx)
            .await?;
        }
        Ok(())
    }
}

#[async_trait]
impl TaskRepositoryPort for PostgresAdapter {
    async fn find_or_create_approval(
        &self,
        request_id: Uuid,
        task_id: Uuid,
        instance_id: Uuid,
        token_id: Uuid,
        node_id: &str,
        definition: V2ApprovalDefinition,
        tx: &mut dyn Tx,
    ) -> Result<V2ApprovalBundle> {
        let sqlx_tx = get_tx_mut(tx)?;

        let request_row = sqlx::query(
            r#"
            insert into v2_approval_requests
              (id, instance_id, token_id, node_id, source, source_provider, external_request_id,
               external_revision, payload_hash,
               content_snapshot, approval_line_snapshot, total_steps,
               status, current_step_order, version, created_at, updated_at)
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                    $10, $11, $12,
                    'IN_PROGRESS', 1, 0, now(), now())
            on conflict do nothing
            returning id, instance_id, token_id, node_id, status, current_step_order
            "#,
        )
        .bind(request_id)
        .bind(instance_id)
        .bind(token_id)
        .bind(node_id)
        .bind(&definition.source)
        .bind(&definition.source_provider)
        .bind(&definition.external_request_id)
        .bind(definition.external_revision)
        .bind(&definition.payload_hash)
        .bind(&definition.content_snapshot)
        .bind(&definition.approval_line_snapshot)
        .bind(definition.steps.len() as i32)
        .fetch_optional(&mut **sqlx_tx)
        .await?;

        let request_row = if let Some(row) = request_row {
            row
        } else {
            let existing = sqlx::query(
                r#"
                select id, instance_id, token_id, node_id, status, current_step_order, payload_hash
                from v2_approval_requests
                where token_id = $1
                   or (source_provider = $2 and external_request_id = $3 and external_revision = $4)
                "#,
            )
            .bind(token_id)
            .bind(&definition.source_provider)
            .bind(&definition.external_request_id)
            .bind(definition.external_revision)
            .fetch_one(&mut **sqlx_tx)
            .await?;
            let existing_token_id: Uuid = existing.get("token_id");
            let existing_payload_hash: Option<String> = existing.get("payload_hash");
            if existing_token_id != token_id {
                anyhow::bail!(
                    "external approval request already belongs to instance {}; replay the original workflow start",
                    existing.get::<Uuid, _>("instance_id")
                );
            }
            if existing_payload_hash != definition.payload_hash {
                anyhow::bail!("approval request payload changed for an existing token");
            }
            existing
        };
        let persisted_request_id: Uuid = request_row.get("id");

        for step in &definition.steps {
            let first = &step.tasks[0];
            let task_specs = Value::Array(
                step.tasks
                    .iter()
                    .map(|task| {
                        serde_json::json!({
                            "assignee": task.assignee,
                            "approver_channel": task.approver_channel,
                            "approval_channels": task.approval_channels,
                            "payload": task.payload
                        })
                    })
                    .collect(),
            );
            sqlx::query(
                r#"
                insert into v2_approval_steps
                  (id, request_id, step_order, mode, required_count, assignee,
                   approver_channel, task_payload, task_specs, status, version, created_at, updated_at)
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                        case when $3 = 1 then 'OPEN' else 'LOCKED' end, 0, now(), now())
                on conflict (request_id, step_order) do nothing
                "#,
            )
            .bind(Uuid::new_v4())
            .bind(persisted_request_id)
            .bind(step.step_order)
            .bind(&step.mode)
            .bind(if step.mode == "ALL" { step.tasks.len() as i32 } else { 1 })
            .bind(&first.assignee)
            .bind(&first.approver_channel)
            .bind(&first.payload)
            .bind(task_specs)
            .execute(&mut **sqlx_tx)
            .await?;
        }
        let step_row = sqlx::query(
            "select id, task_specs from v2_approval_steps where request_id = $1 and step_order = 1",
        )
        .bind(persisted_request_id)
        .fetch_one(&mut **sqlx_tx)
        .await?;
        let persisted_step_id: Uuid = step_row.get("id");
        let task_specs: Value = step_row.get("task_specs");
        let mut tasks = Vec::new();
        for (index, spec) in task_specs.as_array().into_iter().flatten().enumerate() {
            let assignee = spec.get("assignee").and_then(Value::as_str).unwrap_or("admin");
            let payload = spec.get("payload").cloned().unwrap_or(Value::Null);
            let task_row = sqlx::query(
                r#"
                insert into v2_tasks
                  (id, instance_id, token_id, node_id, assignee, status, payload,
                   approval_request_id, approval_step_id, created_at, updated_at)
                values ($1, $2, $3, $4, $5, 'OPEN', $6, $7, $8, now(), now())
                on conflict (approval_step_id, assignee) where approval_step_id is not null
                do update set updated_at = v2_tasks.updated_at
                returning id, instance_id, token_id, node_id, assignee, status, payload
                "#,
            )
            .bind(if index == 0 { task_id } else { Uuid::new_v4() })
            .bind(instance_id)
            .bind(token_id)
            .bind(node_id)
            .bind(assignee)
            .bind(payload)
            .bind(persisted_request_id)
            .bind(persisted_step_id)
            .fetch_one(&mut **sqlx_tx)
            .await?;
            tasks.push(V2Task {
                id: task_row.get("id"),
                instance_id: task_row.get("instance_id"),
                token_id: task_row.get("token_id"),
                node_id: task_row.get("node_id"),
                assignee: task_row.get("assignee"),
                status: task_row.get("status"),
                payload: task_row.get("payload"),
            });
        }

        let request = V2ApprovalRequest {
            id: persisted_request_id,
            instance_id: request_row.get("instance_id"),
            token_id: request_row.get("token_id"),
            node_id: request_row.get("node_id"),
            status: request_row.get("status"),
            current_step_order: request_row.get("current_step_order"),
        };

        Ok(V2ApprovalBundle { request, tasks })
    }

    async fn find_approval_request_by_token(
        &self,
        token_id: Uuid,
        tx: &mut dyn Tx,
    ) -> Result<Option<V2ApprovalRequest>> {
        let sqlx_tx = get_tx_mut(tx)?;
        let row = sqlx::query(
            r#"
            select id, instance_id, token_id, node_id, status, current_step_order
            from v2_approval_requests
            where token_id = $1
            "#,
        )
        .bind(token_id)
        .fetch_optional(&mut **sqlx_tx)
        .await?;

        let Some(r) = row else {
            return Ok(None);
        };

        Ok(Some(V2ApprovalRequest {
            id: r.get("id"),
            instance_id: r.get("instance_id"),
            token_id: r.get("token_id"),
            node_id: r.get("node_id"),
            status: r.get("status"),
            current_step_order: r.get("current_step_order"),
        }))
    }
}

#[async_trait]
impl ExecutionLogPort for PostgresAdapter {
    async fn append_log(
        &self,
        instance_id: Uuid,
        token_id: Option<Uuid>,
        node_id: Option<&str>,
        event_type: &str,
        payload: Value,
        tx: &mut dyn Tx,
    ) -> Result<()> {
        let sqlx_tx = get_tx_mut(tx)?;
        sqlx::query(
            r#"
            insert into v2_execution_logs (instance_id, token_id, node_id, event_type, payload, created_at)
            values ($1, $2, $3, $4, $5, now())
            "#
        )
        .bind(instance_id)
        .bind(token_id)
        .bind(node_id)
        .bind(event_type)
        .bind(payload)
        .execute(&mut **sqlx_tx)
        .await?;
        Ok(())
    }
}

#[async_trait]
impl OutboxPort for PostgresAdapter {
    async fn append_event(
        &self,
        instance_id: Uuid,
        token_id: Option<Uuid>,
        node_id: Option<&str>,
        event_type: &str,
        payload: Value,
        tx: &mut dyn Tx,
    ) -> Result<()> {
        let sqlx_tx = get_tx_mut(tx)?;
        sqlx::query(
            r#"
            insert into v2_event_outbox (instance_id, token_id, node_id, event_type, payload, created_at)
            values ($1, $2, $3, $4, $5, now())
            "#
        )
        .bind(instance_id)
        .bind(token_id)
        .bind(node_id)
        .bind(event_type)
        .bind(payload)
        .execute(&mut **sqlx_tx)
        .await?;
        Ok(())
    }
}

#[async_trait]
impl ProcessDefinitionRepositoryPort for PostgresAdapter {
    async fn load_definition_graph(
        &self,
        definition_id: Uuid,
        version: Option<i32>,
    ) -> Result<(Vec<NodeDef>, Vec<EdgeRule>)> {
        if let Some(version) = version {
            let row = sqlx::query(
                r#"
                select nodes, edges
                from v2_process_definition_versions
                where definition_id = $1 and version = $2
                "#,
            )
            .bind(definition_id)
            .bind(version)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "Process definition version not found: {}:{}",
                    definition_id,
                    version
                )
            })?;
            let nodes_value: Value = row.get("nodes");
            let edges_value: Value = row.get("edges");
            let nodes = nodes_value
                .as_array()
                .into_iter()
                .flatten()
                .map(|node| NodeDef {
                    node_id: node
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    node_type: node
                        .pointer("/data/nodeType")
                        .and_then(Value::as_str)
                        .unwrap_or("task")
                        .to_string(),
                    config: node.get("data").cloned().unwrap_or(Value::Null),
                })
                .collect();
            let edges = edges_value
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
                .map(|(index, edge)| EdgeRule {
                    id: index as i64 + 1,
                    source_node_id: edge
                        .get("source")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    target_node_id: edge
                        .get("target")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    condition_expr: edge
                        .pointer("/data/condition")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    is_default: edge
                        .pointer("/data/isDefault")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    eval_order: index as i32,
                })
                .collect();
            return Ok((nodes, edges));
        }
        let nodes_raw = sqlx::query(
            r#"
            select node_id, node_type, config
            from v2_definition_nodes
            where definition_id = $1
            "#,
        )
        .bind(definition_id)
        .fetch_all(&self.pool)
        .await?;

        let edges_raw = sqlx::query(
            r#"
            select id, source_node_id, target_node_id, condition_expr, is_default, eval_order
            from v2_definition_edges
            where definition_id = $1
            order by eval_order asc
            "#,
        )
        .bind(definition_id)
        .fetch_all(&self.pool)
        .await?;

        let nodes = nodes_raw
            .into_iter()
            .map(|n| NodeDef {
                node_id: n.get("node_id"),
                node_type: n.get("node_type"),
                config: n.get("config"),
            })
            .collect();

        let edges = edges_raw
            .into_iter()
            .map(|e| EdgeRule {
                id: e.get("id"),
                source_node_id: e.get("source_node_id"),
                target_node_id: e.get("target_node_id"),
                condition_expr: e.get("condition_expr"),
                is_default: e.get("is_default"),
                eval_order: e.get("eval_order"),
            })
            .collect();

        Ok((nodes, edges))
    }

    async fn load_active_definition_graph(
        &self,
        definition_id: Uuid,
    ) -> Result<(Vec<NodeDef>, Vec<EdgeRule>, i32)> {
        let row = sqlx::query(
            "select version, metadata from v2_process_definitions where id = $1 and status <> 'DELETED'",
        )
        .bind(definition_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Process definition not found: {}", definition_id))?;
        let current_version: i32 = row.get("version");
        let metadata: Value = row.get("metadata");
        let lifecycle = metadata
            .get("lifecycle_status")
            .and_then(Value::as_str)
            .unwrap_or("PUBLISHED");
        if lifecycle != "PUBLISHED" {
            anyhow::bail!(
                "Workflow is not published or is disabled: {}",
                definition_id
            );
        }
        let version = metadata
            .get("active_published_version")
            .and_then(Value::as_i64)
            .and_then(|value| i32::try_from(value).ok())
            .unwrap_or(current_version);
        let (nodes, edges) = self
            .load_definition_graph(definition_id, Some(version))
            .await?;
        Ok((nodes, edges, version))
    }
}

#[async_trait]
impl WorkflowInstanceRepositoryPort for PostgresAdapter {
    async fn load_instance(
        &self,
        instance_id: Uuid,
        tx: &mut dyn Tx,
    ) -> Result<Option<V2Instance>> {
        let sqlx_tx = get_tx_mut(tx)?;
        let row = sqlx::query(
            r#"
            select id, process_definition_id, state, is_paused, context
            from v2_process_instances
            where id = $1
            "#,
        )
        .bind(instance_id)
        .fetch_optional(&mut **sqlx_tx)
        .await?;

        let Some(r) = row else {
            return Ok(None);
        };

        Ok(Some(V2Instance {
            id: r.get("id"),
            process_definition_id: r.get("process_definition_id"),
            state: r.get("state"),
            is_paused: r.get("is_paused"),
            context: r.get("context"),
        }))
    }

    async fn update_instance(
        &self,
        instance_id: Uuid,
        state: &str,
        context: Value,
        tx: &mut dyn Tx,
    ) -> Result<()> {
        let sqlx_tx = get_tx_mut(tx)?;
        sqlx::query(
            r#"
            update v2_process_instances
            set state = $2, context = $3, updated_at = now()
            where id = $1
            "#,
        )
        .bind(instance_id)
        .bind(state)
        .bind(context)
        .execute(&mut **sqlx_tx)
        .await?;
        Ok(())
    }

    async fn create_instance(
        &self,
        instance_id: Uuid,
        definition_id: Uuid,
        state: &str,
        context: Value,
        tx: &mut dyn Tx,
    ) -> Result<()> {
        let sqlx_tx = get_tx_mut(tx)?;
        sqlx::query(
            r#"
            insert into v2_process_instances (id, process_definition_id, state, context, started_at, created_at, updated_at)
            values ($1, $2, $3, $4, now(), now(), now())
            "#,
        )
        .bind(instance_id)
        .bind(definition_id)
        .bind(state)
        .bind(context)
        .execute(&mut **sqlx_tx)
        .await?;
        Ok(())
    }
}
