/**
 * 그룹 namespace — 진입점(AI Tool·게이트웨이 라우트)이 그룹을 가리키는 불변 식별자.
 *
 * - Tool 한정 이름 `{namespace}__{name}`, 라우트 경로 `/gw/{namespace}/...`에 쓴다
 * - 그룹 생성 시 한 번 정하고 바꾸지 않는다. 그룹 표시명을 바꿔도 그대로다
 * - 전역 유일. 삭제된 그룹의 값도 비우지 않는다
 *
 * 설계: docs/entry-points-design.md 2장
 */
export const GROUP_NAMESPACE_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;
export const GROUP_NAMESPACE_MAX_LENGTH = 32;

export function isValidGroupNamespace(value: unknown): value is string {
  return typeof value === 'string' && GROUP_NAMESPACE_PATTERN.test(value);
}

/**
 * 그룹 이름에서 초기값을 만든다. 영문·숫자가 없는 이름(한글 등)은 그룹 id에서 만든다.
 * 결과는 항상 GROUP_NAMESPACE_PATTERN을 만족한다.
 */
export function suggestGroupNamespace(name: string, groupId: string): string {
  const fromName = slug(name);
  if (fromName.length >= 2)
    return fromName.slice(0, GROUP_NAMESPACE_MAX_LENGTH).replace(/[-_]+$/, '');
  const fromId = groupId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8);
  return `group-${fromId || 'x'}`;
}

/** 이미 쓰인 값과 겹치면 `-2`, `-3` … 을 붙인다. */
export function uniqueGroupNamespace(
  base: string,
  taken: ReadonlySet<string>,
): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${base.slice(0, GROUP_NAMESPACE_MAX_LENGTH - tail.length).replace(/[-_]+$/, '')}${tail}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+/g, '-')
    .replace(/-$/, '');
}
