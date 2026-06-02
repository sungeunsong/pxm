# PXM Plugin SDK Guide

This guide describes how to build a plugin without patching `pxm-engine`.

## Plugin Types

- `hosted`: executor code runs inside `pxm-plugin-host`. Use this for official or customer-owned on-premise connectors that can share one deployment boundary.
- `external_http`: executor code runs in a separate HTTP service. Use this when the integration needs stronger isolation, independent scaling, or a separate runtime.
- `builtin`: small generic executors owned by `pxm-engine`; third-party plugins should not use this.
- `mock`: local development or smoke-test executors only.

## Package Format

A plugin package is a directory with a `plugin.json` manifest at its root.

```text
my-plugin/
  plugin.json
  README.md
  src/...
```

Install a package manifest into the local file registry:

```bash
pnpm plugin:install ../../examples/plugin-packages/connector.sample_echo
```

The install command copies `plugin.json` to `apps/api/plugin-manifests/<plugin_id>.json` after validating the manifest shape. Restart `pxm-api` and `pxm-engine` after installing or updating a manifest.

## Manifest Contract

Required fields:

```json
{
  "plugin_id": "connector.sample_echo",
  "version": "1.0.0",
  "display_name": "Sample Echo",
  "category": "Samples",
  "node_type": "service",
  "icon": "message-square",
  "config_schema": {
    "type": "object",
    "properties": {
      "message": { "type": "string", "title": "Message" }
    },
    "required": ["message"]
  },
  "executor_type": "hosted",
  "executor_ref": "pxm-plugin-host:connector.sample_echo",
  "trusted_source": "local",
  "secrets_policy": {},
  "output_schema": {
    "type": "object",
    "properties": {
      "message": { "type": "string" }
    }
  },
  "timeout_ms": 5000,
  "isolation_policy": {
    "mode": "shared_process",
    "network": "default"
  },
  "resource_limits": {
    "timeout_ms": 5000,
    "max_payload_bytes": 262144
  },
  "retry_policy": {
    "max_attempts": 1,
    "backoff_ms": 0
  }
}
```

Rules:

- `plugin_id` is a dot-delimited lowercase ID, for example `connector.jira.create_issue`.
- `version` uses `MAJOR.MINOR.PATCH`.
- `node_type` is currently `service`.
- `config_schema`, `input_schema`, and `output_schema` are JSON-object schemas.
- `secrets_policy.required` and `secrets_policy.optional` map request secret names to secret references such as `secret://jira/api_token`.
- `trusted_source` must match a source listed in `apps/api/plugin-controls.json` unless untrusted installs are explicitly allowed.
- `isolation_policy.mode` is `shared_process` for hosted plugins and `external_process` for external HTTP plugins.
- `resource_limits.timeout_ms` and `resource_limits.max_payload_bytes` bound plugin execution at the Engine/plugin-host boundary.
- `timeout_ms` is enforced by the Engine HTTP client.
- `retry_policy` is passed to the executor in the invocation request.

## Production Controls

Runtime controls live in `apps/api/plugin-controls.json`.

```json
{
  "default_enabled": true,
  "enabled_plugins": [],
  "disabled_plugins": [],
  "version_pins": {
    "connector.slack.send_message": "1.0.0"
  },
  "workspace_allowlists": {
    "default": ["*"],
    "customer-a": ["builtin.http_request", "connector.slack.send_message"]
  },
  "trusted_sources": ["local", "official", "customer"],
  "require_trusted_source": true,
  "audit_log_path": "../../logs/plugin-audit.jsonl"
}
```

Effects:

- API registry responses hide disabled plugins and plugins outside the current `PXM_WORKSPACE_ID` allowlist.
- Engine loads only active, allowed plugins and honors `version_pins`.
- `plugin:install` rejects untrusted sources and appends install events to the audit log.
- `plugin:control` updates enable/disable, version pinning, and workspace allowlists while appending control-change events to the audit log.
- Engine appends execution events to the audit log when `audit_log_path` or `PXM_PLUGIN_AUDIT_LOG` is set.
- `pxm-plugin-host` rejects hosted plugins outside `PXM_PLUGIN_HOST_ALLOWLIST`, payloads above `resource_limits.max_payload_bytes`, and hosted requests that ask for non-hosted isolation.

