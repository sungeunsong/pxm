use crate::v2::ports::{
    ExecutionLogPort, InstanceLockPort, JobQueuePort, OutboxPort, ProcessDefinitionRepositoryPort,
    TaskRepositoryPort, TokenRepositoryPort, TransactionManagerPort, Tx,
    WorkflowInstanceRepositoryPort,
};
use crate::v2::types::{
    EdgeRule, JobType, NodeDef, TokenStatus, V2Instance, V2Job, V2Task, V2Token,
};
use anyhow::Result;
use chrono::{DateTime, Utc};
use mongodb::bson::{doc, Bson, Document};
use mongodb::error::UNKNOWN_TRANSACTION_COMMIT_RESULT;
use mongodb::{Client, ClientSession, Database};
use serde_json::Value;
use std::any::Any;
use uuid::Uuid;

use async_trait::async_trait;

/// MongoDB ClientSession을 랩핑한 구체 구현체
pub struct MongoTx {
    pub session: Option<ClientSession>,
    pub is_replica_set: bool,
}

impl Tx for MongoTx {
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }

    fn into_any(self: Box<Self>) -> Box<dyn Any> {
        self
    }
}

/// MongoDB 어댑터
#[derive(Clone)]
pub struct MongoAdapter {
    client: Client,
    db: Database,
    is_replica_set: bool,
}

impl MongoAdapter {
    pub fn new(client: Client, db_name: &str, is_replica_set: bool) -> Self {
        let db = client.database(db_name);
        Self {
            client,
            db,
            is_replica_set,
        }
    }
}

/// internal 헬퍼: Tx에서 MongoDB ClientSession을 안전하게 추출 (Replica Set인 경우에만 Some 반환)
fn get_session_mut<'a>(tx: &'a mut dyn Tx) -> Result<Option<&'a mut ClientSession>> {
    let concrete = tx
        .as_any_mut()
        .downcast_mut::<MongoTx>()
        .ok_or_else(|| anyhow::anyhow!("Failed to downcast Tx to MongoTx"))?;
    if concrete.is_replica_set {
        Ok(concrete.session.as_mut())
    } else {
        Ok(None)
    }
}

/// 몽고DB 순차 sequence 번호 생성기 (잡 ID 등 발급용)
async fn get_next_sequence(
    db: &Database,
    counter_name: &str,
    session: Option<&mut ClientSession>,
) -> Result<i64> {
    let coll = db.collection::<Document>("v2_counters");
    let filter = doc! { "_id": counter_name };
    let update = doc! { "$inc": { "seq": 1 } };
    let options = mongodb::options::FindOneAndUpdateOptions::builder()
        .upsert(true)
        .return_document(mongodb::options::ReturnDocument::After)
        .build();

    let res = if let Some(sess) = session {
        coll.find_one_and_update_with_session(filter, update, options, sess)
            .await?
    } else {
        coll.find_one_and_update(filter, update, options).await?
    };

    if let Some(doc) = res {
        if let Some(seq) = doc.get("seq").and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_i32().map(|i| i as i64))
                .or_else(|| v.as_f64().map(|f| f as i64))
        }) {
            return Ok(seq);
        }
    }
    anyhow::bail!("Failed to get sequence counter")
}

// =========================================================================
// 수동 매핑 헬퍼 함수군
// =========================================================================

fn json_to_bson(v: &Value) -> Bson {
    mongodb::bson::to_bson(v).unwrap_or(Bson::Null)
}

fn bson_to_json(b: &Bson) -> Value {
    mongodb::bson::from_bson(b.clone()).unwrap_or(Value::Null)
}

fn bson_i32(value: &Bson) -> Option<i32> {
    value
        .as_i32()
        .or_else(|| value.as_i64().and_then(|number| i32::try_from(number).ok()))
        .or_else(|| value.as_f64().map(|number| number as i32))
}

fn bson_i64(value: &Bson) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_i32().map(i64::from))
        .or_else(|| value.as_f64().map(|number| number as i64))
}

