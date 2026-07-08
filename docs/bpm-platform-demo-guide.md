# BPM Platform Demo Guide

이 문서는 회의 자리에서 웹 화면으로 직접 시연할 기능과 진행 순서를 정리한다.

## Demo Environment

- Web: `http://localhost:5174/`
- API: `http://localhost:3011/api`
- 기본 진입 화면: 좌측 사이드바 기준
  - `Flow Designer`
  - `워크플로우 관리`
  - `실행 모니터링`
  - `Credential Store`
  - `Command Registry`
  - `Plugin Control`
  - `Plugin Registry`

## Demo 원칙

- API 플랫폼이지만, 회의 시연은 웹에서 확인 가능한 관리자/디자이너/이력 화면 중심으로 진행한다.
- Plugin Registry는 현재 "manifest registry" 수준이다. 실제 SDK package 실행/runtime은 별도 로드맵임을 명확히 설명한다.
- Rollback은 기존 버전을 덮어쓰는 방식이 아니라, 과거 스냅샷으로 새 버전을 만드는 방식으로 설명한다.
- DB Watch는 Mongo replica set 환경이면 Change Stream, 아니면 Polling fallback으로 시연한다.

## 사전 준비 체크리스트

- [ ] API 서버 실행: `http://localhost:3011/api/templates`가 `200` 응답
- [ ] Web 서버 실행: `http://localhost:5174/` 접속 가능
- [ ] Engine 실행 상태 확인
- [ ] MongoDB replica set 연결 확인
- [ ] 시연용 Credential 1개 준비
- [ ] 시연용 Command 1개 준비
- [ ] 시연용 Plugin manifest JSON 1개 준비
- [ ] 시연용 DB Watch 컬렉션 준비
- [ ] 시연용 workflow 4개 준비
  - [ ] 일반 실행/resultPath workflow
  - [ ] JS Node 계산/판정 workflow
  - [ ] Schedule Start workflow
  - [ ] DB Watch Start workflow
  - [ ] Workflow Call parent/child workflow
- [ ] 일부러 실패하는 Retry 시연 workflow 준비
- [ ] Version diff/rollback용 workflow 준비

## 권장 시연 순서

1. Flow Designer 기본 설계 경험
2. JS Node 계산 로직
3. Node Test UX
4. Credential Store
5. Workflow 실행/result/trace
6. Schedule Start
7. DB Watch Start
8. Workflow Call Node
9. Dashboard Retry
10. Command Registry / Command Node
11. Plugin Control
12. Plugin Manifest Registry
13. Workflow Version Diff / Rollback

전체를 모두 보여주면 길어질 수 있으므로, 시간이 짧으면 1, 2, 5, 7, 10, 11, 13을 우선 시연한다.

## 시연용 Workflow 매핑

| Workflow | 사용하는 시연 | 목적 |
| --- | --- | --- |
| `DEMO-01 Basic Flow` | 1. Flow Designer 기본 설계 경험 | Start -> JS -> End 기본 구성, metadata 저장, Load 목록 확인 |
| `DEMO-10 JS Node Calculation` | 1-A. JS Node 계산 로직 시연 | `formData.amount`를 읽어 승인 레벨과 결과 JSON을 계산 |
| `DEMO-02 Result Path` | 4. Workflow 실행 / Result / Trace | End Node `resultPath`로 최종 API/result 응답이 정리되는 흐름 |
| `DEMO-03 Schedule Start` | 5. Schedule Start | Start Node의 Schedule trigger, interval 설정, enabled 토글, scheduled instance 생성 |
| `DEMO-04 DB Watch Start` | 6. DB Watch Start | `demo_watch_events` insert를 감지해 workflow 자동 시작 |
| `DEMO-05 Child Workflow` | 7. Workflow Call Node | Parent가 호출하는 자식 workflow. 단독 시연보다는 `DEMO-06`의 대상 |
| `DEMO-06 Parent Workflow` | 7. Workflow Call Node | Workflow Call wait mode, child instance/result 연결 |
| `DEMO-07 Retry Failure` | 8. Dashboard Retry | 의도적으로 실패시킨 뒤 실행 모니터링에서 retry 흐름 확인 |
| `DEMO-08 Command Node` | 9. Command Registry / Command Node | `builtin.echo` command 실행, stdout/result/audit 설명 |
| `DEMO-09 Version Rollback` | 12. Workflow Version Diff / Rollback | v1/v2 version diff 확인, v1 rollback으로 새 버전 생성 |

