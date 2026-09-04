# 보관 문서

시점이 지났거나 현재 전제와 다른 문서를 보관한다. **현재 상태를 확인할 때 참고하지 않는다.**
지원 기능은 `docs/features.md`, 남은 작업은 `docs/roadmap.md`가 기준이다.

파일을 지우지 않고 보관하는 이유는 판단 근거와 재현 절차가 남아 있어 나중에 같은 결론을
다시 도출하는 비용을 줄여주기 때문이다.

| 문서 | 보관 사유 |
|---|---|
| `bpm-platform-meeting-brief.md` | 2026-07 설명 자료. `features.md`가 대체한다. 폐기된 `VITE_ENABLE_APPROVAL_SAMPLE_UI` 플래그를 전제로 결재함을 "샘플 UI"로 설명해 현재와 다르다 |
| `meeting-brief-images/` | 위 문서의 슬라이드 이미지 |
| `bpm-platform-implementation-plan.md` | 2026-07 구현 투두. `roadmap.md`가 대체한다 |
| `beta-release-review-2026-08.md` | 2026-08-25 시점 제품 점검 기록. P0 지적 대부분이 반영되었고, 문서가 전제한 "서드파티 대상 비공개 베타"는 현재 전제가 아니다 |
| `beta-release-todo.md` | 위 점검의 작업 목록. `roadmap.md`가 대체한다. 아래 "정정 사항" 참고 |
| `beta-open-checklist.md` | 외부 베타 오픈 체크리스트. 온프레미스 설치 항목만 `roadmap.md`로 옮겼다 |
| `workflow-runtime-speed-test.md` | 2026-06-22 벤치마크 측정 기록 |

## 정정 사항

`beta-release-todo.md`는 보관 시점에 실제 코드보다 뒤처져 있었다. 미완으로 표기되었지만
**실제로는 완료된 항목**은 다음과 같다. 이 문서를 다시 읽을 일이 있으면 함께 볼 것.

| 항목 | 문서 표기 | 실제 |
|---|---|---|
| DEMO-04 동작하지 않는 상단 UI 제거 | 미완 | 완료. `App.tsx`에 해당 검색창·알림 배지·도움말 버튼이 없다 |
| DEMO-05 하드코딩 대시보드 제거 | 미완 | 완료. `DashboardPage.tsx`가 `/api/templates`, `/api/instances/stats`, `/api/instances`, `/api/tasks`, `/api/health/ready`를 실제 호출한다 |
| DX-04 알려진 제한 공개 | 미완 | 완료. `docs/features.md` 8장이 미지원 기능을 명시한다 |

나머지 미완 항목은 `roadmap.md`로 옮기면서 현재 전제에 맞게 우선순위를 다시 매겼다.
외부 베타 운영 준비 항목(지원 채널, 비상 연락망, 장애 공지)은 외부 고객이 정해진 뒤로 미뤘다.
