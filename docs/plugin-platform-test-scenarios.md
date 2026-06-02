# 플러그인 플랫폼 테스트 시나리오

## 범위

이 문서는 V2 플러그인 플랫폼의 레지스트리, 웹 작성 화면, 런타임 실행, 운영 통제 기능을 검증하기 위한 테스트 시나리오를 정의한다.

## 실행 환경

필요한 로컬 서비스:

```bash
pnpm db:mongo
pnpm db:mongo:init
PORT=3031 pnpm --dir apps/plugin-host dev
DB_TYPE=mongodb pnpm dev:api:mongo
DB_TYPE=mongodb PXM_PLUGIN_HOST_URL=http://127.0.0.1:3031 pnpm dev:engine:mongo
pnpm dev:web
```

기본 접속 주소:

- Web: `http://localhost:5173`
- API: `http://localhost:3000/api`
- Plugin host: `http://localhost:3031`
- MongoDB: `mongodb://127.0.0.1:27017/?replicaSet=rs0`

## 자동 스모크 테스트

모든 서비스가 기동된 뒤 다음 명령을 실행한다.

```bash
pnpm db:mongo:check
pnpm smoke:mongo:approval
pnpm smoke:mongo:gateway
pnpm plugin:conformance -- --manifest ../../examples/plugin-packages/connector.sample_echo/plugin.json --endpoint http://127.0.0.1:3031/invoke
PORT=3020 node examples/external-http-plugin/echo-service.mjs
pnpm plugin:conformance -- --manifest ../../examples/external-http-plugin/plugin.json --endpoint http://127.0.0.1:3020/invoke
```

재사용 중인 로컬 MongoDB에 오래된 V2 런타임 데이터가 남아 있으면, Engine을 중지한 뒤 런타임 큐만 정리하고 스모크 테스트를 다시 실행한다.

```bash
cd apps/api
node - <<'NODE'
const { MongoClient } = require('mongodb');
(async () => {
  const client = new MongoClient('mongodb://127.0.0.1:27017/?replicaSet=rs0');
  await client.connect();
  const db = client.db('pxm_db');
  for (const col of [
    'v2_process_instances',
    'v2_tokens',
    'v2_tasks',
    'v2_engine_jobs',
    'v2_event_outbox',
    'v2_execution_logs',
    'v2_advisory_locks',
  ]) {
    await db.collection(col).deleteMany({});
  }
  await client.close();
})();
NODE
```

## 시나리오 1: 레지스트리와 팔레트

목표: 플러그인 manifest가 API로 노출되고, 웹에서 1급 노드로 렌더링되는지 확인한다.

절차:

1. `http://localhost:5173`에 접속한다.
2. Flow Designer를 연다.
3. `Slack`, `NIT`, `ACRA`, `HTTP Request`를 검색한다.
4. 플러그인 하나를 즐겨찾기한 뒤 새로고침해 즐겨찾기가 유지되는지 확인한다.
5. `Slack Send Message`를 캔버스로 드래그한다.
6. 노드를 선택하고 `config_schema` 기반 설정 필드가 렌더링되는지 확인한다.

기대 결과:

- `GET /api/plugins`가 활성 플러그인 manifest 목록을 반환한다.
- 팔레트에 플러그인 카테고리, 아이콘, 검색, 즐겨찾기가 표시된다.
- 저장된 service 노드는 `node_type = service`와 `plugin_id`를 가진다.

## 시나리오 2: Hosted 플러그인 실행

목표: Engine이 hosted 플러그인을 `pxm-plugin-host`를 통해 디스패치하는지 확인한다.

절차:

1. `pnpm smoke:mongo:approval`을 실행한다.
2. 인스턴스가 `COMPLETED` 상태에 도달하는지 확인한다.
3. plugin-host 로그에서 `/invoke` 호출을 확인한다.
4. Mongo `v2_execution_logs`에서 service 노드의 `NODE_COMPLETED` 로그를 확인한다.

기대 결과:

- 승인 task가 생성되고 완료된다.
- service 노드가 플러그인을 호출한 뒤 완료된다.
- 인스턴스 trace에 `TASK_CREATED`, service `NODE_COMPLETED`, `INSTANCE_COMPLETED`가 포함된다.

## 시나리오 3: 병렬 플러그인 분기

목표: 병렬 게이트웨이에서 여러 플러그인 service 노드가 실행되는지 확인한다.

절차:

1. `pnpm smoke:mongo:gateway`를 실행한다.
2. Slack 및 NIT service 노드가 완료되는지 확인한다.
3. join 노드가 두 분기 token을 모두 소비하는지 확인한다.

