use anyhow::Result;
use chrono::Utc;
use mongodb::error::{TRANSIENT_TRANSACTION_ERROR, UNKNOWN_TRANSACTION_COMMIT_RESULT};
use rand::Rng;
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};
use uuid::Uuid;

use crate::v2::ports::{
    ExecutionLogPort, InstanceLockPort, JobQueuePort, OutboxPort, PluginExecutorPort,
    PluginInvocation, ProcessDefinitionRepositoryPort, TaskRepositoryPort, TokenRepositoryPort,
    TransactionManagerPort, Tx, WorkflowInstanceRepositoryPort,
};
use crate::v2::types::{
    EdgeRule, GatewayType, JobType, NodeDef, TokenStatus, V2Instance, V2Job, V2Token,
};

pub struct V2RuntimeContext {
    pub tx_manager: Box<dyn TransactionManagerPort>,
    pub job_queue: Box<dyn JobQueuePort>,
    pub instance_lock: Box<dyn InstanceLockPort>,
    pub token_repo: Box<dyn TokenRepositoryPort>,
    pub task_repo: Box<dyn TaskRepositoryPort>,
    pub exec_log: Box<dyn ExecutionLogPort>,
    pub outbox: Box<dyn OutboxPort>,
    pub def_repo: Box<dyn ProcessDefinitionRepositoryPort>,
    pub instance_repo: Box<dyn WorkflowInstanceRepositoryPort>,
    pub plugin_executor: Box<dyn PluginExecutorPort>,
}

// ============================================================
// V2 RetryPolicy
// ============================================================
#[derive(Debug, Clone)]
pub struct V2RetryPolicy {
    pub max_attempts: i32,
    pub initial_delay_ms: u64,
    pub max_delay_ms: u64,
    pub multiplier: f64,
    pub jitter_factor: f64,
}

impl Default for V2RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 5,
            initial_delay_ms: 1000,
            max_delay_ms: 60_000,
            multiplier: 2.0,
            jitter_factor: 0.1,
        }
    }
}

impl V2RetryPolicy {
    pub fn from_env() -> Self {
        let max_attempts = std::env::var("RETRY_MAX_ATTEMPTS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(5);
        let initial_delay_ms = std::env::var("RETRY_INITIAL_DELAY_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(1000);
        let max_delay_ms = std::env::var("RETRY_MAX_DELAY_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(60_000);
        let multiplier = std::env::var("RETRY_MULTIPLIER")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(2.0);
        let jitter_factor = std::env::var("RETRY_JITTER_FACTOR")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.1);

        Self {
            max_attempts,
            initial_delay_ms,
            max_delay_ms,
            multiplier,
            jitter_factor,
        }
    }

    pub fn calculate_backoff(&self, attempt: i32) -> u64 {
        let base = self.initial_delay_ms as f64 * self.multiplier.powi(attempt);
        let capped = base.min(self.max_delay_ms as f64);
        let jitter_range = capped * self.jitter_factor;
        let jitter: f64 = rand::thread_rng().gen_range(-jitter_range..=jitter_range);
        ((capped + jitter).max(100.0)) as u64
    }

    pub fn from_node_config(config: &Value) -> Self {
        let mut policy = Self::from_env();

        if let Some(max_attempts) = config
            .get("retryCount")
            .or_else(|| config.get("retry_count"))
            .or_else(|| {
                config
                    .get("retry_policy")
                    .and_then(|retry| retry.get("max_attempts"))
            })
            .or_else(|| {
                config
                    .get("retryPolicy")
                    .and_then(|retry| retry.get("max_attempts"))
            })
            .and_then(|value| value.as_i64())
        {
            policy.max_attempts = max_attempts.max(0) as i32;
        }

        if let Some(backoff_ms) = config
            .get("retryDelay")
            .or_else(|| config.get("retry_delay_ms"))
            .or_else(|| {
                config
                    .get("retry_policy")
                    .and_then(|retry| retry.get("backoff_ms"))
            })
            .or_else(|| {
                config
                    .get("retryPolicy")
                    .and_then(|retry| retry.get("backoff_ms"))
            })
            .and_then(|value| value.as_u64())
        {
            policy.initial_delay_ms = backoff_ms;
        }

        if matches!(
            config.get("enableRetry").and_then(|value| value.as_bool()),
            Some(false)
        ) {
            policy.max_attempts = 0;
        }

        policy
    }
}

// ============================================================
// 식 해석기 (Expression Evaluator)
// ============================================================
fn evaluate_condition(condition: &str, context: &Value) -> bool {
    let form_data = get_form_data(context);
    if let Some(data) = form_data {
        if let Some((field, rest)) = condition.split_once("==") {
            let field = field.trim();
            let expected = rest.trim().trim_matches('"').trim_matches('\'');
            if let Some(actual) = data.get(field).and_then(|v| v.as_str()) {
                return actual == expected;
            }
        } else if let Some((field, rest)) = condition.split_once(">") {
            let field = field.trim();
            let threshold: f64 = rest.trim().parse().unwrap_or(0.0);
            if let Some(actual) = data.get(field).and_then(|v| v.as_f64()) {
                return actual > threshold;
            }
        } else if let Some((field, rest)) = condition.split_once("<") {
            let field = field.trim();
            let threshold: f64 = rest.trim().parse().unwrap_or(0.0);
            if let Some(actual) = data.get(field).and_then(|v| v.as_f64()) {
                return actual < threshold;
            }
        }
    }
    false
}

fn get_form_data(context: &Value) -> Option<&Value> {
    context
        .get("data")
        .and_then(|data| data.get("formData"))
        .or_else(|| context.get("formData"))
}

fn execute_js_node(node: &NodeDef, context: &Value) -> Result<Value> {
    let code = node
        .config
        .get("code")
        .or_else(|| node.config.get("script"))
        .or_else(|| node.config.get("jsCode"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let timeout_ms = node
        .config
        .get("scriptTimeoutMs")
        .or_else(|| node.config.get("timeoutMs"))
        .or_else(|| node.config.get("timeout"))
        .and_then(|v| v.as_u64())
        .unwrap_or(1000)
        .clamp(50, 5000);

    let runner = r#"
const vm = require('node:vm');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(raw || '{}');
    const sandbox = vm.createContext({
      input: payload.context || {},
      context: payload.context || {},
    }, {
      codeGeneration: { strings: false, wasm: false },
    });
    const wrapped = `(function(input, context) {
      "use strict";
      ${String(payload.code || '')}
    })(input, context)`;
    const script = new vm.Script(wrapped, { filename: 'pxm-js-node.vm' });
    const output = script.runInContext(sandbox, {
      timeout: Number(payload.timeout_ms) || 1000,
      displayErrors: true,
    });
    process.stdout.write(JSON.stringify({ success: true, output: output === undefined ? null : output }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      success: false,
      error: {
        name: error && error.name,
        message: error && error.message ? error.message : String(error),
      },
    }));
    process.exitCode = 1;
  }
});
"#;

    let payload = json!({
        "code": code,
        "context": external_execution_context(context),
        "timeout_ms": timeout_ms,
    });

