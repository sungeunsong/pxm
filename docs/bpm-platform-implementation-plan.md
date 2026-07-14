# BPM Platform Implementation Plan

이 문서는 `docs/bpm-platform-meeting-brief.md`를 기준으로 실제 구현 진행 상태를 추적한다.

## Status Legend

- `[ ]` Not started
- `[~]` In progress
- `[x]` Done
- `[!]` Blocked

## Current Baseline

- [x] JS Node 추가
- [x] MongoDB Query Node 추가
- [x] Mock/demo plugin 제거
- [x] HTTP Request core plugin 유지
- [x] DB Node가 PXM runtime `MONGODB_URL`로 fallback하지 않도록 수정
- [x] MongoDB Query Node 테스트 실행 API 추가
- [x] HTTP Request Node 테스트 실행 API 추가
- [x] 속성 패널 폭 개선
- [x] 속성 패널 접기/펼치기
- [x] 디자이너 빈 영역 클릭 시 속성 패널 닫기
- [x] 노드 클릭 시 속성 패널 자동 열기
- [x] 회의 리뷰 기반 로드맵 문서화
- [x] 즉시 실행 노드 기반 runtime 속도 테스트 문서화

## Phase 1

- [x] Workflow metadata 보강
  - [x] description
  - [x] group
  - [x] tags
  - [x] version note

- [x] 외부 연동용 Workflow API 계약 정리
  - [x] start API endpoint 정리
  - [x] request payload schema 정리
  - [x] response payload schema 정리
  - [x] API authentication/permission 기준 초안

- [x] 실행 성능 기준 정의
  - [x] sync timeout 기본값
  - [x] async instance 생성 응답 목표
  - [x] trace/result 조회 응답 기준
  - [x] 장기 실행 workflow 처리 기준

- [x] End resultPath 추가
  - [x] End Node 속성 UI 추가
  - [x] runtime completed result 저장
  - [x] `GET /api/instances/:id/result` API 추가

- [x] Workflow export/import JSON 포맷 정의
  - [x] `schema_version` 정의
  - [x] workflow metadata 포함
  - [x] nodes/edges 포함
  - [x] plugin dependencies 포함
  - [x] secret 원문 제외 정책 반영
  - [x] import validation

- [x] Start API sync/async 응답 모델 정리
  - [x] async mode: 즉시 `instance_id` 반환
  - [x] sync mode: 제한 시간 내 완료 시 `result` 반환
  - [x] sync timeout 시 `202 Accepted + instance_id` 반환
  - [x] stream/trace/result 조회 흐름 정리

- [x] Node test UX 확장
  - [x] 테스트 실행 버튼
  - [x] MongoDB Query 테스트 실행
  - [x] HTTP Request 테스트 실행
  - [x] 테스트 결과 JSON tree view
  - [x] JSON path 자동 추출
  - [x] 이전 노드 output path 자동 제안
  - [x] JS Node editor에 path 삽입 UX

## Phase 2

- [x] Credential Store 관리 화면과 API
  - [x] credential profile + secret value model
  - [x] credential 저장/조회 API
  - [x] workflow export 시 credential 원문 제거
  - [x] node config에서 `credential_id` 선택
  - [x] credential 사용 audit log

- [x] Schedule Start 전 runtime 안정화
  - [x] Mongo transaction transient error 처리
  - [x] Timer job/token 완료 전이 모델 수정
  - [x] `GET /api/engine/queue/stats` queue/backlog 관측 API 추가
  - [x] gateway chain/fanout benchmark 재실행

- [x] Schedule Start
  - [x] Start Node trigger type 추가
  - [x] 관리 화면 schedule enabled 토글 추가
  - [x] cron/interval 설정 UI
  - [x] scheduler job 저장
  - [x] scheduled workflow instance 생성
  - [x] scheduler 부하 테스트 5/50/100개 실행
  - [x] scheduler 초기 튜닝 및 100/300개 same-due 검증

- [x] Dashboard retry
  - [x] 실패 instance retry
  - [x] 실패 node부터 retry
  - [x] retry 전 context/입력 확인
  - [x] side effect node 재실행 경고

