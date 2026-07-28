use chrono::{DateTime, Utc};
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

impl TokenStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Active => "ACTIVE",
            Self::Waiting => "WAITING",
            Self::Completed => "COMPLETED",
            Self::Consumed => "CONSUMED",
            Self::Failed => "FAILED",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "ACTIVE" => Self::Active,
            "WAITING" => Self::Waiting,
            "COMPLETED" => Self::Completed,
            "CONSUMED" => Self::Consumed,
            "FAILED" => Self::Failed,
            _ => Self::Active,
        }
    }
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

impl JobType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Start => "START",
            Self::Resume => "RESUME",
            Self::Retry => "RETRY",
            Self::Timer => "TIMER",
            Self::Reminder => "REMINDER",
            Self::Escalation => "ESCALATION",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "START" => Self::Start,
            "RESUME" => Self::Resume,
            "RETRY" => Self::Retry,
            "TIMER" => Self::Timer,
            "REMINDER" => Self::Reminder,
            "ESCALATION" => Self::Escalation,
            _ => Self::Start,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobStatus {
    Queued,
    Running,
    Completed,
    Failed,
}

impl JobStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "QUEUED",
            Self::Running => "RUNNING",
            Self::Completed => "COMPLETED",
            Self::Failed => "FAILED",
        }
    }
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
pub struct V2Token {
    pub id: Uuid,
    pub instance_id: Uuid,
    pub node_id: String,
    pub status: TokenStatus,
    pub parent_token_id: Option<Uuid>,
    pub scope_key: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
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

#[derive(Debug, Clone)]
pub struct V2Instance {
    pub id: Uuid,
    pub process_definition_id: Uuid,
    pub state: String,
    pub is_paused: bool,
    pub context: Value,
}

#[derive(Debug, Clone)]
pub struct V2Task {
    pub id: Uuid,
    pub instance_id: Uuid,
    pub token_id: Uuid,
    pub node_id: String,
    pub assignee: String,
    pub status: String,
    pub payload: Value,
}

#[derive(Debug, Clone)]
pub struct V2ApprovalRequest {
    pub id: Uuid,
    pub instance_id: Uuid,
    pub token_id: Uuid,
    pub node_id: String,
    pub status: String,
    pub current_step_order: i32,
}

#[derive(Debug, Clone)]
pub struct V2ApprovalTaskInput {
    pub assignee: String,
    pub approver_channel: String,
    pub payload: Value,
}

#[derive(Debug, Clone)]
pub struct V2ApprovalStepInput {
    pub step_order: i32,
    pub mode: String,
    pub tasks: Vec<V2ApprovalTaskInput>,
}

#[derive(Debug, Clone)]
pub struct V2ApprovalDefinition {
    pub source: Value,
    pub external_request_id: Option<String>,
    pub content_snapshot: Value,
    pub approval_line_snapshot: Value,
    pub steps: Vec<V2ApprovalStepInput>,
}

#[derive(Debug, Clone)]
pub struct V2ApprovalBundle {
    pub request: V2ApprovalRequest,
    pub tasks: Vec<V2Task>,
}
