/**
 * 실패 알림에 붙일 원인 문자열을 뽑아낸다.
 *
 * 기존 코드는 "저장에 실패했습니다." 만 띄우고 원인을 console에만 남겼다.
 * 사용자는 왜 실패했는지 알 수 없었으므로, 토스트의 description으로 함께 노출한다.
 */
export function errorMessage(error: unknown, fallback = '알 수 없는 오류가 발생했습니다.'): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}
