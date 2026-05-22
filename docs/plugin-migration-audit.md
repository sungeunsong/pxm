# 하드코딩 연동 상태 진단 및 플러그인 식별 보고서 (Plugin Migration Audit)

본 문서는 기존 PXM Engine 및 API 어플리케이션 내에 구조적 고정 노드로 결합되어 구현되어 있는 외부/내부 연동 부하 상태를 정밀 진단하고, 이를 플랫폼 핵심 엔진을 수정하지 않고도 자유로이 꽂아 쓸 수 있는 범용 플러그인 커넥터(Plugin Connector) 형태로 추출/분리하기 위한 플러그인 마이그레이션 진단서이다.

---

## 1. 하드코딩 연동 구현 상태 및 한계점 분석

기존 구현의 `SERVICE` 노드 처리 블록인 `apps/engine/src/main.rs`의 `node_service_http` 함수는 심각한 레벨의 하드코딩 종속성을 드러내고 있다.

### 1.1 하드코딩된 HTTP 호출 경로 (`node_service_http`)
- **특정 테스트 API 강결합**:
  ```rust
  let url = format!("{}/api/debug/flaky?key={}&fail=2", api_base, job.instance_id);
  ```
  - 외부 HTTP 연동 노드인데, 특정 flaky 테스트 URI 경로가 아예 엔진 핵심 로직 한가운데 고정 텍스트로 박혀있다.
  - 이로 인해 새로운 HTTP 서비스 연동 요청이 발생할 때마다, 엔진 Rust 코어 소스를 수정하여 조건문을 붙이거나 재컴파일해야 하는 설계 결함을 내포한다.

### 1.2 확장 제한 요소 (Secret, Mapping의 강결합 부재)
- 서비스 노드를 동적으로 제어하려면 외부 URL, HTTP Method(GET/POST/PUT), 요청 Headers, Body Payload 템플릿 정보 등이 데이터베이스 설정 정의(node config)로부터 주입되어야 한다.
- 기존 코드는 이를 파싱하지 못하고, 오직 컨텍스트에 `formData` 유무에 따라 단순 reqwest GET/POST 분기만 처리하는 기능적 한계를 보이고 있다.

---

## 2. Plugin Connector 전환 대상 식별 (Migration Targets)

설계 문서에서 요구하는 범용 BPM 시스템으로의 확장을 저해하는 핵심 연동 후보군을 파악하고, 각 컴포넌트의 기능 명세에 맞춘 플러그인 ID(`plugin_id`) 식별 체계를 정의한다.

### 2.1 범용 공통 플러그인
- **`builtin.http_request`**:
  - 기존의 하드코딩 HTTP Node를 완벽하게 승계 및 흡수한다.
  - 임의의 외부 Webhook 또는 REST API를 동적 Config(URL, 메소드, 페이로드 바인딩) 스펙에 맞춰 실행할 수 있는 핵심 공통 플러그인이다.

### 2.2 비즈니스 전용 연동 커넥터 (Major System Connectors)
기존 비즈니스 도메인 업무 포털 내에서 고유 시스템 연계용으로 하드코딩되기 쉬운 결재 연동 흐름들을 플러그인 형태로 규격화하여 분리 식별한다.

1. **ACRA Point 권한 연동 플러그인 (`connector.acra.*`)**:
   - **`connector.acra.grant_permission`**: 승인 완료 인스턴스 흐름 종료 시점에 호출되어 ACRA Point 대상 시스템의 실제 API 키 참조를 갖고 타겟 유저에게 접근 권한 코드를 실시간 매핑 반영해주는 역할을 위임받는다.
   - **`connector.acra.revoke_permission`**: 권한 해제 또는 만료 시 권한을 회수한다.
2. **NIT 개발 이슈 관리 플러그인 (`connector.nit.*`)**:
   - **`connector.nit.create_issue`**: 승인 기각 또는 신규 개발 템플릿 가동 시 NIT 티켓 이슈를 오토 발급한다.
   - **`connector.nit.register_wiki_candidate`**: 성공 완료된 위키 기고 대상 텍스트 후보군을 연계 등록 처리한다.
3. **인사 및 인프라 연동 플러그인**:
   - **`connector.hr.lookup_user`**: 신청 초기 단계에서 결재선 자동 결정을 돕기 위해 해당 사용자의 소속 부서, 직무, 승인 결재권자 정보를 HR 데이터베이스나 조직 서버에서 정밀 스캔 조회해 오는 기능 플러그인이다.
   - **`connector.ad.grant_group`**: Active Directory 접근 계정 그룹을 원격 제어하여 보안 권한 세트를 할당한다.
4. **협업 도구 및 통지 플러그인**:
   - **`connector.slack.send_message`**: 매 승인 단계 도달 및 에스컬레이션 발생, 지연 이슈 탐지 시 지정 채널에 고품격 메시지 카드를 푸시 알림 통보한다.
   - **`connector.jira.create_issue`**: Jira 백로그 보드 내 신규 할 일 카드를 자동 추가 등록한다.
   - **`connector.email.send`**: 범용 메일 송신 연계를 대행한다.

---

## 3. 하드코딩 대비 플러그인 구조 전환의 장단점 비교

| 평가 항목 | 기존 하드코딩 방식 (V1) | 플러그인 커넥터 아키텍처 (V2) |
| :--- | :--- | :--- |
| **신규 연동 시스템 추가 비용** | **매우 높음** (Engine 수정 + API 수정 + 빌드/배포) | **매우 낮음** (Plugin 스펙 JSON 등록 + Executor 추가) |
| **외부 장애 격리성** | **낮음** (하드코딩된 스레드가 메인 루프를 블락 위험) | **높음** (Executor별 타임아웃/서킷브레이커 격리 가능) |
| **Secret 보안성** | **취약함** (코드 내 API Key 노출 또는 config 하드코딩) | **강력함** (`secrets_ref` 기반 간접 바인딩 암호화 보호) |
| **코어 소스 복잡도** | **복잡성 폭발** (수십 종의 외부 연동 분기 코드로 비대화) | **완벽한 격리** (Engine Core는 단 1줄의 외부 API 지식 없음) |

---

## 4. 결론 및 전환 방향성

기존 PXM Engine V1의 하드코딩된 HTTP 연동 구조는 즉시 폐기되어야 할 기술 부채이다. 

우선적으로 기존 하드코딩 코드에서 외부 시스템 통신 모듈(reqwest 등)을 발라내어, **1단계로 모든 HTTP 연동의 부모 역할을 할 `builtin.http_request` 플러그인을 공통 규격으로 개설**하고, **2단계로 개별 특화 연동 모듈들을 Registry 명세에 맞춰 플러그인 모듈 단위로 랩핑 적재**하는 노선으로 아키텍처 마이그레이션 방향을 강력 추천한다.
