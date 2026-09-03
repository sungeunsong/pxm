# 대시보드 지표 범위

대시보드는 각 지표가 실제로 조회하는 범위를 화면 문구와 동일하게 사용합니다.

| 카드/영역 | API | 계산 범위 |
| --- | --- | --- |
| 조회 가능 워크플로우 | `GET /api/templates` | 로그인 사용자가 조회 가능한 활성 워크플로우 |
| 전체 실행 중·대기 중·실패 | `GET /api/instances/stats` | 관리자에게 허용되는 전체 실행 |
| 접근 가능 실행 중·대기 중·실패 | `GET /api/instances/stats` | 비관리자에게 인스턴스 이력 정책상 접근 가능한 전체 실행 |
| 내 결재 대기 | `GET /api/tasks` | 로그인 사용자에게 할당되고 접근 가능한 열린 결재 |
| 최근 실행 | `GET /api/instances` | 접근 가능한 실행 중 최근 50건을 조회하고 화면에는 최근 8건 표시 |

## 인스턴스 집계 계약

`GET /api/instances/stats`는 목록을 애플리케이션으로 불러와 세지 않고 MongoDB `$group` 또는 PostgreSQL `GROUP BY`로 집계합니다.

```json
{
  "total": 128,
  "by_state": {
    "CREATED": 2,
    "RUNNING": 8,
    "WAITING": 4,
    "PAUSED": 1,
    "COMPLETED": 108,
    "FAILED": 3,
    "TERMINATED": 2,
    "UNKNOWN": 0
  },
  "scope": "all"
}
```

- `scope = all`: 관리자 전체 범위이며 화면에는 `전체`로 표시합니다.
- `scope = authorized`: 기존 인스턴스 목록과 동일한 actor 권한 필터를 사용하며 화면에는 `접근 가능`으로 표시합니다.
- `is_paused = true`인 실행은 원래 상태 대신 `PAUSED`로 한 번만 집계합니다.
- 알려지지 않은 상태는 `UNKNOWN`에 합산합니다.
- 화면의 `실행 중`은 `CREATED + RUNNING`입니다.

각 API는 독립적으로 로딩하고 실패합니다. 한 지표가 실패하면 해당 카드에 `조회 실패`를 표시하며 다른 카드의 정상 응답을 0이나 오류로 바꾸지 않습니다.