`Node Test UX`, `Credential Store`, `Plugin Control`, `Plugin Manifest Registry`는 특정 workflow 하나에 묶이지 않고 각 관리 화면 또는 노드 테스트 패널에서 시연한다.

## 1. Flow Designer 기본 설계 경험

### 보여줄 것

- 노드 팔레트
- Start / JS / MongoDB Query / HTTP Request / Command / Workflow Call 노드
- 속성 패널 자동 열림/닫힘
- workflow metadata 저장

### 시연 방법

1. 좌측 사이드바에서 `Flow Designer` 클릭
2. 빈 캔버스에서 Start 노드가 있는지 확인
3. 팔레트에서 `JS` 노드를 캔버스로 드래그
4. 팔레트에서 `End` 노드를 캔버스로 드래그
5. Start -> JS -> End 순서로 edge 연결
6. JS 노드를 클릭
7. 우측 속성 패널이 자동으로 열리는지 확인
8. 빈 캔버스 영역 클릭
9. 속성 패널이 닫히는지 확인
10. 다시 JS 노드를 클릭
11. 속성 패널 접기/펼치기 버튼을 눌러 UI 개선 사항 확인
12. 상단 `Save` 클릭
13. 템플릿 이름 입력
   - 예: `DEMO-01 Basic Flow`
14. description/group/tags/version note 입력
   - description: `회의 시연용 기본 workflow`
   - group: `demo`
   - tags: `demo,basic`
   - version note: `v1 initial`
15. 저장 후 `Load` 클릭
16. 저장된 템플릿 목록에서 metadata와 version을 확인

### 설명 포인트

- 디자이너는 운영 API를 직접 만드는 화면이 아니라, API로 실행될 workflow template을 정의하는 화면이다.
- metadata는 나중에 API catalog, 운영 검색, version 관리 기준으로 사용된다.

## 1-A. JS Node 계산 로직 시연

### 보여줄 것

- JS Node가 `formData`를 읽고 업무 판단 값을 계산하는 흐름
- 계산 결과를 `scriptResults.approvalCalculation`에 저장
- End Node `resultPath`로 JS 결과만 외부 결과로 노출

### 시연 방법

1. 좌측 사이드바에서 `Flow Designer` 클릭
2. 상단 `Load` 클릭
3. `DEMO-10 JS Node Calculation` 선택
4. JS Node `Calculate Approval Data` 클릭
5. 우측 속성 패널에서 JavaScript Code 확인

```javascript
const amount = Number(input.formData?.amount || 0);
const department = input.formData?.department || 'General';
const approvalLevel = amount >= 100000 ? 'executive' : amount >= 50000 ? 'manager' : 'auto';
return {
  amount,
  department,
  approvalLevel,
  requiresApproval: approvalLevel !== 'auto',
  message: approvalLevel === 'auto' ? 'Auto approved' : 'Approval required: ' + approvalLevel,
  calculatedAt: new Date().toISOString()
};
```

6. Output Path가 `scriptResults.approvalCalculation`인지 확인
7. End Node 클릭
8. resultPath가 `scriptResults.approvalCalculation`인지 확인
9. 상단 `Run` 클릭
10. 입력 JSON에 아래 값을 넣어 실행

```json
{
  "amount": 120000,
  "department": "Finance"
}
```

11. 실행 결과에서 `approvalLevel: "executive"`, `requiresApproval: true` 확인
12. 시간이 있으면 amount를 `30000`으로 바꿔 다시 실행하고 `approvalLevel: "auto"` 확인

### 설명 포인트

- JS Node는 외부 연동 없이도 workflow 내부에서 데이터 변환, 계산, 승인 레벨 판정 같은 lightweight logic을 처리할 수 있다.
- 무거운 비즈니스 로직 전체를 JS에 몰아넣기보다, API/플러그인 호출 전후의 mapping/normalization에 쓰는 것이 적절하다.

## 2. Node Test UX

### 보여줄 것

- MongoDB Query Node 테스트 실행
- HTTP Request Node 테스트 실행
- 테스트 결과 JSON tree view
- JSON path 추출/삽입 UX