fn token_to_doc(t: &V2Token) -> Document {
    doc! {
        "_id": t.id.to_string(),
        "instance_id": t.instance_id.to_string(),
        "node_id": &t.node_id,
        "status": t.status.as_str(),
        "parent_token_id": t.parent_token_id.map(|id| id.to_string()),
        "scope_key": &t.scope_key,
        "created_at": t.created_at.to_rfc3339(),
        "updated_at": t.updated_at.to_rfc3339()
    }
}

fn doc_to_token(doc: &Document) -> Result<V2Token> {
    let id_str = doc.get_str("_id")?;
    let inst_str = doc.get_str("instance_id")?;
    let node_id = doc.get_str("node_id")?.to_string();
    let status_str = doc.get_str("status")?;
    let parent_str = doc.get("parent_token_id").and_then(|v| v.as_str());
    let scope_key = doc
        .get("scope_key")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let created_str = doc.get_str("created_at")?;
    let updated_str = doc.get_str("updated_at")?;

    Ok(V2Token {
        id: Uuid::parse_str(id_str)?,
        instance_id: Uuid::parse_str(inst_str)?,
        node_id,
        status: TokenStatus::from_str(status_str),
        parent_token_id: parent_str.and_then(|s| Uuid::parse_str(s).ok()),
        scope_key,
        created_at: DateTime::parse_from_rfc3339(created_str)?.with_timezone(&Utc),
        updated_at: DateTime::parse_from_rfc3339(updated_str)?.with_timezone(&Utc),
    })
}

fn doc_to_job(doc: &Document) -> Result<V2Job> {
    let id = doc
        .get("_id")
        .and_then(bson_i64)
        .ok_or_else(|| anyhow::anyhow!("_id missing or not a number"))?;

    let inst_str = doc.get_str("instance_id")?;
    let token_str = doc.get("token_id").and_then(|v| v.as_str());
    let job_type_str = doc.get_str("job_type")?;

    let attempt = doc
        .get("attempt")
        .and_then(|v| {
            v.as_i32()
                .or_else(|| v.as_i64().map(|i| i as i32))
                .or_else(|| v.as_f64().map(|f| f as i32))
        })
        .unwrap_or(0);

    let payload_bson = doc.get("payload").unwrap_or(&Bson::Null);

    Ok(V2Job {
        id,
        instance_id: Uuid::parse_str(inst_str)?,
        token_id: token_str.and_then(|s| Uuid::parse_str(s).ok()),
        job_type: JobType::from_str(job_type_str),
        attempt,
        payload: bson_to_json(payload_bson),
    })
}

fn doc_to_task(doc: &Document) -> Result<V2Task> {
    let id = Uuid::parse_str(doc.get_str("_id")?)?;
    let instance_id = Uuid::parse_str(doc.get_str("instance_id")?)?;
    let token_id = Uuid::parse_str(doc.get_str("token_id")?)?;
    let node_id = doc.get_str("node_id")?.to_string();
    let assignee = doc.get_str("assignee")?.to_string();
    let status = doc.get_str("status")?.to_string();
    let payload_bson = doc.get("payload").unwrap_or(&Bson::Null);

    Ok(V2Task {
        id,
        instance_id,
        token_id,
        node_id,
        assignee,
        status,
        payload: bson_to_json(payload_bson),
    })
}

// =========================================================================
// Ports 구현
// =========================================================================

#[async_trait]
impl TransactionManagerPort for MongoAdapter {
    async fn begin(&self) -> Result<Box<dyn Tx>> {
        let session = if self.is_replica_set {
            let mut sess = self.client.start_session(None).await?;
            sess.start_transaction(None).await?;
            Some(sess)
        } else {
            None
        };
        Ok(Box::new(MongoTx {
            session,
            is_replica_set: self.is_replica_set,
        }))
    }

    async fn commit(&self, tx: Box<dyn Tx>) -> Result<()> {
        let mut concrete_tx = tx
            .into_any()
            .downcast::<MongoTx>()
            .map_err(|_| anyhow::anyhow!("Failed to downcast Tx to MongoTx"))?;
        if concrete_tx.is_replica_set {
            if let Some(ref mut sess) = concrete_tx.session {
                let mut commit_attempts = 0;
                loop {
                    match sess.commit_transaction().await {
                        Ok(()) => break,
                        Err(err)
                            if err.contains_label(UNKNOWN_TRANSACTION_COMMIT_RESULT)
                                && commit_attempts < 3 =>
                        {
                            commit_attempts += 1;
                            tokio::time::sleep(std::time::Duration::from_millis(
                                50 * commit_attempts,
                            ))
                            .await;
                        }
                        Err(err) => return Err(err.into()),
                    }
                }
            }
        }
        Ok(())
    }

