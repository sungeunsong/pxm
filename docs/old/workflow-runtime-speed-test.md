# Workflow Runtime Speed Test

이 문서는 응답 대기형 HTTP/DB 노드가 아니라 즉시 실행 가능한 노드를 여러 개 연결했을 때 PXM workflow runtime의 현재 처리 속도와 설계 리스크를 기록한다.

## 테스트 목적

- 외부 HTTP, DB query 응답 시간을 제외하고 workflow engine 자체의 노드 전이 비용을 확인한다.
- 많은 노드가 붙은 workflow에서 초기 설계를 바꿔야 할 정도의 병목이 있는지 판단한다.
- 측정 대상은 end-to-end 기준이다. API start 요청, engine job polling, token transition, MongoDB persistence, execution log/outbox 저장 비용이 포함된다.

## 테스트 환경

- Date: 2026-06-22
- API: `http://localhost:3011/api`
- DB: MongoDB replica set, `pxm_db`
- Engine: `DB_TYPE=mongodb`, worker 1개, `poll_ms=300`
- 테스트 스크립트: `apps/api/scripts/benchmark-immediate-nodes.mjs`
- 실행 명령:

```bash
pnpm benchmark:immediate -- --nodes 100 --runs 5 --node-type gateway --shape chain
pnpm benchmark:immediate -- --nodes 100 --runs 5 --node-type gateway --shape fanout
```

## 테스트 노드

### Gateway Chain

`start -> gateway_1 -> gateway_2 -> ... -> gateway_N -> end`

- 외부 호출 없음
- JS subprocess 없음
- 조건 평가은 default edge만 사용
- 엔진의 token transition, log 저장, token 저장 비용을 보는 가장 가벼운 테스트

### Gateway Fanout

`start -> gateway_1..gateway_N -> end`

- start가 N개 gateway로 fan-out
- 각 gateway가 end로 이동
- 병렬 토큰/동일 instance 다중 token 처리에서 transaction contention을 확인하기 위한 테스트

### Script Chain

스크립트도 지원하도록 추가했지만 이번 판단 기준에서는 보조 항목으로 둔다. 현재 script node는 Node.js subprocess를 실행하므로 engine 순수 전이 비용보다 훨씬 무거운 별도 비용이 섞인다.

## 결과

| Scenario | Nodes | Shape | Result | Completion Time | Throughput | Note |
|---|---:|---|---|---:|---:|---|
| Gateway smoke | 10 | chain | completed | 362.89 ms | 27.56 nodes/sec | 스크립트 동작 확인용 |
| Gateway chain | 100 | chain | completed | 1,851.11 ms | 54.02 nodes/sec | 단독 완료 기준 |
| Gateway chain during concurrent load | 100 | chain | first run completed | 6,654.45 ms | 15.03 nodes/sec | fanout 벤치와 동시 실행되어 큐 경합 포함 |
| Gateway fanout during concurrent load | 100 | fanout | run 1 completed | 5,603.80 ms | 17.85 nodes/sec | 큐/transaction 경합 포함 |
| Gateway fanout during concurrent load | 100 | fanout | run 2 completed | 6,360.82 ms | 15.72 nodes/sec | 큐/transaction 경합 포함 |
| Concurrent benchmark follow-up runs | 100 | chain/fanout | timed out at 60 sec | > 60,000 ms | n/a | START job이 60초 내 처리되지 못함 |

DB timestamp 기준 보강:

| Instance | Scenario | DB created->updated |
|---|---|---:|
| `d4d69777-e773-4735-87be-3fcd7d52e3f2` | 10 gateway chain | 275 ms |
| `aa5cd5d6-a30f-4b1d-a687-f334100d67df` | 100 gateway chain | 1,751 ms |
| `f8ef5f3b-cc2c-4cbe-9757-818835aeb828` | 100 gateway fanout | 6,344 ms |
| `4882a174-7c96-4885-9c3d-4d4697d58782` | queued concurrent chain | 105,361 ms |
| `a3ff3d05-de55-469b-90b4-65a23886bbdf` | queued concurrent fanout | 105,135 ms |

## 후속 조치 결과

Date: 2026-06-23

Schedule Start 전에 처리하기로 한 runtime 안정화 항목을 반영하고 같은 계열의 benchmark를 재실행했다.

구현 완료:

- Mongo transaction transient error 처리
  - `WriteConflict`, `TransientTransactionError`, `UnknownTransactionCommitResult` 감지 시 job을 backoff 후 다시 `QUEUED`로 되돌린다.
  - Mongo transaction start/commit/abort 결과를 무시하지 않도록 수정했다.