- [x] Workflow call node
  - [x] 호출 대상 workflow 선택
  - [x] input mapping
  - [x] async 호출 정책: 자식 instance 생성/START job 등록까지 보장, 자식 완료는 기다리지 않음
  - [x] wait 호출 정책: 부모 token WAITING, 자식 완료/실패 후 parent RESUME
  - [x] child instance trace 연결
  - [x] 직접 self-call 차단 및 호출 depth 제한
  - [x] sync/wait 호출 모드
  - [x] 고도화: 간접 순환 호출 사전 탐지 (`A -> B -> A`)
  - [x] 고도화: wait timeout 정책
  - [x] 고도화: parent cancel 시 child cancel propagation
  - [x] 고도화: child trace/result 바로가기 UI
  - [x] 고도화: wait 모드 실패 후 재시도 UX 정리

- [x] 이력 API 권한 구현
  - [x] admin/operator 조회 범위
  - [x] workflow owner 조회 범위
  - [x] requester 조회 범위
  - [x] approver 조회 범위
  - [x] API client 조회 범위

## Phase 3

- [x] Executable/Command Node local executor
  - [x] `command_id` registry 설계
  - [x] argument schema 설계
  - [x] timeout/stdout/stderr limit
  - [x] allowlist 기반 executor
  - [x] audit log
  - [x] external agent 실행 모델 검토 (`docs/command-node-execution-model.md`)

- [x] Command Registry 관리
  - [x] MongoDB command registry 저장소
  - [x] command registry 관리 API
  - [x] 최고관리자 관리 화면
  - [x] Command Node registry dropdown
  - [x] engine DB registry 로딩
  - [x] builtin command 노출

- [x] DB Watch Start
  - [x] watch 대상 connection 설정 (same Mongo cluster/database)
  - [x] polling fallback 구현
  - [x] change event -> workflow input mapping
  - [x] Mongo Change Stream 실시간 watch 구현

- [x] Plugin control UI
  - [x] plugin enable/disable
  - [x] version pin
  - [x] workspace allowlist
  - [x] trusted source 표시

- [ ] Plugin Manifest Registry 관리
  - [x] manifest 등록 API
  - [x] manifest 수정/삭제 API
  - [x] manifest validation
  - [x] plugin manifest hot reload
  - [x] manifest 관리 UI
  - [ ] trusted source / signature 검증
  - [x] Plugin Control UI 연동

## Workflow UX / Observability Roadmap

- [~] 동시에 여러 workflow 보기
  - [x] designer tab 모델 설계
  - [x] unsaved changes guard
  - [x] tab별 version/dirty state 표시
  - [x] workflow 간 복사/참조 UX 검토

- [x] Command 실행 terminal view
  - [x] command 실행 log API 정리
  - [x] stdout/stderr streaming 또는 polling 조회 API 설계
  - [x] ANSI escape 처리/마스킹 정책
  - [x] instance trace에서 command terminal drawer 제공
  - [x] audit log와 terminal output 보관 기간 분리

- [x] JS Node console / output view
  - [x] JS Node `return` 결과를 실행 로그의 `Output JSON` 블록으로 표시
  - [x] JS executor에서 `console.log/warn/error` 캡처
  - [x] 실행 로그의 JS Node 카드에 `Console output` 블록 표시
  - [x] console output line/byte limit 정책
  - [x] console output secret masking 정책
  - [x] 실패한 JS Node도 실행 전까지의 console output 표시

- [x] 자주 쓰는 파라미터 세트
  - [x] workflow별 input preset 모델
  - [x] input preset DB 저장소 및 CRUD API
  - [x] API 실행 프리셋 독립 관리 페이지와 전체 조회 API
  - [x] workflow 선택 기반 생성, Start 입력 스키마 안내, API alias/호출 예시 제공
  - [x] Designer/워크플로우 관리에서 해당 workflow 프리셋 바로가기
  - [x] preset alias/id 기반 Start API 실행
  - [x] preset 값 + 요청 input override 병합
  - [x] 소유 group 기본 + 개인 테스트 고급 scope 정책
  - [x] 로그인 session actor 기반 created_by/updated_by 소유권
  - [x] 관리자는 소유 group 기본, 일반 user 빠른 저장은 private 적용
  - [x] 지정 group 공유 신규 생성 중단: workflow 실행 권한 공유 모델 도입 전까지 legacy 조회/소유 group 전환만 지원
  - [x] Start 입력 스키마 기반 JSON 골격 자동 생성과 필수값/타입/허용 키 검증
  - [x] secret/credential 값 저장 금지 정책
  - [x] request portal / start API에서 preset 선택 지원