    async fn rollback(&self, tx: Box<dyn Tx>) -> Result<()> {
        let mut concrete_tx = tx
            .into_any()
            .downcast::<MongoTx>()
            .map_err(|_| anyhow::anyhow!("Failed to downcast Tx to MongoTx"))?;
        if concrete_tx.is_replica_set {
            if let Some(ref mut sess) = concrete_tx.session {
                sess.abort_transaction().await?;
            }
        }
        Ok(())
    }
}

#[async_trait]
impl JobQueuePort for MongoAdapter {
    async fn fetch_and_mark_running(&self, worker_id: &str) -> Result<Option<V2Job>> {
        let coll = self.db.collection::<Document>("v2_engine_jobs");
        let now = Utc::now().to_rfc3339();

        let filter = doc! {
            "status": "QUEUED",
            "run_at": { "$lte": &now }
        };

        let update = doc! {
            "$set": {
                "status": "RUNNING",
                "lock_owner": worker_id,
                "updated_at": &now
            }
        };

        let options = mongodb::options::FindOneAndUpdateOptions::builder()
            .sort(doc! { "_id": 1 })
            .return_document(mongodb::options::ReturnDocument::After)
            .build();

        let res = coll.find_one_and_update(filter, update, options).await?;

        if let Some(doc) = res {
            Ok(Some(doc_to_job(&doc)?))
        } else {
            Ok(None)
        }
    }

    async fn mark_job_completed(&self, job_id: i64, tx: &mut dyn Tx) -> Result<()> {
        let session = get_session_mut(tx)?;
        let coll = self.db.collection::<Document>("v2_engine_jobs");
        let now = Utc::now().to_rfc3339();
        let filter = doc! { "_id": job_id };
        let update = doc! { "$set": { "status": "COMPLETED", "updated_at": &now } };
        if let Some(sess) = session {
            coll.update_one_with_session(filter, update, None, sess)
                .await?;
        } else {
            coll.update_one(filter, update, None).await?;
        }
        Ok(())
    }

    async fn mark_job_failed(&self, job_id: i64, tx: &mut dyn Tx) -> Result<()> {
        let session = get_session_mut(tx)?;
        let coll = self.db.collection::<Document>("v2_engine_jobs");
        let now = Utc::now().to_rfc3339();
        let filter = doc! { "_id": job_id };
        let update = doc! { "$set": { "status": "FAILED", "updated_at": &now } };
        if let Some(sess) = session {
            coll.update_one_with_session(filter, update, None, sess)
                .await?;
        } else {
            coll.update_one(filter, update, None).await?;
        }
        Ok(())
    }

    async fn release_job(&self, job_id: i64, run_after_sec: f64, tx: &mut dyn Tx) -> Result<()> {
        let session = get_session_mut(tx)?;
        let coll = self.db.collection::<Document>("v2_engine_jobs");
        let run_at = Utc::now() + chrono::Duration::milliseconds((run_after_sec * 1000.0) as i64);
        let now = Utc::now().to_rfc3339();
        let filter = doc! { "_id": job_id, "status": "RUNNING" };
        let update = doc! {
            "$set": {
                "status": "QUEUED",
                "run_at": run_at.to_rfc3339(),
                "lock_owner": Bson::Null,
                "updated_at": &now
            }
        };
        if let Some(sess) = session {
            coll.update_one_with_session(filter, update, None, sess)
                .await?;
        } else {
            coll.update_one(filter, update, None).await?;
        }
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
        let mut session = get_session_mut(tx)?;
        let next_id = get_next_sequence(
            &self.db,
            "v2_engine_jobs",
            session.as_mut().map(|s| &mut **s),
        )
        .await?;

        let run_at = Utc::now() + chrono::Duration::milliseconds((run_after_sec * 1000.0) as i64);
        let now = Utc::now().to_rfc3339();

        let coll = self.db.collection::<Document>("v2_engine_jobs");
        let new_job = doc! {
            "_id": next_id,
            "instance_id": instance_id.to_string(),
            "token_id": token_id.map(|id| id.to_string()),
            "job_type": job_type.as_str(),
            "run_at": run_at.to_rfc3339(),
            "attempt": attempt,
            "status": "QUEUED",
            "payload": json_to_bson(&payload),
            "created_at": &now,
            "updated_at": &now
        };

        if let Some(sess) = session {
            coll.insert_one_with_session(new_job, None, sess).await?;
        } else {
            coll.insert_one(new_job, None).await?;
        }
        Ok(())
    }

