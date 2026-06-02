use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::v2::ports::{PluginExecutionResult, PluginExecutorPort, PluginInvocation};

pub struct PluginExecutorRegistry {
    handlers: HashMap<String, ConnectorHandler>,
}

impl PluginExecutorRegistry {
    pub fn new_default() -> Result<Self> {
        let plugin_host_url = std::env::var("PXM_PLUGIN_HOST_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:3010".to_string());
        let manifests = PluginManifestRegistry::load_default()?;

        let mut registry = Self {
            handlers: HashMap::new(),
        };

        for manifest in manifests.latest_manifests() {
            registry.register_manifest(manifest, &plugin_host_url)?;
        }

        registry.register_dev_mock_aliases();

        Ok(registry)
    }

    fn register_manifest(&mut self, manifest: PluginManifest, plugin_host_url: &str) -> Result<()> {
        let timeout = manifest.timeout();
        let handler = match manifest.executor_type.as_str() {
            "builtin" if manifest.plugin_id == "builtin.http_request" => {
                ConnectorHandler::HttpRequest(HttpRequestExecutor {
                    http_client: reqwest::Client::builder().timeout(timeout).build()?,
                    manifest,
                })
            }
            "builtin" => {
                return Err(anyhow!(
                    "builtin plugin '{}' is not supported by pxm-engine",
                    manifest.plugin_id
                ));
            }
            "hosted" => ConnectorHandler::Hosted(HostedPluginExecutor {
                http_client: reqwest::Client::builder().timeout(timeout).build()?,
                plugin_host_url: plugin_host_url.to_string(),
                manifest,
            }),
            "external_http" => ConnectorHandler::ExternalHttp(ExternalHttpPluginExecutor {
                http_client: reqwest::Client::builder().timeout(timeout).build()?,
                manifest,
            }),
            "mock" => ConnectorHandler::Mock(MockConnectorExecutor::from_manifest(manifest)?),
            other => {
                return Err(anyhow!(
                    "unsupported executor_type '{}' for plugin '{}'",
                    other,
                    manifest.plugin_id
                ));
            }
        };

        self.handlers
            .insert(handler.plugin_id().to_string(), handler);
        Ok(())
    }

    fn register_dev_mock_aliases(&mut self) {
        self.register_aliases(
            &["connector.slack"],
            ConnectorHandler::Mock(MockConnectorExecutor::legacy(
                "connector.slack",
                MockConnectorKind::Slack,
            )),
        );
        self.register_aliases(
            &["connector.acra", "connector.acra.revoke_permission"],
            ConnectorHandler::Mock(MockConnectorExecutor::legacy(
                "connector.acra",
                MockConnectorKind::Acra,
            )),
        );
        self.register_aliases(
            &["connector.nit", "connector.nit.register_wiki_candidate"],
            ConnectorHandler::Mock(MockConnectorExecutor::legacy(
                "connector.nit",
                MockConnectorKind::Nit,
            )),
        );
    }

