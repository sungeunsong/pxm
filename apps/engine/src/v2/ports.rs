use crate::v2::types::{EdgeRule, JobType, NodeDef, V2Instance, V2Job, V2Task, V2Token};
use anyhow::Result;
use serde_json::Value;
use std::any::Any;
use uuid::Uuid;

use async_trait::async_trait;

/// 데이터베이스 트랜잭션 세션을 추상화하는 Opaque 트레이트
pub trait Tx: Send + Sync {
    fn as_any_mut(&mut self) -> &mut dyn Any;
    fn into_any(self: Box<Self>) -> Box<dyn Any>;
}

/// 트랜잭션 수명 주기를 관리하는 포트
#[async_trait]
pub trait TransactionManagerPort: Send + Sync {
    /// 새로운 트랜잭션을 시작합니다.
    async fn begin(&self) -> Result<Box<dyn Tx>>;

    /// 트랜잭션을 커밋합니다.
    async fn commit(&self, tx: Box<dyn Tx>) -> Result<()>;

    /// 트랜잭션을 롤백합니다.
    async fn rollback(&self, tx: Box<dyn Tx>) -> Result<()>;
}

/// 엔진 잡 큐 처리를 위한 포트
#[async_trait]
pub trait JobQueuePort: Send + Sync {
    /// 대기 중인(READY) 잡 하나를 가져와 RUNNING으로 변경하고 반환합니다.
    async fn fetch_and_mark_running(&self, worker_id: &str) -> Result<Option<V2Job>>;

    /// 잡을 완료(COMPLETED) 처리합니다.
    async fn mark_job_completed(&self, job_id: i64, tx: &mut dyn Tx) -> Result<()>;

    /// 잡을 실패(FAILED) 처리합니다.
    async fn mark_job_failed(&self, job_id: i64, tx: &mut dyn Tx) -> Result<()>;

    /// 선점했지만 현재 인스턴스 락을 얻지 못한 잡을 다시 대기열로 되돌립니다.
    async fn release_job(&self, job_id: i64, run_after_sec: f64, tx: &mut dyn Tx) -> Result<()>;

    /// 재시도 또는 타이머 등의 새로운 잡을 스케줄링하여 삽입합니다.
    async fn enqueue_job(
        &self,
        instance_id: Uuid,
        token_id: Option<Uuid>,
        job_type: JobType,
        run_after_sec: f64,
        attempt: i32,
        payload: Value,
        tx: &mut dyn Tx,
    ) -> Result<()>;

    /// 고사(Stale) 상태에 빠진 RUNNING 잡을 다시 READY 상태로 회수합니다.
    async fn reclaim_stale_jobs(&self) -> Result<i64>;
}

/// 분산 인스턴스 락 및 임대를 관리하는 포트
#[async_trait]
pub trait InstanceLockPort: Send + Sync {
    /// 인스턴스에 대한 Advisory Lock을 획득하려고 시도합니다.
    async fn try_advisory_lock(&self, instance_id: Uuid, tx: &mut dyn Tx) -> Result<bool>;

    /// 인스턴스에 대한 Advisory Lock을 해제합니다. Transaction-scoped lock 구현에서는 no-op일 수 있습니다.
    async fn advisory_unlock(&self, instance_id: Uuid) -> Result<()>;

    /// 인스턴스에 대한 Lease Lock을 획득하거나 갱신을 시도합니다.
    async fn acquire_lease(
        &self,
        instance_id: Uuid,
        worker_id: &str,
        lease_seconds: f64,
        tx: &mut dyn Tx,
    ) -> Result<bool>;

    /// 임대 시간(Lease)을 연장(Heartbeat)합니다.
    async fn renew_lease(
        &self,
        instance_id: Uuid,
        worker_id: &str,
        lease_seconds: f64,
    ) -> Result<()>;

    /// 임대를 해제하여 다른 워커가 처리할 수 있도록 반납합니다.
    async fn release_lease(&self, instance_id: Uuid, worker_id: &str) -> Result<()>;
}