### MongoDB Query Node 시연 방법

1. `Flow Designer` 진입
2. 팔레트의 Plugin/Core 영역에서 `MongoDB Query` 노드를 캔버스에 추가
3. MongoDB Query 노드 클릭
4. 속성 패널에서 테스트용 설정 입력
   - connection uri는 credential 사용 흐름을 보여줄 경우 직접 넣지 않고 credential 선택
   - database: `pxm_db`
   - collection: demo_orders
   - operation: `find`
   - filter: `{}` 또는 시연용 조건
5. `Test` 또는 `테스트 실행` 버튼 클릭
6. 결과 JSON tree view 확인
7. 결과 항목에서 JSON path 추출 기능 확인

### HTTP Request Node 시연 방법

1. 팔레트에서 `HTTP Request` 노드 추가
2. 노드 클릭
3. 속성 패널에서 URL 입력
   - 예: `https://httpbin.org/json`
4. method: `GET`
5. `테스트 실행` 클릭
6. 응답 JSON tree view 확인
7. path 추출 후 JS Node editor에 삽입하는 흐름 설명

### 설명 포인트

- 노드 테스트는 workflow 전체 실행 전, 개별 connector 설정 검증 용도다.
- JSON path 추출은 다음 노드 input mapping 실수를 줄이기 위한 UX다.

## 3. Credential Store

### 보여줄 것

- Credential 등록/조회
- 노드에서 `credential_id` 선택
- secret 원문이 다시 노출되지 않는 정책
- audit log

### 시연 방법

1. 좌측 사이드바에서 `Credential Store` 클릭
2. `Credential 등록` 영역에서 새 credential 입력
   - name: `DEMO Mongo Credential`
   - type: `mongodb` 또는 화면에서 제공하는 타입
   - scope/workspace: `default`
   - secret value: 시연용 Mongo connection uri
3. 저장
4. 목록에 credential profile이 추가되는지 확인
5. 저장 후 secret value가 원문으로 다시 표시되지 않는지 설명
6. 하단 또는 우측 audit log에서 생성 이력 확인
7. `Flow Designer`로 이동
8. MongoDB Query Node 선택
9. 속성 패널의 `Credential` dropdown에서 방금 만든 credential 선택

### 설명 포인트

- workflow export/import 시 secret 원문은 제외하고 credential id만 참조한다.
- 실제 secret은 중앙 credential store에서 관리한다.

## 4. Workflow 실행 / Result / Trace

### 보여줄 것

- Flow Designer에서 workflow 실행
- instance 생성
- resultPath 기반 결과 확인
- 실행 모니터링에서 trace/result 확인

### 시연 방법

1. `Flow Designer` 클릭
2. Start -> JS -> End workflow 구성
3. JS Node 설정
   - label: `Build Result`
   - script 예시:

```javascript
return {
  approved: true,
  amount: 120000,
  requester: input.formData?.requester || 'demo-user'
};
```

4. End Node 클릭
5. resultPath 설정
   - 예: `scriptResults.buildResult`
6. `Save` 클릭
   - name: `DEMO-02 Result Path`
   - version note: `resultPath demo`
7. 상단 `Run` 클릭
8. 실행 패널 또는 알림에서 instance id 확인
9. 좌측 `실행 모니터링` 클릭
10. 방금 생성된 instance 확인
11. instance 상세 또는 Flow Designer 추적 화면에서 trace/result 확인

### 설명 포인트

- Start API는 async/sync 모두 지원하지만, 웹에서는 실행 후 instance/result/trace 흐름을 중심으로 보여준다.
- End Node의 resultPath가 외부 API 응답의 result 추출 기준이 된다.

## 5. Schedule Start

### 보여줄 것

- Start Node trigger type을 Schedule로 변경
- interval/cron 설정
- 워크플로우 관리 화면에서 schedule enabled 토글
- scheduled instance 생성

### 시연 방법

1. `Flow Designer` 클릭
2. Start Node 클릭
3. 속성 패널에서 trigger type을 `Schedule`로 변경
4. schedule mode를 interval로 선택
5. interval seconds 입력
   - 예: `30`
6. input JSON 입력
   - 예: `{ "source": "schedule-demo" }`
