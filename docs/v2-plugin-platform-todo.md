# V2 Plugin Platform TODO

Goal: allow new plugins to be added without patching the running core API/Engine, and allow third parties to build plugins against a stable contract.

## P0 - plugin registry foundation

- [ ] Define plugin manifest schema: `plugin_id`, version, display name, category, node type, icon, config schema, executor type, executor ref, secrets policy, input/output schema.
- [ ] Add registry storage for plugin manifests. Start with JSON/file registry, then allow DB-backed registry.
- [ ] Add Plugin Registry API:
  - [ ] `GET /api/plugins`
  - [ ] `GET /api/plugins/:plugin_id`
  - [ ] `GET /api/plugins/:plugin_id/versions`
- [ ] Seed MVP manifests for HTTP Request, Slack, ACRA, NIT, Jira, HR, AD.
- [ ] Add registry validation so invalid plugin manifests fail before runtime.

## P1 - n8n-like web authoring

- [ ] Replace the static Service-only palette with a registry-driven plugin palette.
- [ ] Show plugins as first-class nodes, such as Slack Send Message, NIT Create Issue, ACRA Grant Permission.
- [ ] Keep persisted runtime shape as `node_type = service` plus `plugin_id`.
- [ ] Render node property forms from each plugin's `config_schema`.
- [ ] Support plugin icons, categories, search, and favorites in the node palette.
- [ ] Preserve backward compatibility for existing Service nodes with manual plugin selection.

## P2 - patchless execution

- [ ] Add `executor_type = http` support so the Engine can call external plugin endpoints.
- [ ] Define the standard plugin invocation request:
  - [ ] instance metadata
  - [ ] node metadata
  - [ ] config
  - [ ] context
  - [ ] resolved secrets
  - [ ] attempt/retry metadata
- [ ] Define the standard plugin response:
  - [ ] success/failure
  - [ ] output
  - [ ] retryable
  - [ ] error code/message
- [ ] Add timeout, retry, and error mapping per plugin manifest.
- [ ] Make the Engine resolve plugin execution entirely from registry metadata instead of compiled connector branches.

## P3 - third-party plugin developer experience

- [ ] Write a Plugin SDK guide with manifest format, HTTP contract, examples, and local test flow.
- [ ] Add a sample third-party HTTP plugin service.
- [ ] Add a manifest packaging format.
- [ ] Add plugin install/register command or API.
- [ ] Add plugin conformance tests that third-party plugins can run locally.

## P4 - production controls

- [ ] Add plugin enable/disable and version pinning.
- [ ] Add workspace/customer-level plugin allowlist.
- [ ] Add secret store integration beyond local environment variables.
- [ ] Add audit logs for plugin install, update, enable, disable, and execution.
- [ ] Add plugin signature or trusted source checks before installation.
- [ ] Add execution isolation policy for external plugins.
