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

- [ ] Workflow call node
  - [ ] 호출 대상 workflow 선택
  - [ ] input mapping
  - [ ] sync/async 호출 모드
  - [ ] child instance trace 연결

- [ ] 이력 API 권한 모델 정리
  - [ ] admin/operator 조회 범위
  - [ ] workflow owner 조회 범위
  - [ ] requester 조회 범위
  - [ ] approver 조회 범위
  - [ ] API client 조회 범위

## Phase 3

- [ ] Executable/Command Node
  - [ ] `command_id` registry 설계
  - [ ] argument schema 설계
  - [ ] timeout/stdout/stderr limit
  - [ ] allowlist 기반 executor
  - [ ] audit log
  - [ ] external agent 실행 모델 검토

- [ ] DB Watch Start
  - [ ] watch 대상 connection 설정
  - [ ] Mongo Change Stream 검토
  - [ ] polling fallback 검토
  - [ ] change event -> workflow input mapping

- [ ] Plugin control UI
  - [ ] plugin enable/disable
  - [ ] version pin
  - [ ] workspace allowlist
  - [ ] trusted source 표시

- [ ] Workflow version diff/rollback
  - [ ] workflow version history
  - [ ] JSON diff view
  - [ ] rollback API

- [ ] External agent 실행 모델
  - [ ] agent registration
  - [ ] heartbeat
  - [ ] command dispatch
  - [ ] result collection
  - [ ] network/security model

## Next Recommended Work

1. Phase 2의 Workflow call node를 진행한다.
2. 이후 이력 API 권한 모델을 정리한다.
3. 운영 전 실제 목표 부하 기준으로 engine worker 수와 Mongo write capacity를 재검증한다.