7. Start -> JS -> End 구성
8. JS Node에서 input을 결과로 남기는 간단한 script 입력
9. `Save`
   - name: `DEMO-03 Schedule Start`
   - version note: `schedule trigger demo`
10. 좌측 `워크플로우 관리` 클릭
11. 방금 저장한 workflow 확인
12. schedule detail/status 영역에서 enabled 토글 ON
13. 일정 시간이 지난 뒤 `실행 모니터링` 클릭
14. scheduled instance가 생성되는지 확인

### 설명 포인트

- Flow Designer는 schedule 조건을 정의한다.
- 운영 활성화/비활성화는 워크플로우 관리 화면에서 통제한다.

## 6. DB Watch Start

### 보여줄 것

- DB Watch Start 설정
- polling/change stream 모드
- DB insert로 workflow 자동 시작
- workflow input에 변경 이벤트가 들어오는 구조

### 사전 준비

시연용 컬렉션을 정한다.

- database: `pxm_db`
- collection: `demo_watch_events`

시연 직전에 컬렉션을 비워도 된다.

```bash
docker exec pxm-mongo mongosh pxm_db --quiet --eval 'db.demo_watch_events.deleteMany({demo:true})'
```

### 시연 방법

1. `Flow Designer` 클릭
2. Start Node 클릭
3. trigger type을 `DB Watch`로 변경
4. watch 설정 입력
   - database: `pxm_db`
   - collection: `demo_watch_events`
   - mode: `change_stream`
   - operation: `insert`
   - enabled: ON
5. Start -> JS -> End 구성
6. JS Node에서 watch event를 결과로 남기도록 설정
   - 예: 입력 전체 또는 inserted document를 return
7. `Save`
   - name: `DEMO-04 DB Watch Start`
   - version note: `db watch change stream demo`
8. 별도 터미널에서 데이터 insert

```bash
docker exec pxm-mongo mongosh pxm_db --quiet --eval 'db.demo_watch_events.insertOne({demo:true, title:"meeting-demo", amount:33000, created_at:new Date()})'
```

9. 웹에서 `실행 모니터링` 클릭
10. 새 instance가 자동 생성됐는지 확인
11. instance 상세/result에서 어떤 document/change event로 시작됐는지 확인

### 설명 포인트

- 고객 시스템이 PXM API를 호출하는 방식이 1순위다.
- DB Watch는 API 호출이 어려운 legacy DB 연동을 위한 보완 트리거다.
- Change Stream은 Mongo replica set/managed cluster가 필요하고, 그렇지 않으면 polling fallback을 사용한다.

## 7. Workflow Call Node

### 보여줄 것

- Parent workflow가 Child workflow를 호출
- async/wait 호출 정책
- child instance trace/result 연결
- 순환 호출 차단 정책

### Child workflow 준비

1. `Flow Designer` 클릭
2. Start -> JS -> End 구성
3. JS Node script 예시:

```javascript
return {
  childResult: 'ok',
  received: ctx.data?.formData || {}
};
```

4. 저장
   - name: `DEMO-05 Child Workflow`
   - version note: `child v1`

### Parent workflow 시연 방법

1. 새 workflow 생성
2. Start -> Workflow Call -> End 구성
3. Workflow Call Node 클릭
4. 호출 대상 workflow로 `DEMO-05 Child Workflow` 선택
5. mode 선택
   - 먼저 `async` 또는 `wait`
   - 시간이 있으면 둘 다 비교
6. input mapping 입력
   - 예: `{ "requestId": "demo-001", "amount": 50000 }`
7. 저장
   - name: `DEMO-06 Parent Workflow`
8. `Run`
9. `실행 모니터링`에서 parent instance 확인
10. child instance link 또는 child trace/result 바로가기 확인

### 설명 포인트

- async는 child instance 생성/START job 등록까지만 보장한다.
- wait는 child 완료/실패 후 parent token을 resume한다.
- self-call과 간접 순환 호출은 저장 시점에 차단한다.

## 8. Dashboard Retry

### 보여줄 것

- 실패 instance 확인
- retry preview
- 실패 node부터 retry
- side effect node 경고

### 시연 workflow 준비

1. `Flow Designer` 클릭
2. Start -> JS -> End 구성
3. JS Node script에 의도적 실패 로직 입력

