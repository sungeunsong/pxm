import { useCallback, useEffect, useState } from 'react';
import { Check, RotateCcw, X } from 'lucide-react';
import { Button } from '../components/Button';
import { EmptyState } from '../components';
import { useFeedback } from '../components/feedback/feedback-context';
import { errorMessage } from '../lib/error-message';
import { hashFor } from '../lib/deep-link';
import { resourceRequestsApi, type ResourceRequest } from '../api/resource-requests';
import type { SessionUser } from '../api/session';
import './ResourceRequestsPage.css';

const TYPE_LABEL: Record<ResourceRequest['resource_type'], string> = {
  script_library: 'JS 라이브러리 사용',
  credential: '자격증명 공유',
};

const STATUS_LABEL: Record<ResourceRequest['status'], string> = {
  pending: '처리 대기',
  approved: '승인',
  rejected: '반려',
  cancelled: '취소',
};

/**
 * 워크플로우에 필요한 자원을 해결 주체에게 요청하고 처리한다.
 * 예전에는 "권한이 없다"는 오류를 받으면 메신저로 관리자를 찾아가야 했고, 진행 상태도 알 수 없었다.
 */
export function ResourceRequestsPage({ currentUser }: { currentUser: SessionUser }) {
  const { toast, prompt: promptDialog } = useFeedback();
  const [tab, setTab] = useState<'to_me' | 'mine'>('to_me');
  const [items, setItems] = useState<ResourceRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await resourceRequestsApi.list(tab));
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error, '자원 요청을 불러오지 못했습니다.'));
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (item: ResourceRequest, decision: 'approve' | 'reject') => {
    const comment = await promptDialog({
      title: decision === 'approve' ? `${item.resource_label} 요청을 승인할까요?` : `${item.resource_label} 요청을 반려할까요?`,
      description: decision === 'approve'
        ? approveEffect(item)
        : '반려 사유를 적으면 요청한 관리자가 보낸 요청에서 확인합니다.',
      label: decision === 'approve' ? '의견 (선택)' : '반려 사유',
      confirmLabel: decision === 'approve' ? '승인' : '반려',
      required: decision === 'reject',
    });
    if (comment === null) return;
    setActing(item.id);
    try {
      if (decision === 'approve') await resourceRequestsApi.approve(item.id, comment);
      else await resourceRequestsApi.reject(item.id, comment);
      toast.success(decision === 'approve' ? '승인하고 권한에 반영했습니다.' : '요청을 반려했습니다.', { description: item.resource_label });
      await load();
    } catch (error) {
      toast.error(decision === 'approve' ? '승인하지 못했습니다.' : '반려하지 못했습니다.', { description: errorMessage(error) });
    } finally {
      setActing(null);
    }
  };

  const cancel = async (item: ResourceRequest) => {
    setActing(item.id);
    try {
      await resourceRequestsApi.cancel(item.id);
      toast.success('요청을 취소했습니다.');
      await load();
    } catch (error) {
      toast.error('요청을 취소하지 못했습니다.', { description: errorMessage(error) });
    } finally {
      setActing(null);
    }
  };

  const pendingCount = tab === 'to_me' ? items.filter((item) => item.status === 'pending').length : 0;

  return (
    <div className="resource-requests-page">
      <p className="resource-requests-intro">
        워크플로우에 필요한 JS 라이브러리 사용 승인과 자격증명 공유를 요청하고 처리합니다.
        {currentUser.role === 'admin' ? ' 최고관리자는 JS 라이브러리 요청과 모든 자격증명 요청을 처리할 수 있습니다.' : ' 자격증명 공유 요청은 소유 그룹의 관리자가 처리합니다.'}
      </p>

      <div className="resource-requests-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'to_me'} className={tab === 'to_me' ? 'active' : ''} onClick={() => setTab('to_me')}>
          받은 요청{tab === 'to_me' && pendingCount > 0 ? ` ${pendingCount}` : ''}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>
          보낸 요청
        </button>
        <button type="button" className="resource-requests-refresh" onClick={() => void load()} aria-label="새로고침">
          <RotateCcw size={14} />
        </button>
      </div>

      {loadError ? (
        <EmptyState kind="error" title="자원 요청을 불러오지 못했습니다." description={loadError} />
      ) : loading && items.length === 0 ? (
        <EmptyState kind="loading" title="불러오는 중" />
      ) : items.length === 0 ? (
        <EmptyState
          title={tab === 'to_me' ? '처리할 요청이 없습니다.' : '보낸 요청이 없습니다.'}
          description={tab === 'mine' ? '그룹 호환성 점검에서 승인·공유가 필요한 항목에 요청을 보낼 수 있습니다.' : undefined}
        />
      ) : (
        <ul className="resource-requests-list" data-testid="resource-requests-list">
          {items.map((item) => (
            <li key={item.id} className={`status-${item.status}`} data-testid="resource-request-row">
              <div className="resource-request-head">
                <span className="resource-request-type">{TYPE_LABEL[item.resource_type]}</span>
                <strong>{item.resource_label}</strong>
                <span className={`resource-request-status status-${item.status}`}>{STATUS_LABEL[item.status]}</span>
              </div>
              <p>
                <b>{item.target_group_name || item.target_group_id}</b> 그룹에서 쓰기 위한 요청 · 요청자 {item.requested_by} ·{' '}
                {new Date(item.requested_at).toLocaleString()}
              </p>
              <p className="resource-request-approver">
                처리: {item.approver_role === 'admin' ? '최고관리자' : `${item.approver_group_name || item.approver_group_id || '소유 그룹'} 관리자`}
                {item.workflow_id && <> · <a href={hashFor('designer', { workflow: item.workflow_id })}>관련 워크플로우</a></>}
              </p>
              {item.reason && <blockquote>{item.reason}</blockquote>}
              {item.decision_comment && <blockquote className="decision">{item.decided_by}: {item.decision_comment}</blockquote>}
              <div className="resource-request-actions">
                {tab === 'to_me' && item.status === 'pending' && (
                  <>
                    <Button size="sm" icon={<Check size={14} />} disabled={acting === item.id} onClick={() => void decide(item, 'approve')} data-testid="resource-request-approve">승인</Button>
                    <Button size="sm" variant="secondary" icon={<X size={14} />} disabled={acting === item.id} onClick={() => void decide(item, 'reject')}>반려</Button>
                  </>
                )}
                {tab === 'mine' && item.status === 'pending' && (
                  <Button size="sm" variant="secondary" disabled={acting === item.id} onClick={() => void cancel(item)}>요청 취소</Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function approveEffect(item: ResourceRequest): string {
  const group = item.target_group_name || item.target_group_id;
  return item.resource_type === 'script_library'
    ? `${group} 그룹이 이 라이브러리 버전을 JS 노드에서 쓸 수 있게 됩니다.`
    : `${group} 그룹의 워크플로우가 이 자격증명을 쓸 수 있게 공유됩니다. 비밀값은 공개되지 않습니다.`;
}
