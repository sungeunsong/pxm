# Web Mongo E2E Test Guide

This guide verifies the unchecked P0 item in `docs/v2-mongo-runtime-todo.md`: full Web -> API -> Engine E2E on Mongo from the browser.

## 1. Start the local stack

Run Mongo once:

```bash
cd /opt/workspace/pxm
pnpm db:mongo
```

If this is the first run, after a DB reset, or after Mongo index/validator changes:

```bash
pnpm db:mongo:init
pnpm db:mongo:check
```

Open three terminals:

```bash
pnpm dev:api:mongo
```

```bash
pnpm dev:engine:mongo
```

```bash
pnpm dev:web
```

Open:

```text
http://localhost:5173
```

## 2. Test start -> service -> end

1. Open `Flow Designer`.
2. Drag these nodes onto the canvas: `Start`, `Service`, `End`.
3. Connect `Start -> Service -> End`.
4. Select the `Service` node.
5. In the right property panel, set `Connector Type` to `Slack Alerter (Mock)`.
6. Enter a message, for example `web e2e service`.
7. Click save in the Flow Designer header.
8. Enter a recognizable template name, for example `Web E2E Service`.
9. Open `업무 및 요청`.
10. Find `Web E2E Service`.
11. Click `신청 기동하기`.
12. Fill the launch form and click `가동하기`.
13. Confirm the success panel shows an instance ID.
14. Open `실행 모니터링`.
15. Confirm the instance appears as `COMPLETED`.
16. Click `실시간 추적`.
17. Confirm the execution log includes service completion and instance completion.

Pass condition:

```text
The workflow completes and the tracker/log view shows the completed instance.
```

## 3. Test approval -> resume -> service -> end

1. Open `Flow Designer`.
2. Drag these nodes onto the canvas: `Start`, `Approval`, `Service`, `End`.
3. Connect `Start -> Approval -> Service -> End`.
4. Select the `Approval` node.
5. Set the approver to `admin`.
6. Select the `Service` node.
7. Set `Connector Type` to `Slack Alerter (Mock)`.
8. Save the template as `Web E2E Approval`.
9. Open `업무 및 요청`.
10. Find `Web E2E Approval`.
11. Click `신청 기동하기`.
12. Fill the launch form and click `가동하기`.
13. Open `승인자 / 결재자`.
14. Wait up to a few seconds for the real task to appear in the table.
15. Select the new task.
16. Choose `승인`.
17. Click `승인 완료하기`.
18. Open `실행 모니터링`.
19. Confirm the instance changes to `COMPLETED`.
20. Click `실시간 추적`.
21. Confirm the execution log includes task creation, approval resume, service completion, and instance completion.

Pass condition:

```text
The approval task appears, approval resumes the engine, and the instance completes.
```

## 4. Optional API checks while testing

List templates:

```bash
curl http://localhost:3000/api/templates
```

List instances:

```bash
curl http://localhost:3000/api/instances
```

List approval tasks:

```bash
curl 'http://localhost:3000/api/tasks?assignee=admin'
```

Fetch trace for an instance:

```bash
curl http://localhost:3000/api/instances/<INSTANCE_ID>/trace
```

## 5. When to check the TODO box

In `docs/v2-mongo-runtime-todo.md`, check the P0 browser E2E items only after both browser flows pass:

- `start -> service -> end`
- `approval -> approve -> resume -> service -> end`

If either flow passes only through smoke scripts but not through the browser, keep the browser E2E item unchecked.
