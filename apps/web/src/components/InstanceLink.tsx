import { hashFor } from '../lib/deep-link';

/**
 * 실행 ID를 실행 추적 화면으로 가는 링크로 보여준다.
 * 운영자가 ID를 복사해 다른 메뉴에서 다시 찾지 않도록, 보이는 자리에서 바로 열게 한다.
 */
export function InstanceLink({ id, label }: { id: string; label?: string }) {
  return (
    <a
      className="instance-link"
      href={hashFor('designer', { instance: id })}
      title="실행 추적 열기"
      onClick={(event) => event.stopPropagation()}
    >
      <code>{label || id}</code>
    </a>
  );
}
