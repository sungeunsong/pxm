import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { KeyRound, RefreshCw, RotateCcw, Save, Shield, Trash2, UserRound, UsersRound } from 'lucide-react';
import { Button } from '../components';
import {
  authzApi,
  type ApiKeyOwnerType,
  type ApiKeyScope,
  type CreatedApiKey,
  type PxmApiKey,
  type PxmGroup,
  type PxmRole,
  type PxmServiceAccount,
  type PxmUser,
} from '../api/authz';
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
type AccessDetailTab = 'users' | 'serviceAccounts' | 'apiKeys';

export function AccessManagementPage() {
  const [groups, setGroups] = useState<PxmGroup[]>([]);
  const [users, setUsers] = useState<PxmUser[]>([]);
  const [serviceAccounts, setServiceAccounts] = useState<PxmServiceAccount[]>([]);
  const [apiKeys, setApiKeys] = useState<PxmApiKey[]>([]);
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

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextGroups, nextUsers, nextAccounts, nextKeys] = await Promise.all([
        authzApi.listGroups(true),
        authzApi.listUsers(),
        authzApi.listServiceAccounts(),
        authzApi.listApiKeys(),
      ]);
      setGroups(nextGroups);
      setUsers(nextUsers);
      setServiceAccounts(nextAccounts);
      setApiKeys(nextKeys);
      const firstActive = nextGroups.find((group) => group.status !== 'deleted');
      setSelectedGroupId((current) =>
        current && nextGroups.some((group) => group.id === current && group.status !== 'deleted')
          ? current
          : firstActive?.id || '',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Access data load failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const run = async (operation: () => Promise<unknown>) => {
    setSaving(true);
    setError(null);
    try {
      await operation();
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operation failed');
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
        <Button variant="secondary" size="sm" icon={<RefreshCw size={14} />} onClick={loadData} disabled={loading}>
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
        <SummaryCard label="전체 등록 사용자" value={users.length} />
        <SummaryCard label="서비스 계정" value={serviceAccounts.length} />
        <SummaryCard label="API Key" value={apiKeys.length} />
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
                onClick={() => setSelectedGroupId(group.id)}
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
                disabled={saving || !currentGroupId}
                onSave={(payload) => run(() => authzApi.saveUser(payload))}
              />
              <EntityTable
                rows={groupUsers.map((user) => ({
                  id: user.id,
                  primary: user.display_name,
                  secondary: user.email || undefined,
                  meta:
                    user.role === 'group_manager'
                      ? `${selectedGroup?.name || '현재 그룹'} 관리 가능`
                      : `${selectedGroup?.name || '현재 그룹'} 멤버`,
                  badge: roleLabels[user.role] || user.role,
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
  disabled,
  onSave,
}: {
  groupId: string;
  disabled?: boolean;
  onSave: (payload: { id?: string; display_name: string; email?: string; role: PxmRole; group_ids: string[] }) => void;
}) {
  const [id, setId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<PxmRole>('user');
  return (
    <form className="access-form compact" onSubmit={(event) => {
      event.preventDefault();
      if (!displayName.trim() || !groupId) return;
      onSave({ id: id.trim() || undefined, display_name: displayName.trim(), email: email.trim(), role, group_ids: [groupId] });
      setId('');
      setDisplayName('');
      setEmail('');
      setRole('user');
    }}>
      <input value={id} onChange={(event) => setId(event.target.value)} placeholder="사용자 ID" />
      <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="멤버 이름" />
      <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="이메일" />
      <select value={role} onChange={(event) => setRole(event.target.value as PxmRole)}>
        <option value="user">일반 사용자</option>
        <option value="group_manager">그룹 관리자</option>
        <option value="admin">최고 관리자</option>
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
  disabled,
  onSave,
}: {
  groupId: string;
  users: PxmUser[];
  serviceAccounts: PxmServiceAccount[];
  disabled?: boolean;
  onSave: (payload: {
    name: string;
    owner_type: ApiKeyOwnerType;
    owner_id: string;
    group_id: string;
    scopes: ApiKeyScope[];
    allowed_workflow_ids: string[];
    expires_at?: string | null;
  }) => void;
}) {
  const [name, setName] = useState('');
  const [ownerType, setOwnerType] = useState<ApiKeyOwnerType>('SERVICE_ACCOUNT');
  const [ownerId, setOwnerId] = useState('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['workflow:execute']);
  const [workflowIds, setWorkflowIds] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const owners = ownerType === 'USER' ? users : serviceAccounts;

  useEffect(() => {
    setOwnerId(owners[0]?.id || '');
  }, [ownerType, groupId, owners.length]);

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
        allowed_workflow_ids: workflowIds.split(',').map((item) => item.trim()).filter(Boolean),
        expires_at: expiresAt || null,
      });
      setName('');
      setWorkflowIds('');
      setExpiresAt('');
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
      <input value={workflowIds} onChange={(event) => setWorkflowIds(event.target.value)} placeholder="허용 워크플로우 ID, 쉼표 구분" />
      <input type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
      <Button type="submit" variant="primary" size="sm" disabled={disabled || !name.trim() || !ownerId || scopes.length === 0}>
        발급
      </Button>
    </form>
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
