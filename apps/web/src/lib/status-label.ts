/**
 * 실행/결재 상태 코드를 화면 표기로 옮긴다.
 *
 * 같은 화면에서 COMPLETED 배지와 "완료" 텍스트가 섞여 나오던 것을 한 곳으로 모은다.
 * 모르는 코드는 지어내지 않고 원문을 그대로 돌려준다.
 */
const INSTANCE_STATE: Record<string, string> = {
  CREATED: '생성됨',
  RUNNING: '실행 중',
  WAITING: '대기 중',
  PAUSED: '일시중지',
  COMPLETED: '완료',
  FAILED: '실패',
  TERMINATED: '종료됨',
};

const APPROVAL_STATUS: Record<string, string> = {
  OPEN: '승인 대기',
  IN_PROGRESS: '진행 중',
  APPROVED: '승인',
  REJECTED: '반려',
  CANCELED: '취소',
  HOLD: '보류',
};

const DELIVERY_STATUS: Record<string, string> = {
  PENDING: '전송 대기',
  RUNNING: '전송 중',
  SENT: '전송 완료',
  SUCCEEDED: '전송 완료',
  FAILED: '전송 실패',
  DEAD_LETTER: '전송 포기',
};

const lookup = (table: Record<string, string>, value?: string | null) => {
  if (!value) return '-';
  return table[String(value).toUpperCase()] ?? value;
};

export const instanceStateLabel = (value?: string | null) => lookup(INSTANCE_STATE, value);
export const approvalStatusLabel = (value?: string | null) => lookup(APPROVAL_STATUS, value);
export const deliveryStatusLabel = (value?: string | null) => lookup(DELIVERY_STATUS, value);