```javascript
const attempt = ctx.data?.formData?.attempt || 1;
if (attempt < 2) {
  throw new Error('demo retry failure');
}
return { retry: 'success', attempt };
```

4. 저장
   - name: `DEMO-07 Retry Failure`

### 시연 방법

1. `Run`으로 실행
2. 실패 상태가 되도록 확인
3. 좌측 `실행 모니터링` 클릭
4. 실패 instance 선택
5. retry preview 확인
6. retry 실행
7. 실패 node부터 다시 실행되는지 확인
8. side effect node 재실행 경고가 있다면 같이 보여준다

### 설명 포인트

- 운영자는 실패 지점과 context를 보고 재시도 여부를 판단한다.
- retry는 전체 재실행이 아니라 실패 node 기준 재개를 목표로 한다.

## 9. Command Registry / Command Node

### 보여줄 것

- 최고관리자 command allowlist 관리
- builtin command 노출
- Command Node dropdown
- stdout/stderr/result 확인
- audit log

### 사전 준비

기본 builtin command가 있으면 그걸 사용한다.

- `builtin.echo`
- `builtin.node_version`

필요하면 `Command Registry`에서 시연용 command를 등록한다.

### Command Registry 시연 방법

1. 좌측 `Command Registry` 클릭
2. command 목록 확인
3. `builtin.echo` 또는 등록된 command 선택
4. command id, executable, timeout, output limit, active 상태 확인
5. 새 command 등록이 필요하면 입력
   - Command ID: `demo.echo`
   - Executable: 사용 가능한 안전한 echo 계열 명령
   - Argument keys: `message`
   - Timeout: `3000`
   - Active: ON
6. 저장

### Command Node 시연 방법

1. `Flow Designer` 클릭
2. Start -> Command -> End 구성
3. Command Node 클릭
4. Command ID dropdown에서 `builtin.echo` 또는 `demo.echo` 선택
5. arguments JSON 입력
   - 예: `{ "message": "hello from command node" }`
6. 저장
   - name: `DEMO-08 Command Node`
7. `Run`
8. `실행 모니터링`에서 result/trace 확인
9. `Command Registry`로 돌아가 audit log가 있으면 확인

### 설명 포인트

- Command Node는 임의 실행이 아니라 registry allowlist에 등록된 command만 실행한다.
- timeout/stdout/stderr limit과 audit log가 기본 통제 장치다.
- 외부 Agent 실행 모델은 별도 로드맵이다.

## 10. Plugin Control

### 보여줄 것

- plugin enable/disable
- version pin
- workspace allowlist
- trusted source 표시
- disabled plugin이 디자이너에서 빠지는 흐름

### 시연 방법

1. 좌측 `Plugin Control` 클릭
2. plugin 목록에서 `MongoDB Query` 또는 `HTTP Request` 선택
3. 상세 설정 확인
   - enabled
   - pinned version
   - workspace allowlist
   - trusted source 표시
4. enabled를 OFF로 변경 후 저장
5. `Flow Designer`로 이동
6. plugin palette에서 해당 plugin이 빠졌거나 사용할 수 없는 상태인지 확인
7. 다시 `Plugin Control`로 이동
8. enabled ON으로 복구 후 저장
9. `Flow Designer`에서 plugin이 다시 보이는지 확인

### 설명 포인트

- 운영자가 workspace별로 connector 노출 범위를 통제할 수 있다.
- trusted source 표시는 현재 표시/정책 수준이며, 실제 signature 검증은 별도 설계 항목이다.

## 11. Plugin Manifest Registry

### 보여줄 것

- manifest 등록
- validation
- hot reload
- 수정/삭제
- Plugin Control 연동

### 사전 준비 manifest 예시

```json
{
  "plugin_id": "connector.demo.meeting",
  "version": "1.0.0",
  "display_name": "Meeting Demo Connector",
  "description": "회의 시연용 manifest-only connector",
  "category": "demo",
  "icon": "plug",
  "runtime": "external_http",
  "config_schema": {
    "type": "object",
    "properties": {
      "message": {
        "type": "string",
        "title": "Message",
        "default": "hello"
      }
    },
    "required": []
  },
  "input_schema": {
    "type": "object",
    "properties": {},
    "required": []
  },
  "output_schema": {
    "type": "object",
    "properties": {},
    "required": []
  },
  "timeout_ms": 5000,
  "retry_policy": {
    "max_attempts": 1
  },
  "trusted_source": false
}
```

