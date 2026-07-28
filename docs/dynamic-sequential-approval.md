# 동적 순차·복수 승인 결재

PXM의 Approval 노드는 워크플로우 그래프에서는 하나지만, 실행 시 전달받은 결재라인을
여러 `ApprovalStep`과 `Task`로 전개한다. 중간 단계 승인은 워크플로우 토큰을 이동시키지
않으며 마지막 단계 승인 또는 어느 단계의 반려 때만 Engine에 `RESUME`을 한 번 등록한다.

## 노드 설정

Flow Designer에서 Approval 노드의 `결재라인 입력 방식`을 `실행 요청에서 전달`로
선택한다. 기본 요청 경로는 `formData.approval_request`이며
`approvalRequestPath`로 `formData` 아래의 다른 경로를 지정할 수 있다.

```json
{
  "nodeType": "approval",
  "approvalLineSource": "dynamic",
  "approvalRequestPath": "approval_request"
}
```

## 실행 입력 계약

```json
{
  "formData": {
    "approval_request": {
      "source": "acrapoint",
      "request_id": "ACRA-2026-0042",
      "content": {
        "title": "노트북 구매",
        "summary": "개발 장비 구매 요청",
        "requester": "kim",
        "source_url": "https://acrapoint.example/approvals/42"
      },
      "approval_line": {
        "steps": [
          {
            "order": 1,
            "label": "팀장 전원",
            "mode": "ALL",
            "approvers": [
              { "assignee": "lead-a", "approver_channel": "pxm_user" },
              { "assignee": "lead-b", "approver_channel": "pxm_user" }
            ]
          },
          {
            "order": 2,
            "label": "임원 중 한 명",
            "mode": "ANY",
            "approvers": [
              { "assignee": "director-a@example.com", "approver_channel": "external_email" },
              { "assignee": "director-b@example.com", "approver_channel": "external_email" }
            ]
          }
        ]
      }
    }
  }
}
```

- `source`, `request_id`, `content`, `approval_line.steps`는 필수다.
- `content`에서 저장하는 필드는 `title`, `summary`, `requester`, `source_url`뿐이다.
- 단계는 1부터 시작해 빈 번호 없이 연속이어야 한다.
- `mode`는 `ALL` 또는 `ANY`이며 생략하면 `ALL`이다.
- 각 단계의 `approvers`에는 한 명 이상의 승인자가 필요하고 동일 `assignee`를 중복해
  넣을 수 없다.
- 기존의 단계별 `assignee` 단일 형식도 하위 호환을 위해 지원한다.
- `approver_channel`은 `pxm_user` 또는 `external_email`이며 생략하면 노드의 채널
  설정 또는 `pxm_user`를 사용한다.
- 최대 단계 수는 100개다.

## 실행 시점 스냅샷

Approval 노드에 처음 진입할 때 PXM은 외부 요청 ID, 결재 내용, 정규화된 결재라인을
`ApprovalRequest`에 저장하고 모든 `ApprovalStep`을 생성한다. 1단계만 `OPEN`,
나머지는 `LOCKED`다. 실행 중 원본 시스템의 결재라인이 변경되어도 이 스냅샷은 바뀌지
않는다.

## 상태 전이

| 동작             | 현재 단계  | 다음 처리                             | ApprovalRequest | Engine         |
| ---------------- | ---------- | ------------------------------------- | --------------- | -------------- |
| ALL 일부 승인    | `OPEN`     | 같은 단계의 나머지 Task 유지         | `IN_PROGRESS`   | 계속 `WAITING` |
| ALL 전원 승인    | `APPROVED` | 다음 단계 Task 전부 생성              | `IN_PROGRESS`   | 계속 `WAITING` |
| ANY 첫 승인      | `APPROVED` | 형제 Task `CANCELED`, 다음 단계 개방  | `IN_PROGRESS`   | 계속 `WAITING` |
| 최종 단계 통과   | `APPROVED` | 없음                                  | `APPROVED`      | `RESUME` 1회   |
| 어느 승인자 반려 | `REJECTED` | 형제 Task `CANCELED`, 이후 단계 잠금  | `REJECTED`      | `RESUME` 1회   |

Task 완료, 단계 전이, 다음 Task 생성 또는 최종 `RESUME` 등록은 하나의 DB
트랜잭션에서 처리한다. Task는 `(approval_step_id, assignee)`별로 하나만 존재할 수 있어
동일 승인자의 중복 Task와 다음 단계의 중복 개방을 막는다.

## 이번 차수에서 제외된 범위

QUORUM(n명 중 k명), 외부 요청 중복 방지와 실행 중 결재라인 변경/개정 정책은 PXM-11,
반려 전용 워크플로우 분기는 PXM-12에서 다룬다.
