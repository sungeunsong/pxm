import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Activity, Copy, KeyRound, Link2, Plus, RefreshCw, RotateCcw, Save, Search, Shield, Trash2, UserPlus, UserRound, UsersRound } from 'lucide-react';
import { Button, Drawer } from '../components';
import { useFeedback } from '../components/feedback/feedback-context';
import {
  authzApi,
  type ApiKeyOwnerType,
  type ApiKeyScope,
  type ApiKeyWorkflowAccess,
  type CreatedApiKey,
  type ExternalPrincipalMapping,
  type GroupDeletionImpact,
  type PxmApiKey,
  type PxmGroup,
  type PxmGroupRole,
  type PxmRole,
  type PxmServiceAccount,
  type PxmUser,
} from '../api/authz';
import { templatesApi, type WorkflowTemplate } from '../api/templates';
import type { SessionUser } from '../api/session';
import './AccessManagementPage.css';
import { ApiKeyUsagePanel } from './ApiKeyUsagePanel';

// 조회가 기본 권한이므로 먼저 보여준다. 실행·승인은 그 위에 얹는 동작이다.
const scopeOptions: ApiKeyScope[] = ['workflow:read', 'workflow:execute', 'task:approve'];
const scopeLabels: Record<ApiKeyScope, string> = {
  'workflow:read': '조회 (읽기 전용)',
  'workflow:execute': '워크플로우 실행',
  'task:approve': '결재 승인·반려',
};
const scopeDescriptions: Record<ApiKeyScope, string> = {
  'workflow:read': '워크플로우 목록, 실행 상태, 결과를 읽기만 합니다. 실행은 할 수 없습니다.',
  'workflow:execute': '새 실행을 시작합니다. 결과까지 확인하려면 조회도 함께 선택합니다.',
  'task:approve': '이 사용자에게 배정된 결재를 승인하거나 반려합니다.',
};
type AccessDetailTab = 'users' | 'serviceAccounts' | 'apiKeys' | 'externalMappings';
type AccessPageSection = 'groups' | 'users';
type GroupListMode = 'active' | 'deleted';

