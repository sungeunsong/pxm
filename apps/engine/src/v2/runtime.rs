use anyhow::Result;
use chrono::Utc;
use futures_util::TryStreamExt;
use mongodb::{
    bson::{doc, Bson, Document},
    error::{TRANSIENT_TRANSACTION_ERROR, UNKNOWN_TRANSACTION_COMMIT_RESULT},
    Client,
};
use rand::Rng;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use uuid::Uuid;

use crate::v2::ports::{
    ExecutionLogPort, InstanceLockPort, JobQueuePort, OutboxPort, PluginExecutorPort,
    PluginInvocation, ProcessDefinitionRepositoryPort, TaskRepositoryPort, TokenRepositoryPort,
    TransactionManagerPort, Tx, WorkflowInstanceRepositoryPort,
};
use crate::v2::types::{
    EdgeRule, GatewayType, JobType, NodeDef, TokenStatus, V2ApprovalDefinition,
    V2ApprovalStepInput, V2ApprovalTaskInput, V2Instance, V2Job, V2Token,
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
#[derive(Debug, Clone, Copy, PartialEq)]
enum ConditionOperator {
    Eq,
    Ne,
    Gte,
    Lte,
    Gt,
    Lt,
}

/// 긴 연산자를 먼저 검사해야 한다. `>=`를 `>`로 자르면 우변이 `"= 100"`이 되고,
/// 그 파싱 실패를 기본값으로 흘리면 `amount > 0`을 평가하게 된다.
const CONDITION_OPERATORS: [(&str, ConditionOperator); 6] = [
    ("==", ConditionOperator::Eq),
    ("!=", ConditionOperator::Ne),
    (">=", ConditionOperator::Gte),
    ("<=", ConditionOperator::Lte),
    (">", ConditionOperator::Gt),
    ("<", ConditionOperator::Lt),
];

fn parse_condition(condition: &str) -> Result<(String, ConditionOperator, String)> {
    let condition = condition.trim();
    let matched_operator = CONDITION_OPERATORS
        .iter()
        .copied()
        .filter_map(|(token, operator)| condition.find(token).map(|index| (index, token, operator)))
        .min_by_key(|(index, token, _)| (*index, std::cmp::Reverse(token.len())));

    let Some((operator_index, token, operator)) = matched_operator else {
        return Err(anyhow::anyhow!(
            "condition '{condition}' has no supported operator. supported: ==, !=, >=, <=, >, <"
        ));
    };

    let field = condition[..operator_index].trim();
    if field.is_empty() {
        return Err(anyhow::anyhow!(
            "condition '{condition}' is missing a field name on the left side"
        ));
    }
    if !field
        .chars()
        .all(|character| character.is_alphanumeric() || character == '_' || character == '-')
    {
        return Err(anyhow::anyhow!(
            "condition '{condition}' has an invalid field name"
        ));
    }

    let raw_literal = condition[operator_index + token.len()..].trim();
    if raw_literal.is_empty() {
        return Err(anyhow::anyhow!(
            "condition '{condition}' is missing a value on the right side"
        ));
    }

    let literal = match raw_literal.as_bytes().first().copied() {
        Some(quote @ (b'"' | b'\'')) => {
            if raw_literal.len() < 2 || raw_literal.as_bytes().last().copied() != Some(quote) {
                return Err(anyhow::anyhow!(
                    "condition '{condition}' has an unterminated quoted value"
                ));
            }
            let literal = &raw_literal[1..raw_literal.len() - 1];
            if literal.as_bytes().contains(&quote) {
                return Err(anyhow::anyhow!(
                    "condition '{condition}' has an invalid quoted value"
                ));
            }
            literal.to_string()
        }
        _ => {
            if raw_literal.contains(['"', '\'', '='])
                || raw_literal.chars().any(char::is_whitespace)
                || ["&&", "||", "(", ")"]
                    .iter()
                    .any(|candidate| raw_literal.contains(candidate))
                || CONDITION_OPERATORS
                    .iter()
                    .any(|(candidate, _)| raw_literal.contains(candidate))
            {
                return Err(anyhow::anyhow!(
                    "condition '{condition}' has an invalid value on the right side"
                ));
            }
            raw_literal.to_string()
        }
    };

    Ok((field.to_string(), operator, literal))
}

/// `==`와 `!=`는 문자열, 숫자, 불리언, null을 모두 비교한다.
/// 이전에는 `as_str()`만 봐서 `amount == 50`이나 `flag == true`가 항상 거짓이었다.
fn condition_value_equals(actual: &Value, literal: &str) -> Option<bool> {
    match actual {
        Value::String(text) => Some(text == literal),
        Value::Number(number) => literal
            .parse::<f64>()
            .ok()
            .filter(|expected| expected.is_finite())
            .map(|expected| number.as_f64() == Some(expected)),
        Value::Bool(flag) => literal
            .parse::<bool>()
            .ok()
            .map(|expected| *flag == expected),
        Value::Null => literal.eq_ignore_ascii_case("null").then_some(true),
        _ => None,
    }
}

/// 게이트웨이 조건식을 평가한다.
///
/// 문법 오류는 `Err`로 올려 노드를 실패시킨다. 조용히 `false`로 흘리면 기본 경로를
/// 타면서 워크플로우가 정상 완료되고, 잘못된 분기를 아무도 알아채지 못한다.
/// 반면 참조한 필드가 없거나 타입이 맞지 않는 것은 실행 중 정상적으로 생길 수 있으므로
/// `false`로 평가한다.
///
/// 참조 대상은 `data.formData`의 최상위 필드다. 노드 산출물 참조는 PXM-42에서 다룬다.
fn evaluate_condition(condition: &str, context: &Value) -> Result<bool> {
    let (field, operator, literal) = parse_condition(condition)?;

    // 숫자 비교는 우변이 숫자여야 한다. 파싱 실패를 기본값으로 대체하지 않는다.
    let threshold = match operator {
        ConditionOperator::Gt
        | ConditionOperator::Lt
        | ConditionOperator::Gte
        | ConditionOperator::Lte => {
            let threshold = literal.parse::<f64>().map_err(|_| {
                anyhow::anyhow!("condition '{condition}' expects a number on the right side")
            })?;
            if !threshold.is_finite() {
                return Err(anyhow::anyhow!(
                    "condition '{condition}' expects a finite number on the right side"
                ));
            }
            Some(threshold)
        }
        _ => None,
    };

    let Some(actual) = get_form_data(context).and_then(|data| data.get(&field)) else {
        return Ok(false);
    };

    Ok(match operator {
        ConditionOperator::Eq | ConditionOperator::Ne => {
            let Some(equal) = condition_value_equals(actual, &literal) else {
                return Ok(false);
            };
            match operator {
                ConditionOperator::Eq => equal,
                ConditionOperator::Ne => !equal,
                _ => unreachable!("동등 비교 연산자만 남는다"),
            }
        }
        _ => {
            let Some(actual) = actual.as_f64() else {
                return Ok(false);
            };
            let threshold = threshold.unwrap_or_default();
            match operator {
                ConditionOperator::Gt => actual > threshold,
                ConditionOperator::Lt => actual < threshold,
                ConditionOperator::Gte => actual >= threshold,
                ConditionOperator::Lte => actual <= threshold,
                _ => unreachable!("비교 연산자만 남는다"),
            }
        }
    })
}

fn get_form_data(context: &Value) -> Option<&Value> {
    context
        .get("data")
        .and_then(|data| data.get("formData"))
        .or_else(|| context.get("formData"))
}

#[derive(Debug, Clone)]
struct JsExecution {
    success: bool,
    output: Value,
    console: Value,
    error_message: Option<String>,
}

fn execute_js_node(node: &NodeDef, context: &Value) -> Result<JsExecution> {
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
  let consoleEntries = [];
  try {
    const payload = JSON.parse(raw || '{}');
    let consoleBytes = 0;
    const maxLines = Number(payload.console_max_lines) || 200;
    const maxBytes = Number(payload.console_max_bytes) || 65536;
    const stringify = (value) => {
      if (typeof value === 'string') return value;
      if (typeof value === 'undefined') return 'undefined';
      try {
        return JSON.stringify(value);
      } catch (_error) {
        return String(value);
      }
    };
    const captureConsole = (level, args) => {
      if (consoleEntries.length >= maxLines || consoleBytes >= maxBytes) return;
      const message = Array.from(args).map(stringify).join(' ');
      const remaining = Math.max(0, maxBytes - consoleBytes);
      const text = message.length > remaining ? message.slice(0, remaining) : message;
      consoleBytes += text.length;
      consoleEntries.push({
        level,
        message: text,
        timestamp: new Date().toISOString(),
      });
    };
    const sandbox = vm.createContext({
      input: payload.context || {},
      context: payload.context || {},
      console: {
        log: (...args) => captureConsole('log', args),
        info: (...args) => captureConsole('info', args),
        warn: (...args) => captureConsole('warn', args),
        error: (...args) => captureConsole('error', args),
        debug: (...args) => captureConsole('debug', args),
      },
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
    process.stdout.write(JSON.stringify({
      success: true,
      output: output === undefined ? null : output,
      console: consoleEntries,
    }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      success: false,
      console: consoleEntries,
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
        "console_max_lines": 200,
        "console_max_bytes": 65_536,
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

    let success = response
        .get("success")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let console = response
        .get("console")
        .cloned()
        .unwrap_or_else(|| json!([]));

    if success {
        Ok(JsExecution {
            success: true,
            output: response.get("output").cloned().unwrap_or(Value::Null),
            console,
            error_message: None,
        })
    } else {
        let message = response
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(|value| value.as_str())
            .unwrap_or("JS node execution failed");
        Ok(JsExecution {
            success: false,
            output: Value::Null,
            console,
            error_message: Some(message.to_string()),
        })
    }
}

#[derive(Debug, Clone)]
struct CommandSpec {
    executable: String,
    fixed_args: Vec<String>,
    arg_order: Vec<String>,
    timeout_ms: u64,
    max_stdout_bytes: usize,
    max_stderr_bytes: usize,
    working_dir: Option<String>,
}

async fn execute_command_node(node: &NodeDef, context: &Value) -> Result<Value> {
    let command_id = node
        .config
        .get("commandId")
        .or_else(|| node.config.get("command_id"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Command node requires command_id"))?;

    let registry = command_registry().await?;
    let spec = registry
        .get(command_id)
        .ok_or_else(|| anyhow::anyhow!("Command '{}' is not registered in allowlist", command_id))?;

    let timeout_ms = node
        .config
        .get("commandTimeoutMs")
        .or_else(|| node.config.get("timeoutMs"))
        .or_else(|| node.config.get("timeout"))
        .and_then(|value| value.as_u64().or_else(|| value.as_str().and_then(|text| text.parse().ok())))
        .unwrap_or(spec.timeout_ms)
        .clamp(50, spec.timeout_ms.max(50));

    let args = resolve_command_args(node, context, spec)?;
    let mut command = Command::new(&spec.executable);
    command.args(&spec.fixed_args);
    command.args(&args);
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    if let Some(working_dir) = &spec.working_dir {
        command.current_dir(working_dir);
    }

    let started_at = Utc::now();
    let mut child = command.spawn()?;
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut timed_out = false;

    loop {
        if let Some(_status) = child.try_wait()? {
            break;
        }
        if Instant::now() >= deadline {
            timed_out = true;
            let _ = child.kill();
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }

    let output = child.wait_with_output()?;
    let stdout = truncate_bytes(&output.stdout, spec.max_stdout_bytes);
    let stderr = truncate_bytes(&output.stderr, spec.max_stderr_bytes);
    let exit_code = output.status.code();
    let duration_ms = (Utc::now() - started_at).num_milliseconds().max(0);

    append_command_audit(json!({
        "ts": Utc::now().to_rfc3339(),
        "command_id": command_id,
        "node_id": node.node_id,
        "executable": spec.executable,
        "exit_code": exit_code,
        "timed_out": timed_out,
        "duration_ms": duration_ms,
    }));

    let result = json!({
        "command_id": command_id,
        "exit_code": exit_code,
        "success": output.status.success() && !timed_out,
        "timed_out": timed_out,
        "duration_ms": duration_ms,
        "stdout": stdout,
        "stderr": stderr,
    });

    if timed_out {
        anyhow::bail!("Command '{}' timed out after {}ms", command_id, timeout_ms);
    }
    if !output.status.success() {
        anyhow::bail!(
            "Command '{}' failed with exit_code={:?}: {}",
            command_id,
            exit_code,
            result
                .get("stderr")
                .and_then(|value| value.as_str())
                .unwrap_or("")
        );
    }

    Ok(result)
}

async fn command_registry() -> Result<std::collections::HashMap<String, CommandSpec>> {
    let mut registry = std::collections::HashMap::new();
    registry.insert(
        "builtin.echo".to_string(),
        CommandSpec {
            executable: "/usr/bin/printf".to_string(),
            fixed_args: vec!["%s".to_string()],
            arg_order: vec!["message".to_string()],
            timeout_ms: 1000,
            max_stdout_bytes: 4096,
            max_stderr_bytes: 4096,
            working_dir: None,
        },
    );
    registry.insert(
        "builtin.node_version".to_string(),
        CommandSpec {
            executable: "/usr/bin/node".to_string(),
            fixed_args: vec!["--version".to_string()],
            arg_order: vec![],
            timeout_ms: 1000,
            max_stdout_bytes: 4096,
            max_stderr_bytes: 4096,
            working_dir: None,
        },
    );

    if let Some(raw) = std::env::var("PXM_COMMAND_REGISTRY_JSON")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        registry.extend(parse_command_registry(&raw)?);
    }

    registry.extend(load_mongo_command_registry().await?);
    Ok(registry)
}

async fn load_mongo_command_registry() -> Result<std::collections::HashMap<String, CommandSpec>> {
    let mongo_url = match std::env::var("MONGODB_URL") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => return Ok(std::collections::HashMap::new()),
    };
    let db_name = std::env::var("MONGO_DB_NAME").unwrap_or_else(|_| "pxm_db".to_string());
    let client = Client::with_uri_str(&mongo_url).await?;
    let collection = client
        .database(&db_name)
        .collection::<Document>("command_registry");
    let mut cursor = collection.find(doc! { "enabled": { "$ne": false } }, None).await?;
    let mut registry = std::collections::HashMap::new();

    while let Some(doc) = cursor.try_next().await? {
        let command_id = doc
            .get_str("command_id")
            .or_else(|_| doc.get_str("_id"))
            .unwrap_or("")
            .trim()
            .to_string();
        if command_id.is_empty() {
            continue;
        }
        let executable = doc.get_str("executable").unwrap_or("").trim().to_string();
        if executable.is_empty() {
            continue;
        }
        registry.insert(
            command_id,
            CommandSpec {
                executable,
                fixed_args: bson_string_array(doc.get("fixed_args")),
                arg_order: bson_string_array(doc.get("arg_order")),
                timeout_ms: bson_u64(doc.get("timeout_ms")).unwrap_or(1000).clamp(50, 60_000),
                max_stdout_bytes: bson_u64(doc.get("max_stdout_bytes"))
                    .unwrap_or(16_384)
                    .min(1_048_576) as usize,
                max_stderr_bytes: bson_u64(doc.get("max_stderr_bytes"))
                    .unwrap_or(16_384)
                    .min(1_048_576) as usize,
                working_dir: doc.get_str("working_dir").ok().map(ToString::to_string),
            },
        );
    }

    Ok(registry)
}

fn parse_command_registry(raw: &str) -> Result<std::collections::HashMap<String, CommandSpec>> {
    let value: Value = serde_json::from_str(raw)?;
    let commands = value
        .get("commands")
        .and_then(|value| value.as_object())
        .or_else(|| value.as_object())
        .ok_or_else(|| anyhow::anyhow!("PXM_COMMAND_REGISTRY_JSON must be an object"))?;

    let mut registry = std::collections::HashMap::new();
    for (command_id, spec) in commands {
        let executable = spec
            .get("executable")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow::anyhow!("Command '{}' requires executable", command_id))?;
        registry.insert(
            command_id.clone(),
            CommandSpec {
                executable: executable.to_string(),
                fixed_args: string_array(spec.get("fixed_args").or_else(|| spec.get("fixedArgs"))),
                arg_order: string_array(spec.get("arg_order").or_else(|| spec.get("argOrder"))),
                timeout_ms: spec
                    .get("timeout_ms")
                    .or_else(|| spec.get("timeoutMs"))
                    .and_then(|value| value.as_u64())
                    .unwrap_or(1000)
                    .clamp(50, 60_000),
                max_stdout_bytes: spec
                    .get("max_stdout_bytes")
                    .or_else(|| spec.get("maxStdoutBytes"))
                    .and_then(|value| value.as_u64())
                    .unwrap_or(16_384)
                    .min(1_048_576) as usize,
                max_stderr_bytes: spec
                    .get("max_stderr_bytes")
                    .or_else(|| spec.get("maxStderrBytes"))
                    .and_then(|value| value.as_u64())
                    .unwrap_or(16_384)
                    .min(1_048_576) as usize,
                working_dir: spec
                    .get("working_dir")
                    .or_else(|| spec.get("workingDir"))
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string),
            },
        );
    }
    Ok(registry)
}

fn resolve_command_args(node: &NodeDef, context: &Value, spec: &CommandSpec) -> Result<Vec<String>> {
    let arguments = node
        .config
        .get("commandArguments")
        .or_else(|| node.config.get("arguments"))
        .cloned()
        .or_else(|| {
            node.config
                .get("commandArgumentsJson")
                .or_else(|| node.config.get("argumentsJson"))
                .and_then(|value| value.as_str())
                .and_then(|raw| serde_json::from_str(raw).ok())
        })
        .unwrap_or_else(|| json!({}));

    let mut args = Vec::new();
    for key in &spec.arg_order {
        let value = arguments
            .get(key)
            .cloned()
            .or_else(|| get_context_value_at_path(context, key))
            .unwrap_or(Value::Null);
        args.push(command_arg_to_string(&value));
    }
    Ok(args)
}

fn command_arg_to_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        other => other.to_string(),
    }
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(ToString::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn bson_string_array(value: Option<&Bson>) -> Vec<String> {
    value
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(ToString::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn bson_u64(value: Option<&Bson>) -> Option<u64> {
    match value {
        Some(Bson::Int32(value)) => (*value).try_into().ok(),
        Some(Bson::Int64(value)) => (*value).try_into().ok(),
        Some(Bson::Double(value)) if value.is_finite() && *value >= 0.0 => Some(*value as u64),
        _ => None,
    }
}

fn truncate_bytes(bytes: &[u8], limit: usize) -> String {
    let end = bytes.len().min(limit);
    String::from_utf8_lossy(&bytes[..end]).to_string()
}

fn append_command_audit(event: Value) {
    let path = std::env::var("PXM_COMMAND_AUDIT_LOG")
        .unwrap_or_else(|_| "../../logs/command-audit.jsonl".to_string());
    if let Some(parent) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}", event);
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
        _ => Ok(get_form_data(context).cloned().unwrap_or_else(|| json!({}))),
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

fn workflow_call_mode(node: &NodeDef) -> &str {
    node.config
        .get("workflowCallMode")
        .or_else(|| node.config.get("callMode"))
        .and_then(|value| value.as_str())
        .unwrap_or("async")
}

fn workflow_call_wait_timeout_sec(node: &NodeDef) -> f64 {
    node.config
        .get("workflowWaitTimeoutMs")
        .or_else(|| node.config.get("waitTimeoutMs"))
        .and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
        })
        .unwrap_or(300_000.0)
        .max(1000.0)
        / 1000.0
}

fn workflow_call_depth(context: &Value) -> i64 {
    context
        .get("runtime")
        .and_then(|runtime| runtime.get("call_depth"))
        .and_then(|value| value.as_i64())
        .unwrap_or(0)
}

fn instance_workflow_version(context: &Value) -> Option<i32> {
    context
        .pointer("/runtime/snapshot/workflow/version")
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .filter(|value| *value > 0)
        .or_else(|| {
            context
                .pointer("/runtime/access/workflow_version_id")
                .and_then(Value::as_str)
                .and_then(|value| value.rsplit(':').next())
                .and_then(|value| value.parse::<i32>().ok())
                .filter(|value| *value > 0)
        })
}

fn max_workflow_call_depth() -> i64 {
    std::env::var("WORKFLOW_CALL_MAX_DEPTH")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(8)
        .max(1)
}

fn parent_workflow_call_context(context: &Value) -> Option<(Uuid, Uuid, String)> {
    let runtime = context.get("runtime")?;
    if runtime.get("call_mode").and_then(|value| value.as_str()) != Some("wait") {
        return None;
    }

    let parent_instance_id = runtime
        .get("parent_instance_id")
        .and_then(|value| value.as_str())
        .and_then(|value| Uuid::parse_str(value).ok())?;
    let parent_token_id = runtime
        .get("parent_token_id")
        .and_then(|value| value.as_str())
        .and_then(|value| Uuid::parse_str(value).ok())?;
    let parent_node_id = runtime
        .get("parent_node_id")
        .and_then(|value| value.as_str())?
        .to_string();

    Some((parent_instance_id, parent_token_id, parent_node_id))
}

async fn notify_waiting_parent_workflow_call(
    ctx: &V2RuntimeContext,
    child_instance: &V2Instance,
    child_status: &str,
    child_result: Value,
    tx: &mut dyn Tx,
) -> Result<()> {
    let Some((parent_instance_id, parent_token_id, parent_node_id)) =
        parent_workflow_call_context(&child_instance.context)
    else {
        return Ok(());
    };

    ctx.job_queue
        .enqueue_job(
            parent_instance_id,
            Some(parent_token_id),
            JobType::Resume,
            0.0,
            0,
            json!({
                "reason": "workflow_call_child_terminal",
                "workflow_call_resume": true,
                "completed_node_id": parent_node_id,
                "child_instance_id": child_instance.id,
                "child_status": child_status,
                "child_result": child_result
            }),
            tx,
        )
        .await?;
    ctx.outbox
        .append_event(
            child_instance.id,
            None,
            None,
            "WORKFLOW_CALL_PARENT_RESUME_REQUESTED",
            json!({
                "parent_instance_id": parent_instance_id,
                "parent_token_id": parent_token_id,
                "parent_node_id": parent_node_id,
                "child_status": child_status
            }),
            tx,
        )
        .await?;
    Ok(())
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

/// 조건식 문법 오류는 `Err`로 올린다. 잘못된 조건을 `false`로 흘리면
/// 기본 경로를 타면서 잘못된 분기가 정상 완료로 보인다.
fn select_gateway_edges<'a>(
    gateway_type: GatewayType,
    outgoing_edges: &'a [&'a EdgeRule],
    context: &Value,
) -> Result<Vec<&'a EdgeRule>> {
    match gateway_type {
        GatewayType::Parallel => Ok(outgoing_edges.to_vec()),
        GatewayType::Exclusive => {
            let mut default_edge = None;
            let mut evaluated_edges = Vec::new();
            for edge in outgoing_edges {
                if edge.is_default {
                    default_edge = Some(*edge);
                    continue;
                }
                let matched = match edge.condition_expr.as_deref() {
                    Some(expr) => evaluate_condition(expr, context)?,
                    None => false,
                };
                evaluated_edges.push((*edge, matched));
            }
            Ok(evaluated_edges
                .into_iter()
                .find_map(|(edge, matched)| matched.then_some(edge))
                .or(default_edge)
                .into_iter()
                .collect())
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
                    if evaluate_condition(expr, context)? {
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
            Ok(matched)
        }
    }
}

fn select_approval_edges<'a>(
    outgoing_edges: &'a [&'a EdgeRule],
    outcome: &str,
) -> Vec<&'a EdgeRule> {
    let outcome = outcome.to_ascii_lowercase();
    let tagged: Vec<&EdgeRule> = outgoing_edges
        .iter()
        .copied()
        .filter(|edge| {
            edge.condition_expr
                .as_deref()
                .map(str::trim)
                .map(|condition| {
                    let normalized = condition.to_ascii_lowercase();
                    normalized == "approved"
                        || normalized == "rejected"
                        || normalized.contains("approval_result")
                })
                .unwrap_or(false)
        })
        .collect();
    let matched: Vec<&EdgeRule> = tagged
        .iter()
        .copied()
        .filter(|edge| {
            edge.condition_expr
                .as_deref()
                .map(str::to_ascii_lowercase)
                .map(|condition| condition.contains(&outcome))
                .unwrap_or(false)
        })
        .collect();
    if !matched.is_empty() {
        return matched;
    }
    if let Some(default_edge) = outgoing_edges.iter().copied().find(|edge| edge.is_default) {
        return vec![default_edge];
    }
    if outcome == "approved" && tagged.is_empty() {
        return outgoing_edges.to_vec();
    }
    Vec::new()
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

fn resolve_approval_assignment(node: &NodeDef, context: &Value) -> Result<(String, Value)> {
    let approval_line = node.config.get("approvalLine").unwrap_or(&Value::Null);
    let legacy_approver_channel = node
        .config
        .get("approverChannel")
        .and_then(|value| value.as_str())
        .unwrap_or("pxm_user");
    let approval_channels = normalized_approval_channels(
        node.config.get("approvalChannels"),
        Some(legacy_approver_channel),
    )
    .unwrap_or_else(|_| vec!["pxm_user".to_string()]);
    let approver_channel = primary_approval_channel(&approval_channels);
    let external_require_otp = node
        .config
        .get("externalApprovalRequireOtp")
        .and_then(|value| value.as_bool())
        .unwrap_or(true);
    let external_expires_in_hours = node
        .config
        .get("externalApprovalExpiresInHours")
        .and_then(|value| value.as_u64())
        .unwrap_or(24)
        .clamp(1, 168);
    let model = approval_line
        .get("mode")
        .or_else(|| approval_line.get("type"))
        .or_else(|| node.config.get("approvalLineType"))
        .or_else(|| node.config.get("approvalType"))
        .and_then(|v| v.as_str())
        .unwrap_or("fixed")
        .to_ascii_lowercase();

    Ok(match model.as_str() {
        "condition" | "condition_based" | "conditional" => {
            let rules = approval_line
                .get("rules")
                .or_else(|| node.config.get("approvalRules"))
                .and_then(|v| v.as_array());
            let mut matched_rule = None;
            if let Some(rules) = rules {
                for rule in rules {
                    let condition = rule.get("condition").and_then(|v| v.as_str());
                    let assignee = rule.get("assignee").and_then(|v| v.as_str());
                    if let (Some(condition), Some(assignee)) = (condition, assignee) {
                        let matched = evaluate_condition(condition, context)?;
                        if matched && matched_rule.is_none() {
                            matched_rule = Some((condition, assignee));
                        }
                    }
                }
            }
            if let Some((condition, assignee)) = matched_rule {
                return Ok((
                    assignee.to_string(),
                    json!({
                        "approval_model": "condition",
                        "matched_condition": condition,
                        "assignee": assignee,
                        "approver_channel": approver_channel,
                        "approval_channels": approval_channels,
                        "external_require_otp": external_require_otp,
                        "external_expires_in_hours": external_expires_in_hours
                    }),
                ));
            }

            let assignee = approval_line
                .get("defaultAssignee")
                .or_else(|| approval_line.get("default_assignee"))
                .or_else(|| node.config.get("assignee"))
                .and_then(|v| v.as_str())
                .unwrap_or("admin");
            (
                assignee.to_string(),
                json!({
                    "approval_model": "condition",
                    "matched_condition": null,
                    "assignee": assignee,
                    "approver_channel": approver_channel,
                    "approval_channels": approval_channels,
                    "external_require_otp": external_require_otp,
                    "external_expires_in_hours": external_expires_in_hours
                }),
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
                    "assignee": assignee,
                    "approver_channel": approver_channel,
                    "approval_channels": approval_channels,
                    "external_require_otp": external_require_otp,
                    "external_expires_in_hours": external_expires_in_hours
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
                json!({
                    "approval_model": "fixed",
                    "assignee": assignee,
                    "approver_channel": approver_channel,
                    "approval_channels": approval_channels,
                    "external_require_otp": external_require_otp,
                    "external_expires_in_hours": external_expires_in_hours
                }),
            )
        }
    })
}

fn normalized_approval_channels(
    raw_channels: Option<&Value>,
    legacy_channel: Option<&str>,
) -> Result<Vec<String>> {
    let mut channels = Vec::new();
    if let Some(raw_channels) = raw_channels {
        let values = raw_channels
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("approval_channels must be an array"))?;
        if values.is_empty() {
            anyhow::bail!("approval_channels must not be empty");
        }
        for value in values {
            let channel = value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow::anyhow!("approval_channels must contain strings"))?;
            if channel != "pxm_user" && channel != "external_email" {
                anyhow::bail!("unsupported approval channel '{}'", channel);
            }
            if !channels.iter().any(|item| item == channel) {
                channels.push(channel.to_string());
            }
        }
    } else {
        let channel = legacy_channel.unwrap_or("pxm_user").trim();
        if channel != "pxm_user" && channel != "external_email" {
            anyhow::bail!("unsupported approval channel '{}'", channel);
        }
        channels.push(channel.to_string());
    }
    Ok(channels)
}