    fn register_aliases(&mut self, plugin_ids: &[&str], handler: ConnectorHandler) {
        for plugin_id in plugin_ids {
            self.handlers
                .insert((*plugin_id).to_string(), handler.clone());
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct PluginManifestRegistry {
    manifests: HashMap<String, Vec<PluginManifest>>,
}

impl PluginManifestRegistry {
    fn load_default() -> Result<Self> {
        let manifest_dir = resolve_manifest_dir()?;
        Self::load_from_dir(&manifest_dir)
    }

    fn load_from_dir(manifest_dir: &Path) -> Result<Self> {
        let mut manifests: HashMap<String, Vec<PluginManifest>> = HashMap::new();
        let mut files = fs::read_dir(manifest_dir)?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
            .collect::<Vec<_>>();
        files.sort();

        for file in files {
            let raw = fs::read_to_string(&file)?;
            let manifest: PluginManifest = serde_json::from_str(&raw)
                .map_err(|err| anyhow!("{}: invalid plugin manifest: {}", file.display(), err))?;
            manifest.validate(&file)?;
            manifests
                .entry(manifest.plugin_id.clone())
                .or_default()
                .push(manifest);
        }

        for versions in manifests.values_mut() {
            versions.sort_by(|a, b| compare_semver_desc(&a.version, &b.version));
        }

        Ok(Self { manifests })
    }

    fn latest_manifests(&self) -> Vec<PluginManifest> {
        self.manifests
            .values()
            .filter_map(|versions| versions.first().cloned())
            .collect()
    }
}

#[derive(Debug, Clone, Deserialize)]
struct PluginManifest {
    plugin_id: String,
    version: String,
    executor_type: String,
    executor_ref: String,
    #[serde(default)]
    secrets_policy: PluginSecretsPolicy,
    timeout_ms: Option<u64>,
    retry_policy: Option<PluginRetryPolicy>,
}

impl PluginManifest {
    fn validate(&self, file: &Path) -> Result<()> {
        if self.plugin_id.trim().is_empty() {
            return Err(anyhow!("{}: plugin_id must not be empty", file.display()));
        }
        if self.version.trim().is_empty() {
            return Err(anyhow!("{}: version must not be empty", file.display()));
        }
        if self.executor_type.trim().is_empty() {
            return Err(anyhow!(
                "{}: executor_type must not be empty",
                file.display()
            ));
        }
        if self.executor_ref.trim().is_empty() {
            return Err(anyhow!(
                "{}: executor_ref must not be empty",
                file.display()
            ));
        }
        Ok(())
    }

    fn timeout(&self) -> Duration {
        Duration::from_millis(self.timeout_ms.unwrap_or(5_000).max(1))
    }

    fn legacy_mock(plugin_id: &str) -> Self {
        Self {
            plugin_id: plugin_id.to_string(),
            version: "0.0.0".to_string(),
            executor_type: "mock".to_string(),
            executor_ref: plugin_id.to_string(),
            secrets_policy: PluginSecretsPolicy::default(),
            timeout_ms: Some(5_000),
            retry_policy: None,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
struct PluginSecretsPolicy {
    #[serde(default)]
    required: HashMap<String, String>,
    #[serde(default)]
    optional: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct PluginRetryPolicy {
    max_attempts: Option<i32>,
    backoff_ms: Option<u64>,
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

        invocation.config = handler.prepare_config(&invocation.config)?;
        handler.execute(invocation).await
    }
}

#[derive(Clone)]
enum ConnectorHandler {
    HttpRequest(HttpRequestExecutor),
    Hosted(HostedPluginExecutor),
    ExternalHttp(ExternalHttpPluginExecutor),
    Mock(MockConnectorExecutor),
}

impl ConnectorHandler {
    fn plugin_id(&self) -> &str {
        match self {
            Self::HttpRequest(executor) => &executor.manifest.plugin_id,
            Self::Hosted(executor) => &executor.manifest.plugin_id,
            Self::ExternalHttp(executor) => &executor.manifest.plugin_id,
            Self::Mock(executor) => &executor.manifest.plugin_id,
        }
    }

    fn prepare_config(&self, config: &Value) -> Result<Value> {
        let manifest = match self {
            Self::HttpRequest(executor) => &executor.manifest,
            Self::Hosted(executor) => &executor.manifest,
            Self::ExternalHttp(executor) => &executor.manifest,
            Self::Mock(executor) => &executor.manifest,
        };
        prepare_config(config, manifest)
    }

    async fn execute(&self, invocation: PluginInvocation) -> Result<PluginExecutionResult> {
        match self {
            Self::HttpRequest(executor) => executor.execute(invocation).await,
            Self::Hosted(executor) => executor.execute(invocation).await,
            Self::ExternalHttp(executor) => executor.execute(invocation).await,
            Self::Mock(executor) => executor.execute(invocation).await,
        }
    }
}

#[derive(Clone)]
struct HttpRequestExecutor {
    http_client: reqwest::Client,
    manifest: PluginManifest,
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
struct HostedPluginExecutor {
    http_client: reqwest::Client,
    plugin_host_url: String,
    manifest: PluginManifest,
}

impl HostedPluginExecutor {
    async fn execute(&self, invocation: PluginInvocation) -> Result<PluginExecutionResult> {
        let url = format!("{}/invoke", self.plugin_host_url.trim_end_matches('/'));
        let (config, secrets) = split_resolved_secrets(invocation.config);

        let response = self
            .http_client
            .post(url)
            .json(&json!({
                "plugin_id": invocation.plugin_id,
                "instance": {
                    "id": invocation.instance_id,
                },
                "node": {
                    "id": invocation.node_id,
                    "token_id": invocation.token_id,
                },
                "config": config,
                "context": invocation.context,
                "secrets": secrets,
                "attempt": invocation.attempt,
                "retry": self.manifest.retry_policy,
            }))
            .send()
            .await?;

        parse_plugin_contract_response(invocation.plugin_id.as_str(), response).await
    }
}

#[derive(Clone)]
struct ExternalHttpPluginExecutor {
    http_client: reqwest::Client,
    manifest: PluginManifest,
}

impl ExternalHttpPluginExecutor {
    async fn execute(&self, invocation: PluginInvocation) -> Result<PluginExecutionResult> {
        let endpoint = if self.manifest.executor_ref.starts_with("http://")
            || self.manifest.executor_ref.starts_with("https://")
        {
            self.manifest.executor_ref.as_str()
        } else {
            return Err(anyhow!(
                "external_http plugin '{}' requires executor_ref to be an absolute HTTP URL",
                self.manifest.plugin_id
            ));
        };
        let (config, secrets) = split_resolved_secrets(invocation.config);

        let response = self
            .http_client
            .post(endpoint)
            .json(&json!({
                "plugin_id": invocation.plugin_id,
                "instance": {
                    "id": invocation.instance_id,
                },
                "node": {
                    "id": invocation.node_id,
                    "token_id": invocation.token_id,
                },
                "config": config,
                "context": invocation.context,
                "secrets": secrets,
                "attempt": invocation.attempt,
                "retry": self.manifest.retry_policy,
            }))
            .send()
            .await?;

        parse_plugin_contract_response(invocation.plugin_id.as_str(), response).await
    }
}

#[derive(Clone)]
struct MockConnectorExecutor {
    manifest: PluginManifest,
    kind: MockConnectorKind,
}

impl MockConnectorExecutor {
    fn from_manifest(manifest: PluginManifest) -> Result<Self> {
        let kind = MockConnectorKind::from_plugin_id(&manifest.plugin_id).ok_or_else(|| {
            anyhow!(
                "mock plugin '{}' has no local mock executor",
                manifest.plugin_id
            )
        })?;
        Ok(Self { manifest, kind })
    }

    fn legacy(plugin_id: &str, kind: MockConnectorKind) -> Self {
        Self {
            manifest: PluginManifest::legacy_mock(plugin_id),
            kind,
        }
    }

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

impl MockConnectorKind {
    fn from_plugin_id(plugin_id: &str) -> Option<Self> {
        match plugin_id {
            "connector.slack" | "connector.slack.send_message" => Some(Self::Slack),
            "connector.acra"
            | "connector.acra.grant_permission"
            | "connector.acra.revoke_permission" => Some(Self::Acra),
            "connector.nit"
            | "connector.nit.create_issue"
            | "connector.nit.register_wiki_candidate" => Some(Self::Nit),
            _ => None,
        }
    }
}

async fn parse_plugin_contract_response(
    plugin_id: &str,
    response: reqwest::Response,
) -> Result<PluginExecutionResult> {
    let status_code = response.status().as_u16();
    let body = response.json::<Value>().await?;
    let success = body
        .get("success")
        .and_then(|value| value.as_bool())
        .unwrap_or((200..300).contains(&status_code));

    if !success {
        let retryable = body
            .get("retryable")
            .and_then(|value| value.as_bool())
            .unwrap_or(status_code >= 500 || status_code == 429);
        let code = body
            .get("error")
            .and_then(|error| error.get("code"))
            .and_then(|code| code.as_str())
            .unwrap_or("PLUGIN_ERROR");
        let message = body
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(|message| message.as_str())
            .unwrap_or("plugin execution failed");
        return Err(anyhow!(
            "plugin '{}' failed: code={}, retryable={}, message={}",
            plugin_id,
            code,
            retryable,
            message
        ));
    }

    Ok(PluginExecutionResult {
        status_code,
        output: body.get("output").cloned().unwrap_or(Value::Null),
    })
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

fn split_resolved_secrets(mut config: Value) -> (Value, Value) {
    let secrets = config
        .as_object_mut()
        .and_then(|object| object.remove("secrets"))
        .unwrap_or_else(|| json!({}));

    (config, secrets)
}

fn prepare_config(config: &Value, manifest: &PluginManifest) -> Result<Value> {
    let mut resolved = resolve_config_values(config)?;
    let mut secrets = serde_json::Map::new();

    if let Some(existing_secrets) = config.get("secrets").and_then(|value| value.as_object()) {
        for (name, value) in existing_secrets {
            secrets.insert(name.clone(), resolve_secret_values(value)?);
        }
    }

    if let Some(secrets_ref) = config.get("secrets_ref").and_then(|v| v.as_object()) {
        for (name, secret_ref) in secrets_ref {
            let secret_ref = secret_ref
                .as_str()
                .ok_or_else(|| anyhow!("secrets_ref.{} must be a string", name))?;
            secrets.insert(name.clone(), Value::String(resolve_secret_ref(secret_ref)?));
        }
    }

    for (name, secret_ref) in &manifest.secrets_policy.required {
        secrets.insert(name.clone(), Value::String(resolve_secret_ref(secret_ref)?));
    }

    for (name, secret_ref) in &manifest.secrets_policy.optional {
        if let Some(secret) = try_resolve_secret_ref(secret_ref)? {
            secrets.insert(name.clone(), Value::String(secret));
        }
    }

    if let Some(object) = resolved.as_object_mut() {
        object.remove("secrets");
        object.remove("secrets_ref");
        if !secrets.is_empty() {
            object.insert("secrets".to_string(), Value::Object(secrets));
        }
    }

    Ok(resolved)
}

fn resolve_config_values(value: &Value) -> Result<Value> {
    match value {
        Value::Array(items) => items
            .iter()
            .map(resolve_config_values)
            .collect::<Result<Vec<_>>>()
            .map(Value::Array),
        Value::Object(object) => object
            .iter()
            .filter(|(key, _)| key.as_str() != "secrets" && key.as_str() != "secrets_ref")
            .map(|(key, value)| Ok((key.clone(), resolve_config_values(value)?)))
            .collect::<Result<serde_json::Map<String, Value>>>()
            .map(Value::Object),
        _ => resolve_secret_values(value),
    }
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

fn try_resolve_secret_ref(secret_ref: &str) -> Result<Option<String>> {
    let env_name = secret_ref_to_env_name(secret_ref)?;
    match std::env::var(&env_name) {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(err) => Err(anyhow!(
            "secret reference '{}' could not be resolved from environment variable {}: {}",
            secret_ref,
            env_name,
            err
        )),
    }
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

fn resolve_manifest_dir() -> Result<PathBuf> {
    if let Ok(dir) = std::env::var("PXM_PLUGIN_MANIFEST_DIR") {
        let path = PathBuf::from(dir);
        if path.is_dir() {
            return Ok(path);
        }
        return Err(anyhow!(
            "PXM_PLUGIN_MANIFEST_DIR does not point to a directory: {}",
            path.display()
        ));
    }

    let cwd = std::env::current_dir()?;
    let candidates = [
        cwd.join("plugin-manifests"),
        cwd.join("../api/plugin-manifests"),
        cwd.join("apps/api/plugin-manifests"),
    ];

    candidates
        .into_iter()
        .find(|path| path.is_dir())
        .ok_or_else(|| {
            anyhow!(
                "could not find plugin manifests; set PXM_PLUGIN_MANIFEST_DIR or run from repo/apps/engine"
            )
        })
}

fn compare_semver_desc(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |version: &str| {
        version
            .split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    let a = parse(a);
    let b = parse(b);
    for index in 0..3 {
        let a_part = *a.get(index).unwrap_or(&0);
        let b_part = *b.get(index).unwrap_or(&0);
        match b_part.cmp(&a_part) {
            std::cmp::Ordering::Equal => continue,
            ordering => return ordering,
        }
    }
    std::cmp::Ordering::Equal
}

#[cfg(test)]
mod tests {
    use super::{
        prepare_config, secret_ref_to_env_name, PluginManifest, PluginManifestRegistry,
        PluginRetryPolicy, PluginSecretsPolicy,
    };
    use serde_json::json;
    use std::path::Path;

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

    #[test]
    fn loads_seeded_plugin_manifests() {
        let registry =
            PluginManifestRegistry::load_from_dir(Path::new("../api/plugin-manifests")).unwrap();
        let plugin_ids = registry
            .latest_manifests()
            .into_iter()
            .map(|manifest| manifest.plugin_id)
            .collect::<Vec<_>>();

        assert!(plugin_ids.contains(&"builtin.http_request".to_string()));
        assert!(plugin_ids.contains(&"connector.slack.send_message".to_string()));
    }

    #[test]
    fn prepares_manifest_secrets_without_leaking_refs_into_config() {
        std::env::set_var("PXM_SECRET_ACRA_API_TOKEN", "required-token");
        std::env::remove_var("SLACK_BOT_TOKEN");

        let manifest = PluginManifest {
            plugin_id: "connector.acra.grant_permission".to_string(),
            version: "1.0.0".to_string(),
            executor_type: "hosted".to_string(),
            executor_ref: "pxm-plugin-host:connector.acra.grant_permission".to_string(),
            secrets_policy: PluginSecretsPolicy {
                required: [(
                    "api_token".to_string(),
                    "secret://acra/api_token".to_string(),
                )]
                .into_iter()
                .collect(),
                optional: [("bot_token".to_string(), "env://SLACK_BOT_TOKEN".to_string())]
                    .into_iter()
                    .collect(),
            },
            timeout_ms: Some(5_000),
            retry_policy: Some(PluginRetryPolicy {
                max_attempts: Some(3),
                backoff_ms: Some(1_000),
            }),
        };

        let prepared = prepare_config(
            &json!({
                "targetSystem": "ACRA",
                "permissionCode": "READ",
                "secrets_ref": {
                    "override": "env://PXM_SECRET_ACRA_API_TOKEN"
                }
            }),
            &manifest,
        )
        .unwrap();

        assert_eq!(prepared.get("secrets_ref"), None);
        assert_eq!(
            prepared
                .get("secrets")
                .and_then(|secrets| secrets.get("api_token"))
                .and_then(|secret| secret.as_str()),
            Some("required-token")
        );
        assert_eq!(
            prepared
                .get("secrets")
                .and_then(|secrets| secrets.get("override"))
                .and_then(|secret| secret.as_str()),
            Some("required-token")
        );
        assert_eq!(
            prepared
                .get("secrets")
                .and_then(|secrets| secrets.get("bot_token")),
            None
        );
    }
}