### 시연 방법

1. 좌측 `Plugin Registry` 클릭
2. manifest editor에 위 JSON 입력
3. 저장
4. 목록에 `Meeting Demo Connector`가 생기는지 확인
5. `Flow Designer`로 이동
6. plugin palette에 새 connector가 hot reload되어 보이는지 확인
7. `Plugin Control`로 이동
8. 새 plugin의 enabled/workspace 정책을 확인
9. 다시 `Plugin Registry`로 이동
10. description 또는 display_name 수정 후 저장
11. 목록 반영 확인
12. 삭제 버튼으로 제거
13. `Flow Designer`에서 제거된 plugin이 더 이상 보이지 않는지 확인

### 설명 포인트

- 현재 구현은 manifest registry다.
- 이 JSON만으로 실제 connector 실행 코드가 생기는 것은 아니다.
- MongoDB Query처럼 실제 실행 가능한 plugin은 서버/엔진에 builtin 실행 코드가 있기 때문에 동작한다.
- SDK/package 업로드/runtime 실행은 별도 로드맵으로 분리되어 있다.

## 12. Workflow Version Diff / Rollback

### 보여줄 것

- workflow 저장 v1
- 수정 후 저장 v2
- 버전 목록
- diff view
- rollback API/UI
- rollback이 새 버전 v3로 생성되는 흐름

### 시연 방법

1. `Flow Designer` 클릭
2. Start -> JS -> End 구성
3. JS Node script v1 입력

```javascript
return {
  status: 'v1',
  amount: 10000
};
```

4. `Save`
   - name: `DEMO-09 Version Rollback`
   - version note: `v1 initial`
5. JS Node script를 수정

```javascript
return {
  status: 'v2',
  amount: 20000,
  reviewer: 'manager'
};
```

6. `Save`
   - 같은 workflow를 update
   - version note: `v2 add reviewer`
7. 상단 `Load` 클릭
8. `DEMO-09 Version Rollback` 항목에서 `버전` 버튼 클릭
9. 버전 목록에서 v1, v2 확인
10. v1의 비교 아이콘 클릭
11. diff panel에서 변경 path 확인
12. v1의 rollback 아이콘 클릭
13. confirm
14. 현재 버전이 v3로 바뀌는지 확인
15. v3의 version note가 `Rollback to v1...` 형태인지 확인

### 설명 포인트

- 버전은 저장 시점마다 snapshot으로 남는다.
- rollback은 감사 추적을 위해 과거 버전을 현재에 덮어쓰지 않고 새 버전을 만든다.
- schedule/db watch start 설정도 rollback 후 재동기화된다.

## 시간별 축약안

### 15분 버전

1. Flow Designer 기본 구성
2. Workflow 실행/result 확인
3. DB Watch Start
4. Command Registry/Command Node
5. Plugin Control
6. Version Diff/Rollback

### 30분 버전

1. Flow Designer 기본 구성
2. Node Test UX
3. Credential Store
4. Workflow 실행/result/trace
5. Schedule Start
6. DB Watch Start
7. Command Registry/Command Node
8. Plugin Control/Registry
9. Version Diff/Rollback

### 45분 이상 버전

전체 12개 시나리오를 순서대로 진행한다.

## 시연 중 주의 문구

- "사용자 관리는 이 제품에서 직접 들고 가지 않고, 외부 IAM/API client/context 기반으로 연동하는 방향입니다."
- "Plugin Registry는 현재 manifest 관리 기능입니다. 실제 제3자 SDK package 실행은 별도 runtime 설계가 필요합니다."
- "trusted source/signature 검증은 표시 필드가 아니라 key 관리와 서명 검증 체계가 필요한 별도 설계 항목입니다."
- "Agent 기반 실행은 내부망/망분리/보안 요구가 큰 기능이라 Phase 3에 섞지 않고 별도 로드맵으로 분리했습니다."
- "DB Watch는 API 호출이 어려운 legacy 환경을 위한 보완 트리거이며, 일반적인 권장 방식은 외부 시스템이 PXM Start API를 호출하는 방식입니다."