- [x] Workflow export version metadata 보강
  - [x] workflow 현재 version 관리
  - [x] workflow version history / diff / rollback
  - [x] export JSON에 `workflow.version`, `workflow.definition_id`, `workflow.exported_version_note` 명시
  - [x] import 시 원본 version metadata를 참고 정보로 보존

- [x] Workflow version diff/rollback
  - [x] workflow version history
  - [x] JSON diff view
  - [x] rollback API

## Group / RBAC / API Key Roadmap

- [x] Group domain model
  - [x] group CRUD API/storage skeleton
  - [x] role 모델: `admin`, `group_manager`, `user`
  - [x] workflow group ownership 연결: `group_id` metadata/definition/version/export/start access 반영
  - [x] Flow Designer 생성/수정 화면의 관리 group 선택 UX
  - [x] workflow 관리/Designer 목록의 actor group 기반 서버 필터
  - [x] 최고관리자 workflow 관리 화면의 group 표시/필터/변경
  - [x] 단일 group manager 신규 workflow group 자동 지정
  - [x] group 삭제 정책: soft delete, API key 비활성화, 실행 이력/version 보존 기반
  - [x] 삭제된 group/workflow 조회/복구는 `admin`만 허용하는 guard 적용
  - [x] group 복구 시 비활성화된 API key는 자동 복구하지 않음
  - [x] group별 이력 조회 범위

- [x] Role model 재정리
  - [x] `admin`: group 생성/삭제/복구, group role 부여, 전체 감사
  - [x] `group_manager`: 할당받은 group 안에서 workflow/API key/멤버 관리
  - [x] 사용자별 다중 group membership 및 group별 `group_manager`/`user` role 적용
  - [x] 기존 `role`/`group_ids` 데이터의 membership 자동 호환
  - [x] Access Management 그룹 전환 시 선택 group 기준 사용자/service account/API key 조회
  - [x] 로그인/서버 저장형 opaque session 연동 및 `/api/auth/me`, logout 구현
  - [x] session token hash 저장, idle 30분/absolute 8시간 만료
  - [x] 최고관리자 세션 만료 정책 관리: idle 5~120분, absolute 1~24시간 제한
  - [x] 초기 기본값 30분/8시간과 DB 저장 정책 우선 적용
  - [x] 정책 변경 시 현재 비밀번호 재확인, 변경 사유/전후값 감사 로그
  - [x] 기존 세션 유지/현재 세션 제외 전체 폐기/모든 세션 폐기 선택
  - [x] 기존 세션은 로그인 당시 정책 유지, 신규 세션부터 변경 정책 snapshot 적용
  - [x] 일반 API polling/SSE는 비활동 시간을 연장하지 않도록 분리
  - [x] 키보드/포인터/터치/휠 사용자 활동 기반 전용 heartbeat 적용
  - [x] 브라우저 만료 타이머와 만료 2분 전 경고/계속 사용 UX
  - [x] 세션별 폐기, 다른 세션 전체 폐기, 활성 세션 조회 API
  - [x] unsafe method CSRF token 검증과 HttpOnly/Secure/SameSite cookie 정책
  - [x] 로그인 실패 5회/15분 제한 1차 적용
  - [x] 임시 `x-actor-*` admin header 제거, session actor 기반 관리 권한 적용
  - [x] `admin`/`group_manager`/`user`별 관리 메뉴 노출 제한
  - [x] PXM / Penta eXecute Manager 로그인 브랜딩과 앱 아이콘 적용
  - [x] 내 정보 수정과 비밀번호 변경, 변경 시 다른 세션 폐기
  - [x] Approval 노드는 기본 제공하고 요청/승인 포털과 결재함은 sample UI feature flag로 분리
  - [x] `user`: 개인 API key owner 또는 일반 실행 주체. 관리 권한 없음
  - [x] 웹 콘솔 user는 최고관리자/그룹관리자/개인 API 사용자 중심으로 제한
  - [x] 일반 업무 사용자는 기본적으로 BPM user로 등록하지 않음
  - [x] 요청자/승인자 같은 runtime role은 관리 role과 분리
  - [x] legacy operator/workflow_owner/requester/approver/api_client는 session 관리 role에서 제외하고 opt-in actor header/runtime 호환 path로만 유지

