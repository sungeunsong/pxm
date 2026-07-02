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

## Plugin Runtime / SDK Roadmap

- [ ] Plugin Runtime 상세 설계
  - [ ] `docs/plugin-sdk-design.md` 작성
  - [ ] plugin type 정의 (builtin, external_http, sdk_package, agent_executed)
  - [ ] external_http execution contract 설계
  - [ ] credential/secret 전달 정책 설계
  - [ ] timeout/retry/cancel/result schema 정책 설계
  - [ ] sandbox/security policy 설계

- [ ] Plugin SDK / Package 모델
  - [ ] plugin developer guide 작성
  - [ ] package 구조 정의
  - [ ] manifest schema 확정
  - [ ] execute/test context contract 설계
  - [ ] local validate/test/pack CLI 설계
  - [ ] bundle upload/private registry 전략 설계

- [x] Workflow version diff/rollback
  - [x] workflow version history
  - [x] JSON diff view
  - [x] rollback API

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

## Next Recommended Work

1. 운영 전 실제 목표 부하 기준으로 engine worker 수와 Mongo write capacity를 재검증한다.
2. 회의 시연 전 `docs/bpm-platform-demo-guide.md` 기준으로 demo workflow와 sample data를 준비한다.
3. PXM Agent는 별도 로드맵으로 상세 설계부터 진행한다.