    async fn complete_queued_jobs_for_token(
        &self,
        instance_id: Uuid,
        token_id: Uuid,
        tx: &mut dyn Tx,
    ) -> Result<()> {
        let session = get_session_mut(tx)?;
        let coll = self.db.collection::<Document>("v2_engine_jobs");
        let now = Utc::now().to_rfc3339();
        let filter = doc! {
            "instance_id": instance_id.to_string(),
            "token_id": token_id.to_string(),
            "status": "QUEUED",
        };
        let update = doc! { "$set": { "status": "COMPLETED", "updated_at": &now } };
        if let Some(sess) = session {
            coll.update_many_with_session(filter, update, None, sess)
                .await?;
        } else {
            coll.update_many(filter, update, None).await?;
        }
        Ok(())
    }

    async fn reclaim_stale_jobs(&self) -> Result<i64> {
        let jobs_coll = self.db.collection::<Document>("v2_engine_jobs");
        let _instances_coll = self.db.collection::<Document>("v2_process_instances");
        let now_dt = Utc::now();
        let now = now_dt.to_rfc3339();
        let stale_seconds = std::env::var("ENGINE_STALE_JOB_SECONDS")
            .ok()
            .and_then(|value| value.parse::<i64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(60);
        let stale_before = (now_dt - chrono::Duration::seconds(stale_seconds)).to_rfc3339();

        // MongoDB에서 lookup을 활용해 Stale Job 일괄 회수
        // 1) 고사 상태인(lock_until 이 현재 이전이거나 null인) 인스턴스 목록을 lookup
        let pipeline = vec![
            doc! {
                "$match": { "status": "RUNNING" }
            },
            doc! {
                "$lookup": {
                    "from": "v2_process_instances",
                    "localField": "instance_id",
                    "foreignField": "_id",
                    "as": "inst"
                }
            },
            doc! {
                "$unwind": { "path": "$inst", "preserveNullAndEmptyArrays": true }
            },
            doc! {
                "$match": {
                    "$or": [
                        { "inst.lock_until": { "$lt": &now } },
                        {
                            "$and": [
                                { "updated_at": { "$lt": &stale_before } },
                                {
                                    "$or": [
                                        { "inst": { "$exists": false } },
                                        { "inst.lock_until": null }
                                    ]
                                }
                            ]
                        }
                    ]
                }
            },
        ];

        let mut cursor = jobs_coll.aggregate(pipeline, None).await?;
        let mut stale_ids = Vec::new();
        while cursor.advance().await? {
            let doc = cursor.deserialize_current()?;
            if let Some(id) = doc.get("_id").and_then(bson_i64) {
                stale_ids.push(id);
            }
        }

        if stale_ids.is_empty() {
            return Ok(0);
        }

        let update_res = jobs_coll
            .update_many(
                doc! { "_id": { "$in": &stale_ids } },
                doc! { "$set": { "status": "QUEUED", "run_at": &now, "updated_at": &now } },
                None,
            )
            .await?;

        Ok(update_res.modified_count as i64)
    }
}

#[async_trait]
impl InstanceLockPort for MongoAdapter {
    async fn try_advisory_lock(&self, instance_id: Uuid, tx: &mut dyn Tx) -> Result<bool> {
        let mut session = get_session_mut(tx)?;
        let coll = self.db.collection::<Document>("v2_advisory_locks");

        let now_dt = Utc::now();
        let now = now_dt.to_rfc3339();
        let stale_before = (now_dt - chrono::Duration::seconds(60)).to_rfc3339();
        if let Some(ref mut sess) = session {
            coll.delete_one_with_session(
                doc! { "_id": instance_id.to_string(), "created_at": { "$lt": stale_before } },
                None,
                &mut **sess,
            )
            .await?;
        } else {
            coll.delete_one(
                doc! { "_id": instance_id.to_string(), "created_at": { "$lt": stale_before } },
                None,
            )
            .await?;
        }

        let new_lock = doc! {
            "_id": instance_id.to_string(),
            "created_at": now
        };

        let insert_res = if let Some(sess) = session {
            coll.insert_one_with_session(new_lock, None, sess).await
        } else {
            coll.insert_one(new_lock, None).await
        };

        // MongoDB의 Unique Constraint (_id)를 활용한 advisory lock 흉내
        match insert_res {
            Ok(_) => Ok(true),
            Err(e) => {
                // Duplicate Key Error 시 획득 실패 처리
                if e.to_string().contains("duplicate key") {
                    Ok(false)
                } else {
                    Err(e.into())
                }
            }
        }
    }