- [x] Workflow ownership / audit
  - [x] workflow created_by / updated_by 실제 로그인 주체 반영
  - [x] workflow 생성/수정/삭제 audit event 저장
  - [x] group 변경/role 변경/API key 발급 audit event 저장
  - [x] workflow 실행 instance에 `workflow_version_id` 저장
  - [x] workflow 실행 시 immutable workflow version 생성/참조
  - [x] workflow version 저장소에 실행 당시 definition 보관
  - [x] instance 표시용 snapshot 저장: workflow/group/caller/API key 이름

- [x] Group-scoped API key
  - [x] group별 API key 발급/비활성화 API/storage skeleton
  - [x] API key owner 모델: `USER` 또는 `SERVICE_ACCOUNT`
  - [x] 인증 방식: `Authorization: Bearer pxm_live_xxx`
  - [x] 운영/연동용 API key는 기본적으로 service account에 발급
  - [x] 개인 실행 추적이 필요한 API 호출은 user owner 개인 API key 사용
  - [x] API key 발급자/발급 대상/service account 기록
  - [x] key prefix 기반 식별, secret hash 저장
  - [x] API key scope는 owner/group 권한을 늘리지 않고 줄이는 용도로만 사용
  - [x] key scope는 행위 제한(`workflow:read`, `workflow:execute`, `task:approve`)과 대상 제한(`allowed_workflow_ids`)을 분리
  - [x] workflow 생성/수정/삭제/버전 관리는 API key로 열지 않고 웹 콘솔 `admin`/`group_manager` 권한으로만 처리
  - [x] `task:approve`는 승인 주체 추적을 위해 개인 `USER` owner API key로만 허용
  - [x] workflow start/result/history 권한 scope 1차 적용: API key scope ∩ allowed workflow
  - [x] 기본 key scope는 owner group workflow 전체 선택, 발급자가 축소 가능
  - [x] optional `business_actor`는 권한 판단이 아니라 audit metadata로만 저장
  - [x] 공용 시스템 내부 버튼 클릭자는 기본적으로 해당 시스템 audit 책임
  - [x] API key 사용 이력: owner, group, key_id, endpoint, workflow_id, optional business_actor
  - [x] 기본 만료 없음, optional 만료일, 만료/rotation
  - [x] rate limit / IP allowlist 1차: 분당 DB usage count, exact IP/IPv4 CIDR

- [x] Group-scoped Credential Store
  - [x] credential profile에 `group_id`, created_by/updated_by 저장
  - [x] admin 전체 관리, group_manager 본인 group만 조회/생성/수정/폐기
  - [x] 단일 owner group + `shared_group_ids` 사용 grant 모델
  - [x] 공유 group은 workflow 사용만 허용하고 수정/폐기/재공유 차단
  - [x] 공유 회수 후 workflow 저장/DB Watch/engine runtime에서 사용 차단
  - [x] 공유 대상 group 삭제 시 credential grant 자동 회수, group 복구 시 자동 복원하지 않음
  - [x] 소유 group은 공유 group의 사용 이력까지 조회, 공유 group은 자기 group 사용 이력만 조회
  - [x] API key와 일반 user의 credential 관리 API 접근 차단
  - [x] workflow 저장 및 plugin/DB Watch test/runtime에서 credential group 재검증
  - [x] secret 원문 재노출 금지와 AES-256-GCM 암호화 유지
  - [x] 운영 환경 `CREDENTIAL_SECRET_KEY` 필수화
  - [x] metadata의 password/token/connection string 계열 평문 저장 차단
  - [x] credential 사용 audit log를 group 범위로 제한

