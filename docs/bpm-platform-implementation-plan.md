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

## Phase 1

- [ ] Workflow metadata 보강
  - [ ] description
  - [ ] group
  - [ ] tags
  - [ ] version note

- [ ] 외부 연동용 Workflow API 계약 정리
  - [ ] start API endpoint 정리
  - [ ] request payload schema 정리
  - [ ] response payload schema 정리
  - [ ] API authentication/permission 기준 초안

- [ ] 실행 성능 기준 정의
  - [ ] sync timeout 기본값
  - [ ] async instance 생성 응답 목표
  - [ ] trace/result 조회 응답 기준
  - [ ] 장기 실행 workflow 처리 기준

- [ ] End resultPath 추가
  - [ ] End Node 속성 UI 추가
  - [ ] runtime completed result 저장
  - [ ] `GET /api/instances/:id/result` API 추가

- [ ] Workflow export/import JSON 포맷 정의
  - [ ] `schema_version` 정의
  - [ ] workflow metadata 포함
  - [ ] nodes/edges 포함
  - [ ] plugin dependencies 포함
  - [ ] secret 원문 제외 정책 반영
  - [ ] import validation

- [ ] Start API sync/async 응답 모델 정리
  - [ ] async mode: 즉시 `instance_id` 반환
  - [ ] sync mode: 제한 시간 내 완료 시 `result` 반환
  - [ ] sync timeout 시 `202 Accepted + instance_id` 반환
  - [ ] stream/trace/result 조회 흐름 정리

- [~] Node test UX 확장
  - [x] 테스트 실행 버튼
  - [x] MongoDB Query 테스트 실행
  - [x] HTTP Request 테스트 실행
  - [ ] 테스트 결과 JSON tree view
  - [ ] JSON path 자동 추출
  - [ ] 이전 노드 output path 자동 제안
  - [ ] JS Node editor에 path 삽입 UX

## Phase 2

- [ ] Connection/Secret 관리 화면과 API
  - [ ] connection registry model
  - [ ] secret 저장/조회 API
  - [ ] workflow export 시 secret 원문 제거
  - [ ] node config에서 `connection_id` 선택
  - [ ] secret 사용 audit log

- [ ] Schedule Start
  - [ ] Start Node trigger type 추가
  - [ ] cron/interval 설정 UI
  - [ ] scheduler job 저장
  - [ ] scheduled workflow instance 생성

- [ ] Dashboard retry
  - [ ] 실패 instance retry
  - [ ] 실패 node부터 retry
  - [ ] retry 전 context/입력 확인
  - [ ] side effect node 재실행 경고

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

1. Phase 1의 Workflow metadata부터 구현한다.
2. 이어서 End resultPath와 instance result API를 잡는다.
3. 그 다음 export/import 포맷을 확정한다.
4. Node test UX는 이미 시작됐으므로 JSON path 제안으로 확장한다.