    async fn advisory_unlock(&self, instance_id: Uuid) -> Result<()> {
        let coll = self.db.collection::<Document>("v2_advisory_locks");
        coll.delete_one(doc! { "_id": instance_id.to_string() }, None)
            .await?;
        Ok(())
    }

    async fn acquire_lease(
        &self,
        instance_id: Uuid,
        worker_id: &str,
        lease_seconds: f64,
        tx: &mut dyn Tx,
    ) -> Result<bool> {
        let session = get_session_mut(tx)?;
        let coll = self.db.collection::<Document>("v2_process_instances");
        let now = Utc::now();
        let lease_until = now + chrono::Duration::milliseconds((lease_seconds * 1000.0) as i64);

        let filter = doc! {
            "_id": instance_id.to_string(),
            "$or": [
                { "lock_until": null },
                { "lock_until": { "$lt": now.to_rfc3339() } },
                { "lock_owner": worker_id }
            ]
        };

        let update = doc! {
            "$set": {
                "lock_owner": worker_id,
                "lock_until": lease_until.to_rfc3339(),
                "heartbeat_at": now.to_rfc3339(),
                "updated_at": now.to_rfc3339()
            }
        };

        let modified = if let Some(sess) = session {
            let res = coll
                .update_one_with_session(filter, update, None, sess)
                .await?;
            res.modified_count > 0
        } else {
            let res = coll.update_one(filter, update, None).await?;
            res.modified_count > 0
        };
        Ok(modified)
    }

    async fn renew_lease(
        &self,
        instance_id: Uuid,
        worker_id: &str,
        lease_seconds: f64,
    ) -> Result<()> {
        let coll = self.db.collection::<Document>("v2_process_instances");
        let now = Utc::now();
        let lease_until = now + chrono::Duration::milliseconds((lease_seconds * 1000.0) as i64);

        coll.update_one(
            doc! { "_id": instance_id.to_string(), "lock_owner": worker_id },
            doc! { "$set": { "lock_until": lease_until.to_rfc3339(), "heartbeat_at": now.to_rfc3339(), "updated_at": now.to_rfc3339() } },
            None
        ).await?;
        Ok(())
    }

    async fn release_lease(&self, instance_id: Uuid, worker_id: &str) -> Result<()> {
        let coll = self.db.collection::<Document>("v2_process_instances");
        let now = Utc::now().to_rfc3339();

        coll.update_one(
            doc! { "_id": instance_id.to_string(), "lock_owner": worker_id },
            doc! { "$set": { "lock_owner": Bson::Null, "lock_until": Bson::Null, "updated_at": &now } },
            None
        ).await?;
        Ok(())
    }
}

#[async_trait]
impl TokenRepositoryPort for MongoAdapter {
    async fn load_tokens(&self, instance_id: Uuid, tx: &mut dyn Tx) -> Result<Vec<V2Token>> {
        let session = get_session_mut(tx)?;
        let coll = self.db.collection::<Document>("v2_tokens");
        let filter = doc! { "instance_id": instance_id.to_string() };

        let mut tokens = Vec::new();
        if let Some(sess) = session {
            let mut cursor = coll.find_with_session(filter, None, sess).await?;
            while cursor.advance(sess).await? {
                let doc = cursor.deserialize_current()?;
                tokens.push(doc_to_token(&doc)?);
            }
        } else {
            let mut cursor = coll.find(filter, None).await?;
            while cursor.advance().await? {
                let doc = cursor.deserialize_current()?;
                tokens.push(doc_to_token(&doc)?);
            }
        }

        Ok(tokens)
    }