Secret references support `env://NAME`, `secret://path/to/key` mapped to `PXM_SECRET_PATH_TO_KEY`, and `file:///absolute/path` for on-prem secret file mounts.

Control examples:

```bash
pnpm plugin:control -- disable connector.slack.send_message
pnpm plugin:control -- enable connector.slack.send_message
pnpm plugin:control -- pin connector.slack.send_message 1.0.0
pnpm plugin:control -- allow customer-a connector.slack.send_message
```

## Hosted Executor Contract

Hosted executors are functions registered in `pxm-plugin-host` by `plugin_id`.

Example module: `apps/plugin-host/src/executors/sample-echo.executor.ts`.

```ts
import type { HostedPluginExecutor } from '../plugin-host.types';

export const SAMPLE_ECHO_PLUGIN_ID = 'connector.sample_echo';

export const sampleEchoExecutor: HostedPluginExecutor = (request) => ({
  success: true,
  output: {
    message: request.config.message ?? null,
    instance_id: request.instance.id,
    node_id: request.node.id,
  },
});
```

Register the executor in `PluginHostService`:

```ts
this.register(SAMPLE_ECHO_PLUGIN_ID, sampleEchoExecutor);
```

Rebuild and redeploy only `pxm-plugin-host` when adding hosted executor code. Rebuild or restart `pxm-api` and `pxm-engine` only when the manifest registry changes.

## External HTTP Contract

External plugins receive the same invocation request over HTTP `POST`.

```json
{
  "plugin_id": "connector.external_echo",
  "instance": {
    "id": "instance-id",
    "definition_id": "definition-id",
    "metadata": {}
  },
  "node": {
    "id": "node-id",
    "token_id": "token-id",
    "metadata": {}
  },
  "config": {
    "message": "hello"
  },
  "context": {},
  "secrets": {},
  "attempt": 1,
  "retry": {
    "max_attempts": 1,
    "backoff_ms": 0
  }
}
```

Successful response:

```json
{
  "success": true,
  "output": {
    "message": "hello"
  }
}
```

Failure response:

```json
{
  "success": false,
  "retryable": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "message is required"
  }
}
```

Sample service: `examples/external-http-plugin/echo-service.mjs`.

Run it:

```bash
PORT=3020 node examples/external-http-plugin/echo-service.mjs
```

Install its manifest:

```bash
pnpm plugin:install ../../examples/external-http-plugin
```

## Conformance Tests

Validate a manifest only:

```bash
pnpm plugin:conformance -- --manifest ../../examples/plugin-packages/connector.sample_echo/plugin.json
```

Validate an external HTTP endpoint:

```bash
pnpm plugin:conformance -- \
  --manifest ../../examples/external-http-plugin/plugin.json \
  --endpoint http://127.0.0.1:3020/invoke
```

Validate a hosted executor against a running plugin host:

```bash
pnpm dev:plugin-host
pnpm plugin:conformance -- \
  --manifest ../../examples/plugin-packages/connector.sample_echo/plugin.json \
  --endpoint http://127.0.0.1:3010/invoke
```

The conformance script checks the manifest shape and verifies that the endpoint returns the standard plugin response contract.

## On-Premise Deployment Flow

For hosted plugins:

1. Add or update the hosted executor module in `apps/plugin-host/src/executors`.
2. Register it in `PluginHostService`.
3. Add or update the plugin package `plugin.json`.
4. Run `pnpm plugin:install <plugin-package-dir>`.
5. Rebuild and redeploy `pxm-plugin-host`.
6. Restart `pxm-api` and `pxm-engine` so both reload the manifest registry.

For external HTTP plugins:

1. Build and deploy the external plugin service.
2. Set `executor_type` to `external_http`.
3. Set `executor_ref` to the absolute invoke URL.
4. Run `pnpm plugin:install <plugin-package-dir>`.
5. Restart `pxm-api` and `pxm-engine`.

In both flows, `pxm-engine` does not receive connector-specific code changes.