export function AccessManagementPage({ currentUser }: { currentUser: SessionUser }) {
  const { confirm: confirmDialog } = useFeedback();
  const [groups, setGroups] = useState<PxmGroup[]>([]);
  const [users, setUsers] = useState<PxmUser[]>([]);
  const [userDirectory, setUserDirectory] = useState<PxmUser[]>([]);
  const [serviceAccounts, setServiceAccounts] = useState<PxmServiceAccount[]>([]);
  const [apiKeys, setApiKeys] = useState<PxmApiKey[]>([]);
  const [externalMappings, setExternalMappings] = useState<ExternalPrincipalMapping[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowTemplate[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [showCreateServiceAccount, setShowCreateServiceAccount] = useState(false);
  const [showCreateApiKey, setShowCreateApiKey] = useState(false);
  const [showApiUsage, setShowApiUsage] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);
  const [activeTab, setActiveTab] = useState<AccessDetailTab>('users');
  const [pageSection, setPageSection] = useState<AccessPageSection>('groups');
  const [deletionImpact, setDeletionImpact] = useState<GroupDeletionImpact | null>(null);
  const [groupListMode, setGroupListMode] = useState<GroupListMode>('active');

  const activeGroups = groups.filter((group) => group.status !== 'deleted');
  const deletedGroups = groups.filter((group) => group.status === 'deleted');
  const visibleGroups = groupListMode === 'active' ? activeGroups : deletedGroups;
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) || activeGroups[0] || null;
  const selectedGroupFilterId = selectedGroup?.id || '';
  const currentGroupId = selectedGroup?.status === 'active' ? selectedGroup.id : '';
  const selectedUser = userDirectory.find((user) => user.id === selectedUserId) || userDirectory[0] || null;

  const groupUsers = useMemo(
    () => users.filter((user) => selectedGroupFilterId && user.group_ids.includes(selectedGroupFilterId)),
    [users, selectedGroupFilterId],
  );
  const groupServiceAccounts = useMemo(
    () => serviceAccounts.filter((account) => selectedGroupFilterId && account.group_id === selectedGroupFilterId),
    [serviceAccounts, selectedGroupFilterId],
  );
  const groupKeys = useMemo(
    () => apiKeys.filter((key) => selectedGroupFilterId && key.group_id === selectedGroupFilterId),
    [apiKeys, selectedGroupFilterId],
  );
  const groupWorkflows = useMemo(
    () => workflows.filter((workflow) => workflow.group_id === selectedGroupFilterId),
    [workflows, selectedGroupFilterId],
  );
  const groupExternalMappings = useMemo(
    () => externalMappings.filter((mapping) => selectedGroupFilterId && mapping.group_id === selectedGroupFilterId),
    [externalMappings, selectedGroupFilterId],
  );

  const loadData = async (requestedGroupId = selectedGroupId) => {
    setLoading(true);
    setError(null);
    try {
      const [nextGroups, nextWorkflows] = await Promise.all([
        authzApi.listGroups(true, true),
        templatesApi.list(true),
      ]);
      const firstActive = nextGroups.find((group) => group.status !== 'deleted');
      const targetGroupId = requestedGroupId && nextGroups.some((group) => group.id === requestedGroupId)
        ? requestedGroupId
        : firstActive?.id || '';
      const [nextUsers, nextUserDirectory, nextAccounts, nextKeys, nextMappings] = targetGroupId
        ? await Promise.all([
            authzApi.listUsers(targetGroupId),
            authzApi.listUserDirectory(targetGroupId),
            authzApi.listServiceAccounts(targetGroupId),
            authzApi.listApiKeys(targetGroupId),
            authzApi.listExternalPrincipalMappings(targetGroupId),
          ])
        : [[], [], [], [], []];
      setGroups(nextGroups);
      setUsers(nextUsers);
      setUserDirectory(nextUserDirectory);
      setServiceAccounts(nextAccounts);
      setApiKeys(nextKeys);
      setExternalMappings(nextMappings);
      setWorkflows(nextWorkflows);
      setSelectedGroupId(targetGroupId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Access data load failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData('');
  }, []);

  const run = async (operation: () => Promise<unknown>) => {
    setSaving(true);
    setError(null);
    try {
      await operation();
      await loadData(selectedGroupId);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operation failed');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const inspectGroupDeletion = async () => {
    if (!selectedGroup) return;
    setSaving(true);
    setError(null);
    try {
      setDeletionImpact(await authzApi.getGroupDeletionImpact(selectedGroup.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : '삭제 영향 조회에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  const confirmGroupDeletion = async () => {
    if (!selectedGroup || !deletionImpact || deletionImpact.deletion_blocked) return;
    const permanent = deletionImpact.deletion_mode === 'permanent';
    const proceed = await confirmDialog({
      title: permanent ? `${selectedGroup.name} 그룹을 영구 삭제할까요?` : `${selectedGroup.name} 그룹을 삭제할까요?`,
      description: permanent
        ? '연결 자원과 과거 사용 이력이 없는 그룹입니다. 삭제하면 복구할 수 없습니다.'
        : `사용 이력이 있어 복구 가능한 삭제를 적용합니다. 워크플로우 ${deletionImpact.workflows.length}개와 활성 API Key ${deletionImpact.active_api_key_count}개가 비활성화됩니다.`,
      confirmLabel: permanent ? '영구 삭제' : '복구 가능한 삭제',
      tone: 'danger',
    });
    if (!proceed) return;
    const completed = await run(() => authzApi.deleteGroup(selectedGroup.id));
    if (completed) setDeletionImpact(null);
  };

  const restoreGroup = async () => {
    if (!selectedGroup) return;
    const completed = await run(() => authzApi.restoreGroup(selectedGroup.id));
    if (completed) {
      setGroupListMode('active');
      try {
        setDeletionImpact(await authzApi.getGroupDeletionImpact(selectedGroup.id));
      } catch {
        setDeletionImpact(null);
      }
    }
  };

  const completeRecoveryReview = async () => {
    if (!selectedGroup) return;
    const completed = await run(() => authzApi.completeGroupRecoveryReview(selectedGroup.id));
    if (completed) setDeletionImpact(null);
  };

  return (
    <div className="access-page">
      <div className="access-header">
        <div>
          <strong>접근 권한 관리</strong>
          <p>그룹을 기준으로 사람, 시스템 계정과 API 접근 범위를 관리합니다.</p>
        </div>
        <Button variant="secondary" size="sm" icon={<RefreshCw size={14} />} onClick={() => void loadData()} disabled={loading}>
          새로고침
        </Button>
      </div>

      {error && <div className="access-alert error">{error}</div>}
      <div className="access-page-tabs" role="tablist" aria-label="접근 권한 관리 영역">
        <button className={pageSection === 'groups' ? 'active' : ''} onClick={() => setPageSection('groups')}>
          <UsersRound size={16} />
          <span><strong>그룹 관리</strong><small>그룹별 멤버와 실행 권한</small></span>
        </button>
        <button className={pageSection === 'users' ? 'active' : ''} onClick={() => setPageSection('users')}>
          <UserRound size={16} />
          <span><strong>사용자 관리</strong><small>사용자 계정과 전체 소속</small></span>
        </button>
      </div>

      <div className={`access-summary ${pageSection === 'users' ? 'user-summary' : ''}`}>
        {pageSection === 'groups' ? (
          <>
            <SummaryCard label="활성 그룹" value={activeGroups.length} />
            <SummaryCard label="선택 그룹 사용자" value={users.length} />
            <SummaryCard label="선택 그룹 서비스 계정" value={serviceAccounts.length} />
            <SummaryCard label="선택 그룹 API Key" value={apiKeys.length} />
            <SummaryCard label="외부 승인자 매핑" value={externalMappings.length} />
          </>
        ) : (
          <>
            <SummaryCard label="전체 사용자" value={userDirectory.length} />
            <SummaryCard label="활성 사용자" value={userDirectory.filter((user) => user.status === 'active').length} />
            <SummaryCard label="최고 관리자" value={userDirectory.filter((user) => user.role === 'admin').length} />
            <SummaryCard label="소속 없는 사용자" value={userDirectory.filter((user) => user.group_ids.length === 0).length} />
          </>
        )}
      </div>

      {pageSection === 'groups' ? <div className="access-layout">
        <section className="access-panel group-panel">
          <PanelHeader
            icon={<UsersRound size={16} />}
            title="그룹"
            description={currentUser.role === 'admin' ? '관리할 그룹을 선택하세요.' : '내가 관리할 수 있는 그룹입니다.'}
            action={currentUser.role === 'admin' && groupListMode === 'active' ? (
              <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setShowCreateGroup(true)}>새 그룹</Button>
            ) : undefined}
          />
          <div className="group-list-filter" role="tablist" aria-label="그룹 상태">
            <button className={groupListMode === 'active' ? 'active' : ''} onClick={() => { setGroupListMode('active'); setDeletionImpact(null); activeGroups[0] ? void loadData(activeGroups[0].id) : setSelectedGroupId(''); }}>활성 {activeGroups.length}</button>
            <button className={groupListMode === 'deleted' ? 'active' : ''} onClick={() => { setGroupListMode('deleted'); setDeletionImpact(null); deletedGroups[0] ? void loadData(deletedGroups[0].id) : setSelectedGroupId(''); }}>삭제됨 {deletedGroups.length}</button>
          </div>
          <div className="access-list">
            {visibleGroups.map((group) => (
              <button
                key={group.id}
                className={`access-list-row ${group.id === selectedGroup?.id ? 'selected' : ''}`}
                aria-pressed={group.id === selectedGroup?.id}
                onClick={() => { setDeletionImpact(null); void loadData(group.id); }}
              >
                <span>
                  <strong>{group.name}</strong>
                  <small>{group.id}</small>
                </span>
                <span className={`status-badge ${group.status}`}>{group.recovery_review_required ? '복구 후 확인 필요' : group.status}</span>
              </button>
            ))}
          </div>
          {visibleGroups.length === 0 && <div className="access-empty">{groupListMode === 'active' ? '활성 그룹이 없습니다.' : '삭제된 그룹이 없습니다.'}</div>}
          {selectedGroup && currentUser.role === 'admin' && (
            <div className="access-row-actions">
              <Button
                variant="ghost"
                size="sm"
                icon={<Trash2 size={14} />}
                onClick={() => void inspectGroupDeletion()}
                disabled={selectedGroup.status === 'deleted'}
              >
                삭제 영향 확인
              </Button>
              {selectedGroup.status === 'deleted' && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<RotateCcw size={14} />}
                  onClick={() => void restoreGroup()}
                >
                  복구
                </Button>
              )}
            </div>
          )}
          {selectedGroup?.status === 'active' && deletionImpact?.group.id === selectedGroup.id && (
            <div className={`group-deletion-impact ${deletionImpact.deletion_blocked ? 'blocked' : ''}`}>
              <strong>삭제 영향</strong>
              <p>워크플로우 {deletionImpact.workflows.length}개 · 진행 중 실행 {deletionImpact.active_instance_count}개 · 미결 결재 {deletionImpact.open_approval_count}개</p>
              <p>스케줄 {deletionImpact.schedule_trigger_count}개 · DB Watch {deletionImpact.db_watch_trigger_count}개 · 활성 API Key {deletionImpact.active_api_key_count}개</p>
              <p>소속 사용자 {deletionImpact.member_count}명 · 서비스 계정 {deletionImpact.service_account_count}개 · 외부 승인자 매핑 {deletionImpact.external_mapping_count}개 · 참조 Credential {deletionImpact.referenced_credential_ids.length}개</p>
              {deletionImpact.workflows.length > 0 && <ul>{deletionImpact.workflows.map(workflow => <li key={workflow.id}>{workflow.name} <small>{workflow.lifecycle_status}</small></li>)}</ul>}
              {deletionImpact.deletion_blocked ? (
                <p role="alert">진행 중 실행을 먼저 완료하거나 종료해야 그룹을 삭제할 수 있습니다.</p>
              ) : deletionImpact.deletion_mode === 'permanent' ? (
                <>
                  <p><strong>영구 삭제가 적용됩니다.</strong> 연결 자원과 과거 사용 이력이 없어 삭제 후 복구할 수 없습니다.</p>
                  <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={() => void confirmGroupDeletion()} disabled={saving}>사용 기록 없는 그룹 영구 삭제</Button>
                </>
              ) : (
                <>
                  <p><strong>복구 가능한 삭제가 적용됩니다.</strong> 아래 사용 이력 때문에 현재 비어 있어도 영구 삭제하지 않습니다.</p>
                  <ul>{deletionImpact.usage_history_reasons.map(reason => <li key={reason.code}>{reason.label} {reason.count}건</li>)}</ul>
                  <p>복구 시 그룹만 먼저 활성화됩니다. 워크플로우와 API Key, 자동 실행은 직접 확인해야 합니다.</p>
                  <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={() => void confirmGroupDeletion()} disabled={saving}>복구 가능한 삭제</Button>
                </>
              )}
            </div>
          )}
          {selectedGroup?.status === 'active' && selectedGroup.recovery_review_required && (
            <div className="group-recovery-guide">
              <strong>복구 후 확인이 필요합니다</strong>
              <p>그룹과 기존 소속 정보만 복구했습니다. 워크플로우와 자동 실행은 비활성 상태이며, 그룹 삭제로 비활성화된 API Key는 다시 켤 수 없으므로 필요한 연동에는 새 키를 발급해야 합니다.</p>
              {deletionImpact && <p>워크플로우 {deletionImpact.workflows.length}개 · API Key {deletionImpact.api_key_count}개 · 스케줄 {deletionImpact.schedule_trigger_count}개 · DB Watch {deletionImpact.db_watch_trigger_count}개</p>}
              <div className="access-row-actions">
                <Button variant="secondary" size="sm" onClick={() => { window.location.hash = '#/designer'; }}>워크플로우 확인</Button>
                <Button variant="secondary" size="sm" onClick={() => setActiveTab('apiKeys')}>API Key 확인·재발급</Button>
                <Button variant="primary" size="sm" onClick={() => void completeRecoveryReview()} disabled={saving}>복구 확인 완료</Button>
              </div>
            </div>
          )}
        </section>

        <section className="access-panel detail-panel">
          <div className="access-tabs" role="tablist" aria-label="접근 권한 상세">
            <button className={activeTab === 'users' ? 'active' : ''} onClick={() => setActiveTab('users')}>
              <UserRound size={15} />
              그룹 멤버
              <span>{groupUsers.length}</span>
            </button>
            <button
              className={activeTab === 'serviceAccounts' ? 'active' : ''}
              onClick={() => setActiveTab('serviceAccounts')}
            >
              <Shield size={15} />
              서비스 계정
              <span>{groupServiceAccounts.length}</span>
            </button>
            <button className={activeTab === 'apiKeys' ? 'active' : ''} onClick={() => setActiveTab('apiKeys')}>
              <KeyRound size={15} />
              API Key
              <span>{groupKeys.length}</span>
            </button>
            <button
              className={activeTab === 'externalMappings' ? 'active' : ''}
              onClick={() => setActiveTab('externalMappings')}
            >
              <Link2 size={15} />
              외부 승인자 매핑
              <span>{groupExternalMappings.length}</span>
            </button>
          </div>

          {activeTab === 'users' && (
            <>
              <PanelHeader
                icon={<UserRound size={16} />}
                title="그룹 멤버"
                description="현재 그룹에 참여하는 사용자와 그룹 역할입니다."
                action={<Button variant="primary" size="sm" icon={<UserPlus size={14} />} disabled={saving || !currentGroupId} onClick={() => setShowAddMember(true)}>기존 사용자 추가</Button>}
              />
              <ContextNotice
                group={selectedGroup}
                text={
                  selectedGroup?.status === 'deleted'
                    ? '삭제된 그룹에는 멤버를 추가할 수 없습니다.'
                    : '기존 사용자를 현재 그룹에 추가하고 이 그룹에서의 역할을 관리합니다.'
                }
              />
              <GroupMemberTable
                users={groupUsers}
                groupId={selectedGroupFilterId}
                groups={groups}
                canAssignManager={currentUser.role === 'admin'}
                disabled={saving || !currentGroupId}
                onRoleChange={(userId, role) => run(() => authzApi.setGroupMembership(currentGroupId, userId, role))}
                onRemove={async (user) => {
                  const proceed = await confirmDialog({
                    title: '그룹에서 제외할까요?',
                    description: `${user.display_name} 사용자가 현재 그룹에서 제외됩니다. 사용자 계정과 다른 그룹 소속은 유지됩니다.`,
                    confirmLabel: '제외',
                    tone: 'danger',
                  });
                  if (!proceed) return;
                  void run(() => authzApi.removeGroupMembership(currentGroupId, user.id));
                }}
              />
            </>
          )}

          {activeTab === 'serviceAccounts' && (
            <>
              <PanelHeader
                icon={<Shield size={16} />}
                title="서비스 계정"
                description="사람이 아닌 외부 시스템과 자동화 주체를 관리합니다."
                action={<Button variant="primary" size="sm" icon={<Plus size={14} />} disabled={saving || !currentGroupId} onClick={() => setShowCreateServiceAccount(true)}>서비스 계정 생성</Button>}
              />
              <ContextNotice
                group={selectedGroup}
                text={
                  selectedGroup?.status === 'deleted'
                    ? '삭제된 그룹에는 서비스 계정을 추가할 수 없습니다.'
                    : '서비스 계정은 현재 선택된 그룹에만 귀속됩니다.'
                }
              />
              <EntityTable
                rows={groupServiceAccounts.map((account) => ({
                  id: account.id,
                  primary: account.name,
                  secondary: account.description || account.group_id,
                  badge: 'service',
                  status: account.status,
                }))}
              />
            </>
          )}

          {activeTab === 'apiKeys' && (
            <>
              <PanelHeader
                icon={<KeyRound size={16} />}
                title="API Key"
                description="누가 어떤 워크플로우를 호출할 수 있는지 최소 권한으로 발급합니다."
                action={<div className="access-panel-actions"><Button variant="secondary" size="sm" icon={<Activity size={14} />} onClick={() => setShowApiUsage(true)}>사용 이력</Button><Button variant="primary" size="sm" icon={<Plus size={14} />} disabled={saving || !currentGroupId} onClick={() => setShowCreateApiKey(true)}>API Key 발급</Button></div>}
              />
              <ContextNotice
                group={selectedGroup}
                text={
                  selectedGroup?.status === 'deleted'
                    ? '삭제된 그룹에는 API Key를 발급할 수 없습니다.'
                    : 'API Key는 현재 선택된 그룹 안의 사용자 또는 서비스 계정에만 발급됩니다.'
                }
              />
              <div className="key-table">
                {groupKeys.map((key) => (
                  <div key={key.id} className="key-row">
                    <div>
                      <strong>{key.name}</strong>
                      <small>
                        {key.owner_type === 'USER' ? '사용자' : '서비스 계정'}:{key.owner_id}
                      </small>
                      <small>발급자 ID: {key.created_by || '확인 불가'}</small>
                      <small>발급: {new Date(key.created_at).toLocaleString('ko-KR')}</small>
                      <small>최근 사용: {key.last_used_at ? new Date(key.last_used_at).toLocaleString('ko-KR') : '기록 없음'}</small>
                      <code>{key.key_prefix}...</code>
                    </div>
                    <div className="key-row-meta">
                      <span className={`status-badge ${key.status}`}>{key.status}</span>
                      {key.disabled_reason?.startsWith('group_deleted:') && <span>그룹 삭제로 비활성화됨</span>}
                      <span>{key.scopes.map((scope) => scopeLabels[scope] || scope).join(', ') || '권한 없음'}</span>
                      <span>{key.workflow_access === 'all_in_group' ? '그룹 전체 워크플로우' : `선택 워크플로우 ${key.allowed_workflow_ids.length}개`}</span>
                      <span>{key.expires_at ? `만료 ${new Date(key.expires_at).toLocaleDateString()}` : '만료 없음'}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => run(async () => setCreatedKey(await authzApi.rotateApiKey(key.id)))}
                        disabled={key.status !== 'active'}
                      >
                        Rotation
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => run(() => authzApi.disableApiKey(key.id))}
                        disabled={key.status !== 'active'}
                      >
                        비활성화
                      </Button>
                    </div>
                  </div>
                ))}
                {groupKeys.length === 0 && <div className="access-empty">발급된 API Key가 없습니다.</div>}
              </div>
            </>
          )}

          {activeTab === 'externalMappings' && (
            <>
              <PanelHeader icon={<Link2 size={16} />} title="외부 승인자 매핑" description="외부 시스템의 사용자 식별자를 PXM 사용자와 연결합니다." />
              <ContextNotice
                group={selectedGroup}
                text={
                  selectedGroup?.status === 'deleted'
                    ? '삭제된 그룹에는 외부 승인자 매핑을 추가할 수 없습니다.'
                    : '외부 시스템의 provider/subject를 PXM 사용자와 연결합니다. 실제 전달 채널은 실행 요청의 approval_channels가 결정합니다.'
                }
              />
              <ExternalPrincipalMappingPanel
                groupId={currentGroupId}
                users={groupUsers}
                mappings={groupExternalMappings}
                disabled={saving || !currentGroupId}
                onSave={(id, payload) => run(() => {
                  if (!id) return authzApi.createExternalPrincipalMapping(payload);
                  const { provider: _provider, subject: _subject, ...update } = payload;
                  return authzApi.updateExternalPrincipalMapping(id, update);
                })}
                onStatus={(id, status) => run(() => authzApi.setExternalPrincipalMappingStatus(id, status))}
              />
            </>
          )}
        </section>
      </div> : (
        <section className="access-panel user-management-panel">
          <div className="user-management-intro">
            <span><UserRound size={18} /></span>
            <div>
              <h3>사용자 관리</h3>
              <p>사용자 계정을 생성하고 전체 그룹 소속을 확인합니다. 그룹별 역할 변경과 제외는 그룹 관리에서 처리합니다.</p>
            </div>
            <Button
              variant="primary"
              size="sm"
              icon={<UserPlus size={14} />}
              disabled={saving || activeGroups.length === 0 || showCreateUser}
              onClick={() => setShowCreateUser(true)}
            >
              새 사용자 추가
            </Button>
          </div>
          <div className="user-management-workspace">
            <UserDirectoryTable
              users={userDirectory}
              groups={groups}
              selectedUserId={selectedUser?.id || ''}
              onSelect={setSelectedUserId}
            />
            <UserDetailPanel
              key={selectedUser?.id || 'empty'}
              user={selectedUser}
              groups={activeGroups}
              canEditAccount={currentUser.role === 'admin'}
              disabled={saving}
              onUpdate={(payload) => run(() => authzApi.saveUser(payload))}
              onSetMembership={(groupId, role) => run(() => authzApi.setGroupMembership(groupId, selectedUser?.id || '', role))}
              onRemoveMembership={(groupId) => run(() => authzApi.removeGroupMembership(groupId, selectedUser?.id || ''))}
            />
          </div>
        </section>
      )}

      {showCreateGroup && <Drawer title="새 그룹 만들기" eyebrow="그룹 관리" width="sm" className="access-drawer" onClose={() => setShowCreateGroup(false)}>
        <DrawerIntro title="독립된 권한 경계를 만듭니다" description="그룹을 만든 뒤 멤버, 서비스 계정과 워크플로우를 연결할 수 있습니다." />
        <GroupForm disabled={saving} onSave={async (payload) => {
          const saved = await run(() => authzApi.saveGroup(payload));
          if (saved) setShowCreateGroup(false);
          return saved;
        }} />
      </Drawer>}

      {showAddMember && <Drawer title="기존 사용자 추가" eyebrow={selectedGroup?.name || '그룹 멤버'} width="md" className="access-drawer" onClose={() => setShowAddMember(false)}>
        <DrawerIntro title="계정은 그대로, 그룹 소속만 추가합니다" description="새 계정을 만드는 작업이 아닙니다. 기존 사용자를 검색하고 이 그룹에서의 역할을 지정하세요." />
        <ExistingUserMembershipForm
          groupId={currentGroupId}
          users={userDirectory}
          groupUsers={groupUsers}
          groups={groups}
          canAssignManager={currentUser.role === 'admin'}
          disabled={saving || !currentGroupId}
          onAdd={async (userId, role) => {
            const saved = await run(() => authzApi.setGroupMembership(currentGroupId, userId, role));
            if (saved) setShowAddMember(false);
            return saved;
          }}
        />
      </Drawer>}

      {showCreateServiceAccount && <Drawer title="서비스 계정 생성" eyebrow={selectedGroup?.name || '서비스 계정'} width="sm" className="access-drawer" onClose={() => setShowCreateServiceAccount(false)}>
        <DrawerIntro title="외부 시스템의 신원을 등록합니다" description="서비스 계정 자체에는 권한이 없습니다. 생성 후 별도의 API Key를 최소 권한으로 발급하세요." />
        <ServiceAccountForm groupId={currentGroupId} disabled={saving || !currentGroupId} onSave={async (payload) => {
          const saved = await run(() => authzApi.saveServiceAccount(payload));
          if (saved) setShowCreateServiceAccount(false);
          return saved;
        }} />
      </Drawer>}

      {showCreateApiKey && <Drawer title="API Key 발급" eyebrow={selectedGroup?.name || 'API 접근'} width="lg" className="access-drawer" closeOnBackdrop={false} onClose={() => setShowCreateApiKey(false)}>
        <ApiKeyForm
          groupId={currentGroupId}
          users={groupUsers}
          serviceAccounts={groupServiceAccounts}
          workflows={groupWorkflows}
          disabled={saving || !currentGroupId}
          onSave={async (payload) => {
            const saved = await run(async () => setCreatedKey(await authzApi.createApiKey(payload)));
            if (saved) setShowCreateApiKey(false);
            return saved;
          }}
        />
      </Drawer>}

      {showApiUsage && selectedGroupFilterId && <Drawer title="API Key 사용 이력" eyebrow={selectedGroup?.name || 'API 접근'} width="xl" className="access-drawer usage-drawer" onClose={() => setShowApiUsage(false)}>
        <ApiKeyUsagePanel key={selectedGroupFilterId} groupId={selectedGroupFilterId} keys={groupKeys} />
      </Drawer>}

      {showCreateUser && <Drawer title="새 사용자 계정" eyebrow="사용자 관리" width="md" className="access-drawer" closeOnBackdrop={false} onClose={() => setShowCreateUser(false)}>
        <DrawerIntro title="로그인 가능한 새 계정을 만듭니다" description="기존 계정을 그룹에 추가하려는 경우에는 그룹 관리의 ‘기존 사용자 추가’를 사용하세요." />
        <NewUserForm
          groups={activeGroups}
          defaultGroupId={currentGroupId}
          canAssignManager={currentUser.role === 'admin'}
          disabled={saving || activeGroups.length === 0}
          onClose={() => setShowCreateUser(false)}
          onSave={(payload) => run(() => authzApi.createUser(payload))}
        />
      </Drawer>}

      {createdKey && <CreatedApiKeyDrawer apiKey={createdKey.api_key} name={createdKey.name} onClose={() => setCreatedKey(null)} />}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="access-summary-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PanelHeader({ icon, title, description, action }: { icon: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="access-panel-header">
      <span className="access-panel-header-icon">{icon}</span>
      <div><h3>{title}</h3>{description && <p>{description}</p>}</div>
      {action && <span className="access-panel-header-action">{action}</span>}
    </div>
  );
}

