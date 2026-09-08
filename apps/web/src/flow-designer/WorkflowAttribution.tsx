import { useEffect, useState } from 'react';
import './WorkflowAttribution.css';

type Actor = { id: string | null; display_name: string | null; status: string };
type Attribution = { creator: Actor; updater: Actor; created_at?: string; updated_at?: string; imported_from?: { definition_id?: string; version?: number } | null };
function actorLabel(actor: Actor) {
  if (!actor.id) return '확인 불가';
  if (actor.status === 'missing') return `확인할 수 없는 사용자 · ID: ${actor.id}`;
  return `${actor.display_name || '이름 없음'} · ID: ${actor.id}${actor.status === 'deleted' ? ' (삭제됨)' : actor.status === 'disabled' ? ' (비활성)' : ''}`;
}
function dateLabel(value?: string) { return value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString('ko-KR') : '확인 불가'; }
export function WorkflowAttribution({ workflowId, updatedAt }: { workflowId: string; updatedAt?: string }) {
  const [data, setData] = useState<Attribution | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError(false);
    fetch(`/api/templates/${encodeURIComponent(workflowId)}/attribution`, { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error('attribution'); return response.json(); })
      .then(setData).catch(error => { if (error.name !== 'AbortError') setError(true); });
    return () => controller.abort();
  }, [workflowId, updatedAt]);
  return <section className="workflow-attribution" aria-label="워크플로우 작성 이력">
    <h4>작성 이력</h4>
    {error ? <p role="status">작성 이력을 불러오지 못했습니다.</p> : !data ? <p>작성 이력을 불러오는 중입니다.</p> : <dl>
      <div><dt>생성자</dt><dd>{actorLabel(data.creator)}<time>{dateLabel(data.created_at)}</time></dd></div>
      <div><dt>최근 수정자</dt><dd>{actorLabel(data.updater)}<time>{dateLabel(data.updated_at)}</time></dd></div>
      {data.imported_from && <div><dt>가져온 원본</dt><dd>{data.imported_from.definition_id || '확인 불가'} · v{data.imported_from.version ?? '?'}</dd></div>}
    </dl>}
  </section>;
}