    async fn create_tokens(&self, tokens: &[V2Token], tx: &mut dyn Tx) -> Result<()> {
        if tokens.is_empty() {
            return Ok(());
        }
        let session = get_session_mut(tx)?;
        let coll = self.db.collection::<Document>("v2_tokens");
        let docs: Vec<Document> = tokens.iter().map(token_to_doc).collect();
        if let Some(sess) = session {
            coll.insert_many_with_session(docs, None, sess).await?;
        } else {
            coll.insert_many(docs, None).await?;
        }
        Ok(())
    }

    async fn update_tokens(&self, tokens: &[V2Token], tx: &mut dyn Tx) -> Result<()> {
        let mut session = get_session_mut(tx)?;
        let coll = self.db.collection::<Document>("v2_tokens");

        for token in tokens {
            let now = Utc::now().to_rfc3339();
            let filter = doc! { "_id": token.id.to_string() };
            let update = doc! {
                "$set": {
                    "node_id": &token.node_id,
                    "status": token.status.as_str(),
                    "parent_token_id": token.parent_token_id.map(|id| id.to_string()),
                    "scope_key": &token.scope_key,
                    "updated_at": &now
                }
            };
            if let Some(ref mut sess) = session {
                coll.update_one_with_session(filter, update, None, sess)
                    .await?;
            } else {
                coll.update_one(filter, update, None).await?;
            }
        }
        Ok(())
    }
}

#[async_trait]
impl TaskRepositoryPort for MongoAdapter {
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
        let mut session = get_session_mut(tx)?;
        let coll = self.db.collection::<Document>("v2_tasks");
        let now = Utc::now().to_rfc3339();

        let filter = doc! { "token_id": token_id.to_string() };
        let update = doc! {
            "$setOnInsert": {
                "_id": task_id.to_string(),
                "instance_id": instance_id.to_string(),
                "token_id": token_id.to_string(),
                "node_id": node_id,
                "assignee": assignee,
                "status": "OPEN",
                "payload": json_to_bson(&payload),
                "created_at": &now,
                "updated_at": &now
            }
        };
        let options = mongodb::options::FindOneAndUpdateOptions::builder()
            .upsert(true)
            .return_document(mongodb::options::ReturnDocument::After)
            .build();

        let doc = if let Some(ref mut sess) = session {
            coll.find_one_and_update_with_session(filter, update, options, sess)
                .await?
        } else {
            coll.find_one_and_update(filter, update, options).await?
        }
        .ok_or_else(|| anyhow::anyhow!("failed to create or load task for token {}", token_id))?;

        doc_to_task(&doc)
    }

    async fn find_task_by_token(&self, token_id: Uuid, tx: &mut dyn Tx) -> Result<Option<V2Task>> {
        let session = get_session_mut(tx)?;
        let coll = self.db.collection::<Document>("v2_tasks");

        let filter = doc! { "token_id": token_id.to_string() };
        let res = if let Some(sess) = session {
            coll.find_one_with_session(filter, None, sess).await?
        } else {
            coll.find_one(filter, None).await?
        };

        res.map(|doc| doc_to_task(&doc)).transpose()
    }
}

#[async_trait]
impl ExecutionLogPort for MongoAdapter {
    async fn append_log(
        &self,
        instance_id: Uuid,
        token_id: Option<Uuid>,
        node_id: Option<&str>,
        event_type: &str,
        payload: Value,
        tx: &mut dyn Tx,
    ) -> Result<()> {
        let session = get_session_mut(tx)?;
        let coll = self.db.collection::<Document>("v2_execution_logs");
        let now = Utc::now().to_rfc3339();

        let new_log = doc! {
            "instance_id": instance_id.to_string(),
            "token_id": token_id.map(|id| id.to_string()),
            "node_id": node_id,
            "event_type": event_type,
            "payload": json_to_bson(&payload),
            "created_at": &now
        };

        if let Some(sess) = session {
            coll.insert_one_with_session(new_log, None, sess).await?;
        } else {
            coll.insert_one(new_log, None).await?;
        }
        Ok(())
    }
}

