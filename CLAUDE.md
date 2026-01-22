# PXM Project Context

## 프로젝트 개요

pxm은 DB truth 기반 BPM/Workflow 엔진이다.

- **Node (NestJS)**: API/BFF + SSE 스트리밍
- **Rust Engine**: 워크플로우 실행 (노드 실행, 재시도, 타이머, 락/리스)
- **DB (Postgres)**: 단일 Source of Truth

## 디렉토리 구조

```
apps/
  api/       # NestJS - REST API + SSE 스트리밍 (포트 3000)
  engine/    # Rust - Job 워커 (워크플로우 실행)
  web/       # React/Vite - 프론트엔드 (포트 5173)
packages/
  contracts/ # 공유 타입 (이벤트 타입 등)
infra/
  db/migrations/  # DB 스키마
  docker-compose.yml
```

## 핵심 DB 테이블

| 테이블 | 역할 |
|--------|------|
| `process_instance` | 인스턴스 상태 + ctx.cursor (실행 위치) + lock/lease 정보 |
| `engine_jobs` | 작업 큐 (START/RETRY/TIMER), SKIP LOCKED로 분산 처리 |
| `event_outbox` | 이벤트 로그 (append-only), SSE로 브라우저에 전달 |
| `tasks` | 사용자 승인 작업 (미구현) |

## 실행 흐름

```
1. API → process_instance 생성 + engine_jobs(START) 생성
2. Rust Engine → FOR UPDATE SKIP LOCKED로 job 획득
3. Engine → advisory lock + lease로 인스턴스 실행
4. Engine → cursor 기반 노드 실행 (start → service → timer → end)
5. 각 상태 변화 → event_outbox에 append
6. API → outbox polling → SSE로 브라우저에 전달
```

## 최근 구현 (RetryPolicy + Timer)

### RetryPolicy (운영급 재시도)
- **구조체**: `RetryPolicy` - max_attempts, initial_delay_ms, max_delay_ms, multiplier, jitter_factor, retry_on_statuses
- **함수**: `should_retry()`, `calculate_backoff()`, `build_retry_info()`
- **outbox 표준 포맷**: `retry_info { attempt, max_attempts, next_delay_ms, will_retry, reason }`
- **환경변수**:
  - `RETRY_MAX_ATTEMPTS` (기본 5)
  - `RETRY_INITIAL_DELAY_MS` (기본 1000)
  - `RETRY_MAX_DELAY_MS` (기본 60000)
  - `RETRY_MULTIPLIER` (기본 2.0)
  - `RETRY_JITTER_FACTOR` (기본 0.1)
  - `HTTP_TIMEOUT_SECS` (기본 10)

### Timer (타이머 노드)
- **구조체**: `TimerConfig` - duration_ms, timer_type, node_id, on_expire
- **함수**: `schedule_timer()`, `run_timer_job()`, `node_timer()`
- **워크플로우**: `start → service → timer → end`
- **이벤트 흐름**:
  1. timer 노드 진입 → `TIMER_SCHEDULED` + `INSTANCE_WAITING`
  2. duration_ms 후 TIMER job 실행
  3. timer 완료 → `RESUME` job 생성 → 다음 노드로 진행
- **환경변수**: `TIMER_DURATION_MS` (기본 5000)
- **확장 포인트**: process_def에서 노드별 타이머 설정 읽기 (Designer 연동)

## 설계 원칙

- **DB = Source of Truth**: 모든 상태는 DB에 저장
- **Outbox 패턴**: 이벤트 append-only, SSE로 실시간 전달
- **Lock/Lease**: advisory lock + lease + heartbeat로 다중 워커 동시 실행 방지
- **Retry**: Exponential backoff + jitter, max_retry 제한

## 주요 파일 위치

### API (NestJS)
- `apps/api/src/instances/instances.controller.ts` - POST /instances, SSE 스트림
- `apps/api/src/instances/instances.service.ts` - 인스턴스 생성 로직
- `apps/api/src/outbox/outbox.service.ts` - outbox 조회
- `apps/api/src/debug/flaky.controller.ts` - 재시도 테스트용 엔드포인트

### Engine (Rust)
- `apps/engine/src/main.rs` - 워커 전체 로직 (job fetch, 노드 실행, retry, lock/lease)

### DB
- `infra/db/migrations/001_init.sql` - 스키마 정의

## 테스트 방법

```bash
# 인스턴스 생성
curl -X POST http://localhost:3000/instances \
  -H "Content-Type: application/json" \
  -d '{"template_id":"00000000-0000-0000-0000-000000000001","ctx":{"cursor":"start"}}'

# SSE 스트림 확인
curl http://localhost:3000/instances/{instance_id}/stream
```

## 상세 요구사항

상세 제품 요구사항 및 최종 목표는 `PRODUCT_REQUIREMENTS.md` 참조.