fn primary_approval_channel(channels: &[String]) -> String {
    if channels.iter().any(|channel| channel == "pxm_user") {
        "pxm_user".to_string()
    } else {
        channels
            .first()
            .cloned()
            .unwrap_or_else(|| "pxm_user".to_string())
    }
}

fn context_value_at_path<'a>(context: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.')
        .filter(|part| !part.is_empty())
        .try_fold(context, |value, part| value.get(part))
}

fn resolve_approval_definition(node: &NodeDef, context: &Value) -> Result<V2ApprovalDefinition> {
    let approval_line = node.config.get("approvalLine").unwrap_or(&Value::Null);
    let model = approval_line
        .get("mode")
        .or_else(|| node.config.get("approvalLineSource"))
        .or_else(|| node.config.get("approvalLineType"))
        .or_else(|| node.config.get("approvalType"))
        .and_then(Value::as_str)
        .unwrap_or("fixed")
        .to_ascii_lowercase();

    if model != "dynamic" {
        let (assignee, mut payload) = resolve_approval_assignment(node, context)?;
        let approval_channels = normalized_approval_channels(
            node.config.get("approvalChannels"),
            node.config
                .get("approverChannel")
                .and_then(Value::as_str)
                .or(Some("pxm_user")),
        )?;
        let approver_channel = primary_approval_channel(&approval_channels);
        if let Some(payload) = payload.as_object_mut() {
            payload.insert(
                "approver_channel".to_string(),
                Value::String(approver_channel.clone()),
            );
            payload.insert(
                "approval_channels".to_string(),
                serde_json::to_value(&approval_channels)?,
            );
        }
        if approval_channels
            .iter()
            .any(|channel| channel == "external_email")
        {
            let external_email = node
                .config
                .get("externalApprovalEmail")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    (!approval_channels.iter().any(|channel| channel == "pxm_user"))
                        .then_some(assignee.as_str())
                })
                .ok_or_else(|| anyhow::anyhow!("external approval email is required"))?;
            if !external_email.contains('@')
                || external_email.starts_with('@')
                || external_email.ends_with('@')
            {
                anyhow::bail!("external approval email is invalid");
            }
            if let Some(payload) = payload.as_object_mut() {
                payload.insert(
                    "external_email".to_string(),
                    Value::String(external_email.to_string()),
                );
            }
        }
        return Ok(V2ApprovalDefinition {
            source: json!({"type": "workflow_node"}),
            source_provider: None,
            external_request_id: None,
            external_revision: 1,
            payload_hash: None,
            content_snapshot: json!({}),
            approval_line_snapshot: json!({
                "mode": "fixed",
                "steps": [{"order": 1, "mode": "ALL", "approvers": [{
                    "assignee": assignee,
                    "approver_channel": approver_channel,
                    "approval_channels": approval_channels
                }]}]
            }),
            steps: vec![V2ApprovalStepInput {
                step_order: 1,
                mode: "ALL".to_string(),
                tasks: vec![V2ApprovalTaskInput {
                    assignee,
                    approver_channel,
                    approval_channels,
                    payload,
                }],
            }],
        });
    }

    let path = node
        .config
        .get("approvalRequestPath")
        .and_then(Value::as_str)
        .unwrap_or("approval_request");
    let form_data = get_form_data(context)
        .ok_or_else(|| anyhow::anyhow!("dynamic approval requires formData"))?;
    let request = context_value_at_path(form_data, path)
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow::anyhow!("dynamic approval request '{}' must be an object", path))?;
    let raw_source = request
        .get("source")
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("dynamic approval source is required"))?;
    let source_provider = match &raw_source {
        Value::String(value) => value.trim(),
        Value::Object(value) => value
            .get("provider")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or(""),
        _ => "",
    };
    if source_provider.is_empty()
        || source_provider.len() > 100
        || !source_provider
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        || !source_provider
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        anyhow::bail!("dynamic approval source.provider is invalid");
    }
    let source_provider = source_provider.to_string();
    let source = match raw_source {
        Value::Object(mut value) => {
            value.insert("provider".to_string(), Value::String(source_provider.clone()));
            Value::Object(value)
        }
        _ => json!({"provider": source_provider}),
    };
    let external_request_id = request
        .get("request_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("dynamic approval request_id is required"))?
        .to_string();
    let external_revision = request.get("revision").and_then(Value::as_i64).unwrap_or(1);
    if !(1..=i32::MAX as i64).contains(&external_revision) {
        anyhow::bail!("dynamic approval revision must be a positive integer");
    }
    let external_revision = external_revision as i32;
    let content = request
        .get("content")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow::anyhow!("dynamic approval content must be an object"))?;
    let content_snapshot = json!({
        "title": content.get("title").cloned().unwrap_or(Value::Null),
        "summary": content.get("summary").cloned().unwrap_or(Value::Null),
        "requester": content.get("requester").cloned().unwrap_or(Value::Null),
        "source_url": content.get("source_url").cloned().unwrap_or(Value::Null)
    });
    let line = request
        .get("approval_line")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow::anyhow!("dynamic approval approval_line must be an object"))?;
    let raw_steps = line
        .get("steps")
        .and_then(Value::as_array)
        .filter(|steps| !steps.is_empty())
        .ok_or_else(|| anyhow::anyhow!("dynamic approval steps must not be empty"))?;
    if raw_steps.len() > 100 {
        anyhow::bail!("dynamic approval supports at most 100 steps");
    }

    let default_channel = node
        .config
        .get("approverChannel")
        .and_then(Value::as_str)
        .unwrap_or("pxm_user");
    let default_channels = normalized_approval_channels(
        node.config.get("approvalChannels"),
        Some(default_channel),
    )?;
    let external_require_otp = node
        .config
        .get("externalApprovalRequireOtp")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let external_expires_in_hours = node
        .config
        .get("externalApprovalExpiresInHours")
        .and_then(Value::as_u64)
        .unwrap_or(24)
        .clamp(1, 168);
    let mut steps = Vec::with_capacity(raw_steps.len());
    let mut normalized_steps = Vec::with_capacity(raw_steps.len());
    for (index, raw_step) in raw_steps.iter().enumerate() {
        let step = raw_step
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("approval step {} must be an object", index + 1))?;
        let expected_order = (index + 1) as i32;
        let order = step
            .get("order")
            .and_then(Value::as_i64)
            .unwrap_or(expected_order as i64) as i32;
        if order != expected_order {
            anyhow::bail!("approval step order must be contiguous from 1");
        }
        let mode = step
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("ALL")
            .to_ascii_uppercase();
        if mode != "ALL" && mode != "ANY" {
            anyhow::bail!("approval step {} mode must be ALL or ANY", order);
        }
        let label = step.get("label").cloned().unwrap_or(Value::Null);
        let raw_approvers = step
            .get("approvers")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| vec![raw_step.clone()]);
        if raw_approvers.is_empty() {
            anyhow::bail!("approval step {} approvers must not be empty", order);
        }
        if raw_approvers.len() > 100 {
            anyhow::bail!("approval step {} supports at most 100 approvers", order);
        }
        let mut seen = HashSet::new();
        let mut tasks = Vec::with_capacity(raw_approvers.len());
        let mut normalized_approvers = Vec::with_capacity(raw_approvers.len());
        for raw_approver in raw_approvers {
            let approver = raw_approver
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("approval step {} approver must be an object", order))?;
            let approval_channels =
                if let Some(raw_channels) = approver.get("approval_channels") {
                    normalized_approval_channels(Some(raw_channels), None)
                } else if let Some(legacy_channel) =
                    approver.get("approver_channel").and_then(Value::as_str)
                {
                    normalized_approval_channels(None, Some(legacy_channel))
                } else {
                    Ok(default_channels.clone())
                }
                .map_err(|error| anyhow::anyhow!("approval step {}: {}", order, error))?;
            let approver_channel = primary_approval_channel(&approval_channels);
            let allows_pxm = approval_channels.iter().any(|channel| channel == "pxm_user");
            let allows_external = approval_channels
                .iter()
                .any(|channel| channel == "external_email");
            let principal = approver.get("principal").and_then(Value::as_object);
            let legacy_assignee = approver
                .get("assignee")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let principal_provider = principal
                .and_then(|value| value.get("provider"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(if allows_pxm { "pxm" } else { "email" })
                .to_string();
            let principal_subject = principal
                .and_then(|value| value.get("subject"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .or(legacy_assignee)
                .ok_or_else(|| anyhow::anyhow!("approval step {} principal.subject is required", order))?
                .to_string();
            if principal_provider.len() > 100 || principal_subject.len() > 200 {
                anyhow::bail!("approval step {} principal is too long", order);
            }
            let display_snapshot = approver
                .get("display")
                .cloned()
                .unwrap_or_else(|| json!({
                    "name": approver.get("name").cloned().unwrap_or(Value::Null),
                    "email": approver.get("email").cloned().unwrap_or(Value::Null),
                    "department": approver.get("department").cloned().unwrap_or(Value::Null)
                }));
            let principal_mapping_snapshot = approver
                .get("principal_mapping")
                .cloned()
                .unwrap_or(Value::Null);
            let pxm_user_id = approver
                .get("pxm_user_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let pxm_assignee = pxm_user_id
                .or_else(|| (principal_provider == "pxm").then_some(principal_subject.as_str()));
            if allows_pxm && pxm_assignee.is_none() {
                anyhow::bail!(
                    "approval step {} external principal requires pxm_user_id mapping for pxm_user channel",
                    order
                );
            }
            let external_email = approver
                .get("delivery")
                .and_then(Value::as_object)
                .and_then(|value| value.get("email"))
                .or_else(|| display_snapshot.get("email"))
                .or_else(|| approver.get("email"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    (principal_provider == "email" || principal_subject.contains('@'))
                        .then_some(principal_subject.as_str())
                });
            if allows_external
                && external_email.is_none_or(|email| {
                    !email.contains('@') || email.starts_with('@') || email.ends_with('@')
                })
            {
                anyhow::bail!("approval step {} has invalid external email", order);
            }
            let assignee = if allows_pxm {
                pxm_assignee.unwrap().to_string()
            } else {
                external_email.unwrap().to_string()
            };
            let principal_key = format!("{}:{}", principal_provider, principal_subject);
            if !seen.insert(principal_key.clone()) {
                anyhow::bail!("approval step {} has duplicate principal {}", order, principal_key);
            }
            let payload = json!({
                "approval_model": "dynamic",
                "step_order": order,
                "step_mode": mode,
                "step_label": label,
                "assignee": assignee,
                "approver_channel": approver_channel,
                "approval_channels": approval_channels,
                "principal": {
                    "provider": principal_provider,
                    "subject": principal_subject
                },
                "principal_mapping": principal_mapping_snapshot,
                "display_snapshot": display_snapshot,
                "pxm_user_id": pxm_user_id,
                "external_email": external_email,
                "content": content_snapshot,
                "external_require_otp": external_require_otp,
                "external_expires_in_hours": external_expires_in_hours
            });
            normalized_approvers.push(json!({
                "assignee": assignee,
                "approver_channel": approver_channel,
                "approval_channels": approval_channels,
                "principal": {
                    "provider": principal_provider,
                    "subject": principal_subject
                },
                "principal_mapping": principal_mapping_snapshot,
                "display_snapshot": display_snapshot,
                "pxm_user_id": pxm_user_id,
                "external_email": external_email
            }));
            tasks.push(V2ApprovalTaskInput {
                assignee,
                approver_channel,
                approval_channels,
                payload,
            });
        }
        normalized_steps.push(json!({
            "order": order,
            "mode": mode,
            "label": label,
            "approvers": normalized_approvers
        }));
        steps.push(V2ApprovalStepInput {
            step_order: order,
            mode,
            tasks,
        });
    }

    let approval_line_snapshot = json!({"mode": "sequential", "steps": normalized_steps});
    let payload_hash = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&json!({
                "source": source,
                "request_id": external_request_id,
                "revision": external_revision,
                "content": content_snapshot,
                "approval_line": approval_line_snapshot
            }))?
        )
    );
    Ok(V2ApprovalDefinition {
        source,
        source_provider: Some(source_provider),
        external_request_id: Some(external_request_id),
        external_revision,
        payload_hash: Some(payload_hash),
        content_snapshot,
        approval_line_snapshot,
        steps,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        execute_command_node, resolve_approval_assignment, resolve_approval_definition,
        select_approval_edges, select_gateway_edges, V2RetryPolicy,
    };
    use crate::v2::types::{EdgeRule, GatewayType, NodeDef};
    use serde_json::json;

    #[test]
    fn resolves_fixed_approval_assignee() {
        let node = NodeDef {
            node_id: "approval".to_string(),
            node_type: "approval".to_string(),
            config: json!({"approvalLine": {"mode": "fixed", "assignee": "manager"}}),
        };

        let (assignee, payload) = resolve_approval_assignment(&node, &json!({})).unwrap();
        assert_eq!(assignee, "manager");
        assert_eq!(payload["approval_model"], "fixed");
    }

    #[test]
    fn resolves_fixed_hybrid_approval_as_one_task() {
        let node = NodeDef {
            node_id: "approval".to_string(),
            node_type: "approval".to_string(),
            config: json!({
                "approvalLine": {"mode": "fixed", "assignee": "manager"},
                "approvalChannels": ["pxm_user", "external_email"],
                "externalApprovalEmail": "manager@example.com"
            }),
        };

        let definition = resolve_approval_definition(&node, &json!({})).unwrap();
        assert_eq!(definition.steps[0].tasks.len(), 1);
        assert_eq!(
            definition.steps[0].tasks[0].approval_channels,
            vec!["pxm_user".to_string(), "external_email".to_string()]
        );
        assert_eq!(
            definition.steps[0].tasks[0].payload["external_email"],
            "manager@example.com"
        );
    }

    #[test]
    fn resolves_dynamic_sequential_approval_snapshot() {
        let node = NodeDef {
            node_id: "approval".to_string(),
            node_type: "approval".to_string(),
            config: json!({"approvalType": "dynamic"}),
        };
        let context = json!({"data":{"formData":{"approval_request":{
            "source":"acrapoint",
            "request_id":"AP-42",
            "content":{"title":"구매 결재","summary":"노트북","requester":"kim","ignored":"drop"},
            "approval_line":{"steps":[
                {"order":1,"assignee":"lead"},
                {"order":2,"assignee":"director"}
            ]}
        }}}});

        let definition = resolve_approval_definition(&node, &context).unwrap();
        assert_eq!(definition.external_request_id.as_deref(), Some("AP-42"));
        assert_eq!(definition.steps.len(), 2);
        assert_eq!(definition.steps[1].step_order, 2);
        assert_eq!(definition.content_snapshot.get("ignored"), None);
    }

    #[test]
    fn rejects_non_contiguous_dynamic_approval_steps() {
        let node = NodeDef {
            node_id: "approval".to_string(),
            node_type: "approval".to_string(),
            config: json!({"approvalType": "dynamic"}),
        };
        let context = json!({"data":{"formData":{"approval_request":{
            "source":"acrapoint","request_id":"AP-42","content":{},
            "approval_line":{"steps":[{"order":2,"assignee":"lead"}]}
        }}}});

        assert!(resolve_approval_definition(&node, &context).is_err());
    }

    #[test]
    fn resolves_all_and_any_multi_approver_steps() {
        let node = NodeDef {
            node_id: "approval".to_string(),
            node_type: "approval".to_string(),
            config: json!({"approvalType": "dynamic"}),
        };
        let context = json!({"data":{"formData":{"approval_request":{
            "source":"acrapoint","request_id":"AP-43","content":{},
            "approval_line":{"steps":[
                {"order":1,"mode":"ALL","approvers":[
                    {"assignee":"lead-a"},{"assignee":"lead-b"}
                ]},
                {"order":2,"mode":"ANY","approvers":[
                    {"assignee":"director-a"},{"assignee":"director-b"}
                ]}
            ]}
        }}}});

        let definition = resolve_approval_definition(&node, &context).unwrap();
        assert_eq!(definition.steps[0].mode, "ALL");
        assert_eq!(definition.steps[0].tasks.len(), 2);
        assert_eq!(definition.steps[1].mode, "ANY");
        assert_eq!(definition.steps[1].tasks.len(), 2);
    }

    #[test]
    fn rejects_duplicate_approvers_in_the_same_step() {
        let node = NodeDef {
            node_id: "approval".to_string(),
            node_type: "approval".to_string(),
            config: json!({"approvalType": "dynamic"}),
        };
        let context = json!({"data":{"formData":{"approval_request":{
            "source":"acrapoint","request_id":"AP-44","content":{},
            "approval_line":{"steps":[{"order":1,"mode":"ALL","approvers":[
                {"assignee":"lead"},{"assignee":"lead"}
            ]}]}
        }}}});

        assert!(resolve_approval_definition(&node, &context).is_err());
    }

    #[test]
    fn normalizes_external_principal_and_keeps_display_as_snapshot() {
        let node = NodeDef {
            node_id: "approval".to_string(),
            node_type: "approval".to_string(),
            config: json!({"approvalType": "dynamic"}),
        };
        let context = json!({"data":{"formData":{"approval_request":{
            "source":{"provider":"acrapoint"},
            "request_id":"AP-45",
            "revision":3,
            "content":{"title":"구매 결재"},
            "approval_line":{"steps":[{"approvers":[{
                "principal":{"provider":"acrapoint","subject":"EMP-100"},
                "pxm_user_id":"pxm-user-7",
                "principal_mapping":{"id":"mapping-7","updated_at":"2026-08-03T00:00:00Z"},
                "display":{"name":"김승인","email":"kim@example.com","department":"재무팀"},
                "approver_channel":"pxm_user"
            }]}]}
        }}}});

        let definition = resolve_approval_definition(&node, &context).unwrap();
        assert_eq!(definition.source_provider.as_deref(), Some("acrapoint"));
        assert_eq!(definition.external_revision, 3);
        assert!(definition.payload_hash.is_some());
        assert_eq!(definition.steps[0].tasks[0].assignee, "pxm-user-7");
        assert_eq!(
            definition.steps[0].tasks[0].payload["principal"]["subject"],
            "EMP-100"
        );
        assert_eq!(
            definition.approval_line_snapshot["steps"][0]["approvers"][0]
                ["display_snapshot"]["department"],
            "재무팀"
        );
        assert_eq!(
            definition.approval_line_snapshot["steps"][0]["approvers"][0]
                ["principal_mapping"]["id"],
            "mapping-7"
        );
        assert_eq!(
            definition.steps[0].tasks[0].payload["principal_mapping"]["updated_at"],
            "2026-08-03T00:00:00Z"
        );
    }

    #[test]
    fn resolves_one_hybrid_task_with_pxm_assignee_and_external_email() {
        let node = NodeDef {
            node_id: "approval".to_string(),
            node_type: "approval".to_string(),
            config: json!({"approvalType": "dynamic"}),
        };
        let context = json!({"data":{"formData":{"approval_request":{
            "source":{"provider":"acrapoint"},
            "request_id":"AP-HYBRID-1",
            "content":{"title":"하이브리드 결재"},
            "approval_line":{"steps":[{"approvers":[{
                "principal":{"provider":"acrapoint","subject":"EMP-100"},
                "pxm_user_id":"pxm-user-7",
                "display":{"name":"김승인","email":"kim@example.com"},
                "approval_channels":["pxm_user","external_email"]
            }]}]}
        }}}});

        let definition = resolve_approval_definition(&node, &context).unwrap();
        assert_eq!(definition.steps[0].tasks.len(), 1);
        let task = &definition.steps[0].tasks[0];
        assert_eq!(task.assignee, "pxm-user-7");
        assert_eq!(
            task.approval_channels,
            vec!["pxm_user".to_string(), "external_email".to_string()]
        );
        assert_eq!(task.payload["external_email"], "kim@example.com");
        assert_eq!(task.payload["approver_channel"], "pxm_user");
    }

    #[test]
    fn allows_a_known_pxm_principal_to_use_email_only() {
        let node = NodeDef {
            node_id: "approval".to_string(),
            node_type: "approval".to_string(),
            config: json!({"approvalType": "dynamic"}),
        };
        let context = json!({"data":{"formData":{"approval_request":{
            "source":{"provider":"pxm"},
            "request_id":"AP-EMAIL-ONLY-1",
            "content":{},
            "approval_line":{"steps":[{"approvers":[{
                "principal":{"provider":"pxm","subject":"pxm-user-7"},
                "display":{"email":"kim@example.com"},
                "approval_channels":["external_email"]
            }]}]}
        }}}});

        let definition = resolve_approval_definition(&node, &context).unwrap();
        let task = &definition.steps[0].tasks[0];
        assert_eq!(task.assignee, "kim@example.com");
        assert_eq!(
            task.approval_channels,
            vec!["external_email".to_string()]
        );
    }

    #[test]
    fn rejects_hybrid_task_without_an_external_email() {
        let node = NodeDef {
            node_id: "approval".to_string(),
            node_type: "approval".to_string(),
            config: json!({"approvalType": "dynamic"}),
        };
        let context = json!({"data":{"formData":{"approval_request":{
            "source":{"provider":"acrapoint"},
            "request_id":"AP-HYBRID-BAD",
            "content":{},
            "approval_line":{"steps":[{"approvers":[{
                "principal":{"provider":"acrapoint","subject":"EMP-100"},
                "pxm_user_id":"pxm-user-7",
                "approval_channels":["pxm_user","external_email"]
            }]}]}
        }}}});

        assert!(resolve_approval_definition(&node, &context).is_err());
    }

    #[test]
    fn requires_mapping_when_external_principal_uses_pxm_channel() {
        let node = NodeDef {
            node_id: "approval".to_string(),
            node_type: "approval".to_string(),
            config: json!({"approvalType": "dynamic"}),
        };
        let context = json!({"data":{"formData":{"approval_request":{
            "source":{"provider":"acrapoint"},"request_id":"AP-46","content":{},
            "approval_line":{"steps":[{"approvers":[{
                "principal":{"provider":"acrapoint","subject":"EMP-100"},
                "approver_channel":"pxm_user"
            }]}]}
        }}}});

        assert!(resolve_approval_definition(&node, &context).is_err());
    }

    #[test]
    fn routes_approval_outcome_to_approved_and_rejected_edges() {
        let approved = EdgeRule {
            id: 1,
            source_node_id: "approval".to_string(),
            target_node_id: "approved-end".to_string(),
            condition_expr: Some("approved".to_string()),
            is_default: false,
            eval_order: 0,
        };
        let rejected = EdgeRule {
            id: 2,
            source_node_id: "approval".to_string(),
            target_node_id: "rejected-end".to_string(),
            condition_expr: Some("rejected".to_string()),
            is_default: false,
            eval_order: 1,
        };
        let edges = vec![&approved, &rejected];

        assert_eq!(
            select_approval_edges(&edges, "approved")[0].target_node_id,
            "approved-end"
        );
        assert_eq!(
            select_approval_edges(&edges, "rejected")[0].target_node_id,
            "rejected-end"
        );
    }

    /// PXM-41 회귀: 지원하지 않는 문법이 조용히 다른 조건으로 평가되면 안 된다.
    /// `amount >= 100`이 `amount > 0`으로 평가되어 잘못된 분기를 타던 사례다.
    #[test]
    fn evaluates_comparison_operators_without_silent_fallback() {
        let context = json!({"data": {"formData": {"amount": 50}}});
        let cases = [
            ("amount > 100", false),
            ("amount > 10", true),
            ("amount >= 100", false),
            ("amount >= 50", true),
            ("amount < 10", false),
            ("amount <= 10", false),
            ("amount <= 50", true),
        ];
        for (expr, expected) in cases {
            assert_eq!(
                super::evaluate_condition(expr, &context).unwrap(),
                expected,
                "조건식 {expr}"
            );
        }
    }

    /// `==`가 as_str()만 보던 탓에 숫자와 불리언 비교가 항상 거짓이었다.
    #[test]
    fn compares_strings_numbers_and_booleans() {
        let context = json!({"data": {"formData": {
            "amount": 50,
            "status": "approved",
            "message": "ready >= pending",
            "flag": true,
            "empty": null,
            "metadata": {"source": "form"}
        }}});
        let cases = [
            ("status == approved", true),
            ("status != approved", false),
            ("status != rejected", true),
            ("message == \"ready >= pending\"", true),
            ("amount == 50", true),
            ("amount != 50", false),
            ("amount == abc", false),
            ("amount != abc", false),
            ("flag == true", true),
            ("flag == false", false),
            ("flag != false", true),
            ("flag != nope", false),
            ("empty == null", true),
            ("empty != null", false),
            ("metadata != anything", false),
        ];
        for (expr, expected) in cases {
            assert_eq!(
                super::evaluate_condition(expr, &context).unwrap(),
                expected,
                "조건식 {expr}"
            );
        }
    }

    /// 없는 필드는 실행 중 정상적으로 생길 수 있으므로 false다. 오류가 아니다.
    #[test]
    fn treats_missing_field_as_false() {
        let context = json!({"data": {"formData": {"amount": 50}}});
        assert!(!super::evaluate_condition("missing == x", &context).unwrap());
        assert!(!super::evaluate_condition("missing > 1", &context).unwrap());
    }

    /// 문법 오류는 false로 흘리지 않고 오류로 올려 노드를 실패시킨다.
    #[test]
    fn rejects_malformed_condition_expressions() {
        let context = json!({"data": {"formData": {"amount": 50}}});
        for expr in [
            "amount",
            "amount >",
            "> 100",
            "amount ~ 100",
            "amount > abc",
            "amount > NaN",
            "amount === 50",
            "amount!==50",
            "status == \"approved",
            "status == \"approved\" junk",
            "status == approved && flag == true",
            "status == approved||flag",
            "nested.amount == 50",
            "field name == value",
            "",
        ] {
            assert!(
                super::evaluate_condition(expr, &context).is_err(),
                "조건식 {expr:?}는 오류여야 한다"
            );
        }
    }

    #[test]
    fn rejects_malformed_exclusive_condition_after_an_earlier_match() {
        let matched = EdgeRule {
            id: 1,
            source_node_id: "gateway".to_string(),
            target_node_id: "matched".to_string(),
            condition_expr: Some("amount > 10".to_string()),
            is_default: false,
            eval_order: 0,
        };
        let malformed = EdgeRule {
            id: 2,
            source_node_id: "gateway".to_string(),
            target_node_id: "invalid".to_string(),
            condition_expr: Some("amount === 50".to_string()),
            is_default: false,
            eval_order: 1,
        };
        let edges = vec![&matched, &malformed];

        assert!(select_gateway_edges(
            GatewayType::Exclusive,
            &edges,
            &json!({"data": {"formData": {"amount": 50}}}),
        )
        .is_err());
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
            resolve_approval_assignment(&node, &json!({"formData": {"amount": 150}})).unwrap();
        assert_eq!(assignee, "finance");
        assert_eq!(payload["matched_condition"], "amount > 100");
    }

    #[test]
    fn rejects_malformed_approval_condition_after_an_earlier_match() {
        let node = NodeDef {
            node_id: "approval".to_string(),
            node_type: "approval".to_string(),
            config: json!({
                "approvalLine": {
                    "mode": "condition",
                    "rules": [
                        {"condition": "amount > 100", "assignee": "finance"},
                        {"condition": "amount === 150", "assignee": "invalid"}
                    ],
                    "defaultAssignee": "manager"
                }
            }),
        };

        assert!(
            resolve_approval_assignment(&node, &json!({"formData": {"amount": 150}}),).is_err()
        );
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
            resolve_approval_assignment(&node, &json!({"formData": {"approver": "director"}}))
                .unwrap();
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

    #[tokio::test]
    async fn executes_builtin_echo_command_node() {
        let node = NodeDef {
            node_id: "cmd".to_string(),
            node_type: "command".to_string(),
            config: json!({
                "commandId": "builtin.echo",
                "commandArguments": {
                    "message": "hello"
                }
            }),
        };

        let output = execute_command_node(&node, &json!({}))
            .await
            .expect("command should run");
        assert_eq!(output["success"], true);
        assert_eq!(output["exit_code"], 0);
        assert_eq!(output["stdout"], "hello");
    }

    #[tokio::test]
    async fn rejects_unregistered_command_node() {
        let node = NodeDef {
            node_id: "cmd".to_string(),
            node_type: "command".to_string(),
            config: json!({
                "commandId": "missing.command"
            }),
        };

        let error = execute_command_node(&node, &json!({}))
            .await
            .expect_err("command must be denied");
        assert!(error.to_string().contains("not registered"));
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

        if instance.is_paused {
            println!(
                "[v2_engine] instance {} is paused; releasing job {}",
                instance.id, job.id
            );
            ctx.job_queue.release_job(job.id, 1.0, tx.as_mut()).await?;
            return Ok((false, true));
        }

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
            .load_definition_graph(
                instance.process_definition_id,
                instance_workflow_version(&instance.context),
            )
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
                &job.payload,
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

async fn fail_node_for_invalid_configuration(
    ctx: &V2RuntimeContext,
    instance: &mut V2Instance,
    token: &mut V2Token,
    reason: &str,
    error: &anyhow::Error,
    tx: &mut dyn Tx,
) -> Result<()> {
    token.status = TokenStatus::Failed;
    token.updated_at = Utc::now();
    ctx.token_repo
        .update_tokens(std::slice::from_ref(token), tx)
        .await?;

    instance.state = "FAILED".to_string();
    ctx.instance_repo
        .update_instance(instance.id, &instance.state, instance.context.clone(), tx)
        .await?;

    ctx.exec_log
        .append_log(
            instance.id,
            Some(token.id),
            Some(&token.node_id),
            "NODE_FAILED",
            json!({"reason": reason, "error": error.to_string()}),
            tx,
        )
        .await?;
    ctx.outbox
        .append_event(
            instance.id,
            Some(token.id),
            Some(&token.node_id),
            "INSTANCE_FAILED",
            json!({"reason": reason, "error": error.to_string()}),
            tx,
        )
        .await?;
    notify_waiting_parent_workflow_call(
        ctx,
        instance,
        "FAILED",
        json!({"reason": reason, "error": error.to_string()}),
        tx,
    )
    .await?;
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
    job_payload: &Value,
    tx: &mut dyn Tx,
) -> Result<()> {
    while let Some(mut token) = active_tokens.pop() {
        if token.status == TokenStatus::Consumed || token.status == TokenStatus::Failed {
            println!(
                "[v2_engine] skipping token {} at node {} because status is {:?}",
                token.id, token.node_id, token.status
            );
            continue;
        }

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
                    match select_gateway_edges(gateway_type, &next_edges, &instance.context) {
                        Ok(edges) => edges,
                        Err(error) => {
                            fail_node_for_invalid_configuration(
                                ctx,
                                instance,
                                &mut token,
                                "invalid_gateway_condition",
                                &error,
                                tx,
                            )
                            .await?;
                            active_tokens.clear();
                            continue;
                        }
                    };

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
                // 1) 결재 전체 상태 확인 (재진입 시나리오)
                let approval_request = ctx
                    .task_repo
                    .find_approval_request_by_token(token.id, tx)
                    .await?;

                if let Some(request) = approval_request {
                    if request.status == "APPROVED" || request.status == "REJECTED" {
                        println!(
                            "[v2_engine] ✅ Approval Request is {}, moving next.",
                            request.status
                        );

                        ctx.exec_log
                            .append_log(
                                instance.id,
                                Some(token.id),
                                Some(&token.node_id),
                                "NODE_COMPLETED",
                                json!({
                                    "approval_request_id": request.id,
                                    "approval_status": request.status
                                }),
                                tx,
                            )
                            .await?;

                        token.status = TokenStatus::Consumed;
                        token.updated_at = Utc::now();
                        ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                        let outcome = request.status.to_ascii_lowercase();
                        set_context_value_at_path(
                            &mut instance.context,
                            &format!("data.outputs.{}", token.node_id),
                            json!({
                                "approval_request_id": request.id,
                                "status": request.status,
                                "outcome": outcome
                            }),
                        );
                        let next_edges: Vec<&EdgeRule> = edges
                            .iter()
                            .filter(|e| e.source_node_id == token.node_id)
                            .collect();
                        let selected_edges = select_approval_edges(&next_edges, &outcome);

                        if selected_edges.is_empty() && request.status == "REJECTED" {
                            instance.state = "COMPLETED".to_string();
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
                                    "INSTANCE_COMPLETED",
                                    json!({
                                        "outcome": "rejected",
                                        "approval_request_id": request.id
                                    }),
                                    tx,
                                )
                                .await?;
                            notify_waiting_parent_workflow_call(
                                ctx,
                                instance,
                                "COMPLETED",
                                json!({
                                    "outcome": "rejected",
                                    "approval_request_id": request.id
                                }),
                                tx,
                            )
                            .await?;
                            continue;
                        }

                        instance.state = "RUNNING".to_string();
                        ctx.instance_repo
                            .update_instance(
                                instance.id,
                                &instance.state,
                                instance.context.clone(),
                                tx,
                            )
                            .await?;
                        for edge in selected_edges {
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

                    if request.status == "PENDING" || request.status == "IN_PROGRESS" {
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
                let request_id = Uuid::new_v4();
                let approval_definition = match resolve_approval_definition(node, &instance.context)
                {
                    Ok(definition) => definition,
                    Err(error) => {
                        fail_node_for_invalid_configuration(
                            ctx,
                            instance,
                            &mut token,
                            "invalid_approval_configuration",
                            &error,
                            tx,
                        )
                        .await?;
                        active_tokens.clear();
                        continue;
                    }
                };
                let approval = ctx
                    .task_repo
                    .find_or_create_approval(
                        request_id,
                        task_id,
                        instance.id,
                        token.id,
                        &token.node_id,
                        approval_definition,
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

                for task in &approval.tasks {
                    ctx.outbox
                        .append_event(
                            instance.id,
                            Some(token.id),
                            Some(&token.node_id),
                            "TASK_CREATED",
                            json!({
                                "approval_request_id": approval.request.id,
                                "approval_step_order": approval.request.current_step_order,
                                "task_id": task.id,
                                "assignee": task.assignee,
                                "approval": task.payload
                            }),
                            tx,
                        )
                        .await?;
                }

                ctx.outbox
                    .append_event(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "INSTANCE_WAITING",
                        json!({
                            "state": "WAITING",
                            "approval_request_id": approval.request.id,
                            "task_ids": approval.tasks.iter().map(|task| task.id).collect::<Vec<_>>()
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
                if token.status == TokenStatus::Waiting
                    && job_payload
                        .get("workflow_call_timeout")
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false)
                {
                    token.status = TokenStatus::Failed;
                    token.updated_at = Utc::now();
                    ctx.token_repo.update_tokens(&[token.clone()], tx).await?;

                    instance.state = "FAILED".to_string();
                    ctx.instance_repo
                        .update_instance(instance.id, &instance.state, instance.context.clone(), tx)
                        .await?;
                    ctx.exec_log
                        .append_log(
                            instance.id,
                            Some(token.id),
                            Some(&token.node_id),
                            "NODE_FAILED",
                            json!({
                                "reason": "workflow_call_timeout",
                                "child_instance_id": job_payload.get("child_instance_id").cloned().unwrap_or(Value::Null)
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
                            json!({
                                "reason": "workflow_call_timeout",
                                "child_instance_id": job_payload.get("child_instance_id").cloned().unwrap_or(Value::Null)
                            }),
                            tx,
                        )
                        .await?;
                    continue;
                }

                if token.status == TokenStatus::Waiting
                    && job_payload
                        .get("workflow_call_resume")
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false)
                {
                    let child_status = job_payload
                        .get("child_status")
                        .and_then(|value| value.as_str())
                        .unwrap_or("UNKNOWN");
                    let child_instance_id = job_payload
                        .get("child_instance_id")
                        .cloned()
                        .unwrap_or(Value::Null);
                    let child_result = job_payload
                        .get("child_result")
                        .cloned()
                        .unwrap_or(Value::Null);
                    ctx.job_queue
                        .complete_queued_jobs_for_token(instance.id, token.id, tx)
                        .await?;

                    if child_status == "COMPLETED" {
                        let output_path = workflow_call_output_path(node);
                        let output = json!({
                            "child_instance_id": child_instance_id,
                            "child_status": child_status,
                            "child_result": child_result,
                            "call_mode": "wait",
                            "status": "COMPLETED"
                        });
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
                                json!({"output_path": output_path, "output": output.clone()}),
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
                    } else {
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
                                    "reason": "workflow_call_child_failed",
                                    "child_instance_id": child_instance_id,
                                    "child_status": child_status,
                                    "child_result": child_result
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
                                json!({
                                    "reason": "workflow_call_child_failed",
                                    "child_instance_id": child_instance_id
                                }),
                                tx,
                            )
                            .await?;
                    }
                    continue;
                }

                ctx.exec_log
                    .append_log(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "NODE_STARTED",
                        json!({"call_mode": workflow_call_mode(node)}),
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
                    let call_mode = workflow_call_mode(node);
                    let (child_nodes, _, child_workflow_version) = ctx
                        .def_repo
                        .load_active_definition_graph(target_definition_id)
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
                            "call_mode": call_mode,
                            "call_depth": current_depth + 1,
                            "snapshot": {
                                "workflow": {
                                    "id": target_definition_id,
                                    "version": child_workflow_version
                                }
                            },
                            "access": {
                                "workflow_version_id": format!("{}:{}", target_definition_id, child_workflow_version)
                            }
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
                        "call_mode": call_mode,
                        "call_depth": current_depth + 1,
                        "status": "STARTED"
                    }))
                }
                .await;

                match call_result {
                    Ok(output) => {
                        let output_path = workflow_call_output_path(node);
                        let is_wait_call = output.get("call_mode").and_then(|value| value.as_str())
                            == Some("wait");
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

                        ctx.outbox
                            .append_event(
                                instance.id,
                                Some(token.id),
                                Some(&token.node_id),
                                "WORKFLOW_CALLED",
                                output.clone(),
                                tx,
                            )
                            .await?;

                        if is_wait_call {
                            let child_instance_id = output
                                .get("child_instance_id")
                                .cloned()
                                .unwrap_or(Value::Null);
                            ctx.exec_log
                                .append_log(
                                    instance.id,
                                    Some(token.id),
                                    Some(&token.node_id),
                                    "NODE_WAITING",
                                    json!({"output_path": output_path, "output": output.clone()}),
                                    tx,
                                )
                                .await?;
                            token.status = TokenStatus::Waiting;
                            token.updated_at = Utc::now();
                            ctx.token_repo.update_tokens(&[token.clone()], tx).await?;
                            ctx.job_queue
                                .enqueue_job(
                                    instance.id,
                                    Some(token.id),
                                    JobType::Resume,
                                    workflow_call_wait_timeout_sec(node),
                                    0,
                                    json!({
                                        "reason": "workflow_call_timeout",
                                        "workflow_call_timeout": true,
                                        "completed_node_id": token.node_id,
                                        "child_instance_id": child_instance_id
                                    }),
                                    tx,
                                )
                                .await?;

                            instance.state = "WAITING".to_string();
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
                                    "INSTANCE_WAITING",
                                    json!({
                                        "state": "WAITING",
                                        "reason": "workflow_call_wait",
                                        "child_instance_id": output.get("child_instance_id")
                                    }),
                                    tx,
                                )
                                .await?;
                            continue;
                        }

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
                        notify_waiting_parent_workflow_call(
                            ctx,
                            instance,
                            "FAILED",
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
                            notify_waiting_parent_workflow_call(
                                ctx,
                                instance,
                                "FAILED",
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
                    Ok(js) if js.success => {
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
                            js.output.clone(),
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
                                    "output": js.output,
                                    "console": js.console
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
                    Ok(js) => {
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
                                    "reason": js.error_message.unwrap_or_else(|| "JS node execution failed".to_string()),
                                    "console": js.console
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
                        notify_waiting_parent_workflow_call(
                            ctx,
                            instance,
                            "FAILED",
                            json!({"reason": "script_node_failed"}),
                            tx,
                        )
                        .await?;
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
                                    "reason": err.to_string(),
                                    "console": []
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
                        notify_waiting_parent_workflow_call(
                            ctx,
                            instance,
                            "FAILED",
                            json!({"reason": "script_node_failed"}),
                            tx,
                        )
                        .await?;
                    }
                }
            }

            "command" => {
                ctx.exec_log
                    .append_log(
                        instance.id,
                        Some(token.id),
                        Some(&token.node_id),
                        "NODE_STARTED",
                        json!({
                            "command_id": node
                                .config
                                .get("commandId")
                                .or_else(|| node.config.get("command_id"))
                                .and_then(|value| value.as_str())
                                .unwrap_or("")
                        }),
                        tx,
                    )
                    .await?;

                match execute_command_node(node, &instance.context).await {
                    Ok(output) => {
                        let output_path = node
                            .config
                            .get("outputPath")
                            .or_else(|| node.config.get("output_path"))
                            .and_then(|value| value.as_str())
                            .filter(|value| !value.trim().is_empty())
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| format!("commandResults.{}", token.node_id));

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
                                    "command_id": output.get("command_id").cloned().unwrap_or(Value::Null),
                                    "output_path": output_path,
                                    "exit_code": output.get("exit_code").cloned().unwrap_or(Value::Null),
                                    "timed_out": output.get("timed_out").cloned().unwrap_or(Value::Bool(false)),
                                    "duration_ms": output.get("duration_ms").cloned().unwrap_or(Value::Null)
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
                                    "command_id": node
                                        .config
                                        .get("commandId")
                                        .or_else(|| node.config.get("command_id"))
                                        .and_then(|value| value.as_str())
                                        .unwrap_or(""),
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
                                json!({"reason": "command_node_failed"}),
                                tx,
                            )
                            .await?;
                        notify_waiting_parent_workflow_call(
                            ctx,
                            instance,
                            "FAILED",
                            json!({"reason": "command_node_failed"}),
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
                        json!({"result_path": result_path, "result": completed_result.clone()}),
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
                    notify_waiting_parent_workflow_call(
                        ctx,
                        instance,
                        "COMPLETED",
                        completed_result,
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
