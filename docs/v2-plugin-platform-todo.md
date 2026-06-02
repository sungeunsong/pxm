# V2 Plugin Platform TODO

Goal: allow new plugins to be added without patching the running core API/Engine, and allow third parties to build plugins against a stable contract.

## Operating model

- Default on-premise model: ship one `pxm-plugin-host` service that owns business/system connector executors.
- Keep `pxm-engine` focused on workflow runtime only: token/job execution, approval, gateways, retries, logs, and generic plugin invocation.
- Keep business-specific connectors out of `pxm-engine` unless they are temporary MVP mocks.
- Use plugin manifests to describe node UI, config schema, secret requirements, executor routing, timeout, retry, and output contract.
- Preferred executor model:
  - `builtin`: small generic executors embedded in `pxm-engine`, such as `builtin.http_request`.
  - `hosted`: official/customer executors implemented inside the single `pxm-plugin-host`.
  - `external_http`: optional dedicated plugin service for heavy or strongly isolated integrations.
  - `mock`: local development and smoke-test executors only.
- Hot plugin install/reload is not a P0 requirement for on-premise. Restart/redeploy is acceptable, but the restart target should usually be `pxm-plugin-host`, not `pxm-engine`.

## P0 - plugin registry foundation

- [x] Define plugin manifest schema: `plugin_id`, version, display name, category, node type, icon, config schema, executor type, executor ref, secrets policy, input/output schema.
- [x] Add registry storage for plugin manifests. Start with JSON/file registry, then allow DB-backed registry.
- [x] Add Plugin Registry API:
  - [x] `GET /api/plugins`
  - [x] `GET /api/plugins/:plugin_id`
  - [x] `GET /api/plugins/:plugin_id/versions`
- [x] Seed MVP manifests for HTTP Request, Slack, ACRA, NIT, Jira, HR, AD.
- [x] Add registry validation so invalid plugin manifests fail before runtime.

## P1 - n8n-like web authoring

- [x] Replace the static Service-only palette with a registry-driven plugin palette.
- [x] Treat each plugin manifest as a first-class authoring node in the palette, not as a dropdown option inside a generic Service node.
- [x] Show plugins as first-class nodes, such as Slack Send Message, NIT Create Issue, ACRA Grant Permission.
- [x] Keep persisted runtime shape as `node_type = service` plus `plugin_id`.
- [x] Render node property forms from each plugin's `config_schema`.
- [x] Support plugin icons, categories, search, and favorites in the node palette.
- [x] Preserve backward compatibility for existing Service nodes with manual plugin selection.

## P2 - patchless execution

- [x] Add `pxm-plugin-host` service as the default runtime home for hosted plugin executors.
- [x] Add `executor_type = hosted` support so the Engine can call the shared plugin host with `plugin_id`.
- [x] Keep `executor_type = builtin` limited to generic Engine-owned executors.
- [x] Keep `executor_type = mock` limited to local development and smoke coverage.
- [x] Add optional `executor_type = external_http` support so the Engine can call dedicated plugin endpoints when isolation is needed.
- [x] Define the standard plugin invocation request:
  - [x] instance metadata
  - [x] node metadata
  - [x] config
  - [x] context
  - [x] resolved secrets
  - [x] attempt/retry metadata
- [x] Define the standard plugin response:
  - [x] success/failure
  - [x] output
  - [x] retryable
  - [x] error code/message
- [x] Add timeout, retry, and error mapping per plugin manifest.
- [x] Make the Engine resolve plugin execution entirely from registry metadata instead of compiled business connector branches.
- [x] Move ACRA, NIT, Slack, Jira, HR, and AD executor implementations out of Engine mock branches and into `pxm-plugin-host`.
- [x] Add plugin-host `/invoke` and `/health` endpoints.
- [x] Add plugin-host executor registry keyed by `plugin_id`.

## P3 - third-party plugin developer experience

- [x] Write a Plugin SDK guide with manifest format, hosted executor contract, external HTTP contract, examples, and local test flow.
- [x] Add a sample `pxm-plugin-host` executor module.
- [x] Add a sample third-party external HTTP plugin service.
- [x] Add a manifest packaging format.
- [x] Add plugin install/register command or API.
- [x] Add plugin conformance tests that third-party plugins can run locally.
- [x] Document on-premise deployment flow: rebuild/redeploy `pxm-plugin-host` for hosted executor changes, without rebuilding Engine.

## P4 - production controls

- [x] Add plugin enable/disable and version pinning.
- [x] Add workspace/customer-level plugin allowlist.
- [x] Add secret store integration beyond local environment variables.
- [x] Add audit logs for plugin install, update, enable, disable, and execution.
- [x] Add plugin signature or trusted source checks before installation.
- [x] Add execution isolation policy for hosted and external plugins.
- [x] Add plugin-host resource limits, timeout boundaries, and failure containment.