#[async_trait]
impl OutboxPort for MongoAdapter {
    async fn append_event(
        &self,
        instance_id: Uuid,
        token_id: Option<Uuid>,
        node_id: Option<&str>,
        event_type: &str,
        payload: Value,
        tx: &mut dyn Tx,
    ) -> Result<()> {
        let session = get_session_mut(tx)?;
        let coll = self.db.collection::<Document>("v2_event_outbox");
        let now = Utc::now().to_rfc3339();

        let new_event = doc! {
            "instance_id": instance_id.to_string(),
            "token_id": token_id.map(|id| id.to_string()),
            "node_id": node_id,
            "event_type": event_type,
            "payload": json_to_bson(&payload),
            "created_at": &now
        };

        if let Some(sess) = session {
            coll.insert_one_with_session(new_event, None, sess).await?;
        } else {
            coll.insert_one(new_event, None).await?;
        }
        Ok(())
    }
}

#[async_trait]
impl ProcessDefinitionRepositoryPort for MongoAdapter {
    async fn load_definition_graph(
        &self,
        definition_id: Uuid,
        version: Option<i32>,
    ) -> Result<(Vec<NodeDef>, Vec<EdgeRule>)> {
        let doc_opt = if let Some(version) = version {
            self.db
                .collection::<Document>("v2_process_definition_versions")
                .find_one(
                    doc! { "definition_id": definition_id.to_string(), "version": version },
                    None,
                )
                .await?
        } else {
            self.db
                .collection::<Document>("v2_process_definitions")
                .find_one(doc! { "_id": definition_id.to_string() }, None)
                .await?
        };
        let Some(doc) = doc_opt else {
            anyhow::bail!("Process definition not found: {}", definition_id);
        };

        let mut nodes = Vec::new();
        if let Some(nodes_arr) = doc.get_array("nodes").ok() {
            for node_val in nodes_arr {
                if let Some(node_doc) = node_val.as_document() {
                    let node_id = node_doc.get_str("node_id")?.to_string();
                    let node_type = node_doc.get_str("node_type")?.to_string();
                    let config_bson = node_doc.get("config").unwrap_or(&Bson::Null);
                    nodes.push(NodeDef {
                        node_id,
                        node_type,
                        config: bson_to_json(config_bson),
                    });
                }
            }
        }

        let mut edges = Vec::new();
        if let Some(edges_arr) = doc.get_array("edges").ok() {
            for edge_val in edges_arr {
                if let Some(edge_doc) = edge_val.as_document() {
                    let id_bson = edge_doc
                        .get("id")
                        .ok_or_else(|| anyhow::anyhow!("edge id missing"))?;
                    let id = if let Some(s) = id_bson.as_str() {
                        if let Some(num_str) = s.split('_').last() {
                            if let Ok(num) = num_str.parse::<i64>() {
                                num
                            } else {
                                let mut hash: i64 = 5381;
                                for c in s.bytes() {
                                    hash = ((hash << 5).wrapping_add(hash)).wrapping_add(c as i64);
                                }
                                hash
                            }
                        } else {
                            0
                        }
                    } else {
                        id_bson
                            .as_i64()
                            .or_else(|| id_bson.as_i32().map(|i| i as i64))
                            .or_else(|| id_bson.as_f64().map(|f| f as i64))
                            .ok_or_else(|| anyhow::anyhow!("edge id is not a number or string"))?
                    };

                    let source_node_id = edge_doc.get_str("source_node_id")?.to_string();
                    let target_node_id = edge_doc.get_str("target_node_id")?.to_string();
                    let condition_expr = edge_doc
                        .get("condition_expr")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let is_default = edge_doc.get_bool("is_default")?;

                    let eval_order = edge_doc
                        .get("eval_order")
                        .and_then(|v| {
                            v.as_i32()
                                .or_else(|| v.as_i64().map(|i| i as i32))
                                .or_else(|| v.as_f64().map(|f| f as i32))
                        })
                        .unwrap_or(0);

                    edges.push(EdgeRule {
                        id,
                        source_node_id,
                        target_node_id,
                        condition_expr,
                        is_default,
                        eval_order,
                    });
                }
            }
        }

        Ok((nodes, edges))
    }

