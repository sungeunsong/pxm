use std::{collections::HashMap, time::Duration};

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use reqwest::Method;
use serde_json::{json, Value};

use crate::v2::ports::{PluginExecutionResult, PluginExecutorPort, PluginInvocation};

pub struct PluginExecutorRegistry {
    handlers: HashMap<String, ConnectorHandler>,
}

impl PluginExecutorRegistry {
    pub fn new_default() -> Result<Self> {
        let http_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()?;

        let mut registry = Self {
            handlers: HashMap::new(),
        };

        registry.register_aliases(
            &["builtin.http_request"],
            ConnectorHandler::HttpRequest(HttpRequestExecutor { http_client }),
        );
        registry.register_aliases(
            &["connector.slack", "connector.slack.send_message"],
            ConnectorHandler::Mock(MockConnectorExecutor {
                kind: MockConnectorKind::Slack,
            }),
        );
        registry.register_aliases(
            &[
                "connector.acra",
                "connector.acra.grant_permission",
                "connector.acra.revoke_permission",
            ],
            ConnectorHandler::Mock(MockConnectorExecutor {
                kind: MockConnectorKind::Acra,
            }),
        );
        registry.register_aliases(
            &[
                "connector.nit",
                "connector.nit.create_issue",
                "connector.nit.register_wiki_candidate",
            ],
            ConnectorHandler::Mock(MockConnectorExecutor {
                kind: MockConnectorKind::Nit,
            }),
        );

        Ok(registry)
    }

    fn register_aliases(&mut self, plugin_ids: &[&str], handler: ConnectorHandler) {
        for plugin_id in plugin_ids {
            self.handlers
                .insert((*plugin_id).to_string(), handler.clone());
        }
    }
}

#[async_trait]
impl PluginExecutorPort for PluginExecutorRegistry {
    async fn execute(&self, mut invocation: PluginInvocation) -> Result<PluginExecutionResult> {
        let handler = self.handlers.get(&invocation.plugin_id).ok_or_else(|| {
            anyhow!(
                "plugin '{}' is not registered with the current PluginExecutorRegistry",
                invocation.plugin_id
            )
        })?;

        invocation.config = resolve_config_secrets(&invocation.config)?;
        handler.execute(invocation).await
    }
}

#[derive(Clone)]
enum ConnectorHandler {
    HttpRequest(HttpRequestExecutor),
    Mock(MockConnectorExecutor),
}

impl ConnectorHandler {
    async fn execute(&self, invocation: PluginInvocation) -> Result<PluginExecutionResult> {
        match self {
            Self::HttpRequest(executor) => executor.execute(invocation).await,
            Self::Mock(executor) => executor.execute(invocation).await,
        }
    }
}

#[derive(Clone)]
struct HttpRequestExecutor {
    http_client: reqwest::Client,
}

impl HttpRequestExecutor {
    async fn execute(&self, invocation: PluginInvocation) -> Result<PluginExecutionResult> {
        let url = invocation
            .config
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("builtin.http_request requires config.url"))?;

        let method = invocation
            .config
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("GET")
            .parse::<Method>()?;

        let mut request = self.http_client.request(method, url);

        if let Some(headers) = parse_json_object(invocation.config.get("headers"))? {
            for (key, value) in headers {
                if let Some(value) = value.as_str() {
                    request = request.header(key, value);
                }
            }
        }

        if let Some(body) = invocation.config.get("body") {
            request = request.json(body);
        }

        let resp = request.send().await?;
        let status = resp.status().as_u16();
        if (200..300).contains(&status) {
            Ok(PluginExecutionResult {
                status_code: status,
                output: json!({
                    "url": url,
                    "plugin_id": invocation.plugin_id,
                    "node_id": invocation.node_id,
                }),
            })
        } else {
            Err(anyhow!("plugin returned non-success status: {}", status))
        }
    }
}

#[derive(Clone)]
struct MockConnectorExecutor {
    kind: MockConnectorKind,
}

