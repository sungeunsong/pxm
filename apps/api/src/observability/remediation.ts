/**
 * 오류 응답에 "누가 무엇을 하면 풀리는지"를 붙인다.
 *
 * 원인만 말하는 오류는 사용자를 메신저로 보낸다. 해결 주체와 행동을 함께 주면
 * 화면이 "그룹 관리자에게 공유를 요청하세요"처럼 다음 행동을 안내할 수 있다.
 * 응답에는 remediation(사람이 읽는 문장), remediation_actor(해결 주체 역할),
 * remediation_group_id(주체가 특정 그룹의 관리자일 때)가 실린다.
 */
export type RemediationActor = 'self' | 'group_manager' | 'admin';

export type Remediation = {
  actor: RemediationActor;
  action: string;
  group_id?: string | null;
};

export function errorBody(
  code: string,
  message: string,
  remediation?: Remediation,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    code,
    message,
    ...extra,
    ...(remediation
      ? {
          remediation: remediation.action,
          remediation_actor: remediation.actor,
          ...(remediation.group_id ? { remediation_group_id: remediation.group_id } : {}),
        }
      : {}),
  };
}