function DrawerIntro({ title, description }: { title: string; description: string }) {
  return <div className="access-drawer-intro"><strong>{title}</strong><p>{description}</p></div>;
}

function CreatedApiKeyDrawer({ apiKey, name, onClose }: { apiKey: string; name: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  return <Drawer title="API Key 발급 완료" eyebrow={name} width="md" className="access-drawer created-key-drawer" closeOnBackdrop={false} onClose={onClose}>
    <div className="created-key-warning"><KeyRound size={22} /><div><strong>이 키는 지금 한 번만 확인할 수 있습니다</strong><p>창을 닫기 전에 안전한 비밀 저장소에 복사하세요. 분실하면 기존 키를 확인할 수 없으며 새 키로 Rotation해야 합니다.</p></div></div>
    <label className="created-key-value"><span>발급된 API Key</span><code>{apiKey}</code></label>
    <Button variant="primary" icon={<Copy size={15} />} onClick={async () => { const success = await copyText(apiKey); setCopied(success); setCopyFailed(!success); }}>{copied ? '복사됨' : 'API Key 복사'}</Button>
    {copyFailed && <p className="copy-fallback-message">자동 복사가 차단됐습니다. 위 Key 값을 선택해 직접 복사하세요.</p>}
    <Button variant="secondary" onClick={onClose}>복사 완료 후 닫기</Button>
  </Drawer>;
}

async function copyText(value: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // LAN의 HTTP 개발 주소에서는 Clipboard API가 차단될 수 있어 아래 호환 경로를 사용한다.
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied;
}

function ContextNotice({ group, text }: { group: PxmGroup | null; text: string }) {
  return (
    <div className="access-context">
      <strong>현재 그룹</strong>
      <span>{group ? `${group.name} (${group.id})` : '선택된 그룹 없음'}</span>
      <small>{text}</small>
    </div>
  );
}

function membershipRole(user: PxmUser, groupId: string): PxmGroupRole {
  return user.memberships?.find((membership) => membership.group_id === groupId)?.role
    || (user.role === 'group_manager' ? 'group_manager' : 'user');
}

function GroupForm({ disabled, onSave }: { disabled?: boolean; onSave: (payload: { id?: string; name: string; description?: string }) => Promise<boolean> }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  return (
    <form
      className="access-drawer-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!name.trim()) return;
        if (!await onSave({ name: name.trim(), description: description.trim() })) return;
        setName('');
        setDescription('');
      }}
    >
      <label><span>그룹 이름 <b>필수</b></span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="예: 보안운영팀" autoFocus /></label>
      <label><span>설명</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="이 그룹이 담당하는 업무를 입력하세요." rows={3} /></label>
      <Button type="submit" variant="primary" size="sm" icon={<Save size={14} />} disabled={disabled || !name.trim()}>
        그룹 만들기
      </Button>
    </form>
  );
}

