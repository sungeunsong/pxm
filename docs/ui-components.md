# PXM Web 공용 UI 컴포넌트

PXM-32에서 도입한 공용 화면 구성 요소의 최소 계약이다. 구현은
`apps/web/src/components/ui/`에 있으며 `../components` barrel에서 가져온다.

## 공통 원칙

- 색상, 간격, 타이포는 `design-system.css` 토큰만 사용한다.
- 화면의 조회·권한·작업 로직은 컴포넌트 안으로 옮기지 않는다.
- 상태는 색만으로 전달하지 않고 항상 텍스트를 함께 표시한다.
- 아이콘 전용 버튼에는 접근 가능한 이름을 제공한다.

## 컴포넌트 계약

### `PageHeader`

- 필수: `description`
- 선택: `title`, `eyebrow`, `icon`, `actions`
- 앱 셸에 화면 제목이 있으면 `title`을 생략해 화면당 제목을 하나로 유지한다.
- 제목을 생략할 때는 사용처에서 `aria-label`로 section의 목적을 지정한다.

대표 적용: 감사 로그, 운영 상태, 승인자 알림.

### `DataTable`

- 필수: `aria-label`
- 선택: `minWidth`, `containerClassName` 및 native table 속성
- native `<table>` 구조를 유지하며 가로 overflow, 공통 셀 타이포, 내부 focus 표시를 담당한다.
- 빈 상태와 로딩 상태는 `EmptyState`를 사용한다.

대표 적용: 실행 모니터링, 실행 프리셋.

### `StatusBadge`

- 필수: 원본 상태 코드인 `status`
- 선택: 사용자용 `label`, `icon`, 명시적인 `tone`
- tone을 생략하면 알려진 상태 코드를 의미 색상으로 변환하고, 모르는 코드는 neutral로 표시한다.
- 아이콘은 장식으로 숨기며 상태 텍스트는 항상 남긴다.

대표 적용: 실행 모니터링, 승인자 알림.

### `EmptyState`

- 필수: `title`
- 선택: `kind`, `description`, `icon`, `action`, `compact`
- `empty`, `loading`, `error` 세 상태를 지원한다.
- 오류는 `role=alert`, 로딩은 `role=status`와 polite live region을 사용한다.

대표 적용: 감사 로그, 실행 모니터링, 실행 프리셋, 승인자 알림.

### `Drawer`

- 필수: `title`, `onClose`, `children`
- 선택: `eyebrow`, `footer`, `width`, `closeLabel`, `closeOnBackdrop`
- `role=dialog`, `aria-modal`, 제목 연결을 기본 제공한다.
- 열릴 때 닫기 버튼으로 포커스를 이동하고 Tab을 내부에 고정한다.
- Esc 또는 배경 클릭으로 닫으며, 닫힌 뒤 기존 트리거로 포커스를 복원한다.

대표 적용: 감사 로그 상세, 승인 알림 상세.

## 검증 기준

- `pnpm --filter web build`
- `pnpm --filter web exec eslint src` 결과가 기존 기준선보다 증가하지 않아야 한다.
- 주요 화면에서 의도하지 않은 가로 overflow와 이름 없는 버튼이 없어야 한다.
- Drawer는 초기 포커스, Tab/Shift+Tab 순환, Esc 종료, 트리거 복귀를 브라우저에서 확인한다.
