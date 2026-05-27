use std::time::Duration;

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde_json::json;

use crate::v2::ports::{PluginExecutionResult, PluginExecutorPort, PluginInvocation};

pub struct BuiltinPluginExecutor {
    http_client: reqwest::Client,
}

impl BuiltinPluginExecutor {
    pub fn new() -> Result<Self> {
        let http_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()?;
        Ok(Self { http_client })
    }
}

#[async_trait]
impl PluginExecutorPort for BuiltinPluginExecutor {
    async fn execute(&self, invocation: PluginInvocation) -> Result<PluginExecutionResult> {
        match invocation.plugin_id.as_str() {
            "builtin.http_request" => {
                let url = invocation
                    .config
                    .get("url")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow!("builtin.http_request requires config.url"))?;

                let resp = self.http_client.get(url).send().await?;
                let status = resp.status().as_u16();
                if (200..300).contains(&status) {
                    Ok(PluginExecutionResult {
                        status_code: status,
                        output: json!({"url": url}),
                    })
                } else {
                    Err(anyhow!("plugin returned non-success status: {}", status))
                }
            }
            plugin_id => Err(anyhow!(
                "plugin '{}' is not registered with the current PluginExecutor",
                plugin_id
            )),
        }
    }
}