    async fn load_active_definition_graph(
        &self,
        definition_id: Uuid,
    ) -> Result<(Vec<NodeDef>, Vec<EdgeRule>, i32)> {
        let current = self
            .db
            .collection::<Document>("v2_process_definitions")
            .find_one(doc! { "_id": definition_id.to_string() }, None)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Process definition not found: {}", definition_id))?;
        let lifecycle = current
            .get_str("lifecycle_status")
            .or_else(|_| {
                current
                    .get_document("metadata")?
                    .get_str("lifecycle_status")
            })
            .unwrap_or("PUBLISHED");
        if lifecycle != "PUBLISHED" {
            anyhow::bail!(
                "Workflow is not published or is disabled: {}",
                definition_id
            );
        }
        let version = current
            .get("active_published_version")
            .and_then(bson_i32)
            .or_else(|| {
                current
                    .get_document("metadata")
                    .ok()?
                    .get("active_published_version")
                    .and_then(bson_i32)
            })
            .or_else(|| current.get("version").and_then(bson_i32))
            .ok_or_else(|| anyhow::anyhow!("Published workflow version is missing: {}", definition_id))?;
        let (nodes, edges) = self
            .load_definition_graph(definition_id, Some(version))
            .await?;
        Ok((nodes, edges, version))
    }
}

#[async_trait]
impl WorkflowInstanceRepositoryPort for MongoAdapter {
    async fn load_instance(
        &self,
        instance_id: Uuid,
        tx: &mut dyn Tx,
    ) -> Result<Option<V2Instance>> {
        let session = get_session_mut(tx)?;
        let coll = self.db.collection::<Document>("v2_process_instances");
        let filter = doc! { "_id": instance_id.to_string() };

        let res = if let Some(sess) = session {
            coll.find_one_with_session(filter, None, sess).await?
        } else {
            coll.find_one(filter, None).await?
        };

        if let Some(doc) = res {
            let id = Uuid::parse_str(doc.get_str("_id")?)?;
            let def_id = Uuid::parse_str(doc.get_str("process_definition_id")?)?;
            let state = doc.get_str("state")?.to_string();
            let context_bson = doc.get("context").unwrap_or(&Bson::Null);

            Ok(Some(V2Instance {
                id,
                process_definition_id: def_id,
                state,
                context: bson_to_json(context_bson),
            }))
        } else {
            Ok(None)
        }
    }

    async fn update_instance(
        &self,
        instance_id: Uuid,
        state: &str,
        context: Value,
        tx: &mut dyn Tx,
    ) -> Result<()> {
        let session = get_session_mut(tx)?;
        let coll = self.db.collection::<Document>("v2_process_instances");
        let now = Utc::now().to_rfc3339();
        let filter = doc! { "_id": instance_id.to_string() };
        let update = doc! { "$set": { "state": state, "context": json_to_bson(&context), "updated_at": &now } };

        if let Some(sess) = session {
            coll.update_one_with_session(filter, update, None, sess)
                .await?;
        } else {
            coll.update_one(filter, update, None).await?;
        }
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
        let session = get_session_mut(tx)?;
        let coll = self.db.collection::<Document>("v2_process_instances");
        let now = Utc::now().to_rfc3339();
        let doc = doc! {
            "_id": instance_id.to_string(),
            "process_definition_id": definition_id.to_string(),
            "state": state,
            "status": state,
            "context": json_to_bson(&context),
            "lock_owner": Bson::Null,
            "lock_until": Bson::Null,
            "heartbeat_at": Bson::Null,
            "created_at": &now,
            "updated_at": &now,
        };

        if let Some(sess) = session {
            coll.insert_one_with_session(doc, None, sess).await?;
        } else {
            coll.insert_one(doc, None).await?;
        }
        Ok(())
    }
}