    let mut child = Command::new("node")
        .arg("-e")
        .arg(runner)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin.write_all(payload.to_string().as_bytes())?;
    }

    let output = child.wait_with_output()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let response: Value = serde_json::from_str(stdout.trim()).unwrap_or_else(|_| {
        json!({
            "success": false,
            "error": {
                "message": format!(
                    "JS node returned invalid response. status={:?}, stderr={}",
                    output.status.code(),
                    String::from_utf8_lossy(&output.stderr)
                )
            }
        })
    });

    if response
        .get("success")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        Ok(response.get("output").cloned().unwrap_or(Value::Null))
    } else {
        let message = response
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(|value| value.as_str())
            .unwrap_or("JS node execution failed");
        anyhow::bail!(message.to_string())
    }
}

fn set_context_value_at_path(context: &mut Value, output_path: &str, value: Value) {
    let raw_path = output_path
        .trim()
        .strip_prefix("context.")
        .unwrap_or(output_path.trim());
    let path = normalize_context_write_path(raw_path);

    if path.is_empty() {
        *context = value;
        return;
    }

    if !context.is_object() {
        *context = json!({});
    }

    let parts: Vec<&str> = path.split('.').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() {
        *context = value;
        return;
    }

    let mut current = context;
    for part in &parts[..parts.len() - 1] {
        if !current.is_object() {
            *current = json!({});
        }
        current = current
            .as_object_mut()
            .expect("context object")
            .entry((*part).to_string())
            .or_insert_with(|| json!({}));
    }

    if !current.is_object() {
        *current = json!({});
    }
    current
        .as_object_mut()
        .expect("context object")
        .insert(parts[parts.len() - 1].to_string(), value);
}

fn get_context_value_at_path(context: &Value, input_path: &str) -> Option<Value> {
    let raw_path = input_path
        .trim()
        .strip_prefix("context.")
        .unwrap_or(input_path.trim());

    if raw_path.is_empty() {
        return Some(context.clone());
    }

    for path in candidate_context_read_paths(raw_path) {
        if let Some(value) = get_context_value_at_exact_path(context, &path) {
            return Some(value);
        }
    }

    None
}

fn get_context_value_at_exact_path(context: &Value, path: &str) -> Option<Value> {
    let mut current = context;
    for part in path.split('.').filter(|part| !part.is_empty()) {
        current = current.get(part)?;
    }
    Some(current.clone())
}

fn normalize_context_write_path(path: &str) -> String {
    if path.is_empty()
        || path == "result"
        || path == "result_path"
        || path.starts_with("data.")
        || path.starts_with("runtime.")
    {
        return path.to_string();
    }

    if path == "formData" || path.starts_with("formData.") {
        return format!("data.{path}");
    }

    format!("data.outputs.{path}")
}

fn candidate_context_read_paths(path: &str) -> Vec<String> {
    let mut paths = vec![path.to_string()];

    if path == "formData" || path.starts_with("formData.") {
        paths.push(format!("data.{path}"));
    } else if !(path.starts_with("data.")
        || path.starts_with("runtime.")
        || path == "result"
        || path == "result_path")
    {
        paths.push(format!("data.outputs.{path}"));
    }

    paths
}

fn external_result_default(context: &Value) -> Value {
    context.get("data").cloned().unwrap_or_else(|| {
        json!({
            "formData": context.get("formData").cloned().unwrap_or_else(|| json!({})),
            "outputs": context.get("outputs").cloned().unwrap_or_else(|| json!({}))
        })
    })
}

fn external_execution_context(context: &Value) -> Value {
    let mut external = context.clone();

    if let (Some(target), Some(data)) = (external.as_object_mut(), context.get("data")) {
        if let Some(data_obj) = data.as_object() {
            for (key, value) in data_obj {
                target.entry(key.clone()).or_insert_with(|| value.clone());
            }
        }
    }

    external
}

fn resolve_workflow_call_target(node: &NodeDef) -> Result<Uuid> {
    let raw = node
        .config
        .get("targetWorkflowId")
        .or_else(|| node.config.get("target_definition_id"))
        .or_else(|| node.config.get("targetDefinitionId"))
        .or_else(|| node.config.get("workflow_id"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Workflow Call target workflow is not configured"))?;

    Ok(Uuid::parse_str(raw)?)
}

fn resolve_workflow_call_input(node: &NodeDef, context: &Value) -> Result<Value> {
    let mode = node
        .config
        .get("workflowInputMode")
        .or_else(|| node.config.get("inputMode"))
        .and_then(|value| value.as_str())
        .unwrap_or("inherit_form_data");

    match mode {
        "context_path" => {
            let path = node
                .config
                .get("workflowInputPath")
                .or_else(|| node.config.get("inputPath"))
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow::anyhow!("Workflow Call input path is required"))?;
            Ok(get_context_value_at_path(context, path).unwrap_or(Value::Null))
        }
        "static_json" => {
            if let Some(value) = node.config.get("workflowInput") {
                return Ok(value.clone());
            }

            let raw = node
                .config
                .get("workflowInputJson")
                .or_else(|| node.config.get("inputJson"))
                .and_then(|value| value.as_str())
                .unwrap_or("{}")
                .trim();
            Ok(serde_json::from_str(raw)?)
        }
        _ => Ok(get_form_data(context)
            .cloned()
            .unwrap_or_else(|| json!({}))),
    }
}

fn workflow_call_output_path(node: &NodeDef) -> String {
    node.config
        .get("outputPath")
        .or_else(|| node.config.get("output_path"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("workflowCalls.{}", node.node_id))
}

fn workflow_call_depth(context: &Value) -> i64 {
    context
        .get("runtime")
        .and_then(|runtime| runtime.get("call_depth"))
        .and_then(|value| value.as_i64())
        .unwrap_or(0)
}

fn max_workflow_call_depth() -> i64 {
    std::env::var("WORKFLOW_CALL_MAX_DEPTH")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(8)
        .max(1)
}

fn gateway_type(node: &NodeDef) -> GatewayType {
    let raw = node
        .config
        .get("gatewayType")
        .or_else(|| node.config.get("gateway_type"))
        .and_then(|v| v.as_str())
        .unwrap_or("exclusive")
        .to_ascii_lowercase();

    match raw.as_str() {
        "parallel" | "and" => GatewayType::Parallel,
        "inclusive" | "or" => GatewayType::Inclusive,
        _ => GatewayType::Exclusive,
    }
}

fn select_gateway_edges<'a>(
    gateway_type: GatewayType,
    outgoing_edges: &'a [&'a EdgeRule],
    context: &Value,
) -> Vec<&'a EdgeRule> {
    match gateway_type {
        GatewayType::Parallel => outgoing_edges.to_vec(),
        GatewayType::Exclusive => {
            let mut default_edge = None;
            for edge in outgoing_edges {
                if edge.is_default {
                    default_edge = Some(*edge);
                } else if edge
                    .condition_expr
                    .as_deref()
                    .map(|expr| evaluate_condition(expr, context))
                    .unwrap_or(false)
                {
                    return vec![*edge];
                }
            }
            default_edge.into_iter().collect()
        }
        GatewayType::Inclusive => {
            let mut matched = Vec::new();
            let mut default_edge = None;
            let mut has_condition = false;

            for edge in outgoing_edges {
                if edge.is_default {
                    default_edge = Some(*edge);
                } else if let Some(expr) = edge.condition_expr.as_deref() {
                    has_condition = true;
                    if evaluate_condition(expr, context) {
                        matched.push(*edge);
                    }
                } else if !has_condition {
                    matched.push(*edge);
                }
            }

            if matched.is_empty() {
                if let Some(edge) = default_edge {
                    matched.push(edge);
                }
            }
            matched
        }
    }
}

