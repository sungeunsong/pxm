# V2 Mongo Runtime TODO

## P0 - local Mongo runtime path

- [x] Run local MongoDB as a single-node replica set for transaction support.
- [x] Add Mongo runtime indexes for jobs, tokens, tasks, outbox, and logs.
- [x] Add root scripts for Mongo DB startup, index initialization, API, engine, and web.
- [x] Run API -> Engine smoke E2E on Mongo and verify `start -> end` completes.
- [ ] Run full Web -> API -> Engine E2E on Mongo from the browser.

## P1 - schema and runtime correctness

- [x] Store runtime node config separately from the original React Flow UI node.
- [x] Normalize legacy `READY` token creation to engine `ACTIVE`.
- [x] Make API task completion enqueue `RESUME` with `token_id` when available.
- [ ] Add Mongo collection validator or bootstrap checks for required fields.
- [ ] Add stale job reclaim and lease behavior tests against Mongo replica set.

## P2 - platform features

- [ ] Replace `BuiltinPluginExecutor` with a registry-backed connector resolver.
- [ ] Add secret reference resolution for connector credentials.
- [ ] Implement gateway parallel/inclusive fork and join semantics.
- [ ] Add DB-backed runtime trace API for `v2_execution_logs` and `v2_event_outbox`.
- [ ] Add approval line models: fixed, condition-based, and requester-selected candidates.

## P3 - optional DB support

- [ ] Decide whether PostgreSQL remains a supported adapter or dev-only fallback.
- [ ] If PostgreSQL remains supported, align Node API Postgres adapter with V2 schema.