- Timer job/token 완료 전이 모델 수정
  - TIMER job 만료 시 같은 timer node를 다시 실행하지 않는다.
  - timer node를 완료 처리한 뒤 outgoing edge로 token을 전이한다.
- Queue/backlog 관측 API 추가
  - `GET /api/engine/queue/stats`
  - `QUEUED/RUNNING/FAILED/COMPLETED` count, oldest queued age, running worker, worker heartbeat, max attempt를 조회한다.

재확인 결과:

| Scenario | Nodes | Shape | Runs | Result | Completion Time | Throughput | Note |
|---|---:|---|---:|---|---:|---:|---|
| Gateway smoke after fix | 10 | chain | 1 | completed | 418.20 ms | 23.91 nodes/sec | smoke |
| Gateway chain after fix | 100 | chain | 5 | completed | avg 1,805.73 ms | avg 56.07 nodes/sec | 단독 완료 기준 |
| Gateway fanout after fix | 100 | fanout | 5 | completed | avg 5,010.00 ms | avg 20.17 nodes/sec | 단독 완료 기준 |
| Gateway chain during concurrent load after fix | 100 | chain | 5 | completed | avg 6,299.63 ms | avg 24.57 nodes/sec | fanout 벤치와 동시 실행 |
| Gateway fanout during concurrent load after fix | 100 | fanout | 5 | completed | avg 7,180.53 ms | avg 15.06 nodes/sec | chain 벤치와 동시 실행 |
| Timer smoke after fix | 1 timer | chain | 1 | completed | 796.40 ms | n/a | `start -> timer(100ms) -> end` |

최종 queue 확인:

```json
{
  "queued": 0,
  "running": 0,
  "failed": 0,
  "timerQueued": 0,
  "retryCount": 0
}
```

관찰:

- 이전처럼 60초 timeout이나 START job 장기 대기는 재현되지 않았다.
- TIMER job이 같은 token으로 새 TIMER job을 계속 만드는 현상은 재현되지 않았다.
- 이번 재실행에서는 실제 `WriteConflict`가 발생하지 않아 transient retry 로그는 생성되지 않았다. 다만 retry 경로와 commit error 감지는 구현되어 있다.
- 동시 실행 성능은 여전히 단독 실행보다 크게 느리다. worker concurrency/batch 처리 검토는 남은 성능 과제다.

## 관찰된 문제

### 1. 단일 workflow 100개 직렬 노드는 완료 가능

100개 gateway chain이 약 1.75-1.85초에 완료됐다. 즉 현재 구조가 아주 작은 workflow만 처리 가능한 수준은 아니다.

하지만 이 수치는 외부 호출 없는 가장 가벼운 gateway 기준이다. 일반 업무 workflow에서 service node, approval wait, script node, result 저장, retry 등이 섞이면 더 느려진다.

### 2. 동시 실행/병렬 token에서 급격히 느려짐

100개 fanout 또는 chain/fanout 동시 벤치마크에서는 5-6초대로 늘었고, 후속 run은 60초 내 START job도 처리되지 못했다.

현재 engine이 worker 1개, job polling 기반이고, instance/token/log 변경을 Mongo transaction으로 묶는 구조라 queue backlog와 write contention에 민감하다.

### 3. MongoDB WriteConflict로 engine이 종료됨

fanout 처리 중 다음 오류로 engine 프로세스가 종료됐다.

```text
WriteConflict: Caused by :: Write conflict during plan execution and yielding is disabled.
labels: TransientTransactionError
```

이건 성능보다 더 중요한 안정성 이슈다. Mongo transaction에서 transient error가 발생했을 때 retry하지 않으면 fanout/동시 실행 workflow가 엔진 프로세스를 죽일 수 있다.

### 4. Timer job이 큐를 오염시키는 현상 발견

기존 timer 테스트 인스턴스가 같은 timer token으로 계속 `TIMER` job을 만들고 처리하는 상태가 관찰됐다.

```text
v2_engine_jobs completed TIMER count: 50,792+
```

이 때문에 벤치마크 중 engine queue가 오염됐고, 일부 START job이 60초 이상 대기했다. Timer 처리 모델은 Schedule Start 전에 반드시 정리해야 한다.

## 분석

### 현재 속도는 적절한가?

운영 기준으로는 아직 부족하다.

100개 직렬 즉시 노드가 약 2초 이내에 끝나는 것은 데모/소규모 워크플로우에는 허용 가능하다. 하지만 가장 가벼운 노드 기준으로 50 nodes/sec 수준이고, 동시 실행에서는 15-18 nodes/sec 수준까지 떨어졌다.

업무 workflow가 보통 10-30개 노드이고 동시 실행량이 낮다면 당장 막히지는 않는다. 반대로 다음 요구가 있다면 현재 설계는 초기에 손보는 것이 맞다.

