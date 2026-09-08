import { useEffect, useState } from 'react';
import { Button } from '../components';
import type { PxmApiKey } from '../api/authz';
import './ApiKeyUsagePanel.css';

type Usage = { id: string; api_key_id: string; owner_id: string; owner_type: string; endpoint: string; request_id: string | null; ip: string | null; created_at: string; business_actor: Record<string, string> | null; status_code: number | null; duration_ms: number | null; completed_at: string | null; completion_state: 'pending' | 'completed' | 'aborted' };
type Result = { items: Usage[]; total: number; page: number; pageSize: number };
export function ApiKeyUsagePanel({ groupId, keys }: { groupId: string; keys: PxmApiKey[] }) {
  const [keyId, setKeyId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setResult(null);
    const query = new URLSearchParams({ groupId, page: String(page), pageSize: '20' });
    if (keyId) query.set('keyId', keyId);
    if (ownerId) query.set('ownerId', ownerId);
    if (from) query.set('from', new Date(`${from}T00:00:00`).toISOString());
    if (to) query.set('to', new Date(`${to}T23:59:59.999`).toISOString());
    fetch(`/api/authz/api-keys/usage?${query}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(response.status === 400 ? '조회 시작일과 종료일을 확인해 주세요.' : '호출 이력을 불러오지 못했습니다.');
      return response.json();
    }).then(setResult).catch(error => { if (error.name !== 'AbortError') setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [groupId, keyId, ownerId, from, to, page, revision]);
  return <section className="api-key-usage" aria-label="API 키 호출 이력">
    <header><h3>호출 이력</h3><Button variant="secondary" size="sm" disabled={loading} onClick={() => setRevision(n => n + 1)}>이력 새로고침</Button></header>
    <p>인증된 키의 소유자와 호출 경로, API 요청 처리 결과를 확인합니다. 성공 표시는 워크플로우 전체 완료가 아니라 API 요청 처리 성공을 뜻합니다.</p>
    <div className="api-key-usage-filters">
      <label>API 키<select value={keyId} onChange={e => { setKeyId(e.target.value); setPage(1); }}><option value="">전체 키</option>{keys.map(key => <option key={key.id} value={key.id}>{key.name}</option>)}</select></label>
      <label>소유자 ID<select value={ownerId} onChange={e => { setOwnerId(e.target.value); setPage(1); }}><option value="">전체 소유자</option>{[...new Set(keys.map(key => key.owner_id))].map(id => <option key={id}>{id}</option>)}</select></label>
      <label>시작일<input type="date" value={from} onChange={e => { setFrom(e.target.value); setPage(1); }} /></label>
      <label>종료일<input type="date" value={to} onChange={e => { setTo(e.target.value); setPage(1); }} /></label>
    </div>
    {error ? <p role="alert">{error}</p> : loading ? <p role="status">호출 이력을 불러오는 중입니다.</p> : !result?.items.length ? <p>조건에 맞는 호출 이력이 없습니다.</p> : <div className="api-key-usage-table"><table>
      <thead><tr><th>시각 / 키</th><th>인증된 소유자</th><th>호출 경로 / 요청 ID</th><th>API 요청 결과</th><th>IP / 외부 전달 정보</th></tr></thead>
      <tbody>{result.items.map(item => <tr key={item.id}>
        <td>{new Date(item.created_at).toLocaleString('ko-KR')}<small>{keys.find(key => key.id === item.api_key_id)?.name || item.api_key_id}</small></td>
        <td>{item.owner_id}<small>{item.owner_type === 'USER' ? '사용자' : '서비스 계정'}</small></td>
        <td><code>{item.endpoint}</code><small>{item.request_id || '요청 ID 없음'}</small></td>
        <td>{usageResult(item)}</td>
        <td>{item.ip || '확인 불가'}{item.business_actor && Object.keys(item.business_actor).length > 0 && <small>외부 시스템 전달값 (별도 인증 아님): {Object.entries(item.business_actor).map(([key, value]) => `${key}: ${value}`).join(', ')}</small>}</td>
      </tr>)}</tbody>
    </table></div>}
    <footer><Button variant="ghost" size="sm" disabled={loading || page <= 1} onClick={() => setPage(n => n - 1)}>이전</Button><span>{page} 페이지 · {result?.total ?? 0}건</span><Button variant="ghost" size="sm" disabled={loading || !result || page * result.pageSize >= result.total} onClick={() => setPage(n => n + 1)}>다음</Button></footer>
  </section>;
}

function usageResult(item: Usage) {
  if (item.completion_state === 'aborted') return <><span className="api-key-usage-result is-aborted">응답 중단</span><small>{completionDetail(item)}</small></>;
  if (item.completion_state !== 'completed' || item.status_code == null) return <span className="api-key-usage-result is-pending">결과 미수집 또는 처리 중</span>;
  const success = item.status_code < 400;
  return <><span className={`api-key-usage-result ${success ? 'is-success' : 'is-failure'}`}>{success ? 'API 요청 성공' : 'API 요청 실패'} · {item.status_code}</span><small>{completionDetail(item)}</small></>;
}

function completionDetail(item: Usage) {
  const duration = item.duration_ms == null ? '처리 시간 없음' : `${item.duration_ms.toLocaleString()}ms`;
  return item.completed_at ? `${duration} · 응답 ${new Date(item.completed_at).toLocaleString('ko-KR')}` : duration;
}
