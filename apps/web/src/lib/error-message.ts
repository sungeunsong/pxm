import { ApiError } from './api-error';

/**
 * 실패 알림에 붙일 원인 문자열을 뽑아낸다.
 *
 * 서버 오류(ApiError)면 원인 뒤에 세부 항목, 해결 방법, 문의 번호를 줄바꿈으로 덧붙인다.
 * 사용자가 "왜 안 되는지"와 "누구에게 무엇을 요청하면 되는지"를 함께 알 수 있게 하기 위해서다.
 */
export function errorMessage(error: unknown, fallback = '알 수 없는 오류가 발생했습니다.'): string {
  if (error instanceof ApiError) {
    const lines = [error.message];
    const details = error.details.filter((detail) => detail !== error.message);
    if (details.length > 0) {
      lines.push(...details.slice(0, 3).map((detail) => `· ${detail}`));
      if (details.length > 3) lines.push(`· 외 ${details.length - 3}건`);
    }
    if (error.remediation) lines.push(error.remediation);
    if (error.requestId && error.status >= 500) lines.push(`문의 번호: ${error.requestId}`);
    return lines.join('\n');
  }
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}