### Group / RBAC / API Key Handoff

현재 상태:

- Group/RBAC/API Key 백엔드 1차 구현 완료: group/user/service account/API key 저장소, 관리 API, Bearer API key 인증 middleware, scope/allowed workflow 권한 체크가 연결되어 있다.
- Access Management 웹 화면 1차 구현 완료: group 중심으로 group member, service account, API key를 관리하며 group ID는 자동 생성, user ID는 운영 식별자로 직접 입력한다.
- API 권한 smoke 테스트 완료: 잘못된 key 차단, workflow scope/allowed workflow 제한, service account `task:approve` 차단, user `task:approve` 허용, group 삭제 후 key 차단까지 확인했다.

다음 작업:

- Workflow 생성/수정 화면의 `group_id` 선택 UX 완료. 레거시 group name-only workflow는 저장 전 실제 관리 group을 선택한다.
- API key 발급 화면의 `allowed_workflow_ids`를 group workflow 목록 체크박스 선택으로 전환 완료했다.
- Credential은 단일 group 소유 자원이며 다른 관리 group에는 실행 사용 권한만 공유할 수 있다. 공유 group은 secret/설정/공유 범위를 변경할 수 없고, 기존 `group_id` 없는 credential은 admin에게만 보인다.
- API key optional 만료일/rotation/exact IP·IPv4 CIDR allowlist/분당 rate limit을 관리 화면과 인증 middleware에 연결했다.
- 서버 저장형 세션과 CSRF 1차 연동 완료. 운영 배포 전 OIDC/SSO 전환 여부, Redis 기반 분산 로그인 제한, reverse proxy/trusted IP 정책을 확정한다.
- 로컬 최초 로그인은 기본 `admin` / `admin1234`이며, 운영에서는 `PXM_BOOTSTRAP_ADMIN_ID`, `PXM_BOOTSTRAP_ADMIN_PASSWORD`를 반드시 지정한다. 세션 원문은 256-bit 난수이고 서버에는 SHA-256 hash만 저장한다.
- `task:approve` scope를 실제 승인 API end-to-end 흐름에 연결하고 권한 테스트를 자동화한다.
- 최고관리자용 전체 사용자 디렉터리와 reverse proxy trusted IP/Redis 기반 고정밀 분산 rate limit은 후속 운영 UX·인프라 항목으로 검토한다.

## Security Hardening Roadmap

- [~] Web/API backend 보안 기준 정리
  - [~] NestJS/API validation pipe와 DTO validation 일관 적용
    - [x] 전역 `ValidationPipe`의 transform/whitelist/unknown field 차단 적용
    - [x] 로그인/profile/password/group/user/service account/API key/credential/workflow DTO 검증 적용
    - [ ] legacy inline body/interface DTO를 class DTO로 순차 전환
  - [~] auth guard / permission guard 도입 범위 결정
    - [x] 전역 authentication guard 적용: session/API key가 없는 요청은 기본 `401`
    - [x] 공개 endpoint를 login/logout/health로 명시하고 production 개발 우회 차단
    - [ ] controller별 수동 권한 검사를 resource permission guard/decorator로 표준화
  - [x] CSRF/CORS/session/JWT 정책 결정
    - [x] 브라우저는 서버 저장형 opaque session + CSRF double-submit token 사용
    - [x] 외부 연동은 JWT 대신 group-scoped API key 사용
    - [x] production CORS default deny 및 `PXM_CORS_ORIGINS` allowlist 적용
    - [x] reverse proxy 신뢰는 `PXM_TRUST_PROXY` 명시 설정일 때만 적용
  - [x] API key hashing/rotation/secret redaction 기준
  - [ ] audit log tamper resistance 검토
  - [x] dependency vulnerability scan / lockfile audit 운영 기준
    - [x] API/plugin-host NestJS 및 전이 의존성 보안 패치 적용
    - [x] `pnpm audit:prod` 기준 production dependency 취약점 0건 확인

운영 설정 기준:

- 동일 origin 배포는 `PXM_CORS_ORIGINS` 없이 사용하며, Web/API origin이 다르면 허용할 origin만 쉼표로 지정한다.
- reverse proxy 뒤에서는 실제 proxy hop 수 또는 신뢰할 proxy IP 목록을 `PXM_TRUST_PROXY`에 지정한다. 설정이 없으면 forwarded IP를 신뢰하지 않는다.
- Helmet 보안 응답 헤더를 기본 적용하고, DTO에 선언되지 않은 body 필드는 `400 Bad Request`로 차단한다.
- `AUTHZ_ALLOW_DEVELOPMENT_BYPASS`와 `AUTHZ_ALLOW_ACTOR_HEADERS`는 로컬 호환 테스트 전용이며 production에서는 항상 무시한다.
- production dependency 취약점 검사는 배포 전 `pnpm audit:prod`로 실행하며 High/Critical 발견 시 배포를 중단한다.
- 세션 정책 DB 값이 없을 때는 `PXM_SESSION_IDLE_MINUTES`(기본 30분), `PXM_SESSION_ABSOLUTE_HOURS`(기본 8시간)를 초기값으로 사용한다. 범위 또는 상호 관계가 잘못되면 API 서버 시작을 중단한다.
- 비활동 타임아웃은 별도 scheduler가 아니라 모든 인증 요청에서 만료 여부를 검사한다. 일반 API polling/SSE는 시간을 연장하지 않으며, 실제 키보드·포인터·터치·휠 활동이 발생한 브라우저가 `/api/auth/activity` heartbeat를 보낼 때만 `last_seen_at`과 `idle_expires_at`을 최대 1분 간격으로 갱신한다.

- [ ] Script/Plugin execution 보안
  - [ ] JS Node sandbox timeout/memory/output limit 재검토
  - [ ] JS module import allowlist와 package version pin
  - [ ] SSH/Command plugin network egress allowlist
  - [ ] command/ssh output secret masking

## Plugin Runtime / SDK Roadmap

- [ ] Plugin Runtime 상세 설계
  - [ ] `docs/plugin-sdk-design.md` 작성
  - [ ] plugin type 정의 (builtin, external_http, sdk_package, agent_executed)
  - [ ] external_http execution contract 설계
  - [ ] credential/secret 전달 정책 설계
  - [ ] timeout/retry/cancel/result schema 정책 설계
  - [ ] sandbox/security policy 설계
  - [ ] SSH plugin 실행 모델 결정 (engine direct vs agent_executed)
  - [ ] SSH credential binding 정책 설계 (password/key/passphrase/known_hosts)
  - [ ] JS Node module import 정책 설계 (기본 내장 모듈/allowlist package만 허용)

- [ ] Plugin SDK / Package 모델
  - [ ] plugin developer guide 작성
  - [ ] package 구조 정의
  - [ ] manifest schema 확정
  - [ ] execute/test context contract 설계
  - [ ] local validate/test/pack CLI 설계
  - [ ] bundle upload/private registry 전략 설계

## PXM Agent Roadmap

- [ ] Agent 상세 설계
  - [ ] `docs/pxm-agent-architecture.md` 작성
  - [ ] 네트워크 모델 결정 (outbound polling / long polling / push 배제 여부)
  - [ ] 인증/등록 모델 결정 (registration token, agent_id, token rotation, revocation)
  - [ ] capability/권한 모델 결정 (workspace, command, plugin, secret scope)
  - [ ] job dispatch/result protocol 설계
  - [ ] audit/security model 설계
  - [ ] MVP 구현 범위 확정

- [ ] Agent PoC
  - [ ] agent registration API
  - [ ] heartbeat API
  - [ ] outbound job polling
  - [ ] command dispatch PoC
  - [ ] result collection PoC

- [ ] Agent MVP
  - [ ] agent group / workspace binding
  - [ ] command/plugin capability matching
  - [ ] timeout/retry/cancel
  - [ ] stdout/stderr/resource limit
  - [ ] admin UI

- [ ] Agent 운영화
  - [ ] mTLS 또는 강화된 token rotation
  - [ ] binary signing / upgrade strategy
  - [ ] proxy/offline/reconnect 지원
  - [ ] HA / load balancing
  - [ ] metrics / alerting
  - [ ] artifact / 대용량 결과 처리