function ExistingUserMembershipForm({
  groupId,
  users,
  groupUsers,
  groups,
  canAssignManager,
  disabled,
  onAdd,
}: {
  groupId: string;
  users: PxmUser[];
  groupUsers: PxmUser[];
  groups: PxmGroup[];
  canAssignManager: boolean;
  disabled?: boolean;
  onAdd: (userId: string, role: PxmGroupRole) => Promise<boolean>;
}) {
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<PxmGroupRole>('user');
  const memberIds = useMemo(() => new Set(groupUsers.map((user) => user.id)), [groupUsers]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const candidates = useMemo(() => {
    if (!normalizedQuery) return [];
    return users
      .filter((user) => user.status === 'active' && user.role !== 'admin' && !memberIds.has(user.id))
      .filter((user) => [user.id, user.display_name, user.email || ''].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
      .slice(0, 8);
  }, [memberIds, normalizedQuery, users]);

  const groupName = (id: string) => groups.find((group) => group.id === id)?.name || id;

  return (
    <section className="drawer-member-search">
      <div className="member-search-controls">
        <label><span>사용자 검색</span><span className="drawer-search-input"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ID, 이름 또는 이메일" disabled={disabled} autoFocus /></span></label>
        <label><span>그룹 역할</span><select value={role} onChange={(event) => setRole(event.target.value as PxmGroupRole)} disabled={disabled}>
          <option value="user">일반 사용자</option>
          {canAssignManager && <option value="group_manager">그룹 관리자</option>}
        </select></label>
      </div>
      {!normalizedQuery && <div className="access-empty">검색어를 입력하면 추가 가능한 사용자가 표시됩니다.</div>}
      {normalizedQuery && (
        <div className="member-search-results">
          {candidates.map((user) => (
            <div key={user.id} className="member-search-result">
              <span>
                <strong>{user.display_name}</strong>
                <small>{user.id}{user.email ? ` · ${user.email}` : ''}</small>
                <small>현재 소속: {user.group_ids.length ? user.group_ids.map(groupName).join(', ') : '없음'}</small>
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={disabled || !groupId}
                onClick={async () => { if (await onAdd(user.id, role)) setQuery(''); }}
              >
                그룹에 추가
              </Button>
            </div>
          ))}
          {candidates.length === 0 && <div className="access-empty">추가할 수 있는 사용자를 찾지 못했습니다.</div>}
        </div>
      )}
    </section>
  );
}

function NewUserForm({
  groups,
  defaultGroupId,
  canAssignManager,
  disabled,
  onClose,
  onSave,
}: {
  groups: PxmGroup[];
  defaultGroupId: string;
  canAssignManager: boolean;
  disabled?: boolean;
  onClose: () => void;
  onSave: (payload: { id?: string; display_name: string; email?: string; role: PxmRole; group_ids: string[]; memberships: Array<{ group_id: string; role: PxmGroupRole }>; password?: string }) => Promise<boolean>;
}) {
  const [id, setId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<PxmGroupRole>('user');
  const [password, setPassword] = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const groupId = selectedGroupId || defaultGroupId || groups[0]?.id || '';
  return (
      <form className="access-drawer-form" onSubmit={async (event) => {
        event.preventDefault();
        if (!displayName.trim() || !groupId) return;
        const saved = await onSave({
          id: id.trim() || undefined,
          display_name: displayName.trim(),
          email: email.trim() || undefined,
          role,
          group_ids: [groupId],
          memberships: [{ group_id: groupId, role }],
          password: password || undefined,
        });
        if (!saved) return;
        setId('');
        setDisplayName('');
        setEmail('');
        setRole('user');
        setPassword('');
        onClose();
      }}>
        <label><span>초기 소속 그룹 <b>필수</b></span><select value={groupId} onChange={(event) => setSelectedGroupId(event.target.value)} disabled={disabled} aria-label="초기 소속 그룹">
          {groups.map((group) => <option key={group.id} value={group.id}>초기 소속 · {group.name}</option>)}
        </select><small>계정 생성 후 다른 그룹도 추가할 수 있습니다.</small></label>
        <label><span>사용자 ID</span><input value={id} onChange={(event) => setId(event.target.value)} placeholder="비우면 자동 생성" disabled={disabled} /></label>
        <label><span>사용자 이름 <b>필수</b></span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="표시할 이름" disabled={disabled} autoFocus /></label>
        <label><span>이메일</span><input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" disabled={disabled} /></label>
        <label><span>초기 비밀번호</span><input type="password" minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="비우면 시스템 정책에 따라 생성" disabled={disabled} /><small>직접 입력할 경우 12자 이상이어야 합니다.</small></label>
        <label><span>그룹 역할 <b>필수</b></span><select value={role} onChange={(event) => setRole(event.target.value as PxmGroupRole)} disabled={disabled}>
          <option value="user">일반 사용자</option>
          {canAssignManager && <option value="group_manager">그룹 관리자</option>}
        </select></label>
        <Button type="submit" variant="primary" size="sm" disabled={disabled || !displayName.trim()}>사용자 생성</Button>
      </form>
  );
}

function GroupMemberTable({
  users,
  groupId,
  groups,
  canAssignManager,
  disabled,
  onRoleChange,
  onRemove,
}: {
  users: PxmUser[];
  groupId: string;
  groups: PxmGroup[];
  canAssignManager: boolean;
  disabled?: boolean;
  onRoleChange: (userId: string, role: PxmGroupRole) => void;
  onRemove: (user: PxmUser) => void;
}) {
  if (users.length === 0) return <div className="access-empty">현재 그룹에 등록된 멤버가 없습니다.</div>;
  const groupName = (id: string) => groups.find((group) => group.id === id)?.name || id;
  return (
    <div className="group-member-table">
      <div className="group-member-heading"><strong>현재 그룹 멤버</strong><span>{users.length}명</span></div>
      {users.map((user) => {
        const role = membershipRole(user, groupId);
        const managerProtected = role === 'group_manager' && !canAssignManager;
        return (
          <div key={user.id} className="group-member-row">
            <span className="group-member-identity">
              <strong>{user.display_name}</strong>
              <small>{user.id}{user.email ? ` · ${user.email}` : ''}</small>
              <small>전체 소속: {user.group_ids.map(groupName).join(', ') || '없음'}</small>
            </span>
            <span className="group-member-actions">
              <select
                aria-label={`${user.display_name} 역할`}
                value={role}
                disabled={disabled || managerProtected}
                onChange={(event) => onRoleChange(user.id, event.target.value as PxmGroupRole)}
              >
                <option value="user">일반 사용자</option>
                {canAssignManager && <option value="group_manager">그룹 관리자</option>}
              </select>
              <span className={`status-badge ${user.status}`}>{user.status}</span>
              <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} disabled={disabled || managerProtected} onClick={() => onRemove(user)}>
                그룹 제외
              </Button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function UserDirectoryTable({
  users,
  groups,
  selectedUserId,
  onSelect,
}: {
  users: PxmUser[];
  groups: PxmGroup[];
  selectedUserId: string;
  onSelect: (userId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredUsers = useMemo(() => users.filter((user) => (
    !normalizedQuery
    || [user.id, user.display_name, user.email || ''].some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
  )), [normalizedQuery, users]);
  const groupName = (id: string) => groups.find((group) => group.id === id)?.name || id;

  return (
    <section className="user-directory">
      <div className="user-directory-header">
        <div><strong>전체 사용자</strong><small>사용자를 선택해 계정과 그룹 소속을 관리합니다.</small></div>
        <label><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="사용자 검색" /></label>
      </div>
      <div className="entity-table">
        {filteredUsers.map((user) => (
          <button key={user.id} className={`entity-row user-directory-row ${selectedUserId === user.id ? 'selected' : ''}`} onClick={() => onSelect(user.id)}>
            <span>
              <strong>{user.display_name}</strong>
              <small>{user.id}{user.email ? ` · ${user.email}` : ''}</small>
              <small>
                소속: {(user.memberships || []).length
                  ? (user.memberships || []).map((membership) => `${groupName(membership.group_id)} (${membership.role === 'group_manager' ? '관리자' : '사용자'})`).join(', ')
                  : '없음'}
              </small>
            </span>
            <span className="entity-badges">
              <span className="type-badge">{user.role === 'admin' ? '최고 관리자' : '사용자'}</span>
              <span className={`status-badge ${user.status}`}>{user.status}</span>
            </span>
          </button>
        ))}
        {filteredUsers.length === 0 && <div className="access-empty">검색 결과가 없습니다.</div>}
      </div>
    </section>
  );
}

function UserDetailPanel({
  user,
  groups,
  canEditAccount,
  disabled,
  onUpdate,
  onSetMembership,
  onRemoveMembership,
}: {
  user: PxmUser | null;
  groups: PxmGroup[];
  canEditAccount: boolean;
  disabled?: boolean;
  onUpdate: (payload: { id?: string; display_name: string; email?: string; role: PxmRole; group_ids: string[]; memberships?: Array<{ group_id: string; role: PxmGroupRole }>; status?: PxmUser['status']; password?: string }) => Promise<boolean>;
  onSetMembership: (groupId: string, role: PxmGroupRole) => Promise<boolean>;
  onRemoveMembership: (groupId: string) => Promise<boolean>;
}) {
  const { confirm: confirmDialog } = useFeedback();
  const [displayName, setDisplayName] = useState(user?.display_name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [status, setStatus] = useState<PxmUser['status']>(user?.status || 'active');
  const [password, setPassword] = useState('');
  const [membershipGroupId, setMembershipGroupId] = useState('');
  const [membershipRole, setMembershipRole] = useState<PxmGroupRole>('user');

  if (!user) return <section className="user-detail-panel"><div className="access-empty">관리할 사용자를 선택하세요.</div></section>;

  const manageableGroupIds = new Set(groups.map((group) => group.id));
  const memberships = user.memberships || [];
  const availableGroups = groups.filter((group) => !memberships.some((membership) => membership.group_id === group.id));
  const selectedMembershipGroupId = membershipGroupId && availableGroups.some((group) => group.id === membershipGroupId)
    ? membershipGroupId
    : availableGroups[0]?.id || '';
  const groupName = (groupId: string) => groups.find((group) => group.id === groupId)?.name || groupId;

  return (
    <section className="user-detail-panel">
      <div className="user-detail-heading">
        <div><strong>{user.display_name}</strong><small>{user.id}</small></div>
        <span className={`status-badge ${user.status}`}>{user.status}</span>
      </div>

      <form className="user-account-form" onSubmit={async (event) => {
        event.preventDefault();
        if (!canEditAccount || !displayName.trim()) return;
        const saved = await onUpdate({
          id: user.id,
          display_name: displayName.trim(),
          email: email.trim() || undefined,
          role: user.role,
          group_ids: user.group_ids,
          memberships,
          status,
          password: password || undefined,
        });
        if (saved) setPassword('');
      }}>
        <div className="user-detail-section-title"><strong>계정 정보</strong><small>{canEditAccount ? '최고 관리자만 수정할 수 있습니다.' : '계정 정보는 조회만 가능합니다.'}</small></div>
        <label><span>이름</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} disabled={disabled || !canEditAccount} /></label>
        <label><span>이메일</span><input value={email} onChange={(event) => setEmail(event.target.value)} disabled={disabled || !canEditAccount} /></label>
        <label><span>상태</span><select value={status} onChange={(event) => setStatus(event.target.value as PxmUser['status'])} disabled={disabled || !canEditAccount}>
          <option value="active">활성</option>
          <option value="disabled">비활성</option>
          <option value="deleted">삭제됨</option>
        </select></label>
        <label><span>새 비밀번호</span><input type="password" minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="변경할 때만 입력" disabled={disabled || !canEditAccount} /></label>
        {canEditAccount && <Button type="submit" variant="primary" size="sm" disabled={disabled || !displayName.trim()}>계정 정보 저장</Button>}
      </form>

      <div className="user-membership-manager">
        <div className="user-detail-section-title"><strong>그룹 소속</strong><small>관리 가능한 그룹의 membership과 역할을 변경합니다.</small></div>
        {availableGroups.length > 0 && (
          <div className="user-membership-add">
            <select value={selectedMembershipGroupId} onChange={(event) => setMembershipGroupId(event.target.value)} disabled={disabled}>
              {availableGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select>
            <select value={membershipRole} onChange={(event) => setMembershipRole(event.target.value as PxmGroupRole)} disabled={disabled}>
              <option value="user">일반 사용자</option>
              {canEditAccount && <option value="group_manager">그룹 관리자</option>}
            </select>
            <Button variant="secondary" size="sm" disabled={disabled || !selectedMembershipGroupId} onClick={() => onSetMembership(selectedMembershipGroupId, membershipRole)}>그룹 추가</Button>
          </div>
        )}
        <div className="user-membership-list">
          {memberships.map((membership) => {
            const manageable = manageableGroupIds.has(membership.group_id);
            const managerProtected = membership.role === 'group_manager' && !canEditAccount;
            return (
              <div key={membership.group_id} className="user-membership-row">
                <span><strong>{groupName(membership.group_id)}</strong><small>{membership.group_id}</small></span>
                <span>
                  <select value={membership.role} disabled={disabled || !manageable || managerProtected} onChange={(event) => onSetMembership(membership.group_id, event.target.value as PxmGroupRole)}>
                    <option value="user">일반 사용자</option>
                    {canEditAccount && <option value="group_manager">그룹 관리자</option>}
                  </select>
                  <Button variant="ghost" size="sm" disabled={disabled || !manageable || managerProtected} onClick={async () => {
                    const proceed = await confirmDialog({
                      title: '그룹에서 제외할까요?',
                      description: `${user.display_name} 사용자가 ${groupName(membership.group_id)} 그룹에서 제외됩니다.`,
                      confirmLabel: '제외',
                      tone: 'danger',
                    });
                    if (!proceed) return;
                    void onRemoveMembership(membership.group_id);
                  }}>그룹 제외</Button>
                </span>
              </div>
            );
          })}
          {memberships.length === 0 && <div className="access-empty">소속된 그룹이 없습니다.</div>}
        </div>
      </div>
    </section>
  );
}

function ServiceAccountForm({
  groupId,
  disabled,
  onSave,
}: {
  groupId: string;
  disabled?: boolean;
  onSave: (payload: { id?: string; name: string; group_id: string; description?: string }) => Promise<boolean>;
}) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  return (
    <form className="access-drawer-form" onSubmit={async (event) => {
      event.preventDefault();
      if (!name.trim() || !groupId) return;
      if (!await onSave({ id: id.trim() || undefined, name: name.trim(), group_id: groupId, description: description.trim() })) return;
      setId('');
      setName('');
      setDescription('');
    }}>
      <label><span>서비스 계정 ID</span><input value={id} onChange={(event) => setId(event.target.value)} placeholder="예: hr-portal" autoFocus /><small>비우면 자동 생성됩니다. 발급 후에는 변경하지 않는 식별자입니다.</small></label>
      <label><span>표시 이름 <b>필수</b></span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="예: 인사 포털" /></label>
      <label><span>사용 목적</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="어떤 시스템이 어떤 목적으로 사용하는지 기록하세요." rows={3} /></label>
      <Button type="submit" variant="primary" size="sm" disabled={disabled || !name.trim()}>서비스 계정 생성</Button>
    </form>
  );
}

function ApiKeyForm({
  groupId,
  users,
  serviceAccounts,
  workflows,
  disabled,
  onSave,
}: {
  groupId: string;
  users: PxmUser[];
  serviceAccounts: PxmServiceAccount[];
  workflows: WorkflowTemplate[];
  disabled?: boolean;
  onSave: (payload: {
    name: string;
    owner_type: ApiKeyOwnerType;
    owner_id: string;
    group_id: string;
    scopes: ApiKeyScope[];
    workflow_access: ApiKeyWorkflowAccess;
    allowed_workflow_ids: string[];
    ip_allowlist?: string[];
    rate_limit_per_minute?: number | null;
    expires_at?: string | null;
  }) => Promise<boolean>;
}) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [ownerType, setOwnerType] = useState<ApiKeyOwnerType>('SERVICE_ACCOUNT');
  const [ownerId, setOwnerId] = useState('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['workflow:read', 'workflow:execute']);
  const [workflowAccess, setWorkflowAccess] = useState<ApiKeyWorkflowAccess>('allowlist');
  const [workflowIds, setWorkflowIds] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState('');
  const [ipAllowlist, setIpAllowlist] = useState('');
  const [rateLimit, setRateLimit] = useState('');
  const owners = ownerType === 'USER' ? users : serviceAccounts;

  useEffect(() => {
    setOwnerId(owners[0]?.id || '');
  }, [ownerType, groupId, owners.length]);

  useEffect(() => {
    setWorkflowIds([]);
  }, [groupId, workflows]);

  const selectOwnerType = (next: ApiKeyOwnerType) => {
    setOwnerType(next);
    setScopes(next === 'USER' ? ['workflow:read', 'task:approve'] : ['workflow:read', 'workflow:execute']);
  };
  const ownerLabel = owners.find((owner) => owner.id === ownerId);
  const canContinuePermissions = scopes.length > 0 && (workflowAccess === 'all_in_group' || workflowIds.length > 0);

  return (
    <form className="api-key-wizard" onSubmit={async (event) => {
      event.preventDefault();
      if (step < 3) return;
      if (!name.trim() || !ownerId || !groupId || !canContinuePermissions) return;
      await onSave({
        name: name.trim(),
        owner_type: ownerType,
        owner_id: ownerId,
        group_id: groupId,
        scopes,
        workflow_access: workflowAccess,
        allowed_workflow_ids: workflowAccess === 'allowlist' ? workflowIds : [],
        ip_allowlist: ipAllowlist.split(',').map((item) => item.trim()).filter(Boolean),
        rate_limit_per_minute: rateLimit ? Number(rateLimit) : null,
        expires_at: expiresAt || null,
      });
    }}>
      <ol className="wizard-steps" aria-label="API Key 발급 단계">
        {['소유자', '권한 범위', '보안 및 확인'].map((label, index) => <li key={label} className={step === index + 1 ? 'active' : step > index + 1 ? 'complete' : ''}><span>{index + 1}</span><strong>{label}</strong></li>)}
      </ol>

      {step === 1 && <section className="wizard-panel">
        <div className="wizard-heading"><strong>누가 사용할 키인가요?</strong><p>키는 그룹 공용 익명 키가 아니라 반드시 사용자 또는 서비스 계정에 귀속됩니다.</p></div>
        <label><span>Key 이름 <b>필수</b></span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="예: 인사 포털 실행 키" autoFocus /></label>
        <fieldset className="owner-type-cards"><legend>소유자 유형</legend>
          <label className={ownerType === 'SERVICE_ACCOUNT' ? 'selected' : ''}><input type="radio" name="owner-type" checked={ownerType === 'SERVICE_ACCOUNT'} onChange={() => selectOwnerType('SERVICE_ACCOUNT')} /><Shield size={18} /><span><strong>서비스 계정</strong><small>외부 시스템과 자동화에서 사용</small></span></label>
          <label className={ownerType === 'USER' ? 'selected' : ''}><input type="radio" name="owner-type" checked={ownerType === 'USER'} onChange={() => selectOwnerType('USER')} /><UserRound size={18} /><span><strong>사용자</strong><small>특정 사용자의 API 결재 등에 사용</small></span></label>
        </fieldset>
        <label><span>소유자 <b>필수</b></span><select value={ownerId} onChange={(event) => setOwnerId(event.target.value)}>
          {owners.map((owner) => <option key={owner.id} value={owner.id}>{'display_name' in owner ? owner.display_name : owner.name} · {owner.id}</option>)}
        </select>{owners.length === 0 && <small className="field-error">선택 가능한 소유자가 없습니다. 먼저 {ownerType === 'USER' ? '그룹 멤버' : '서비스 계정'}를 등록하세요.</small>}</label>
      </section>}

      {step === 2 && <section className="wizard-panel">
        <div className="wizard-heading"><strong>무엇을 할 수 있나요?</strong><p>필요한 동작과 워크플로우만 선택하는 것이 안전합니다.</p></div>
        <fieldset className="permission-options"><legend>허용 동작</legend>{scopeOptions.map((scope) => {
          const unavailable = ownerType === 'SERVICE_ACCOUNT' && scope === 'task:approve';
          return <label key={scope} className={unavailable ? 'disabled' : ''}><input type="checkbox" disabled={unavailable} checked={scopes.includes(scope)} onChange={(event) => setScopes((current) => event.target.checked ? Array.from(new Set([...current, scope])) : current.filter((item) => item !== scope))} /><span><strong>{scopeLabels[scope]}</strong><small>{unavailable ? '서비스 계정에는 줄 수 없습니다. 결재는 사람이 소유한 키로만 처리합니다.' : scopeDescriptions[scope]}</small></span></label>;
        })}</fieldset>
        <label><span>워크플로우 접근 범위</span><select value={workflowAccess} onChange={(event) => setWorkflowAccess(event.target.value as ApiKeyWorkflowAccess)}>
          <option value="allowlist">선택한 워크플로우만 (권장)</option>
          <option value="all_in_group">그룹 전체 워크플로우와 향후 추가 항목</option>
        </select></label>
        {workflowAccess === 'allowlist' && <fieldset className="workflow-options"><legend>허용 워크플로우 <b>필수</b></legend>{workflows.length === 0 ? <small>현재 그룹에 활성 워크플로우가 없습니다.</small> : workflows.map((workflow) => <label key={workflow.id}><input type="checkbox" checked={workflowIds.includes(workflow.id)} onChange={(event) => setWorkflowIds((current) => event.target.checked ? Array.from(new Set([...current, workflow.id])) : current.filter((id) => id !== workflow.id))} /><span>{workflow.name}<small>v{workflow.version || 1}</small></span></label>)}</fieldset>}
      </section>}

      {step === 3 && <section className="wizard-panel">
        <div className="wizard-heading"><strong>보안 제한을 확인하세요</strong><p>선택 사항을 비워두면 별도의 만료·IP·요청량 제한을 적용하지 않습니다.</p></div>
        <div className="security-fields"><label><span>만료일</span><input type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label><label><span>분당 요청 제한</span><input type="number" min="1" max="100000" value={rateLimit} onChange={(event) => setRateLimit(event.target.value)} placeholder="예: 120" /></label></div>
        <label><span>허용 IP/CIDR</span><input value={ipAllowlist} onChange={(event) => setIpAllowlist(event.target.value)} placeholder="예: 10.0.0.12, 10.20.0.0/16" /><small>여러 값은 쉼표로 구분합니다.</small></label>
        <dl className="key-review"><div><dt>Key 이름</dt><dd>{name}</dd></div><div><dt>소유자</dt><dd>{ownerType === 'USER' ? '사용자' : '서비스 계정'} · {'display_name' in (ownerLabel || {}) ? (ownerLabel as PxmUser).display_name : (ownerLabel as PxmServiceAccount | undefined)?.name || ownerId}</dd></div><div><dt>권한</dt><dd>{scopes.map((scope) => scopeLabels[scope]).join(', ')}</dd></div><div><dt>워크플로우</dt><dd>{workflowAccess === 'all_in_group' ? '그룹 전체' : `${workflowIds.length}개 선택`}</dd></div></dl>
        <div className="one-time-key-note"><KeyRound size={18} /><span><strong>발급 직후 원문을 한 번만 표시합니다.</strong><small>안전한 위치에 즉시 복사해야 합니다.</small></span></div>
      </section>}

      <div className="wizard-actions"><Button type="button" variant="secondary" disabled={step === 1 || disabled} onClick={() => setStep((current) => Math.max(1, current - 1))}>이전</Button>{step < 3 ? <Button key="next" type="button" variant="primary" disabled={disabled || (step === 1 ? !name.trim() || !ownerId : !canContinuePermissions)} onClick={(event) => { event.preventDefault(); setStep((current) => Math.min(3, current + 1)); }}>다음</Button> : <Button key="issue" type="submit" variant="primary" disabled={disabled || !canContinuePermissions}>API Key 발급</Button>}</div>
    </form>
  );
}

const mappingIssueLabels: Record<ExternalPrincipalMapping['issues'][number], string> = {
  mapping_disabled: '매핑 비활성',
  user_missing: '사용자 없음',
  user_disabled: '사용자 비활성',
  group_mismatch: '그룹 불일치',
  email_missing: '이메일 없음',
};

function ExternalPrincipalMappingPanel({
  groupId,
  users,
  mappings,
  disabled,
  onSave,
  onStatus,
}: {
  groupId: string;
  users: PxmUser[];
  mappings: ExternalPrincipalMapping[];
  disabled?: boolean;
  onSave: (
    id: string | null,
    payload: {
      provider: string;
      subject: string;
      group_id: string;
      pxm_user_id: string;
      display_name?: string;
      email?: string;
      department?: string;
    },
  ) => Promise<boolean>;
  onStatus: (id: string, status: 'active' | 'disabled') => Promise<boolean>;
}) {
  const activeUsers = users.filter((user) => user.status === 'active');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [provider, setProvider] = useState('');
  const [subject, setSubject] = useState('');
  const [userId, setUserId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [department, setDepartment] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [subjectFilter, setSubjectFilter] = useState('');
  const filteredMappings = useMemo(() => {
    const normalizedProvider = providerFilter.trim().toLowerCase();
    const normalizedSubject = subjectFilter.trim().toLowerCase();
    return mappings.filter((mapping) => (
      (!normalizedProvider || mapping.provider.toLowerCase() === normalizedProvider)
      && (!normalizedSubject || mapping.subject.toLowerCase().includes(normalizedSubject))
    ));
  }, [mappings, providerFilter, subjectFilter]);

  useEffect(() => {
    setEditingId(null);
    setProvider('');
    setSubject('');
    setUserId(activeUsers[0]?.id || '');
    setDisplayName('');
    setEmail('');
    setDepartment('');
    setShowEditor(false);
    setProviderFilter('');
    setSubjectFilter('');
  }, [groupId]);

  useEffect(() => {
    if (!userId && activeUsers[0]) setUserId(activeUsers[0].id);
  }, [activeUsers.length, userId]);

  const reset = () => {
    setEditingId(null);
    setProvider('');
    setSubject('');
    setUserId(activeUsers[0]?.id || '');
    setDisplayName('');
    setEmail('');
    setDepartment('');
  };

  const startEdit = (mapping: ExternalPrincipalMapping) => {
    setEditingId(mapping.id);
    setProvider(mapping.provider);
    setSubject(mapping.subject);
    setUserId(mapping.pxm_user_id);
    setDisplayName(mapping.display_name || '');
    setEmail(mapping.email || '');
    setDepartment(mapping.department || '');
    setShowEditor(true);
  };

  return (
    <>
      <div className="mapping-list-toolbar"><div><strong>등록된 매핑</strong><small>Provider와 외부 Subject를 기준으로 검색합니다.</small></div><Button variant="primary" size="sm" icon={<Plus size={14} />} disabled={disabled} onClick={() => { reset(); setShowEditor(true); }}>외부 사용자 매핑</Button></div>

      {showEditor && <Drawer title={editingId ? '외부 사용자 매핑 수정' : '외부 사용자 매핑'} eyebrow="외부 승인자" width="md" className="access-drawer" onClose={reset}>
      <DrawerIntro title="외부 신원을 PXM 사용자와 연결합니다" description="Provider와 Subject는 외부 시스템이 전달하는 고유 식별자입니다. 실제 승인 권한은 연결된 PXM 사용자의 그룹 권한을 따릅니다." />
      <form className="access-drawer-form" onSubmit={async (event) => {
        event.preventDefault();
        if (!provider.trim() || !subject.trim() || !userId || !groupId) return;
        const saved = await onSave(editingId, {
          provider: provider.trim(),
          subject: subject.trim(),
          group_id: groupId,
          pxm_user_id: userId,
          display_name: displayName.trim(),
          email: email.trim(),
          department: department.trim(),
        });
        if (saved) reset();
      }}>
        <label><span>Provider <b>필수</b></span><input
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
          placeholder="provider (예: acrapoint)"
          disabled={Boolean(editingId)}
          autoFocus
        /><small>예: hr-system, partner-portal</small></label>
        <label><span>외부 사용자 Subject <b>필수</b></span><input
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          placeholder="외부 사용자 subject"
          disabled={Boolean(editingId)}
        /></label>
        <label><span>연결할 PXM 사용자 <b>필수</b></span><select value={userId} onChange={(event) => setUserId(event.target.value)}>
          <option value="">PXM 사용자 선택</option>
          {activeUsers.map((user) => (
            <option key={user.id} value={user.id}>{user.display_name} ({user.id})</option>
          ))}
        </select></label>
        <label><span>외부 표시 이름</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="선택 입력" /></label>
        <label><span>승인 전달 이메일</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="선택 입력" /></label>
        <label><span>부서</span><input value={department} onChange={(event) => setDepartment(event.target.value)} placeholder="선택 입력" /></label>
        <div className="mapping-form-actions">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            icon={<Save size={14} />}
            disabled={disabled || !provider.trim() || !subject.trim() || !userId}
          >
            {editingId ? '변경 저장' : '매핑 등록'}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={reset}>취소</Button>
        </div>
      </form>
      </Drawer>}

      <div className="mapping-search">
        <input
          value={providerFilter}
          onChange={(event) => setProviderFilter(event.target.value)}
          placeholder="provider 검색"
        />
        <input
          value={subjectFilter}
          onChange={(event) => setSubjectFilter(event.target.value)}
          placeholder="subject 검색"
        />
        <span>{filteredMappings.length}건</span>
      </div>

      <div className="mapping-table">
        {filteredMappings.map((mapping) => (
          <div key={mapping.id} className="mapping-row">
            <div className="mapping-identity">
              <strong>{mapping.provider}:{mapping.subject}</strong>
              <small>
                {mapping.display_name || mapping.pxm_user?.display_name || mapping.pxm_user_id}
                {mapping.department ? ` · ${mapping.department}` : ''}
              </small>
              <small>PXM 사용자: {mapping.pxm_user_id}</small>
              <small>이메일: {mapping.email || mapping.pxm_user?.email || '없음'}</small>
            </div>
            <div className="mapping-meta">
              <span className={`status-badge ${mapping.status}`}>{mapping.status}</span>
              <span className="mapping-channels">
                {mapping.available_channels.length > 0
                  ? mapping.available_channels.map((channel) => (
                      <span key={channel} className="type-badge">{channel}</span>
                    ))
                  : <span className="mapping-issue">사용 가능한 채널 없음</span>}
              </span>
              {mapping.issues.length > 0 && (
                <span className="mapping-issues">
                  {mapping.issues.map((issue) => (
                    <span key={issue} className="mapping-issue">{mappingIssueLabels[issue]}</span>
                  ))}
                </span>
              )}
              <span className="mapping-actions">
                <Button variant="ghost" size="sm" onClick={() => startEdit(mapping)} disabled={disabled}>수정</Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onStatus(mapping.id, mapping.status === 'active' ? 'disabled' : 'active')}
                  disabled={disabled}
                >
                  {mapping.status === 'active' ? '비활성화' : '활성화'}
                </Button>
              </span>
            </div>
          </div>
        ))}
        {filteredMappings.length === 0 && (
          <div className="access-empty">
            {providerFilter.trim() || subjectFilter.trim()
              ? '검색한 외부 승인자는 미매핑 상태입니다.'
              : '등록된 외부 승인자 매핑이 없습니다.'}
          </div>
        )}
      </div>
    </>
  );
}

function EntityTable({
  rows,
}: {
  rows: Array<{ id: string; primary: string; secondary?: string; meta?: string; badge: string; status: string }>;
}) {
  if (rows.length === 0) {
    return <div className="access-empty">등록된 항목이 없습니다.</div>;
  }
  return (
    <div className="entity-table">
      {rows.map((row) => (
        <div key={row.id} className="entity-row">
          <span>
            <strong>{row.primary}</strong>
            <small>{row.id}</small>
            {row.secondary && <small>{row.secondary}</small>}
            {row.meta && <small>{row.meta}</small>}
          </span>
          <span className="entity-badges">
            <span className="type-badge">{row.badge}</span>
            <span className={`status-badge ${row.status}`}>{row.status}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
