# API Consumer Demo

`apps/api-playground`는 PXM 관리자 UI와 분리된 외부 시스템 관점의 reference client다. 세션 쿠키를 사용하지 않고 실제 API Key의 scope, 그룹, `allowed_workflow_ids` 제한을 그대로 적용한다.

## 실행

API(`3011`)와 Engine이 실행 중인 상태에서 다음 명령을 실행한다.

```bash
pnpm dev:api-playground
```

브라우저에서 `http://localhost:5175`를 연다. 원격 개발 환경에서는 `5175` 포트를 포워딩해야 한다. 로컬 Vite 서버는 `/api` 요청을 `http://localhost:3011`로 프록시한다.

## 테스트용 API Key 발급

PXM Console(`http://localhost:5174`)의 접근 관리 화면에서 다음 순서로 만든다.

1. 테스트 워크플로우가 속한 그룹을 선택한다.
2. 외부 연동용 서비스 계정을 만든다.
3. 해당 서비스 계정 소유 API Key를 만들고 `workflow:read`, `workflow:execute` scope를 부여한다.
4. 접근 정책에서 `선택한 워크플로우만`을 고른 뒤 `allowed_workflow_ids`에는 Demo에서 실행할 워크플로우만 선택한다. 그룹에 이후 추가되는 워크플로우까지 자동 허용하려면 `그룹 전체 워크플로우`를 선택한다.
5. 발급 직후 한 번만 표시되는 `pxm_...` 값을 Demo 연결 화면에 붙여 넣는다.

개인에게 할당된 PXM 결재를 API로 승인/반려하는 시험에는 서비스 계정이 아닌 `USER` 소유 키와 `task:approve` scope를 사용한다. 서비스 계정은 결재자가 될 수 없으며 외부 이메일 결재는 이메일 링크와 OTP로만 처리한다.

## 제공 화면

- Workflows: 키에 허용된 워크플로우 조회 및 실행
- Instances: 실행 인스턴스 조회와 이벤트 trace 확인
- Approval History: 결재 대기·승인·반려 이력 조회 및 개인 키 결재 처리
- API Console: Authorization 값을 제외한 요청/응답과 재사용 가능한 cURL 예시

API Key와 API Base URL은 현재 브라우저 탭의 `sessionStorage`에만 저장된다. 로그와 cURL 예시에는 실제 키가 남지 않는다.

## 권한 실패도 테스트하기

- `workflow:read`를 제거하면 워크플로우·인스턴스·결재 이력 조회가 `403`이어야 한다.
- `workflow:execute`를 제거하면 워크플로우 실행이 `403`이어야 한다.
- 다른 그룹 또는 허용 목록 밖의 워크플로우를 직접 호출하면 `403` 또는 필터링된 결과가 반환되어야 한다.
- 만료, 비활성화, IP allowlist, rate limit을 설정한 키도 동일한 연결 화면에서 검증할 수 있다.