/// Explicit Token의 영속성 및 상태 전이를 처리하는 포트
#[async_trait]
pub trait TokenRepositoryPort: Send + Sync {
    /// 프로세스 인스턴스에 속한 모든 토큰 리스트를 로드합니다.
    async fn load_tokens(&self, instance_id: Uuid, tx: &mut dyn Tx) -> Result<Vec<V2Token>>;

    /// 신규 토큰들을 삽입합니다.
    async fn create_tokens(&self, tokens: &[V2Token], tx: &mut dyn Tx) -> Result<()>;

    /// 기존 토큰들의 상태(Status)와 노드 ID를 갱신합니다.
    async fn update_tokens(&self, tokens: &[V2Token], tx: &mut dyn Tx) -> Result<()>;
}

/// 승인 태스크의 영속성을 처리하는 포트
#[async_trait]
pub trait TaskRepositoryPort: Send + Sync {
    /// token_id 기준으로 승인 태스크를 재사용하거나 생성합니다.
    async fn find_or_create_task(
        &self,
        task_id: Uuid,
        instance_id: Uuid,
        token_id: Uuid,
        node_id: &str,
        assignee: &str,
        payload: Value,
        tx: &mut dyn Tx,
    ) -> Result<V2Task>;

    /// 특정 토큰에 연결된 승인 태스크를 조회합니다.
    async fn find_task_by_token(&self, token_id: Uuid, tx: &mut dyn Tx) -> Result<Option<V2Task>>;
}

/// 엔진 상세 실행 로그 적재를 위한 포트
#[async_trait]
pub trait ExecutionLogPort: Send + Sync {
    /// 인스턴스 실행 과정의 단계를 기록합니다.
    async fn append_log(
        &self,
        instance_id: Uuid,
        token_id: Option<Uuid>,
        node_id: Option<&str>,
        event_type: &str,
        payload: Value,
        tx: &mut dyn Tx,
    ) -> Result<()>;
}

/// 외부 통신용 아웃박스 이벤트 적재를 위한 포트
#[async_trait]
pub trait OutboxPort: Send + Sync {
    /// 트랜잭션 아웃박스 패턴을 위한 이벤트를 적재합니다.
    async fn append_event(
        &self,
        instance_id: Uuid,
        token_id: Option<Uuid>,
        node_id: Option<&str>,
        event_type: &str,
        payload: Value,
        tx: &mut dyn Tx,
    ) -> Result<()>;
}

/// 프로세스 정의 데이터(노드, 엣지 분기 규칙)를 로드하기 위한 포트
#[async_trait]
pub trait ProcessDefinitionRepositoryPort: Send + Sync {
    /// 정의 ID에 속한 모든 노드와 엣지 규칙을 조회합니다.
    async fn load_definition_graph(
        &self,
        definition_id: Uuid,
    ) -> Result<(Vec<NodeDef>, Vec<EdgeRule>)>;
}

/// 프로세스 인스턴스 영속성을 처리하는 포트
#[async_trait]
pub trait WorkflowInstanceRepositoryPort: Send + Sync {
    /// 인스턴스 정보 (process_definition_id, state, context)를 로드합니다.
    async fn load_instance(&self, instance_id: Uuid, tx: &mut dyn Tx)
        -> Result<Option<V2Instance>>;

    /// 인스턴스의 상태(state), 컨텍스트(context) 등을 업데이트합니다.
    async fn update_instance(
        &self,
        instance_id: Uuid,
        state: &str,
        context: Value,
        tx: &mut dyn Tx,
    ) -> Result<()>;
}

#[derive(Debug, Clone)]
pub struct PluginInvocation {
    pub plugin_id: String,
    pub instance_id: Uuid,
    pub token_id: Uuid,
    pub node_id: String,
    pub config: Value,
    pub context: Value,
    pub attempt: i32,
}

#[derive(Debug, Clone)]
pub struct PluginExecutionResult {
    pub status_code: u16,
    pub output: Value,
}

/// SERVICE 노드의 실제 외부 연동 실행을 엔진 코어에서 분리하기 위한 포트
#[async_trait]
pub trait PluginExecutorPort: Send + Sync {
    async fn execute(&self, invocation: PluginInvocation) -> Result<PluginExecutionResult>;
}