기대 결과:

- 인스턴스가 `COMPLETED` 상태에 도달한다.
- `slack`, `nit`, `join`, `end` 노드에 각각 `NODE_COMPLETED` 로그가 존재한다.
- join 노드에 소비된 token이 2개 존재한다.

## 시나리오 4: External HTTP 플러그인 계약

목표: 서드파티 external HTTP 플러그인 서비스가 invoke 계약을 만족하는지 확인한다.

절차:

1. 샘플 서비스를 시작한다: `PORT=3020 node examples/external-http-plugin/echo-service.mjs`.
2. external conformance를 실행한다.

```bash
pnpm plugin:conformance -- \
  --manifest ../../examples/external-http-plugin/plugin.json \
  --endpoint http://127.0.0.1:3020/invoke
```

기대 결과:

- manifest 검증이 통과한다.
- endpoint가 표준 `{ success, output }` 응답을 반환한다.

## 시나리오 5: 설치와 운영 통제 감사 로그

목표: install/control 명령이 trusted source를 검증하고 audit event를 기록하는지 확인한다.

절차:

1. 샘플 패키지를 설치한다.

```bash
pnpm plugin:install -- ../../examples/plugin-packages/connector.sample_echo
```

2. 플러그인을 비활성화, 활성화, 버전 pin 처리한다.

```bash
pnpm plugin:control -- disable connector.sample_echo
pnpm plugin:control -- enable connector.sample_echo
pnpm plugin:control -- pin connector.sample_echo 1.0.0
```

3. `logs/plugin-audit.jsonl`을 확인한다.
4. 테스트 목적으로만 설치했다면 sample registry 복사본을 제거한다.

```bash
rm -f apps/api/plugin-manifests/connector.sample_echo.json
```

기대 결과:

- 명시적으로 허용하지 않은 untrusted source 설치는 거부된다.
- audit log에 `install`, `disable`, `enable`, `update` 이벤트가 기록된다.
- controls 파일에 enable/pin 변경이 반영된다.

## 시나리오 6: Workspace Allowlist

목표: 활성 workspace allowlist 밖의 플러그인이 API와 Engine에서 숨겨지는지 확인한다.

절차:

1. `apps/api/plugin-controls.json`을 백업한다.
2. 다음 값을 설정한다.

```json
"workspace_allowlists": {
  "default": ["builtin.http_request"]
}
```

3. API와 Engine을 재시작한다.
4. `GET /api/plugins`를 호출한다.
5. `connector.slack.send_message`를 사용하는 workflow 실행을 시도한다.

기대 결과:

- API는 `builtin.http_request`만 반환한다.
- Engine은 allowlist 밖의 Slack 플러그인을 등록하지 않는다.
- Slack 실행은 미등록 플러그인 오류로 실패한다.

## 시나리오 7: Plugin-Host 가드레일

목표: resource 및 isolation 통제가 fail-closed 방식으로 동작하는지 확인한다.

절차:

1. plugin-host 서비스 테스트를 실행한다.

```bash
pnpm --dir apps/plugin-host test -- plugin-host.service.spec.ts
```

2. `resource_limits.max_payload_bytes = 10`이 포함된 hosted invoke 요청을 보낸다.
3. `isolation.mode = external_process`가 포함된 hosted invoke 요청을 보낸다.

기대 결과:

- 과도한 payload는 `PLUGIN_PAYLOAD_TOO_LARGE`를 반환한다.
- 지원하지 않는 isolation은 `PLUGIN_ISOLATION_UNSUPPORTED`를 반환한다.

## 시나리오 8: Secret Reference 해석

목표: 플러그인 secret이 저장된 노드 config 밖에서 해석되는지 확인한다.

절차:

1. `PXM_SECRET_ACRA_API_TOKEN=test-token`을 설정한다.
2. `connector.acra.grant_permission`을 사용하는 workflow를 실행한다.
3. service 노드 output과 로그를 확인한다.

기대 결과:

- Engine이 `secret://acra/api_token`을 `PXM_SECRET_ACRA_API_TOKEN`에서 해석한다.
- 원본 `secret://...` reference는 config로 전달되지 않는다.
- Hosted executor가 `secrets.api_token`을 수신한다.

## 통과 기준

- API, plugin-host, web, engine이 오류 없이 빌드된다.
- 자동 스모크 테스트가 통과한다.
- 수동 시나리오에서 기대 결과가 확인된다.
- 테스트 중 생성된 sample manifest와 audit log는 의도적으로 유지하는 경우를 제외하고 정리한다.