fn fork_scope(parent_token: &V2Token, selected_count: usize) -> Option<String> {
    if selected_count > 1 {
        Some(format!("fork:{}:count:{}", parent_token.id, selected_count))
    } else {
        parent_token.scope_key.clone()
    }
}

fn expected_join_count(scope_key: Option<&str>, fallback: usize) -> usize {
    scope_key
        .and_then(|scope| scope.rsplit_once(":count:"))
        .and_then(|(_, count)| count.parse::<usize>().ok())
        .unwrap_or(fallback)
        .max(1)
}

fn resolve_approval_assignment(node: &NodeDef, context: &Value) -> (String, Value) {
    let approval_line = node.config.get("approvalLine").unwrap_or(&Value::Null);
    let model = approval_line
        .get("mode")
        .or_else(|| approval_line.get("type"))
        .or_else(|| node.config.get("approvalLineType"))
        .or_else(|| node.config.get("approvalType"))
        .and_then(|v| v.as_str())
        .unwrap_or("fixed")
        .to_ascii_lowercase();

    match model.as_str() {
        "condition" | "condition_based" | "conditional" => {
            let rules = approval_line
                .get("rules")
                .or_else(|| node.config.get("approvalRules"))
                .and_then(|v| v.as_array());
            if let Some(rules) = rules {
                for rule in rules {
                    let condition = rule.get("condition").and_then(|v| v.as_str());
                    let assignee = rule.get("assignee").and_then(|v| v.as_str());
                    if let (Some(condition), Some(assignee)) = (condition, assignee) {
                        if evaluate_condition(condition, context) {
                            return (
                                assignee.to_string(),
                                json!({
                                    "approval_model": "condition",
                                    "matched_condition": condition,
                                    "assignee": assignee
                                }),
                            );
                        }
                    }
                }
            }

            let assignee = approval_line
                .get("defaultAssignee")
                .or_else(|| approval_line.get("default_assignee"))
                .or_else(|| node.config.get("assignee"))
                .and_then(|v| v.as_str())
                .unwrap_or("admin");
            (
                assignee.to_string(),
                json!({"approval_model": "condition", "matched_condition": null, "assignee": assignee}),
            )
        }
        "requester_selected" | "requester-selected" | "requester" => {
            let candidate_field = approval_line
                .get("candidateField")
                .or_else(|| approval_line.get("candidate_field"))
                .or_else(|| node.config.get("requesterSelectedField"))
                .and_then(|v| v.as_str())
                .unwrap_or("approver");
            let selected = get_form_data(context)
                .and_then(|v| v.get(candidate_field))
                .and_then(|v| v.as_str());
            let candidates: Vec<String> = approval_line
                .get("candidates")
                .or_else(|| node.config.get("approvalCandidates"))
                .and_then(|v| v.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(ToString::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let default_assignee = approval_line
                .get("defaultAssignee")
                .or_else(|| approval_line.get("default_assignee"))
                .or_else(|| node.config.get("assignee"))
                .and_then(|v| v.as_str())
                .unwrap_or("admin");
            let assignee = selected
                .filter(|value| {
                    candidates.is_empty() || candidates.iter().any(|item| item == value)
                })
                .unwrap_or(default_assignee);

            (
                assignee.to_string(),
                json!({
                    "approval_model": "requester_selected",
                    "candidate_field": candidate_field,
                    "candidates": candidates,
                    "assignee": assignee
                }),
            )
        }
        _ => {
            let assignee = approval_line
                .get("assignee")
                .or_else(|| node.config.get("assignee"))
                .and_then(|v| v.as_str())
                .unwrap_or("admin");
            (
                assignee.to_string(),
                json!({"approval_model": "fixed", "assignee": assignee}),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve_approval_assignment, V2RetryPolicy};
    use crate::v2::types::NodeDef;
    use serde_json::json;

    #[test]
    fn resolves_fixed_approval_assignee() {
        let node = NodeDef {
            node_id: "approval".to_string(),
            node_type: "approval".to_string(),
            config: json!({"approvalLine": {"mode": "fixed", "assignee": "manager"}}),
        };

        let (assignee, payload) = resolve_approval_assignment(&node, &json!({}));
        assert_eq!(assignee, "manager");
        assert_eq!(payload["approval_model"], "fixed");
    }

    #[test]
    fn resolves_condition_based_approval_assignee() {
        let node = NodeDef {
            node_id: "approval".to_string(),
            node_type: "approval".to_string(),
            config: json!({
                "approvalLine": {
                    "mode": "condition",
                    "rules": [
                        {"condition": "amount > 100", "assignee": "finance"}
                    ],
                    "defaultAssignee": "manager"
                }
            }),
        };

        let (assignee, payload) =
            resolve_approval_assignment(&node, &json!({"formData": {"amount": 150}}));
        assert_eq!(assignee, "finance");
        assert_eq!(payload["matched_condition"], "amount > 100");
    }

    #[test]
    fn resolves_requester_selected_candidate() {
        let node = NodeDef {
            node_id: "approval".to_string(),
            node_type: "approval".to_string(),
            config: json!({
                "approvalLine": {
                    "mode": "requester_selected",
                    "candidateField": "approver",
                    "candidates": ["lead", "director"],
                    "defaultAssignee": "lead"
                }
            }),
        };

        let (assignee, payload) =
            resolve_approval_assignment(&node, &json!({"formData": {"approver": "director"}}));
        assert_eq!(assignee, "director");
        assert_eq!(payload["approval_model"], "requester_selected");
    }

    #[test]
    fn resolves_retry_policy_from_plugin_node_config() {
        let policy = V2RetryPolicy::from_node_config(&json!({
            "retryCount": 2,
            "retry_policy": {
                "backoff_ms": 250
            }
        }));

        assert_eq!(policy.max_attempts, 2);
        assert_eq!(policy.initial_delay_ms, 250);
    }

    #[test]
    fn disables_retry_from_plugin_node_config() {
        let policy = V2RetryPolicy::from_node_config(&json!({
            "enableRetry": false,
            "retryCount": 3
        }));

        assert_eq!(policy.max_attempts, 0);
    }
}

// ============================================================
// V2 Engine Main Loop Entry
// ============================================================
pub async fn run_v2_once(ctx: &V2RuntimeContext, worker_id: &str) -> Result<bool> {
    // 1) READY(QUEUED) 잡 선점
    let maybe_job = ctx.job_queue.fetch_and_mark_running(worker_id).await?;
    let Some(job) = maybe_job else {
        return Ok(false);
    };

    println!(
        "[v2_engine] 🚀 processing job_id={}, type={:?}, instance_id={}",
        job.id, job.job_type, job.instance_id
    );

    let mut tx = ctx.tx_manager.begin().await?;
    let mut advisory_acquired = false;
    let mut lease_acquired = false;

    let result: Result<(bool, bool)> = async {
        advisory_acquired = ctx
            .instance_lock
            .try_advisory_lock(job.instance_id, tx.as_mut())
            .await?;
        if !advisory_acquired {
            println!(
                "[v2_engine] failed to acquire advisory lock for instance {}",
                job.instance_id
            );
            ctx.job_queue.release_job(job.id, 1.0, tx.as_mut()).await?;
            return Ok((false, true));
        }

        lease_acquired = ctx
            .instance_lock
            .acquire_lease(job.instance_id, worker_id, 30.0, tx.as_mut())
            .await?;
        if !lease_acquired {
            println!(
                "[v2_engine] failed to acquire lease for instance {}",
                job.instance_id
            );
            ctx.job_queue.release_job(job.id, 1.0, tx.as_mut()).await?;
            return Ok((false, true));
        }

        let maybe_instance = ctx
            .instance_repo
            .load_instance(job.instance_id, tx.as_mut())
            .await?;
        let Some(mut instance) = maybe_instance else {
            println!(
                "[v2_engine] instance {} not found, marking job failed",
                job.instance_id
            );
            ctx.job_queue.mark_job_failed(job.id, tx.as_mut()).await?;
            return Ok((true, true));
        };

        if instance.state == "COMPLETED"
            || instance.state == "FAILED"
            || instance.state == "TERMINATED"
        {
            println!(
                "[v2_engine] instance {} is already in terminal state: {}",
                instance.id, instance.state
            );
            ctx.job_queue
                .mark_job_completed(job.id, tx.as_mut())
                .await?;
            return Ok((true, true));
        }

        if instance.state == "CREATED" || instance.state == "WAITING" {
            instance.state = "RUNNING".to_string();
            ctx.instance_repo
                .update_instance(
                    instance.id,
                    &instance.state,
                    instance.context.clone(),
                    tx.as_mut(),
                )
                .await?;
            ctx.outbox
                .append_event(
                    instance.id,
                    None,
                    None,
                    "INSTANCE_RUNNING",
                    json!({
                        "instance_id": instance.id,
                        "state": "RUNNING",
                        "worker_id": worker_id
                    }),
                    tx.as_mut(),
                )
                .await?;
        }

        let (nodes, edges) = ctx
            .def_repo
            .load_definition_graph(instance.process_definition_id)
            .await?;
        let mut active_tokens = Vec::new();

        match job.job_type {
            JobType::Start => {
                let tokens = ctx.token_repo.load_tokens(instance.id, tx.as_mut()).await?;
                let mut start_tokens: Vec<V2Token> = tokens
                    .into_iter()
                    .filter(|t| t.status == TokenStatus::Active || t.node_id == "start")
                    .collect();

                if start_tokens.is_empty() {
                    let start_token = V2Token {
                        id: Uuid::new_v4(),
                        instance_id: instance.id,
                        node_id: "start".to_string(),
                        status: TokenStatus::Active,
                        parent_token_id: None,
                        scope_key: None,
                        created_at: Utc::now(),
                        updated_at: Utc::now(),
                    };
                    ctx.token_repo
                        .create_tokens(&[start_token.clone()], tx.as_mut())
                        .await?;
                    start_tokens.push(start_token);
                }
                active_tokens = start_tokens;
            }
            JobType::Resume => {
                let mut tokens = ctx.token_repo.load_tokens(instance.id, tx.as_mut()).await?;
                if let Some(tid) = job.token_id {
                    active_tokens = tokens.into_iter().filter(|t| t.id == tid).collect();
                } else {
                    let completed_node_id = job
                        .payload
                        .get("completed_node_id")
                        .and_then(|v| v.as_str());
                    if let Some(node_id) = completed_node_id {
                        let mut matched = false;
                        for t in &mut tokens {
                            if t.node_id == node_id && t.status == TokenStatus::Waiting {
                                t.status = TokenStatus::Active;
                                t.updated_at = Utc::now();
                                ctx.token_repo
                                    .update_tokens(&[t.clone()], tx.as_mut())
                                    .await?;
                                active_tokens.push(t.clone());
                                matched = true;
                            }
                        }
                        if !matched {
                            active_tokens = tokens
                                .into_iter()
                                .filter(|t| t.status == TokenStatus::Active)
                                .collect();
                        }
                    } else {
                        active_tokens = tokens
                            .into_iter()
                            .filter(|t| t.status == TokenStatus::Active)
                            .collect();
                    }
                }
            }
            JobType::Timer => {
                let tokens = ctx.token_repo.load_tokens(instance.id, tx.as_mut()).await?;
                if let Some(tid) = job.token_id {
                    let timer_token = tokens.into_iter().find(|t| t.id == tid);
                    if let Some(mut token) = timer_token {
                        if token.status == TokenStatus::Waiting {
                            ctx.exec_log
                                .append_log(
                                    instance.id,
                                    Some(token.id),
                                    Some(&token.node_id),
                                    "NODE_COMPLETED",
                                    json!({"timer_expired": true}),
                                    tx.as_mut(),
                                )
                                .await?;

                            token.status = TokenStatus::Consumed;
                            token.updated_at = Utc::now();
                            ctx.token_repo
                                .update_tokens(&[token.clone()], tx.as_mut())
                                .await?;

                            let next_edges: Vec<&EdgeRule> = edges
                                .iter()
                                .filter(|e| e.source_node_id == token.node_id)
                                .collect();

                            for edge in next_edges {
                                let new_token = V2Token {
                                    id: Uuid::new_v4(),
                                    instance_id: instance.id,
                                    node_id: edge.target_node_id.clone(),
                                    status: TokenStatus::Active,
                                    parent_token_id: Some(token.id),
                                    scope_key: token.scope_key.clone(),
                                    created_at: Utc::now(),
                                    updated_at: Utc::now(),
                                };
                                ctx.token_repo
                                    .create_tokens(&[new_token.clone()], tx.as_mut())
                                    .await?;
                                active_tokens.push(new_token);
                            }
                        } else {
                            println!(
                                "[v2_engine] timer job {} ignored because token {} is {:?}",
                                job.id, token.id, token.status
                            );
                        }
                    }
                }
            }
            JobType::Retry => {
                let tokens = ctx.token_repo.load_tokens(instance.id, tx.as_mut()).await?;
                if let Some(tid) = job.token_id {
                    let mut retry_tokens: Vec<V2Token> =
                        tokens.into_iter().filter(|t| t.id == tid).collect();
                    for token in &mut retry_tokens {
                        if token.status == TokenStatus::Waiting {
                            token.status = TokenStatus::Active;
                            token.updated_at = Utc::now();
                            ctx.token_repo
                                .update_tokens(&[token.clone()], tx.as_mut())
                                .await?;
                        }
                    }
                    active_tokens = retry_tokens;
                }
            }
            _ => {}
        }

        if !active_tokens.is_empty() {
            execute_token_flow(
                ctx,
                &mut instance,
                active_tokens,
                &nodes,
                &edges,
                job.attempt,
                tx.as_mut(),
            )
            .await?;
        }

        ctx.job_queue
            .mark_job_completed(job.id, tx.as_mut())
            .await?;
        ctx.exec_log
            .append_log(
                job.instance_id,
                job.token_id,
                None,
                "V2_JOB_PROCESSED",
                json!({"job_id": job.id, "job_type": job.job_type.as_str()}),
                tx.as_mut(),
            )
            .await?;

        Ok((true, true))
    }
    .await;

    match result {
        Ok((processed, should_commit)) => {
            let finish_result = if should_commit {
                ctx.tx_manager.commit(tx).await
            } else {
                ctx.tx_manager.rollback(tx).await
            };
            if lease_acquired {
                let _ = ctx
                    .instance_lock
                    .release_lease(job.instance_id, worker_id)
                    .await;
            }
            if advisory_acquired {
                let _ = ctx.instance_lock.advisory_unlock(job.instance_id).await;
            }
            if let Err(err) = finish_result {
                if is_transient_transaction_error(&err) {
                    requeue_transient_job(ctx, &job, &err).await?;
                    return Ok(true);
                }
                return Err(err);
            }
            Ok(processed)
        }
        Err(err) => {
            let _ = ctx.tx_manager.rollback(tx).await;
            if lease_acquired {
                let _ = ctx
                    .instance_lock
                    .release_lease(job.instance_id, worker_id)
                    .await;
            }
            if advisory_acquired {
                let _ = ctx.instance_lock.advisory_unlock(job.instance_id).await;
            }
            if is_transient_transaction_error(&err) {
                requeue_transient_job(ctx, &job, &err).await?;
                return Ok(true);
            }
            Err(err)
        }
    }
}

fn is_transient_transaction_error(err: &anyhow::Error) -> bool {
    for cause in err.chain() {
        if let Some(mongo_err) = cause.downcast_ref::<mongodb::error::Error>() {
            return mongo_err.contains_label(TRANSIENT_TRANSACTION_ERROR)
                || mongo_err.contains_label(UNKNOWN_TRANSACTION_COMMIT_RESULT);
        }
    }

    let message = err.to_string();
    message.contains("WriteConflict")
        || message.contains(TRANSIENT_TRANSACTION_ERROR)
        || message.contains(UNKNOWN_TRANSACTION_COMMIT_RESULT)
}

async fn requeue_transient_job(
    ctx: &V2RuntimeContext,
    job: &V2Job,
    err: &anyhow::Error,
) -> Result<()> {
    let delay_ms = std::env::var("ENGINE_TRANSIENT_RETRY_DELAY_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(250);
    let delay_sec = delay_ms as f64 / 1000.0;

    println!(
        "[v2_engine] transient transaction error for job_id={}, requeueing after {}ms: {}",
        job.id, delay_ms, err
    );

    let mut retry_tx = ctx.tx_manager.begin().await?;
    ctx.job_queue
        .release_job(job.id, delay_sec, retry_tx.as_mut())
        .await?;
    ctx.exec_log
        .append_log(
            job.instance_id,
            job.token_id,
            None,
            "V2_JOB_TRANSIENT_RETRY",
            json!({
                "job_id": job.id,
                "job_type": job.job_type.as_str(),
                "delay_ms": delay_ms,
                "error": err.to_string()
            }),
            retry_tx.as_mut(),
        )
        .await?;
    ctx.tx_manager.commit(retry_tx).await?;
    Ok(())
}

// ============================================================
// 토큰 전이 루프 엔진 (Explicit Token State Machine)
// ============================================================
async fn execute_token_flow(
    ctx: &V2RuntimeContext,
    instance: &mut V2Instance,
    mut active_tokens: Vec<V2Token>,
    nodes: &[NodeDef],
    edges: &[EdgeRule],
    attempt: i32,
    tx: &mut dyn Tx,
) -> Result<()> {
    while let Some(mut token) = active_tokens.pop() {
        // 노드 명세 조회
        let node = nodes.iter().find(|n| n.node_id == token.node_id);
        let Some(node) = node else {
            println!(
                "[v2_engine] node {} not found in definition, marking token failed",
                token.node_id
            );
            token.status = TokenStatus::Failed;
            token.updated_at = Utc::now();
            ctx.token_repo.update_tokens(&[token], tx).await?;
            continue;
        };

        println!(
            "[v2_engine] flow token {} at node: id={}, type={}",
            token.id, node.node_id, node.node_type
        );

        match node.node_type.as_str() {
            "start" => {
                // 1) 시작 노드 이벤트 발행 및 소모
                ctx.exec_log
                    .append_log(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "NODE_STARTED",
                        json!({}),
                        tx,
                    )
                    .await?;
                ctx.exec_log
                    .append_log(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "NODE_COMPLETED",
                        json!({}),
                        tx,
                    )
                    .await?;

                token.status = TokenStatus::Consumed;
                token.updated_at = Utc::now();
                ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                // 2) 다음 노드들을 찾아서 토큰 전이
                let next_edges: Vec<&EdgeRule> = edges
                    .iter()
                    .filter(|e| e.source_node_id == token.node_id)
                    .collect();

                for edge in next_edges {
                    let new_token = V2Token {
                        id: Uuid::new_v4(),
                        instance_id: instance.id,
                        node_id: edge.target_node_id.clone(),
                        status: TokenStatus::Active,
                        parent_token_id: Some(token.id),
                        scope_key: token.scope_key.clone(),
                        created_at: Utc::now(),
                        updated_at: Utc::now(),
                    };
                    ctx.token_repo
                        .create_tokens(&[new_token.clone()], tx)
                        .await?;
                    active_tokens.push(new_token);
                }
            }

            "gateway" => {
                let gateway_type = gateway_type(node);
                let incoming_edges: Vec<&EdgeRule> = edges
                    .iter()
                    .filter(|e| e.target_node_id == token.node_id)
                    .collect();
                let is_join = incoming_edges.len() > 1;

                ctx.exec_log
                    .append_log(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "NODE_STARTED",
                        json!({"gateway_type": format!("{:?}", gateway_type), "is_join": is_join}),
                        tx,
                    )
                    .await?;

                if is_join {
                    let all_tokens = ctx.token_repo.load_tokens(instance.id, tx).await?;
                    let arrived_tokens: Vec<V2Token> = all_tokens
                        .into_iter()
                        .filter(|candidate| {
                            candidate.node_id == token.node_id
                                && (candidate.status == TokenStatus::Active
                                    || candidate.status == TokenStatus::Waiting)
                                && candidate.scope_key == token.scope_key
                        })
                        .collect();
                    let expected_count =
                        expected_join_count(token.scope_key.as_deref(), incoming_edges.len());

                    if arrived_tokens.len() < expected_count {
                        token.status = TokenStatus::Waiting;
                        token.updated_at = Utc::now();
                        ctx.token_repo.update_tokens(&[token.clone()], tx).await?;
                        ctx.exec_log
                            .append_log(
                                instance.id,
                                Some(token.id),
                                Some(&token.node_id),
                                "GATEWAY_JOIN_WAITING",
                                json!({
                                    "gateway_type": format!("{:?}", gateway_type),
                                    "arrived": arrived_tokens.len(),
                                    "expected": expected_count
                                }),
                                tx,
                            )
                            .await?;
                        continue;
                    }

                    let mut tokens_to_consume = arrived_tokens;
                    for arrived in &mut tokens_to_consume {
                        arrived.status = TokenStatus::Consumed;
                        arrived.updated_at = Utc::now();
                    }
                    ctx.token_repo.update_tokens(&tokens_to_consume, tx).await?;
                } else {
                    token.status = TokenStatus::Consumed;
                    token.updated_at = Utc::now();
                    ctx.token_repo.update_tokens(&[token.clone()], tx).await?;
                }

                let next_edges: Vec<&EdgeRule> = edges
                    .iter()
                    .filter(|e| e.source_node_id == token.node_id)
                    .collect();
                let selected_edges =
                    select_gateway_edges(gateway_type, &next_edges, &instance.context);

                if !selected_edges.is_empty() {
                    let selected_targets: Vec<String> = selected_edges
                        .iter()
                        .map(|edge| edge.target_node_id.clone())
                        .collect();
                    ctx.exec_log
                        .append_log(
                            instance.id,
                            Some(token.id),
                            Some(&token.node_id),
                            "NODE_COMPLETED",
                            json!({
                                "gateway_type": format!("{:?}", gateway_type),
                                "decision_targets": selected_targets,
                                "is_join": is_join
                            }),
                            tx,
                        )
                        .await?;

                    let next_scope = if is_join {
                        None
                    } else {
                        fork_scope(&token, selected_edges.len())
                    };

                    for edge in selected_edges {
                        let new_token = V2Token {
                            id: Uuid::new_v4(),
                            instance_id: instance.id,
                            node_id: edge.target_node_id.clone(),
                            status: TokenStatus::Active,
                            parent_token_id: Some(token.id),
                            scope_key: next_scope.clone(),
                            created_at: Utc::now(),
                            updated_at: Utc::now(),
                        };
                        ctx.token_repo
                            .create_tokens(&[new_token.clone()], tx)
                            .await?;
                        active_tokens.push(new_token);
                    }
                } else {
                    println!("[v2_engine] Gateway failed to find any matching edge, stopping flow");
                    token.status = TokenStatus::Failed;
                    token.updated_at = Utc::now();
                    ctx.token_repo.update_tokens(&[token.clone()], tx).await?;
                }
            }

            "approval" => {
                // 1) 완료된 Task 확인 (재진입 시나리오)
                let completed_task = ctx.task_repo.find_task_by_token(token.id, tx).await?;

                if let Some(task) = completed_task {
                    if task.status == "APPROVED" || task.status == "REJECTED" {
                        println!(
                            "[v2_engine] ✅ Approval Task is {}, moving next.",
                            task.status
                        );

                        ctx.exec_log
                            .append_log(
                                instance.id,
                                Some(token.id),
                                Some(&token.node_id),
                                "NODE_COMPLETED",
                                json!({"approval_status": task.status}),
                                tx,
                            )
                            .await?;

                        token.status = TokenStatus::Consumed;
                        token.updated_at = Utc::now();
                        ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                        if task.status == "REJECTED" {
                            println!("[v2_engine] 🛑 Task rejected, failing instance.");
                            instance.state = "FAILED".to_string();
                            ctx.instance_repo
                                .update_instance(
                                    instance.id,
                                    &instance.state,
                                    instance.context.clone(),
                                    tx,
                                )
                                .await?;

                            ctx.outbox
                                .append_event(
                                    instance.id,
                                    Some(token.id),
                                    Some(&token.node_id),
                                    "INSTANCE_FAILED",
                                    json!({"reason": "task_rejected"}),
                                    tx,
                                )
                                .await?;
                            continue;
                        }

                        // 승인 시 다음 노드 진행
                        let next_edges: Vec<&EdgeRule> = edges
                            .iter()
                            .filter(|e| e.source_node_id == token.node_id)
                            .collect();

                        for edge in next_edges {
                            let new_token = V2Token {
                                id: Uuid::new_v4(),
                                instance_id: instance.id,
                                node_id: edge.target_node_id.clone(),
                                status: TokenStatus::Active,
                                parent_token_id: Some(token.id),
                                scope_key: token.scope_key.clone(),
                                created_at: Utc::now(),
                                updated_at: Utc::now(),
                            };
                            ctx.token_repo
                                .create_tokens(&[new_token.clone()], tx)
                                .await?;
                            active_tokens.push(new_token);
                        }
                        continue;
                    }

                    if task.status == "OPEN" {
                        token.status = TokenStatus::Waiting;
                        token.updated_at = Utc::now();
                        ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                        instance.state = "WAITING".to_string();
                        ctx.instance_repo
                            .update_instance(
                                instance.id,
                                &instance.state,
                                instance.context.clone(),
                                tx,
                            )
                            .await?;
                        continue;
                    }
                }

                // 2) 신규 진입 시나리오: Task 생성 후 대기
                ctx.exec_log
                    .append_log(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "NODE_STARTED",
                        json!({}),
                        tx,
                    )
                    .await?;

                let task_id = Uuid::new_v4();
                let (assignee, approval_payload) =
                    resolve_approval_assignment(node, &instance.context);

                let task = ctx
                    .task_repo
                    .find_or_create_task(
                        task_id,
                        instance.id,
                        token.id,
                        &token.node_id,
                        &assignee,
                        approval_payload.clone(),
                        tx,
                    )
                    .await?;

                // 토큰을 WAITING으로 마킹
                token.status = TokenStatus::Waiting;
                token.updated_at = Utc::now();
                ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                // 인스턴스를 WAITING으로 마킹
                instance.state = "WAITING".to_string();
                ctx.instance_repo
                    .update_instance(instance.id, &instance.state, instance.context.clone(), tx)
                    .await?;

                ctx.outbox
                    .append_event(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "TASK_CREATED",
                        json!({
                            "task_id": task.id,
                            "assignee": assignee,
                            "approval": approval_payload
                        }),
                        tx,
                    )
                    .await?;

                ctx.outbox
                    .append_event(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "INSTANCE_WAITING",
                        json!({
                            "state": "WAITING",
                            "task_id": task.id
                        }),
                        tx,
                    )
                    .await?;
            }

            "timer" => {
                ctx.exec_log
                    .append_log(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "NODE_STARTED",
                        json!({}),
                        tx,
                    )
                    .await?;

                // 타이머 설정 읽기
                let duration_sec = node
                    .config
                    .get("durationMs")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<f64>().ok())
                    .map(|ms| ms / 1000.0)
                    .unwrap_or(5.0);

                // 토큰을 WAITING으로 마킹
                token.status = TokenStatus::Waiting;
                token.updated_at = Utc::now();
                ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                // 타이머 잡 스케줄링 등록
                ctx.job_queue
                    .enqueue_job(
                        instance.id,
                        Some(token.id),
                        JobType::Timer,
                        duration_sec,
                        0,
                        json!({"node_id": token.node_id}),
                        tx,
                    )
                    .await?;

                ctx.outbox
                    .append_event(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "TIMER_SCHEDULED",
                        json!({"duration_sec": duration_sec}),
                        tx,
                    )
                    .await?;
            }

            "workflow_call" => {
                ctx.exec_log
                    .append_log(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "NODE_STARTED",
                        json!({"call_mode": "async"}),
                        tx,
                    )
                    .await?;

                let call_result: Result<Value> = async {
                    let target_definition_id = resolve_workflow_call_target(node)?;
                    if target_definition_id == instance.process_definition_id {
                        anyhow::bail!("Workflow Call cannot target the current workflow");
                    }

                    let current_depth = workflow_call_depth(&instance.context);
                    let max_depth = max_workflow_call_depth();
                    if current_depth >= max_depth {
                        anyhow::bail!(
                            "Workflow Call depth limit exceeded: current={}, max={}",
                            current_depth,
                            max_depth
                        );
                    }

                    let child_form_data = resolve_workflow_call_input(node, &instance.context)?;
                    let (child_nodes, _) = ctx
                        .def_repo
                        .load_definition_graph(target_definition_id)
                        .await?;
                    let child_start_node = child_nodes
                        .iter()
                        .find(|child_node| child_node.node_type == "start")
                        .ok_or_else(|| anyhow::anyhow!("Target workflow start node not found"))?;

                    let child_instance_id = Uuid::new_v4();
                    let child_token_id = Uuid::new_v4();
                    let child_context = json!({
                        "runtime": {
                            "cursor": child_start_node.node_id,
                            "template_id": target_definition_id,
                            "parent_instance_id": instance.id,
                            "parent_token_id": token.id,
                            "parent_node_id": token.node_id,
                            "call_mode": "async",
                            "call_depth": current_depth + 1
                        },
                        "data": {
                            "formData": child_form_data,
                            "outputs": {}
                        }
                    });

                    ctx.instance_repo
                        .create_instance(
                            child_instance_id,
                            target_definition_id,
                            "CREATED",
                            child_context,
                            tx,
                        )
                        .await?;
                    ctx.token_repo
                        .create_tokens(
                            &[V2Token {
                                id: child_token_id,
                                instance_id: child_instance_id,
                                node_id: child_start_node.node_id.clone(),
                                status: TokenStatus::Active,
                                parent_token_id: None,
                                scope_key: None,
                                created_at: Utc::now(),
                                updated_at: Utc::now(),
                            }],
                            tx,
                        )
                        .await?;
                    ctx.job_queue
                        .enqueue_job(
                            child_instance_id,
                            None,
                            JobType::Start,
                            0.0,
                            0,
                            json!({
                                "node_id": child_start_node.node_id,
                                "reason": "workflow_call",
                                "parent_instance_id": instance.id,
                                "parent_token_id": token.id,
                                "parent_node_id": token.node_id
                            }),
                            tx,
                        )
                        .await?;

                    Ok(json!({
                        "child_instance_id": child_instance_id,
                        "target_workflow_id": target_definition_id,
                        "target_workflow_name": node.config.get("targetWorkflowName").and_then(|value| value.as_str()),
                        "call_mode": "async",
                        "call_depth": current_depth + 1,
                        "status": "STARTED"
                    }))
                }
                .await;

                match call_result {
                    Ok(output) => {
                        let output_path = workflow_call_output_path(node);
                        set_context_value_at_path(&mut instance.context, &output_path, output.clone());
                        ctx.instance_repo
                            .update_instance(
                                instance.id,
                                &instance.state,
                                instance.context.clone(),
                                tx,
                            )
                            .await?;

                        ctx.exec_log
                            .append_log(
                                instance.id,
                                Some(token.id),
                                Some(&token.node_id),
                                "NODE_COMPLETED",
                                json!({"output_path": output_path, "output": output}),
                                tx,
                            )
                            .await?;
                        ctx.outbox
                            .append_event(
                                instance.id,
                                Some(token.id),
                                Some(&token.node_id),
                                "WORKFLOW_CALLED",
                                output,
                                tx,
                            )
                            .await?;

                        token.status = TokenStatus::Consumed;
                        token.updated_at = Utc::now();
                        ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                        let next_edges: Vec<&EdgeRule> = edges
                            .iter()
                            .filter(|e| e.source_node_id == token.node_id)
                            .collect();

                        for edge in next_edges {
                            let new_token = V2Token {
                                id: Uuid::new_v4(),
                                instance_id: instance.id,
                                node_id: edge.target_node_id.clone(),
                                status: TokenStatus::Active,
                                parent_token_id: Some(token.id),
                                scope_key: token.scope_key.clone(),
                                created_at: Utc::now(),
                                updated_at: Utc::now(),
                            };
                            ctx.token_repo
                                .create_tokens(&[new_token.clone()], tx)
                                .await?;
                            active_tokens.push(new_token);
                        }
                    }
                    Err(err) => {
                        token.status = TokenStatus::Failed;
                        token.updated_at = Utc::now();
                        ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                        instance.state = "FAILED".to_string();
                        ctx.instance_repo
                            .update_instance(
                                instance.id,
                                &instance.state,
                                instance.context.clone(),
                                tx,
                            )
                            .await?;

                        ctx.exec_log
                            .append_log(
                                instance.id,
                                Some(token.id),
                                Some(&token.node_id),
                                "NODE_FAILED",
                                json!({"reason": err.to_string()}),
                                tx,
                            )
                            .await?;
                        ctx.outbox
                            .append_event(
                                instance.id,
                                Some(token.id),
                                Some(&token.node_id),
                                "INSTANCE_FAILED",
                                json!({"reason": "workflow_call_failed", "detail": err.to_string()}),
                                tx,
                            )
                            .await?;
                    }
                }
            }

            "service" => {
                ctx.exec_log
                    .append_log(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "NODE_STARTED",
                        json!({"attempt": attempt}),
                        tx,
                    )
                    .await?;

                let plugin_id = node
                    .config
                    .get("plugin_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("builtin.http_request");

                println!("[v2_engine] Executing plugin: {}", plugin_id);

                let invocation = PluginInvocation {
                    plugin_id: plugin_id.to_string(),
                    instance_id: instance.id,
                    token_id: token.id,
                    node_id: token.node_id.clone(),
                    config: node.config.clone(),
                    context: external_execution_context(&instance.context),
                    attempt,
                };

                let call_result = ctx.plugin_executor.execute(invocation).await;

                match call_result {
                    Ok(result) => {
                        if let Some(output_path) = node
                            .config
                            .get("outputPath")
                            .or_else(|| node.config.get("output_path"))
                            .and_then(|value| value.as_str())
                            .filter(|value| !value.trim().is_empty())
                        {
                            set_context_value_at_path(
                                &mut instance.context,
                                output_path,
                                result.output.clone(),
                            );
                            ctx.instance_repo
                                .update_instance(
                                    instance.id,
                                    &instance.state,
                                    instance.context.clone(),
                                    tx,
                                )
                                .await?;
                        }

                        ctx.exec_log
                            .append_log(
                                instance.id,
                                Some(token.id),
                                Some(&token.node_id),
                                "NODE_COMPLETED",
                                json!({"status_code": result.status_code, "output": result.output}),
                                tx,
                            )
                            .await?;

                        token.status = TokenStatus::Consumed;
                        token.updated_at = Utc::now();
                        ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                        // 다음 엣지 탐색
                        let next_edges: Vec<&EdgeRule> = edges
                            .iter()
                            .filter(|e| e.source_node_id == token.node_id)
                            .collect();

                        for edge in next_edges {
                            let new_token = V2Token {
                                id: Uuid::new_v4(),
                                instance_id: instance.id,
                                node_id: edge.target_node_id.clone(),
                                status: TokenStatus::Active,
                                parent_token_id: Some(token.id),
                                scope_key: token.scope_key.clone(),
                                created_at: Utc::now(),
                                updated_at: Utc::now(),
                            };
                            ctx.token_repo
                                .create_tokens(&[new_token.clone()], tx)
                                .await?;
                            active_tokens.push(new_token);
                        }
                    }
                    Err(err) => {
                        let retry_policy = V2RetryPolicy::from_node_config(&node.config);
                        if attempt < retry_policy.max_attempts {
                            let delay_ms = retry_policy.calculate_backoff(attempt);
                            let delay_sec = delay_ms as f64 / 1000.0;

                            token.status = TokenStatus::Waiting;
                            token.updated_at = Utc::now();
                            ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                            ctx.job_queue
                                .enqueue_job(
                                    instance.id,
                                    Some(token.id),
                                    JobType::Retry,
                                    delay_sec,
                                    attempt + 1,
                                    json!({"node_id": token.node_id, "plugin_id": plugin_id}),
                                    tx,
                                )
                                .await?;

                            ctx.exec_log.append_log(
                                instance.id,
                                Some(token.id),
                                Some(&token.node_id),
                                "NODE_RETRY_SCHEDULED",
                                json!({"attempt": attempt + 1, "delay_sec": delay_sec, "reason": err.to_string()}),
                                tx
                            ).await?;
                        } else {
                            println!("[v2_engine] Service node failed after max retries. Failing instance.");
                            token.status = TokenStatus::Failed;
                            token.updated_at = Utc::now();
                            ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                            instance.state = "FAILED".to_string();
                            ctx.instance_repo
                                .update_instance(
                                    instance.id,
                                    &instance.state,
                                    instance.context.clone(),
                                    tx,
                                )
                                .await?;

                            ctx.outbox
                                .append_event(
                                    instance.id,
                                    Some(token.id),
                                    Some(&token.node_id),
                                    "INSTANCE_FAILED",
                                    json!({"reason": "service_node_failed_max_retries"}),
                                    tx,
                                )
                                .await?;
                        }
                    }
                }
            }

            "script" => {
                ctx.exec_log
                    .append_log(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "NODE_STARTED",
                        json!({"script_type": "javascript"}),
                        tx,
                    )
                    .await?;

                match execute_js_node(node, &instance.context) {
                    Ok(output) => {
                        let output_path = node
                            .config
                            .get("outputPath")
                            .or_else(|| node.config.get("output_path"))
                            .and_then(|value| value.as_str())
                            .filter(|value| !value.trim().is_empty())
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| format!("scriptResults.{}", token.node_id));

                        set_context_value_at_path(
                            &mut instance.context,
                            &output_path,
                            output.clone(),
                        );
                        ctx.instance_repo
                            .update_instance(
                                instance.id,
                                &instance.state,
                                instance.context.clone(),
                                tx,
                            )
                            .await?;

                        ctx.exec_log
                            .append_log(
                                instance.id,
                                Some(token.id),
                                Some(&token.node_id),
                                "NODE_COMPLETED",
                                json!({
                                    "script_type": "javascript",
                                    "output_path": output_path,
                                    "output": output
                                }),
                                tx,
                            )
                            .await?;

                        token.status = TokenStatus::Consumed;
                        token.updated_at = Utc::now();
                        ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                        let next_edges: Vec<&EdgeRule> = edges
                            .iter()
                            .filter(|e| e.source_node_id == token.node_id)
                            .collect();

                        for edge in next_edges {
                            let new_token = V2Token {
                                id: Uuid::new_v4(),
                                instance_id: instance.id,
                                node_id: edge.target_node_id.clone(),
                                status: TokenStatus::Active,
                                parent_token_id: Some(token.id),
                                scope_key: token.scope_key.clone(),
                                created_at: Utc::now(),
                                updated_at: Utc::now(),
                            };
                            ctx.token_repo
                                .create_tokens(&[new_token.clone()], tx)
                                .await?;
                            active_tokens.push(new_token);
                        }
                    }
                    Err(err) => {
                        token.status = TokenStatus::Failed;
                        token.updated_at = Utc::now();
                        ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                        instance.state = "FAILED".to_string();
                        ctx.instance_repo
                            .update_instance(
                                instance.id,
                                &instance.state,
                                instance.context.clone(),
                                tx,
                            )
                            .await?;

                        ctx.exec_log
                            .append_log(
                                instance.id,
                                Some(token.id),
                                Some(&token.node_id),
                                "NODE_FAILED",
                                json!({
                                    "script_type": "javascript",
                                    "reason": err.to_string()
                                }),
                                tx,
                            )
                            .await?;

                        ctx.outbox
                            .append_event(
                                instance.id,
                                Some(token.id),
                                Some(&token.node_id),
                                "INSTANCE_FAILED",
                                json!({"reason": "script_node_failed"}),
                                tx,
                            )
                            .await?;
                    }
                }
            }

            "end" => {
                let result_path = node
                    .config
                    .get("resultPath")
                    .or_else(|| node.config.get("result_path"))
                    .and_then(|value| value.as_str())
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty());
                let completed_result = result_path
                    .as_ref()
                    .and_then(|path| get_context_value_at_path(&instance.context, path))
                    .unwrap_or_else(|| external_result_default(&instance.context));

                set_context_value_at_path(
                    &mut instance.context,
                    "result",
                    completed_result.clone(),
                );
                if let Some(path) = result_path.as_ref() {
                    set_context_value_at_path(
                        &mut instance.context,
                        "result_path",
                        Value::String(path.clone()),
                    );
                }

                ctx.exec_log
                    .append_log(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "NODE_STARTED",
                        json!({}),
                        tx,
                    )
                    .await?;
                ctx.exec_log
                    .append_log(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "NODE_COMPLETED",
                        json!({"result_path": result_path, "result": completed_result}),
                        tx,
                    )
                    .await?;

                token.status = TokenStatus::Consumed;
                token.updated_at = Utc::now();
                ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                // 전체 토큰 조회하여 완료 여부 판정
                let all_tokens = ctx.token_repo.load_tokens(instance.id, tx).await?;
                let has_active_or_waiting = all_tokens.iter().any(|t| {
                    t.id != token.id
                        && (t.status == TokenStatus::Active || t.status == TokenStatus::Waiting)
                });

                if !has_active_or_waiting {
                    // 모든 토큰 소모 완료 -> 인스턴스 종료
                    instance.state = "COMPLETED".to_string();
                    ctx.instance_repo
                        .update_instance(instance.id, &instance.state, instance.context.clone(), tx)
                        .await?;

                    ctx.outbox
                        .append_event(
                            instance.id,
                            None,
                            None,
                            "INSTANCE_COMPLETED",
                            json!({"instance_id": instance.id}),
                            tx,
                        )
                        .await?;
                }
            }

            _ => {
                println!("[v2_engine] Unknown node type: {}", node.node_type);
                token.status = TokenStatus::Failed;
                token.updated_at = Utc::now();
                ctx.token_repo.update_tokens(&[token.clone()], tx).await?;
            }
        }
    }
    Ok(())
}
