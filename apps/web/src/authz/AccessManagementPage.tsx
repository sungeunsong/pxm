import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { KeyRound, Link2, RefreshCw, RotateCcw, Save, Shield, Trash2, UserRound, UsersRound } from 'lucide-react';
import { Button } from '../components';
import {
  authzApi,
  type ApiKeyOwnerType,
  type ApiKeyScope,
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
const roleLabels: Record<PxmRole, string> = {
  admin: '최고 관리자',
  group_manager: '그룹 관리자',
  user: '일반 사용자',
};
type AccessDetailTab = 'users' | 'serviceAccounts' | 'apiKeys' | 'externalMappings';

export function AccessManagementPage({ currentUser }: { currentUser: SessionUser }) {
  const [groups, setGroups] = useState<PxmGroup[]>([]);
  const [users, setUsers] = useState<PxmUser[]>([]);
  const [serviceAccounts, setServiceAccounts] = useState<PxmServiceAccount[]>([]);
  const [apiKeys, setApiKeys] = useState<PxmApiKey[]>([]);
  const [externalMappings, setExternalMappings] = useState<ExternalPrincipalMapping[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowTemplate[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);
  const [activeTab, setActiveTab] = useState<AccessDetailTab>('users');

  const activeGroups = groups.filter((group) => group.status !== 'deleted');
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) || activeGroups[0] || null;
  const selectedGroupFilterId = selectedGroup?.id || '';
  const currentGroupId = selectedGroup?.status === 'active' ? selectedGroup.id : '';

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
      const [nextUsers, nextAccounts, nextKeys, nextMappings] = targetGroupId
        ? await Promise.all([
            authzApi.listUsers(targetGroupId),
            authzApi.listServiceAccounts(targetGroupId),
            authzApi.listApiKeys(targetGroupId),
            authzApi.listExternalPrincipalMappings(targetGroupId),
          ])
        : [[], [], [], []];
      setGroups(nextGroups);
      setUsers(nextUsers);
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
          <div className="access-title">
            <Shield size={20} />
            <h2>접근 권한 관리</h2>
          </div>
          <p>그룹, 실행 주체, API key scope를 한 곳에서 관리합니다.</p>
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

      <div className="access-summary">
        <SummaryCard label="활성 그룹" value={activeGroups.length} />
        <SummaryCard label="선택 그룹 사용자" value={users.length} />
        <SummaryCard label="선택 그룹 서비스 계정" value={serviceAccounts.length} />
        <SummaryCard label="선택 그룹 API Key" value={apiKeys.length} />
        <SummaryCard label="외부 승인자 매핑" value={externalMappings.length} />
      </div>

      <div className="access-layout">
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
                    : '이 탭은 현재 선택된 그룹의 멤버만 보여줍니다. 역할이 그룹 관리자이면 이 그룹만 관리할 수 있습니다.'
                }
              />
              <UserForm
                groupId={currentGroupId}
                canAssignManager={currentUser.role === 'admin'}
                disabled={saving || !currentGroupId}
                onSave={(payload) => run(() => authzApi.saveUser(payload))}
              />
              <EntityTable
                rows={groupUsers.map((user) => ({
                  id: user.id,
                  primary: user.display_name,
                  secondary: user.email || undefined,
                  meta:
                    membershipRole(user, selectedGroupFilterId) === 'group_manager'
                      ? `${selectedGroup?.name || '현재 그룹'} 관리 가능`
                      : `${selectedGroup?.name || '현재 그룹'} 멤버`,
                  badge: roleLabels[membershipRole(user, selectedGroupFilterId)] || membershipRole(user, selectedGroupFilterId),
                  status: user.status,
                }))}
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
      </div>
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

function UserForm({
  groupId,
  canAssignManager,
  disabled,
  onSave,
}: {
  groupId: string;
  canAssignManager: boolean;
  disabled?: boolean;
  onSave: (payload: { id?: string; display_name: string; email?: string; role: PxmRole; group_ids: string[]; memberships: Array<{ group_id: string; role: PxmGroupRole }>; password?: string }) => void;
}) {
  const [id, setId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<PxmRole>('user');
  const [password, setPassword] = useState('');
  return (
    <form className="access-form compact" onSubmit={(event) => {
      event.preventDefault();
      if (!displayName.trim() || !groupId) return;
      onSave({
        id: id.trim() || undefined,
        display_name: displayName.trim(),
        email: email.trim(),
        role,
        group_ids: [groupId],
        memberships: [{ group_id: groupId, role: role === 'group_manager' ? 'group_manager' : 'user' }],
        password: password || undefined,
      });
      setId('');
      setDisplayName('');
      setEmail('');
      setRole('user');
      setPassword('');
    }}>
      <input value={id} onChange={(event) => setId(event.target.value)} placeholder="사용자 ID" />
      <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="멤버 이름" />
      <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="이메일" />
      <input type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="초기 비밀번호 (8자 이상)" />
      <select value={role} onChange={(event) => setRole(event.target.value as PxmRole)}>
        <option value="user">일반 사용자</option>
        {canAssignManager && <option value="group_manager">그룹 관리자</option>}
        {canAssignManager && <option value="admin">최고 관리자</option>}
      </select>
      <Button type="submit" variant="primary" size="sm" disabled={disabled || !displayName.trim()}>멤버 추가</Button>
    </form>
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
        allowed_workflow_ids: workflowIds,
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
      <div className="scope-box workflow-scope-box">
        <strong>허용 워크플로우</strong>
        {workflows.length === 0 ? (
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