impl MockConnectorExecutor {
    async fn execute(&self, invocation: PluginInvocation) -> Result<PluginExecutionResult> {
        match self.kind {
            MockConnectorKind::Slack => Ok(PluginExecutionResult {
                status_code: 200,
                output: json!({
                    "mock": true,
                    "connector": "slack",
                    "message": invocation.config.get("message").cloned().unwrap_or(Value::Null),
                    "instance_id": invocation.instance_id,
                    "token_id": invocation.token_id,
                    "attempt": invocation.attempt,
                }),
            }),
            MockConnectorKind::Acra => Ok(PluginExecutionResult {
                status_code: 200,
                output: json!({
                    "mock": true,
                    "connector": "acra",
                    "decision": "approved",
                    "instance_id": invocation.instance_id,
                    "token_id": invocation.token_id,
                }),
            }),
            MockConnectorKind::Nit => Ok(PluginExecutionResult {
                status_code: 200,
                output: json!({
                    "mock": true,
                    "connector": "nit",
                    "ticket": format!("NIT-{}", &invocation.token_id.to_string()[..8]),
                    "instance_id": invocation.instance_id,
                    "token_id": invocation.token_id,
                }),
            }),
        }
    }
}

#[derive(Clone, Copy)]
enum MockConnectorKind {
    Slack,
    Acra,
    Nit,
}

fn parse_json_object(value: Option<&Value>) -> Result<Option<serde_json::Map<String, Value>>> {
    let Some(value) = value else {
        return Ok(None);
    };

    if let Some(object) = value.as_object() {
        return Ok(Some(object.clone()));
    }

    if let Some(text) = value.as_str() {
        if text.trim().is_empty() {
            return Ok(None);
        }
        let parsed: Value = serde_json::from_str(text)?;
        if let Some(object) = parsed.as_object() {
            return Ok(Some(object.clone()));
        }
        return Err(anyhow!("expected headers to be a JSON object"));
    }

    Err(anyhow!("expected headers to be a JSON object"))
}

fn resolve_config_secrets(config: &Value) -> Result<Value> {
    let mut resolved = resolve_secret_values(config)?;

    if let Some(secrets_ref) = config.get("secrets_ref").and_then(|v| v.as_object()) {
        let mut secrets = serde_json::Map::new();
        for (name, secret_ref) in secrets_ref {
            let secret_ref = secret_ref
                .as_str()
                .ok_or_else(|| anyhow!("secrets_ref.{} must be a string", name))?;
            secrets.insert(name.clone(), Value::String(resolve_secret_ref(secret_ref)?));
        }

        if let Some(object) = resolved.as_object_mut() {
            object.remove("secrets_ref");
            object.insert("secrets".to_string(), Value::Object(secrets));
        }
    }

    Ok(resolved)
}

fn resolve_secret_values(value: &Value) -> Result<Value> {
    match value {
        Value::String(text) if is_secret_ref(text) => Ok(Value::String(resolve_secret_ref(text)?)),
        Value::Array(items) => items
            .iter()
            .map(resolve_secret_values)
            .collect::<Result<Vec<_>>>()
            .map(Value::Array),
        Value::Object(object) => object
            .iter()
            .map(|(key, value)| Ok((key.clone(), resolve_secret_values(value)?)))
            .collect::<Result<serde_json::Map<String, Value>>>()
            .map(Value::Object),
        _ => Ok(value.clone()),
    }
}

fn resolve_secret_ref(secret_ref: &str) -> Result<String> {
    let env_name = secret_ref_to_env_name(secret_ref)?;
    std::env::var(&env_name).map_err(|_| {
        anyhow!(
            "secret reference '{}' could not be resolved from environment variable {}",
            secret_ref,
            env_name
        )
    })
}

fn secret_ref_to_env_name(secret_ref: &str) -> Result<String> {
    if let Some(env_name) = secret_ref.strip_prefix("env://") {
        if env_name.is_empty() {
            return Err(anyhow!("env secret reference must include a variable name"));
        }
        return Ok(env_name.to_string());
    }

    let Some(path) = secret_ref.strip_prefix("secret://") else {
        return Err(anyhow!("unsupported secret reference '{}'", secret_ref));
    };
    let path_without_version = path.split('@').next().unwrap_or(path);
    let normalized = path_without_version
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();

    if normalized.is_empty() {
        return Err(anyhow!("secret reference must include a non-empty path"));
    }

    Ok(format!("PXM_SECRET_{}", normalized))
}

fn is_secret_ref(value: &str) -> bool {
    value.starts_with("secret://") || value.starts_with("env://")
}

#[cfg(test)]
mod tests {
    use super::secret_ref_to_env_name;

    #[test]
    fn maps_secret_uri_to_prefixed_env_name() {
        assert_eq!(
            secret_ref_to_env_name("secret://acra/api_token@1").unwrap(),
            "PXM_SECRET_ACRA_API_TOKEN"
        );
    }

    #[test]
    fn keeps_explicit_env_reference() {
        assert_eq!(
            secret_ref_to_env_name("env://SLACK_BOT_TOKEN").unwrap(),
            "SLACK_BOT_TOKEN"
        );
    }
}
