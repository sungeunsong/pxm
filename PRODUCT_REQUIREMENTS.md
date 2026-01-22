** 바이브코딩용 요구사항 정리본 **

BPM 바이브코딩 요구사항 최종본 (Hybrid: Node + Rust Engine, DB Truth, Outbox+SSE, Lock/Retry 강화)
0) 목표

편리함 + 수려함 + 임팩트: 고객이 “오… 이거 쓰고 싶다”가 바로 나오는 워크플로우 제품

Flow 캔버스 기반 설계/실행 추적이 시각적으로 “탁탁” 보이는 런타임 트레이싱

엔진은 **신뢰성(재시도/타이머/에러 핸들링/락/원자성)**이 제품 품질의 핵심

1) 핵심 아키텍처 결정
1.1 역할 분리
Node (API/BFF)

로그인/권한(RBAC), 테넌트, 템플릿/디자이너 CRUD

UI용 조회 API(인스턴스 상태/토큰/로그/작업함)

사용자 액션(승인/반려/코멘트/첨부) 수신

SSE 실시간 스트리밍 제공(우선), 필요 시 WS 확장

event_outbox 이벤트를 소비하여 브라우저로 실시간 전송

Rust (Workflow Engine / Worker)

프로세스 그래프 실행(토큰 이동), 자동 처리(Service Task), 타이머/재시도

상태 전이(Waiting/Running/Failed/Completed), 실행 로그 기록

사람이 필요한 지점(Approval)에서 task 생성 후 중단

동시 실행 방지(락/임대/원자성) 필수

1.2 Source of Truth

✅ DB가 Source of Truth(DB truth)

상태/토큰/로그/태스크는 DB에 기록

이벤트 스트림은 “전달/알림/UX”용 보조 채널

2) 사용자 관점 시나리오 (민수 스토리, 구현용)
2.1 프로세스 설계(Designer)

민수는 Flow 캔버스에서 다음 노드를 배치하고 배포(Activate)한다:

Start/Form: 권한 요청 폼(사용자/시스템/권한/사유)

Service(HTTP): HR API 호출 → 직무 코드 조회 → ctx.hr.jobCode 저장

Gateway(조건): 직무/요청권한 매칭

OK → 다음 단계

NG → Auto Reject(자동 반려 + 사유 표시)

Approval: 팀장 승인

Gateway(조건): 운영계 권한이면 보안팀 승인 추가

Service(HTTP): AD/권한시스템 API 호출(실제 권한 부여)

성공: 완료 + 알림

실패: 재시도 → 지속 실패 시 Failed + 담당자 알림

End

2.2 프로세스 실행(런타임)

직원이 템플릿 선택 후 제출하면 Node가 인스턴스를 생성하고 엔진 실행을 트리거한다.

Rust 엔진이 자동 노드들을 실행하다가 사람 승인 노드에서 멈추고 task를 생성한다.

사용자가 승인하면 Node가 승인 기록 후 “재개(job)”를 생성하고 Rust가 이어서 실행한다.

2.3 사용자는 “어디서 막혔는지” 실시간으로 본다

인스턴스 상세 화면에서 Flow 캔버스 위에 실행 경로가 실시간 하이라이트

현재 대기 노드/실패 노드 표시

실패 시 에러 카드(HTTP status/timeout/retry count/다음 재시도 시간)

페이지 새로고침 없이 SSE로 상태가 갱신됨

3) 필수 제품 기능 요구사항 (MVP + 임팩트)
3.1 Flow Designer (수려함/임팩트 핵심)

노드 팔레트(최소 6종): Start/Form, Approval, Service(HTTP), Gateway, Timer, End

드래그&드롭, 엣지 연결, 스냅/정렬, 미니맵, 줌, 단축키

노드 선택 시 우측 속성 패널 설정:

Form 필드 구성

Approval(승인자/순차/자동승인/반려사유 필수/대리처리 옵션)

Service(HTTP: URL/Method/Headers/Body/Timeout/Retry/Mapping)

Gateway(조건식 빌더: 쉬운 모드 + 고급식)

Timer(대기시간/SLA/리마인드/에스컬레이션)

3.2 Runtime Trace (고객 “와” 포인트)

인스턴스 상세 화면:

실행된 노드 하이라이트 + 현재 토큰 위치 표시

실패/대기 시 상태 배지 + 원인 요약 카드

실행 로그 타임라인(노드별 입출력 요약, 에러, 재시도 기록)

엣지(연결선) 위로 흐르는 애니메이션으로 “토큰이 이동”하는 느낌 제공

이벤트 기반으로 특정 edge의 animated 상태를 on/off

3.3 Service Task(HTTP) 필수 옵션(운영급)

Secrets 참조(토큰/키 UI 미노출)

Response mapping(JSONPath 등)으로 ctx 저장

Retry Policy 고도화(필수)

Exponential backoff + Jitter(thundering herd 방지)

max_delay 상한

retry_budget(총 재시도 시간/횟수 제한)

retry_on (재시도 대상 status/에러 유형: 429/5xx 등)

Timeout 필수

실패 시 전이(에러 핸들링 경로) 지원

Idempotency 키(중복 호출 방지) 지원