## 3차 회의 반영 판단

| 회의 의견 | 판단 | 이유 / 반영 위치 |
|---|---|---|
| 동시에 여러 워크플로우 보기 | 적용 | 운영자가 여러 정의를 비교/수정하는 UX 요구로 타당하다. `Workflow UX / Observability Roadmap`에 designer tab으로 반영한다. |
| 워크플로우 export할 때 버전 정보 | 적용 | 현재 version history는 있으나 export document에는 workflow version/definition id가 명시되지 않는다. `Workflow export version metadata 보강`으로 반영한다. |
| 명령어 노드 수행 내용을 터미널로 보여주는 화면 | 적용 | Command Node의 실사용 디버깅에 필요하다. 단, stdout/stderr 보관과 secret masking 정책이 필요하므로 observability 항목으로 분리한다. |
| JS Node 로그 출력 | 적용 | Command Terminal과 섞지 않고 `Console output`으로 분리한다. `return` 결과는 workflow data이므로 `Output JSON`, `console.log/warn/error`는 debug trace로 표시한다. |
| SSH 플러그인 | 적용 | 운영 자동화 connector로 필요성이 높다. 보안상 engine direct 실행보다 `agent_executed` 우선 검토로 Plugin Runtime/Agent 로드맵에 연결한다. |
| JS module import 가능 여부 | 제한 적용 | 임의 npm import는 sandbox/package supply-chain 위험이 크다. 기본은 차단하고 allowlist + version pin 방식만 검토한다. |
| 권한/이력 등을 그룹별로 | 적용 | 현재 role 기반 이력 권한은 있으나 group domain이 없다. `Group / RBAC / API Key Roadmap`에 신규 축으로 반영한다. |
| 그룹 삭제시 포함된 워크플로우까지 삭제 | 제한 적용 | 무조건 hard delete는 실행 이력/감사/복구 관점에서 위험하다. 기본은 group/workflow soft delete와 API key 비활성화로 처리하고, 실행 이력과 workflow version은 보존한다. |
| 그룹별 API 키 발급 및 사용 추적 | 적용 | 외부 솔루션 연동에서 필수다. 발급자, service account, 사용 이력까지 포함해 group-scoped API key로 반영한다. |
| 해당 그룹에서 누구에게 발급했는지 추적 | 적용 | API key governance 핵심이다. key owner/service account/issuer audit로 반영한다. |
| 워크플로우 누가 추가/생성했는지 | 적용 | DTO에는 `created_by` 필드가 있으나 현재 기본값이 `admin`에 가깝다. 실제 로그인 주체/audit 반영 항목으로 추가한다. |
| 롤은 두 개로: 최고관리자, 중간 관리자 | 부분 적용 | 제품 운영 role은 `admin`, `group_manager`, `user` 3단계로 둔다. runtime role(요청자/승인자/API client)은 관리 role과 분리한다. |
| 자주 쓰는 파라미터 세트 | 적용 | 반복 실행 UX와 외부 테스트에 유용하다. secret 저장 금지를 전제로 input preset 기능으로 반영한다. |
| 웹 백엔드는 JS인데 보안은 어쩔까? | 적용 | 언어 문제가 아니라 API validation/auth/secret/audit/dependency/sandbox 기준 문제다. `Security Hardening Roadmap`으로 반영한다. |

## Next Recommended Work

1. Web/API 보안의 남은 항목인 resource permission guard 표준화와 audit log tamper resistance를 진행한다.
2. `task:approve` scope를 실제 승인 API end-to-end 흐름에 연결하고 자동 권한 테스트를 보강한다.
3. Plugin Manifest Registry의 trusted source/signature 검증을 완료한다.
4. Plugin Runtime / SDK 상세 설계를 진행하되 SSH와 임의 JS module import는 agent·sandbox 정책 확정 전까지 제한한다.
5. PXM Agent는 후순위로 유지하고, 우선 registration/heartbeat/outbound polling 계약부터 문서화한다.
6. 운영 전 실제 목표 부하 기준으로 engine worker 수, Mongo write capacity, API key rate-limit 저장소를 재검증한다.