- workflow 하나에 수십-수백 개 자동 노드가 붙는다.
- 여러 workflow instance를 동시에 많이 시작한다.
- fanout/fanin 구조를 자주 쓴다.
- 실행 완료 지연이 사용자 경험이나 SLA에 직접 영향이 있다.
- scheduler가 주기적으로 많은 instance를 만든다.

### 설계를 지금 바꿔야 하는가?

일부는 지금 바꿔야 한다.

전체 runtime을 갈아엎을 필요까지는 아직 증거가 부족하지만, 다음은 Schedule Start 전에 처리하는 것이 맞다.

1. Mongo transaction transient error retry - 완료
   - `WriteConflict`, `TransientTransactionError` 발생 시 job 전체를 재시도해야 한다.
   - engine process가 종료되면 안 된다.

2. Timer job 상태 전이 수정 - 완료
   - timer가 같은 token으로 무한 재스케줄되는 문제를 막아야 한다.
   - Schedule Start는 timer와 scheduler job을 더 많이 만들기 때문에 이 문제를 방치하면 벤치마크뿐 아니라 운영 큐도 오염된다.

3. Job queue/backlog 관측 API - 완료
   - `QUEUED/RUNNING/FAILED` job count
   - oldest queued age
   - worker heartbeat
   - retry count

4. Engine worker concurrency 모델 검토 - 남음
   - 단일 worker/polling 300ms는 초기 데모에는 충분하지만 throughput 기준으로는 빠르게 병목이 된다.
   - 최소한 worker 수 확장, batch fetch, adaptive poll 또는 wake-up 방식 검토가 필요하다.

5. Execution log/outbox 저장량 최적화 - 남음
   - 현재 모든 노드에서 `NODE_STARTED`, `NODE_COMPLETED`를 저장한다.
   - 수백 노드 workflow에서는 저장량이 성능을 지배할 수 있다.
   - trace level 또는 sampling/compact mode가 필요하다.

## 결론

현재 runtime은 소규모 순차 workflow에는 동작 가능하지만, 대량 노드/동시 실행/fanout 기준으로는 아직 안정성과 성능이 부족하다.

특히 `WriteConflict`로 engine이 종료된 점과 timer job 무한 처리 현상은 Schedule Start에 들어가기 전 반드시 정리해야 한다. Schedule Start는 구조적으로 job을 더 많이 만들기 때문에, 이 상태로 scheduler를 붙이면 속도 문제가 아니라 큐 안정성 문제가 먼저 터질 가능성이 높다.

권장 순서:

1. Mongo transaction transient retry 추가 - 완료
2. Timer job/token 완료 모델 수정 - 완료
3. queue/backlog 관측 API 추가 - 완료
4. 동일 벤치마크 재실행 - 완료
5. 그 결과를 보고 worker concurrency/batch 처리 설계 결정 - 남음

따라서 Schedule Start 구현을 시작할 수 있는 최소 안정성 조건은 충족했다. 다만 scheduler가 실제로 주기적 instance를 만들기 시작하면 queue 부하 양상이 달라지므로, Schedule Start 구현 후 같은 benchmark와 scheduler 부하 테스트를 다시 실행해야 한다.

## Schedule Start 부하 테스트

Date: 2026-06-25

Schedule Start 구현 후 API scheduler가 주기적으로 instance를 만드는 경로를 확인했다.

테스트 스크립트:

- `apps/api/scripts/benchmark-schedule-start.mjs`

실행 명령:

```bash
pnpm benchmark:schedule -- --schedules 5 --interval-seconds 1 --timeout-ms 30000
pnpm benchmark:schedule -- --schedules 50 --interval-seconds 1 --timeout-ms 120000
pnpm benchmark:schedule -- --schedules 100 --interval-seconds 1 --timeout-ms 180000
pnpm benchmark:schedule -- --schedules 100 --interval-seconds 3600 --force-due-in-seconds 3 --timeout-ms 90000
pnpm benchmark:schedule -- --schedules 300 --interval-seconds 3600 --force-due-in-seconds 3 --timeout-ms 180000
pnpm benchmark:immediate -- --nodes 10 --runs 1 --node-type gateway --shape chain
```

결과:

| Scenario | Schedules | Interval | Result | Elapsed | Queue after summary | Note |
|---|---:|---:|---|---:|---|---|
| Schedule smoke | 5 | 1s | 5 fired, 0 failed | 6,643 ms | queued 2, running 1 | 3초 후 queue drain 완료 |
| Schedule load | 50 | 1s | 50 fired, 0 failed | 23,015 ms | queued 0, running 0 | 테스트 후 schedule 자동 비활성화 |
| Schedule load | 100 | 1s | 100 fired, 0 failed | 51,654 ms | queued 1, running 0 | 3초 후 queue drain 완료 |
| Post-load queue check | n/a | n/a | drained | +3,000 ms | queued 0, running 0 | failed 0 |
| Gateway smoke after schedule load | 10 | n/a | completed | 498.26 ms | n/a | nodes/sec 20.07 |

초기 튜닝 결과:

| Scenario | Schedules | Scheduler Settings | Engine Workers | Result | Elapsed | Queue after summary | Duplicate Runs |
|---|---:|---|---:|---|---:|---|---:|
| Same due baseline | 100 | batch 100, poll 1s, sequential run | 1 | 100 fired, 0 failed | 16,599 ms | queued 38, running 1 | 0 |
| Same due tuned scheduler | 100 | batch 100, poll 1s, run concurrency 10 | 1 | 100 fired, 0 failed | 9,603 ms | queued 81, running 1 | 0 |
| Same due tuned scheduler + workers | 100 | batch 100, poll 1s, run concurrency 10 | 4 | 100 fired, 0 failed | 15,276 ms | queued 0, running 0 | 0 |
| Same due scale check | 300 | batch 100, poll 1s, run concurrency 10 | 4 | 300 fired, 0 failed | 32,612 ms | queued 0, running 0 | 0 |

관찰:

- scheduler가 `v2_schedule_jobs`를 claim하고 `START` job을 만드는 경로는 정상 동작했다.
- 5/50/100개 schedule은 모두 `v2_schedule_runs`에 `STARTED`로 기록됐고 실패는 없었다.
- `SCHEDULE_START_BATCH_SIZE` 기본값이 10이라 due schedule은 한 번에 모두 발화하지 않고 여러 scheduler tick으로 나뉘었다.
- 100개 발화 직후에는 queue가 1개 남았지만 3초 후 `queued=0`, `running=0`, `failed=0`으로 drain됐다.
- 현재 수준에서는 Schedule Start가 queue를 오염시키거나 engine을 멈추는 현상은 재현되지 않았다.
- `SCHEDULE_START_BATCH_SIZE=10`, `SCHEDULE_START_POLL_MS=5000` 기본값에서는 100개 발화가 약 51초 걸려 동시 due 부하에 너무 보수적이었다.
- scheduler tick 기본값을 `SCHEDULE_START_BATCH_SIZE=100`, `SCHEDULE_START_POLL_MS=1000`으로 조정하고, claim한 schedule 실행을 `SCHEDULE_START_RUN_CONCURRENCY=10` 병렬 처리로 바꿨다.
- 같은 due time 100개 기준 sequential scheduler는 due 이후 약 11초가 걸렸고, run concurrency 10 적용 후 due 이후 약 4초대로 줄었다.
- scheduler가 빨라지면 단일 engine worker에서는 queue backlog가 보인다. 4개 engine worker에서는 100/300개 same-due 테스트 모두 summary 시점에 queue가 남지 않았다.
- 300개 same-due 테스트에서 schedule run은 300건, instance는 300건, job당 최대 run 수는 1건이었다. 중복 claim/중복 실행은 재현되지 않았다.
- 운영 전에는 목표 부하 기준으로 engine worker 수와 Mongo write capacity를 함께 잡아야 한다. scheduler만 빠르게 만들면 backlog가 engine queue로 이동한다.
- 벤치마크 종료 후 `pnpm benchmark:cleanup -- --yes`로 benchmark definition/instance/job/run 데이터를 정리했고, dry-run 기준 잔여 benchmark 데이터는 0건이다.

## 재실행 방법

API와 MongoDB:

```bash
pnpm db:mongo
pnpm dev:api:mongo
```

Engine:

```bash
pnpm dev:engine:mongo
```

Benchmark:

```bash
pnpm benchmark:immediate -- --nodes 10 --runs 1 --node-type gateway --shape chain
pnpm benchmark:immediate -- --nodes 100 --runs 5 --node-type gateway --shape chain
pnpm benchmark:immediate -- --nodes 100 --runs 5 --node-type gateway --shape fanout
pnpm benchmark:immediate -- --nodes 25 --runs 3 --node-type script --shape chain
pnpm benchmark:schedule -- --schedules 50 --interval-seconds 1 --timeout-ms 120000
pnpm benchmark:schedule -- --schedules 100 --interval-seconds 1 --timeout-ms 180000
pnpm benchmark:schedule -- --schedules 300 --interval-seconds 3600 --force-due-in-seconds 3 --timeout-ms 180000
pnpm benchmark:cleanup -- --yes
```