4) 실시간 UX 요구사항 (Outbox + SSE, “탁탁” 애니메이션)
4.1 event_outbox (엔진→UI 결합도 최소화)

Rust 엔진은 상태 변화마다 DB event_outbox에 이벤트를 기록한다.

이벤트 타입 예:

INSTANCE_CREATED, INSTANCE_RUNNING, INSTANCE_WAITING, INSTANCE_FAILED, INSTANCE_COMPLETED

NODE_STARTED, NODE_COMPLETED, NODE_FAILED

TASK_CREATED, TASK_COMPLETED

(선택) TIMER_SCHEDULED, RETRY_SCHEDULED

UI 애니메이션 정확도를 위해 payload 계약 강화(필수)

이벤트 payload에 최소 포함:

instance_id

token_id

from_node_id / to_node_id (또는 edge_id) ✅ 엣지 애니메이션용

node_id (현재 노드)

status

error_summary(있을 때)

retry_info(attempt/next_run_at/backoff 등)

timestamp

4.2 Node SSE 스트리밍

브라우저는 GET /instances/{id}/stream (SSE)로 연결

Node는 outbox 이벤트를 소비(폴링 또는 LISTEN/NOTIFY)하여 SSE로 전송

프론트는 이벤트 수신 시:

실행 노드 하이라이트 갱신

from_node_id → to_node_id edge에 animated=true 켜기

완료/실패 시 해당 edge 애니메이션 끄기 + 상태 표시

초기 안정성/단순성을 위해 SSE 우선, 추후 다중 구독/양방향 필요 시 WS 확장.

5) Queue 추천 (DB truth와 궁합 최상)
✅ 추천: Postgres 기반 큐(engine_jobs + SKIP LOCKED)

별도 메시지 브로커 없이 DB만으로 실행 트리거/재시도/타이머까지 처리

Rust 워커 N개가 SELECT … FOR UPDATE SKIP LOCKED로 job을 안전하게 분산 처리

engine_jobs 개념

job_id, instance_id, type(START/RESUME/TIMER/RETRY), run_at, attempt, status, payload

워커 루프 개념

run_at <= now()인 job을 SKIP LOCKED로 가져와 실행

성공 → 완료 마킹

실패 → retry policy로 run_at 재설정(backoff+jitter) + attempt 증가

6) 인스턴스 락/원자성 요구사항 (반드시, 강화 반영)

같은 instance_id를 여러 워커가 동시에 실행하면 안 됨.

6.1 락 전략: Advisory Lock + Lease(임대) 하이브리드(권장)

Advisory lock만으로도 강력하지만 “회색지대” 대비를 위해 lease를 병행

process_instance에 다음 컬럼을 둠:

lock_owner(worker_id)

lock_until(timestamp)

heartbeat_at

실행 시작 시:

pg_try_advisory_lock(hash(instance_id)) 시도 (잠김이면 패스)

동시에 DB에서 lock_until 갱신(lease 획득)

실행 중:

워커는 주기적으로 heartbeat_at 업데이트 + lock_until 연장(renew)

회수(reclaim):

lock_until < now()인 인스턴스는 다른 워커가 lease를 재획득 가능

별도 Cleanup Worker가 오래된 잠금/좀비 인스턴스를 정리 가능

6.2 상태 전이 원자성

노드 실행 결과 기록(로그) + 토큰 이동 + 인스턴스 상태 변경은 가능한 한 단일 트랜잭션으로

중간 실패 시 “마지막 안정 상태”를 DB에 남겨 재시도 가능해야 함

7) API 계약(브라우저는 Node만 바라봄)
7.1 Node API

POST /instances : 템플릿 실행(폼 제출)

GET /instances/{id} : 인스턴스 상태/토큰/로그 요약

GET /instances/{id}/graph : 캔버스 렌더용 그래프 정의

GET /instances/{id}/stream : SSE 이벤트 스트림

POST /tasks/{task_id}/approve : 승인

POST /tasks/{task_id}/reject : 반려

GET /inbox : 내 작업함(승인 태스크)

7.2 Node → Engine 트리거

Node는 DB에 engine_jobs를 insert하여 엔진 “시작/재개”만 트리거

인스턴스 생성 후 START job

승인 처리 후 RESUME job

Rust는 외부에 “조회 API”를 굳이 제공하지 않음(조회는 Node가 DB 기반으로)

8) “있어 보이는” 제품 요소 (임팩트 체크리스트)

런타임 실시간 하이라이트 + edge 애니메이션(필수)

실패 카드: 에러 요약 + retry count + next retry time

시뮬레이션: 샘플 입력으로 분기 경로 미리보기(가능하면)

템플릿 갤러리(권한요청/구매요청/계정생성 등 기본 제공)

커넥터 카탈로그(“HR 조회”, “AD 권한 부여” 같은 블록 스토어 느낌)

9) 추가로 꼭 넣을 것(프로덕트 안정화)
9.1 스키마/버전 = 계약서

Node/Rust가 같은 DB를 쓰므로 DB 스키마가 곧 계약서

process_def.version, engine_schema_version 등 버전 관리

마이그레이션/호환성 정책: “새 엔진이 옛 인스턴스를 어떻게 처리하는가” 규칙 명시