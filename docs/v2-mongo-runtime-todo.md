# V2 Mongo Runtime TODO

## P0 - local Mongo runtime path

- [x] Run local MongoDB as a single-node replica set for transaction support.
- [x] Add Mongo runtime indexes for jobs, tokens, tasks, outbox, and logs.
- [x] Add root scripts for Mongo DB startup, index initialization, API, engine, and web.
- [x] Run API -> Engine smoke E2E on Mongo and verify `start -> end` completes.
- [x] Run API -> Engine smoke E2E on Mongo and verify mock service connector completes.
- [x] Run API -> Engine smoke E2E on Mongo and verify approval task -> approve -> RESUME completes.
- [ ] Run full Web -> API -> Engine E2E on Mongo from the browser.
  - [ ] Start API, Engine, and Web with the Mongo scripts.
  - [ ] Save a template from Flow Designer.
  - [ ] Launch the saved template from Request Portal.
  - [ ] Verify Engine completes `start -> service -> end`.
  - [ ] Create an approval template and verify an OPEN task appears in Inbox.
  - [ ] Approve the task and verify `RESUME` completes the instance.
  - [ ] Verify Instance Tracker can load the completed instance.
  - [ ] Verify runtime trace/log events render without relying on SSE-only behavior.
- [x] Add automated Mongo approval smoke coverage for DB-backed runtime trace API.

## P1 - schema and runtime correctness

- [x] Store runtime node config separately from the original React Flow UI node.
- [x] Normalize legacy `READY` token creation to engine `ACTIVE`.
- [x] Make API task completion enqueue `RESUME` with `token_id` when available.
- [x] Add Mongo collection validator or bootstrap checks for required fields.
- [x] Add stale job reclaim and lease behavior tests against Mongo replica set.
- [x] Requeue jobs when instance advisory lock or lease cannot be acquired.

## P2 - platform features

- [x] Register MVP mock executors for Slack, ACRA, and NIT connector IDs exposed in the web UI.
- [x] Load Instance Tracker from `/api/instances` instead of static mock instances.
- [x] Replace `BuiltinPluginExecutor` with a registry-backed connector resolver.
- [x] Add secret reference resolution for connector credentials.
- [x] Implement gateway parallel/inclusive fork and join semantics.
- [x] Add DB-backed runtime trace API for `v2_execution_logs` and `v2_event_outbox`.
- [x] Add approval line models: fixed, condition-based, and requester-selected candidates.

## P3 - optional DB support

- [x] Keep PostgreSQL as a secondary supported adapter, with MongoDB as the primary customer/runtime path.
- [x] Align Node API Postgres adapter with V2 schema names for definitions, instances, outbox, and trace.
- [ ] Run PostgreSQL API -> Engine smoke E2E against `003_v2_runtime_foundation.sql`.
