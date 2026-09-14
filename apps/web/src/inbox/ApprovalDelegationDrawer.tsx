import { useEffect, useMemo, useState } from 'react';
import { Button } from '../components/Button';
import { Drawer } from '../components/ui/Drawer';
import { authzApi, type ApprovalDelegation, type PxmGroup, type PxmUser } from '../api/authz';
import type { SessionUser } from '../api/session';
import { errorMessage } from '../lib/error-message';
import { useFeedback } from '../components/feedback/feedback-context';
import './ApprovalDelegationDrawer.css';

type Workflow = { id: string; name: string; group_id?: string | null };
type OpenApproval = { task_id: string; group_id: string; node_label?: string | null; workflow_name?: string | null; assignee: string };

const localDateTime = (date: Date) => {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
};

export function ApprovalDelegationDrawer({ currentUser, onClose }: { currentUser: SessionUser; onClose: () => void }) {
  const { toast, confirm: confirmDialog } = useFeedback();
  const [groups, setGroups] = useState<PxmGroup[]>([]);
  const [users, setUsers] = useState<PxmUser[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [items, setItems] = useState<ApprovalDelegation[]>([]);
  const [groupId, setGroupId] = useState(currentUser.group_ids[0] || '');
  const [delegatorId, setDelegatorId] = useState(currentUser.id);
  const [delegateId, setDelegateId] = useState('');
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [workflowIds, setWorkflowIds] = useState<string[]>([]);
  const [includeExisting, setIncludeExisting] = useState(false);
  const [startsAt, setStartsAt] = useState(localDateTime(new Date()));
  const [endsAt, setEndsAt] = useState(localDateTime(new Date(Date.now() + 7 * 86_400_000)));
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [openTaskCount, setOpenTaskCount] = useState<number | null>(null);
  const [openApprovals, setOpenApprovals] = useState<OpenApproval[]>([]);
  const [reassignTargets, setReassignTargets] = useState<Record<string, string>>({});
  const [reassignReasons, setReassignReasons] = useState<Record<string, string>>({});

  const canManageSelected = currentUser.role === 'admin' || currentUser.memberships.some((m) => m.group_id === groupId && m.role === 'group_manager');
  const selectedWorkflows = useMemo(() => workflows.filter((w) => w.group_id === groupId), [groupId, workflows]);
  const names = useMemo(() => new Map(users.map((user) => [user.id, user.display_name])), [users]);

  useEffect(() => {
    Promise.all([authzApi.listGroups(false), fetch('/api/templates?activeOnly=false').then((res) => res.ok ? res.json() : [])])
      .then(([nextGroups, nextWorkflows]) => {
        const visible = currentUser.role === 'admin' ? nextGroups : nextGroups.filter((g) => currentUser.group_ids.includes(g.id));
        setGroups(visible); setWorkflows(Array.isArray(nextWorkflows) ? nextWorkflows : []);
        if (!groupId && visible[0]) setGroupId(visible[0].id);
      })
      .catch((error) => toast.error('위임 설정 정보를 불러오지 못했습니다.', { description: errorMessage(error) }));
  }, []);

  const reload = async (selectedGroup = groupId) => {
    if (!selectedGroup) return;
    const [nextUsers, nextItems] = await Promise.all([
      authzApi.listApprovalDelegationCandidates(selectedGroup), authzApi.listApprovalDelegations(selectedGroup),
    ]);
    setUsers(nextUsers); setItems(nextItems);
    const nextDelegatorId = nextUsers.some((user) => user.id === delegatorId)
      ? delegatorId
      : nextUsers.some((user) => user.id === currentUser.id)
        ? currentUser.id
        : nextUsers[0]?.id || '';
    setDelegatorId(nextDelegatorId);
    setDelegateId((current) => nextUsers.some((user) => user.id === current && user.id !== nextDelegatorId) ? current : '');
  };

  useEffect(() => { reload().catch((error) => toast.error('위임 목록을 불러오지 못했습니다.', { description: errorMessage(error) })); }, [groupId]);
  useEffect(() => {
    if (!canManageSelected || !groupId) { setOpenApprovals([]); return; }
    fetch('/api/tasks/history?status=OPEN&limit=100').then((res) => res.ok ? res.json() : { items: [] })
      .then((page) => setOpenApprovals((page.items || []).filter((item: OpenApproval) => item.group_id === groupId))).catch(() => setOpenApprovals([]));
  }, [groupId, canManageSelected]);
  useEffect(() => {
    if (!groupId || !delegatorId) { setOpenTaskCount(null); return; }
    const timer = window.setTimeout(() => authzApi.previewApprovalDelegation(groupId, delegatorId, scope, workflowIds).then((result) => setOpenTaskCount(result.current_open_task_count)).catch(() => setOpenTaskCount(null)), 150);
    return () => window.clearTimeout(timer);
  }, [groupId, delegatorId, scope, workflowIds.join(',')]);

  const create = async () => {
    if (!groupId || !delegateId) return toast.error('그룹과 대리 결재자를 선택해 주세요.');
    if (scope === 'selected' && !workflowIds.length) return toast.error('적용할 워크플로우를 선택해 주세요.');
    if (delegatorId !== currentUser.id && !reason.trim()) return toast.error('다른 사용자의 위임 설정에는 사유가 필요합니다.');
    setSaving(true);
    try {
      const created = await authzApi.createApprovalDelegation({ group_id: groupId, delegator_id: delegatorId, delegate_id: delegateId,
        scope, workflow_ids: scope === 'selected' ? workflowIds : [], include_existing: includeExisting,
        starts_at: new Date(startsAt).toISOString(), ends_at: new Date(endsAt).toISOString(), reason: reason.trim() || null });
      toast.success('대리 결재를 설정했습니다.', { description: includeExisting ? `현재 미결 결재 ${created.current_open_task_count}건도 적용 대상입니다.` : '설정 시작 후 생성되는 결재부터 적용됩니다.' });
      setReason(''); await reload();
    } catch (error) { toast.error('대리 결재를 설정하지 못했습니다.', { description: errorMessage(error) }); }
    finally { setSaving(false); }
  };

  const revoke = async (item: ApprovalDelegation) => {
    const ok = await confirmDialog({ title: '대리 결재 설정을 해제할까요?', description: '아직 처리하지 않은 결재는 즉시 원래 승인자에게 돌아갑니다.', confirmLabel: '해제' });
    if (!ok) return;
    try { await authzApi.revokeApprovalDelegation(item.id); await reload(); toast.success('대리 결재를 해제했습니다.'); }
    catch (error) { toast.error('대리 결재를 해제하지 못했습니다.', { description: errorMessage(error) }); }
  };

  const reassign = async (task: OpenApproval) => {
    const assignee = reassignTargets[task.task_id]; const reasonText = reassignReasons[task.task_id]?.trim();
    if (!assignee || !reasonText) return toast.error('새 승인자와 재배정 사유를 입력해 주세요.');
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.task_id)}/reassign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assignee, reason: reasonText }) });
      const payload = await response.json().catch(() => null); if (!response.ok) throw new Error(payload?.message || 'reassignment failed');
      setOpenApprovals((rows) => rows.filter((row) => row.task_id !== task.task_id)); toast.success('결재 담당자를 재배정했습니다.');
    } catch (error) { toast.error('결재를 재배정하지 못했습니다.', { description: errorMessage(error) }); }
  };

  return <Drawer title="대리 결재 설정" eyebrow="결재 부재 관리" width="lg" onClose={onClose}
    footer={<div className="delegation-footer"><Button variant="secondary" onClick={onClose}>닫기</Button><Button onClick={create} disabled={saving}>{saving ? '저장 중…' : '위임 설정'}</Button></div>}>
    <div className="delegation-drawer-content">
      <p className="delegation-guide">기간 중 결재 권한을 같은 그룹의 PXM 사용자에게 맡깁니다. 기간이 끝나거나 설정을 해제하면 미처리 건은 원래 승인자에게 자동으로 돌아갑니다.</p>
      <div className="delegation-form-grid">
        <label>그룹<select value={groupId} onChange={(e) => { setGroupId(e.target.value); setWorkflowIds([]); }}><option value="">선택</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
        {canManageSelected && <label>원래 승인자<select value={delegatorId} onChange={(e) => { setDelegatorId(e.target.value); setDelegateId(''); }}><option value="">선택</option>{users.map((u) => <option key={u.id} value={u.id}>{u.id === currentUser.id ? `나 (${u.display_name})` : `${u.display_name} (${u.id})`}</option>)}</select></label>}
        <label>대리 결재자<select value={delegateId} onChange={(e) => setDelegateId(e.target.value)}><option value="">선택</option>{users.filter((u) => u.id !== delegatorId).map((u) => <option key={u.id} value={u.id}>{u.display_name} ({u.id})</option>)}</select></label>
        <label>시작<input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} /></label>
        <label>종료<input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} /></label>
        <label>적용 범위<select value={scope} onChange={(e) => setScope(e.target.value as 'all'|'selected')}><option value="all">그룹의 모든 워크플로우</option><option value="selected">선택한 워크플로우만</option></select></label>
      </div>
      {scope === 'selected' && <div className="delegation-workflows">{selectedWorkflows.map((w) => <label key={w.id}><input type="checkbox" checked={workflowIds.includes(w.id)} onChange={(e) => setWorkflowIds((ids) => e.target.checked ? [...ids, w.id] : ids.filter((id) => id !== w.id))} />{w.name}</label>)}</div>}
      <label className="delegation-check"><input type="checkbox" checked={includeExisting} onChange={(e) => setIncludeExisting(e.target.checked)} /><span>현재 미결 결재 {openTaskCount === null ? '' : `${openTaskCount}건`}도 함께 위임</span></label>
      <p className="delegation-hint">체크하지 않으면 시작 시각 이후 새로 생성되는 결재에만 적용됩니다.</p>
      {delegatorId !== currentUser.id && <label className="delegation-reason">설정 사유<textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder="갑작스러운 부재 등 설정 사유를 입력하세요." /></label>}
      <section className="delegation-current"><h4>위임 설정 내역</h4>{items.length === 0 ? <p className="delegation-empty">등록된 위임이 없습니다.</p> : items.map((item) => <article key={item.id}>
        <div><strong>{names.get(item.delegator_id) || item.delegator_id} → {names.get(item.delegate_id) || item.delegate_id}</strong><span className={`delegation-status ${item.status}`}>{item.status === 'active' && new Date(item.ends_at) > new Date() ? '적용/예약' : item.status === 'revoked' ? '해제됨' : '기간 종료'}</span></div>
        <p>{new Date(item.starts_at).toLocaleString()} ~ {new Date(item.ends_at).toLocaleString()} · {item.scope === 'all' ? '전체 워크플로우' : `${item.workflow_ids.length}개 워크플로우`} · 기존 미결 {item.include_existing ? '포함' : '제외'}</p>
        {item.status === 'active' && new Date(item.ends_at) > new Date() && (item.delegator_id === currentUser.id || canManageSelected) && <Button size="sm" variant="ghost" onClick={() => revoke(item)}>해제</Button>}
      </article>)}</section>
      {canManageSelected && <section className="delegation-current"><h4>미결 결재 긴급 재배정</h4><p className="delegation-hint">예정하지 못한 부재에는 특정 결재의 담당자를 직접 바꿀 수 있습니다. 이 변경은 기간 종료 시 되돌아가지 않습니다.</p>
        {openApprovals.length === 0 ? <p className="delegation-empty">재배정할 미결 결재가 없습니다.</p> : openApprovals.map((task) => <article key={task.task_id} className="delegation-reassign-item">
          <div><strong>{task.workflow_name || task.node_label || task.task_id}</strong><span>{names.get(task.assignee) || task.assignee}</span></div>
          <select value={reassignTargets[task.task_id] || ''} onChange={(e) => setReassignTargets((value) => ({ ...value, [task.task_id]: e.target.value }))}><option value="">새 승인자 선택</option>{users.filter((u) => u.id !== task.assignee).map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select>
          <input value={reassignReasons[task.task_id] || ''} onChange={(e) => setReassignReasons((value) => ({ ...value, [task.task_id]: e.target.value }))} placeholder="재배정 사유" maxLength={1000} />
          <Button size="sm" variant="secondary" onClick={() => reassign(task)}>재배정</Button>
        </article>)}
      </section>}
    </div>
  </Drawer>;
}
