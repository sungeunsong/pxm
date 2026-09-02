import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { KeyRound, Link2, RefreshCw, RotateCcw, Save, Search, Shield, Trash2, UserPlus, UserRound, UsersRound } from 'lucide-react';
import { Button } from '../components';
import { useFeedback } from '../components/feedback/feedback-context';
import {
  authzApi,
  type ApiKeyOwnerType,
  type ApiKeyScope,
  type ApiKeyWorkflowAccess,
  type CreatedApiKey,
  type ExternalPrincipalMapping,
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

const scopeOptions: ApiKeyScope[] = ['workflow:execute', 'workflow:read', 'task:approve'];
const scopeLabels: Record<ApiKeyScope, string> = {
  'workflow:execute': '워크플로우 실행',
  'workflow:read': '워크플로우/실행 결과 조회',
  'task:approve': '승인 처리',
};
type AccessDetailTab = 'users' | 'serviceAccounts' | 'apiKeys' | 'externalMappings';
type AccessPageSection = 'groups' | 'users';

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
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);
  const [activeTab, setActiveTab] = useState<AccessDetailTab>('users');
  const [pageSection, setPageSection] = useState<AccessPageSection>('groups');

  const activeGroups = groups.filter((group) => group.status !== 'deleted');
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

  return (
    <div className="access-page">
      <div className="access-header">
        <div>
          <p>그룹 권한과 사용자 계정을 구분해 관리합니다.</p>
        </div>
        <Button variant="secondary" size="sm" icon={<RefreshCw size={14} />} onClick={() => void loadData()} disabled={loading}>
          새로고침
        </Button>
      </div>

      {error && <div className="access-alert error">{error}</div>}
      {createdKey && (
        <div className="access-alert success">
          <strong>생성된 API key</strong>
          <code>{createdKey.api_key}</code>
          <span>이 값은 생성 직후에만 표시됩니다.</span>
        </div>
      )}

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
          <PanelHeader icon={<UsersRound size={16} />} title="그룹" />
          <GroupForm disabled={saving} onSave={(payload) => run(() => authzApi.saveGroup(payload))} />
          {selectedGroup && (
            <div className="selected-group-card">
              <span>선택된 그룹</span>
              <strong>{selectedGroup.name}</strong>
              <small>{selectedGroup.id}</small>
              <span className={`status-badge ${selectedGroup.status}`}>{selectedGroup.status}</span>
            </div>
          )}
          <div className="access-list">
            {groups.map((group) => (
              <button
                key={group.id}
                className={`access-list-row ${group.id === selectedGroup?.id ? 'selected' : ''}`}
                onClick={() => void loadData(group.id)}
              >
                <span>
                  <strong>{group.name}</strong>
                  <small>{group.id}</small>
                </span>
                <span className={`status-badge ${group.status}`}>{group.status}</span>
              </button>
            ))}
          </div>
          {groups.length === 0 && <div className="access-empty">등록된 그룹이 없습니다.</div>}
          {selectedGroup && (
            <div className="access-row-actions">
              <Button
                variant="ghost"
                size="sm"
                icon={<Trash2 size={14} />}
                onClick={() => run(() => authzApi.deleteGroup(selectedGroup.id))}
                disabled={selectedGroup.status === 'deleted'}
              >
                삭제
              </Button>
              {selectedGroup.status === 'deleted' && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<RotateCcw size={14} />}
                  onClick={() => run(() => authzApi.restoreGroup(selectedGroup.id))}
                >
                  복구
                </Button>
              )}
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
              <PanelHeader icon={<UserRound size={16} />} title="그룹 멤버" />
              <ContextNotice
                group={selectedGroup}
                text={
                  selectedGroup?.status === 'deleted'
                    ? '삭제된 그룹에는 멤버를 추가할 수 없습니다.'
                    : '기존 사용자를 현재 그룹에 추가하고 이 그룹에서의 역할을 관리합니다.'
                }
              />
              <ExistingUserMembershipForm
                groupId={currentGroupId}
                users={userDirectory}
                groupUsers={groupUsers}
                groups={groups}
                canAssignManager={currentUser.role === 'admin'}
                disabled={saving || !currentGroupId}
                onAdd={(userId, role) => run(() => authzApi.setGroupMembership(currentGroupId, userId, role))}
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
              <PanelHeader icon={<Shield size={16} />} title="서비스 계정" />
              <ContextNotice
                group={selectedGroup}
                text={
                  selectedGroup?.status === 'deleted'
                    ? '삭제된 그룹에는 서비스 계정을 추가할 수 없습니다.'
                    : '서비스 계정은 현재 선택된 그룹에만 귀속됩니다.'
                }
              />
              <ServiceAccountForm
                groupId={currentGroupId}
                disabled={saving || !currentGroupId}
                onSave={(payload) => run(() => authzApi.saveServiceAccount(payload))}
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
              <PanelHeader icon={<KeyRound size={16} />} title="API Key" />
              <ContextNotice
                group={selectedGroup}
                text={
                  selectedGroup?.status === 'deleted'
                    ? '삭제된 그룹에는 API Key를 발급할 수 없습니다.'
                    : 'API Key는 현재 선택된 그룹 안의 사용자 또는 서비스 계정에만 발급됩니다.'
                }
              />
              <ApiKeyForm
                groupId={currentGroupId}
                users={groupUsers}
                serviceAccounts={groupServiceAccounts}
                workflows={groupWorkflows}
                disabled={saving || !currentGroupId}
                onSave={(payload) =>
                  run(async () => {
                    const key = await authzApi.createApiKey(payload);
                    setCreatedKey(key);
                  })
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
                      <code>{key.key_prefix}...</code>
                    </div>
                    <div className="key-row-meta">
                      <span className={`status-badge ${key.status}`}>{key.status}</span>
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
              <PanelHeader icon={<Link2 size={16} />} title="외부 승인자 매핑" />
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
          {showCreateUser && (
            <NewUserForm
              groups={activeGroups}
              defaultGroupId={currentGroupId}
              canAssignManager={currentUser.role === 'admin'}
              disabled={saving || activeGroups.length === 0}
              onClose={() => setShowCreateUser(false)}
              onSave={(payload) => run(() => authzApi.createUser(payload))}
            />
          )}
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

function PanelHeader({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="access-panel-header">
      <span>{icon}</span>
      <h3>{title}</h3>
    </div>
  );
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

function GroupForm({ disabled, onSave }: { disabled?: boolean; onSave: (payload: { id?: string; name: string; description?: string }) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  return (
    <form
      className="access-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return;
        onSave({ name: name.trim(), description: description.trim() });
        setName('');
        setDescription('');
      }}
    >
      <input value={name} onChange={(event) => setName(event.target.value)} placeholder="그룹 이름" />
      <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="설명" />
      <Button type="submit" variant="primary" size="sm" icon={<Save size={14} />} disabled={disabled || !name.trim()}>
        저장
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
    <section className="member-management-card">
      <div className="member-management-title">
        <Search size={15} />
        <div><strong>기존 사용자 추가</strong><small>ID, 이름 또는 이메일로 사용자를 찾습니다.</small></div>
      </div>
      <div className="member-search-controls">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="사용자 검색" disabled={disabled} />
        <select value={role} onChange={(event) => setRole(event.target.value as PxmGroupRole)} disabled={disabled}>
          <option value="user">일반 사용자</option>
          {canAssignManager && <option value="group_manager">그룹 관리자</option>}
        </select>
      </div>
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
    <section className="member-management-card new-user-card">
      <div className="new-user-form-header">
        <span><UserPlus size={16} /></span>
        <div><strong>새 사용자 정보</strong><small>계정을 생성하고 첫 소속 그룹을 지정합니다.</small></div>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={onClose}>취소</Button>
      </div>
      <form className="access-form user-create-form" onSubmit={async (event) => {
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
        <select value={groupId} onChange={(event) => setSelectedGroupId(event.target.value)} disabled={disabled} aria-label="초기 소속 그룹">
          {groups.map((group) => <option key={group.id} value={group.id}>초기 소속 · {group.name}</option>)}
        </select>
        <input value={id} onChange={(event) => setId(event.target.value)} placeholder="사용자 ID (선택)" disabled={disabled} />
        <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="사용자 이름" disabled={disabled} />
        <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="이메일" disabled={disabled} />
        <input type="password" minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="초기 비밀번호 (12자 이상)" disabled={disabled} />
        <select value={role} onChange={(event) => setRole(event.target.value as PxmGroupRole)} disabled={disabled}>
          <option value="user">일반 사용자</option>
          {canAssignManager && <option value="group_manager">그룹 관리자</option>}
        </select>
        <Button type="submit" variant="primary" size="sm" disabled={disabled || !displayName.trim()}>사용자 생성</Button>
      </form>
    </section>
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
  onSave: (payload: { id?: string; name: string; group_id: string; description?: string }) => void;
}) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  return (
    <form className="access-form compact" onSubmit={(event) => {
      event.preventDefault();
      if (!name.trim() || !groupId) return;
      onSave({ id: id.trim() || undefined, name: name.trim(), group_id: groupId, description: description.trim() });
      setId('');
      setName('');
      setDescription('');
    }}>
      <input value={id} onChange={(event) => setId(event.target.value)} placeholder="서비스 계정 ID" />
      <input value={name} onChange={(event) => setName(event.target.value)} placeholder="이름" />
      <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="설명" />
      <Button type="submit" variant="primary" size="sm" disabled={disabled || !name.trim()}>저장</Button>
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
  }) => void;
}) {
  const [name, setName] = useState('');
  const [ownerType, setOwnerType] = useState<ApiKeyOwnerType>('SERVICE_ACCOUNT');
  const [ownerId, setOwnerId] = useState('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['workflow:execute']);
  const [workflowAccess, setWorkflowAccess] = useState<ApiKeyWorkflowAccess>('all_in_group');
  const [workflowIds, setWorkflowIds] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState('');
  const [ipAllowlist, setIpAllowlist] = useState('');
  const [rateLimit, setRateLimit] = useState('');
  const owners = ownerType === 'USER' ? users : serviceAccounts;

  useEffect(() => {
    setOwnerId(owners[0]?.id || '');
  }, [ownerType, groupId, owners.length]);

  useEffect(() => {
    setWorkflowIds(workflows.map((workflow) => workflow.id));
  }, [groupId, workflows]);

  return (
    <form className="access-form key-form" onSubmit={(event) => {
      event.preventDefault();
      if (!name.trim() || !ownerId || !groupId) return;
      onSave({
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
      setName('');
      setWorkflowIds(workflows.map((workflow) => workflow.id));
      setExpiresAt('');
      setIpAllowlist('');
      setRateLimit('');
    }}>
      <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Key 이름" />
      <select value={ownerType} onChange={(event) => setOwnerType(event.target.value as ApiKeyOwnerType)}>
        <option value="SERVICE_ACCOUNT">서비스 계정</option>
        <option value="USER">사용자</option>
      </select>
      <select value={ownerId} onChange={(event) => setOwnerId(event.target.value)}>
        {owners.map((owner) => (
          <option key={owner.id} value={owner.id}>
            {'display_name' in owner ? owner.display_name : owner.name}
          </option>
        ))}
      </select>
      <div className="scope-box">
        {scopeOptions.map((scope) => (
          <label key={scope}>
            <input
              type="checkbox"
              checked={scopes.includes(scope)}
              onChange={(event) => {
                setScopes((current) =>
                  event.target.checked ? Array.from(new Set([...current, scope])) : current.filter((item) => item !== scope),
                );
              }}
            />
            {scopeLabels[scope]}
          </label>
        ))}
      </div>
      <select value={workflowAccess} onChange={(event) => setWorkflowAccess(event.target.value as ApiKeyWorkflowAccess)}>
        <option value="all_in_group">그룹 전체 워크플로우 (향후 추가 포함)</option>
        <option value="allowlist">선택한 워크플로우만</option>
      </select>
      <div className="scope-box workflow-scope-box">
        <strong>허용 워크플로우</strong>
        {workflowAccess === 'all_in_group' ? (
          <small>이 그룹에 나중에 추가되는 워크플로우도 자동으로 허용됩니다.</small>
        ) : workflows.length === 0 ? (
          <small>현재 그룹에 활성 워크플로우가 없습니다.</small>
        ) : workflows.map((workflow) => (
          <label key={workflow.id}>
            <input
              type="checkbox"
              checked={workflowIds.includes(workflow.id)}
              onChange={(event) => setWorkflowIds((current) =>
                event.target.checked
                  ? Array.from(new Set([...current, workflow.id]))
                  : current.filter((id) => id !== workflow.id),
              )}
            />
            {workflow.name}
          </label>
        ))}
      </div>
      <input type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
      <input value={ipAllowlist} onChange={(event) => setIpAllowlist(event.target.value)} placeholder="허용 IP/CIDR, 쉼표 구분 (선택)" />
      <input type="number" min="1" max="100000" value={rateLimit} onChange={(event) => setRateLimit(event.target.value)} placeholder="분당 요청 제한 (선택)" />
      <Button type="submit" variant="primary" size="sm" disabled={disabled || !name.trim() || !ownerId || scopes.length === 0}>
        발급
      </Button>
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
  };

  return (
    <>
      <form className="access-form mapping-form" onSubmit={async (event) => {
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
        <input
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
          placeholder="provider (예: acrapoint)"
          disabled={Boolean(editingId)}
        />
        <input
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          placeholder="외부 사용자 subject"
          disabled={Boolean(editingId)}
        />
        <select value={userId} onChange={(event) => setUserId(event.target.value)}>
          <option value="">PXM 사용자 선택</option>
          {activeUsers.map((user) => (
            <option key={user.id} value={user.id}>{user.display_name} ({user.id})</option>
          ))}
        </select>
        <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="표시 이름 (선택)" />
        <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="전달 이메일 (선택)" />
        <input value={department} onChange={(event) => setDepartment(event.target.value)} placeholder="부서 (선택)" />
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
          {editingId && <Button type="button" variant="ghost" size="sm" onClick={reset}>취소</Button>}
        </div>
      </form>

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
