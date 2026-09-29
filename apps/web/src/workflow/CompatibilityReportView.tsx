import { useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, Send, UserRoundCog } from 'lucide-react';
import type { CompatibilityItem, CompatibilityReport, CompatibilityStatus } from '../api/templates';
import { resourceRequestsApi } from '../api/resource-requests';
import { useFeedback } from '../components/feedback/feedback-context';
import { errorMessage } from '../lib/error-message';
import { hashFor } from '../lib/deep-link';
import './CompatibilityReportView.css';

const KIND_LABEL: Record<CompatibilityItem['kind'], string> = {
  script_library: 'JS 라이브러리',
  credential: '자격증명',
  approver: '결재자',
  plugin: '플러그인',
  command: '명령',
  workflow_call: '하위 워크플로우',
  group: '관리 그룹',
};

const STATUS_LABEL: Record<CompatibilityStatus, string> = {
  blocked: '바꿔야 함',
  action_required: '승인·공유 필요',
  warning: '확인 권장',
  ok: '사용 가능',
};

const ACTOR_LABEL = { self: '직접', group_manager: '그룹 관리자', admin: '최고관리자' } as const;

const ORDER: CompatibilityStatus[] = ['blocked', 'action_required', 'warning', 'ok'];

/**
 * 호환성 진단 결과. 막히는 것부터 보여주고, 항목마다 누가 무엇을 하면 풀리는지 적는다.
 * 문제가 없는 항목은 개수만 보이고 펼쳐서 확인한다.
 */
export function CompatibilityReportView({
  report,
  workflowId,
}: {
  report: CompatibilityReport;
  /** 요청에 함께 남길 워크플로우. 저장 전 캔버스면 생략한다. */
  workflowId?: string | null;
}) {
  const { toast } = useFeedback();
  // 요청을 보낸 항목. 같은 화면에서 다시 누르지 않도록 표시한다(서버도 대기 중인 같은 요청은 하나로 합친다).
  const [requested, setRequested] = useState<Record<string, 'sending' | 'sent'>>({});
  const groupName = report.target_group_name || '대상 그룹';

  const sendRequest = async (item: CompatibilityItem) => {
    if (!item.requestable || !report.target_group_id) return;
    const key = `${item.kind}:${item.ref}`;
    setRequested((current) => ({ ...current, [key]: 'sending' }));
    try {
      await resourceRequestsApi.create({
        ...item.requestable,
        target_group_id: report.target_group_id,
        workflow_id: workflowId && workflowId !== 'unsaved' ? workflowId : null,
      });
      setRequested((current) => ({ ...current, [key]: 'sent' }));
      toast.success('요청을 보냈습니다.', { description: `${item.label} · 처리 결과는 자원 요청의 보낸 요청에서 확인하세요.` });
    } catch (error) {
      setRequested((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      toast.error('요청을 보내지 못했습니다.', { description: errorMessage(error) });
    }
  };
  const problems = report.items.filter((item) => item.status !== 'ok');
  const fine = report.items.filter((item) => item.status === 'ok');
  const sorted = [...problems].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));

  return (
    <div className="compat-report" data-testid="compatibility-report">
      <div className={`compat-summary ${report.summary.ready ? 'ready' : 'not-ready'}`}>
        {report.summary.ready ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
        <div>
          <strong>
            {report.summary.ready
              ? `${groupName}에서 저장·실행할 수 있습니다.`
              : `${groupName}에서 쓰려면 먼저 해결할 항목이 ${report.summary.blocked + report.summary.action_required}개 있습니다.`}
          </strong>
          <span>
            사용 가능 {report.summary.ok} · 승인·공유 필요 {report.summary.action_required} · 바꿔야 함 {report.summary.blocked} · 확인 권장 {report.summary.warning}
          </span>
        </div>
      </div>

      {sorted.length > 0 && (
        <ul className="compat-items">
          {sorted.map((item) => (
            <li key={`${item.kind}:${item.ref}`} className={`compat-item status-${item.status}`}>
              <div className="compat-item-head">
                <span className="compat-kind">{KIND_LABEL[item.kind]}</span>
                <strong>{item.label}</strong>
                <span className="compat-status">
                  {item.status === 'blocked' ? <CircleSlash size={13} /> : <AlertTriangle size={13} />}
                  {STATUS_LABEL[item.status]}
                </span>
              </div>
              <p>{item.message}</p>
              {item.remediation && (
                <p className="compat-remediation">
                  <UserRoundCog size={13} />
                  <span><b>{ACTOR_LABEL[item.remediation.actor]}</b> · {item.remediation.action}</span>
                </p>
              )}
              {item.node_ids.length > 0 && <small>사용하는 노드: {item.node_ids.join(', ')}</small>}
              {item.requestable && report.target_group_id && (
                <div className="compat-request">
                  {requested[`${item.kind}:${item.ref}`] === 'sent' ? (
                    <span className="compat-request-sent">
                      요청함 · <a href={hashFor('resource-requests')}>보낸 요청에서 확인</a>
                    </span>
                  ) : (
                    <button
                      type="button"
                      data-testid="compat-request"
                      disabled={requested[`${item.kind}:${item.ref}`] === 'sending'}
                      onClick={() => void sendRequest(item)}
                    >
                      <Send size={13} />
                      {item.remediation?.actor === 'admin' ? '최고관리자에게 요청' : '소유 그룹 관리자에게 요청'}
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {fine.length > 0 && (
        <details className="compat-fine">
          <summary>사용 가능한 자원 {fine.length}개</summary>
          <ul>
            {fine.map((item) => (
              <li key={`${item.kind}:${item.ref}`}>{KIND_LABEL[item.kind]} · {item.label}</li>
            ))}
          </ul>
        </details>
      )}

      {report.items.length === 0 && <p className="compat-empty">그룹에 따라 달라지는 자원을 쓰지 않습니다.</p>}
    </div>
  );
}
