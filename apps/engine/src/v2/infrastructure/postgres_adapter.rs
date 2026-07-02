use crate::v2::ports::{
    ExecutionLogPort, InstanceLockPort, JobQueuePort, OutboxPort, ProcessDefinitionRepositoryPort,
    TaskRepositoryPort, TokenRepositoryPort, TransactionManagerPort, Tx,
    WorkflowInstanceRepositoryPort,
};
use crate::v2::types::{
    EdgeRule, JobType, NodeDef, TokenStatus, V2Instance, V2Job, V2Task, V2Token,
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
            select id, instance_id, token_id, type as "job_type", attempt, payload
            from v2_engine_jobs
            where status = 'QUEUED' and run_at <= now()
            order by id asc
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
        let res = sqlx::query(
            r#"
            update v2_engine_jobs j
            set status = 'QUEUED',
                run_at = now(),
                updated_at = now()
            from v2_process_instances i
            where j.instance_id = i.id
              and j.status = 'RUNNING'
              and (i.lock_until is null or i.lock_until < now())
            "#,
        )
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
    async fn find_or_create_task(
        &self,
        task_id: Uuid,
        instance_id: Uuid,
        token_id: Uuid,
        node_id: &str,
        assignee: &str,
        payload: Value,
        tx: &mut dyn Tx,
    ) -> Result<V2Task> {
        let sqlx_tx = get_tx_mut(tx)?;
        let row = sqlx::query(
            r#"
            insert into v2_tasks (id, instance_id, token_id, node_id, assignee, status, payload, created_at, updated_at)
            values ($1, $2, $3, $4, $5, 'OPEN', $6, now(), now())
            on conflict (token_id) where token_id is not null do nothing
            returning id, instance_id, token_id, node_id, assignee, status, payload
            "#
        )
        .bind(task_id)
        .bind(instance_id)
        .bind(token_id)
        .bind(node_id)
        .bind(assignee)
        .bind(payload)
        .fetch_optional(&mut **sqlx_tx)
        .await?;

        let row = if let Some(row) = row {
            row
        } else {
            sqlx::query(
                r#"
                select id, instance_id, token_id, node_id, assignee, status, payload
                from v2_tasks
                where token_id = $1
                "#,
            )
            .bind(token_id)
            .fetch_one(&mut **sqlx_tx)
            .await?
        };

        Ok(V2Task {
            id: row.get("id"),
            instance_id: row.get("instance_id"),
            token_id: row.get("token_id"),
            node_id: row.get("node_id"),
            assignee: row.get("assignee"),
            status: row.get("status"),
            payload: row.get("payload"),
        })
    }

    async fn find_task_by_token(&self, token_id: Uuid, tx: &mut dyn Tx) -> Result<Option<V2Task>> {
        let sqlx_tx = get_tx_mut(tx)?;
        let row = sqlx::query(
            r#"
            select id, instance_id, token_id, node_id, assignee, status, payload
            from v2_tasks
            where token_id = $1
            "#,
        )
        .bind(token_id)
        .fetch_optional(&mut **sqlx_tx)
        .await?;

        let Some(r) = row else {
            return Ok(None);
        };

        Ok(Some(V2Task {
            id: r.get("id"),
            instance_id: r.get("instance_id"),
            token_id: r.get("token_id"),
            node_id: r.get("node_id"),
            assignee: r.get("assignee"),
            status: r.get("status"),
            payload: r.get("payload"),
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
    ) -> Result<(Vec<NodeDef>, Vec<EdgeRule>)> {
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
            select id, process_definition_id, state, context
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
