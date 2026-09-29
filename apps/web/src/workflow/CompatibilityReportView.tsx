import { AlertTriangle, CheckCircle2, CircleSlash, UserRoundCog } from 'lucide-react';
import type { CompatibilityItem, CompatibilityReport, CompatibilityStatus } from '../api/templates';
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
export function CompatibilityReportView({ report }: { report: CompatibilityReport }) {
  const groupName = report.target_group_name || '대상 그룹';
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
