# 워크플로우 배포 메타데이터 보정

PXM-33은 배포 상태인 워크플로우가 다음 계약을 항상 만족하도록 저장 계층에서 검증합니다.

- `lifecycle_status = PUBLISHED`
- `active_published_version`은 1 이상의 정수이며 동일 정의의 불변 버전 스냅샷이 존재함
- `published_at`이 유효한 시각임
- 새 버전을 배포하면 배포 시각과 배포자가 새로 기록됨
- 같은 버전을 중지 후 재활성화하면 원래 배포 시각과 배포자를 보존함
- 롤백은 과거 스냅샷을 새 초안 버전으로 복원하며 현재 배포 포인터를 이동하지 않음

## 대상 수와 실행 방법

2026-09-02 UI 검토 당시 개발 데이터에서는 전체 정의 29개 중 `PUBLISHED`가 23개였고, 27개 정의에서 배포 버전과 배포 시각이 비어 있었습니다. 이후 데이터가 정리된 현재 개발 DB를 다시 측정한 결과는 `PUBLISHED` 2개 중 불일치 0개입니다. 운영 적용 전에는 반드시 대상 환경에서 dry-run 결과를 새로 기록해야 합니다.

```bash
# MongoDB (기본값, 쓰기 없음)
pnpm db:workflow-publish-metadata:repair

# PostgreSQL (쓰기 없음)
DB_TYPE=postgres DATABASE_URL=postgres://... pnpm db:workflow-publish-metadata:repair

# 검토·백업 후 실제 반영
pnpm db:workflow-publish-metadata:repair -- --apply
```

도구는 기본적으로 dry-run이며, `--apply`를 명시해야 현재 정의 메타데이터만 갱신합니다. 출력의 `published_definitions`, `changes`, `report`를 변경 기록에 남깁니다.

## 안전 보정 정책

1. 기존 포인터와 일치하는 불변 스냅샷을 우선 사용하고, 없으면 현재 버전과 일치하는 스냅샷만 사용합니다.
2. 배포 시각은 기존 유효 값 → MongoDB `workflow.deployed` 감사 로그 → 불변 스냅샷 생성 시각 → 정의 수정/생성 시각 순으로 선택하며 출처를 출력합니다.
3. 일치하는 불변 스냅샷이나 신뢰할 시각이 없으면 추측하지 않고 `skipped`로 남깁니다.
4. 버전 번호를 낙관적 잠금 조건으로 사용하므로 실행 중 정의가 바뀌면 해당 건은 건너뜁니다.
5. `v2_process_definition_versions`, `v2_process_instances` 및 실행 이력은 조회만 하며 절대 수정하지 않습니다.

적용 전 DB 백업을 확보하고 dry-run 목록을 승인받습니다. 되돌려야 할 경우 백업에서 해당 `v2_process_definitions` 문서/행의 메타데이터만 복원합니다.
