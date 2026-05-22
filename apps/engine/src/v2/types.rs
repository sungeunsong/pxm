use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatewayType {
    Exclusive,
    Parallel,
    Inclusive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenStatus {
    Active,
    Waiting,
    Completed,
    Consumed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobType {
    Start,
    Resume,
    Retry,
    Timer,
    Reminder,
    Escalation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobStatus {
    Queued,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone)]
pub struct V2Job {
    pub id: i64,
    pub instance_id: Uuid,
    pub token_id: Option<Uuid>,
    pub job_type: JobType,
    pub attempt: i32,
    pub payload: Value,
}

#[derive(Debug, Clone)]
pub struct EdgeRule {
    pub id: i64,
    pub source_node_id: String,
    pub target_node_id: String,
    pub condition_expr: Option<String>,
    pub is_default: bool,
    pub eval_order: i32,
}

#[derive(Debug, Clone)]
pub struct NodeDef {
    pub node_id: String,
    pub node_type: String,
    pub config: Value,
}
