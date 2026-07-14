import React, { useEffect, useMemo, useState } from 'react';
import { KeyRound, Plus, RotateCw, Search, Share2, ShieldCheck, Trash2 } from 'lucide-react';
import { Button, Input, Select, Checkbox } from '../components';
import {
  credentialsApi,
  type CredentialAuditLog,
  type CredentialProfile,
  type CredentialType,
} from '../api/credentials';
import { authzApi, type PxmGroup } from '../api/authz';
import type { SessionUser } from '../api/session';
import './CredentialsPage.css';

type CredentialFormState = {
  id?: string;
  groupId: string;
  sharedGroupIds: string[];
  name: string;
  type: CredentialType;
  description: string;
  scopesText: string;
  secretValue: string;
  metadataText: string;
  active: boolean;
};

const emptyForm: CredentialFormState = {
  groupId: '',
  sharedGroupIds: [],
  name: '',
  type: 'api_key',
  description: '',
  scopesText: '',
  secretValue: '',
  metadataText: '{}',
  active: true,
};

export const CredentialsPage: React.FC<{ currentUser: SessionUser }> = ({ currentUser }) => {
  const [credentials, setCredentials] = useState<CredentialProfile[]>([]);
  const [auditLogs, setAuditLogs] = useState<CredentialAuditLog[]>([]);
  const [form, setForm] = useState<CredentialFormState>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<PxmGroup[]>([]);

  const activeCount = useMemo(
    () => credentials.filter((credential) => credential.active).length,
    [credentials],
  );

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [credentialList, audits] = await Promise.all([
        credentialsApi.list(false),
        credentialsApi.audit(),
      ]);
      setCredentials(credentialList);
      setAuditLogs(audits);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Credential data load failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
    void authzApi.listGroups(false, true).then((items) => {
      const allowed = currentUser.role === 'admin'
        ? items
        : items.filter((group) => currentUser.group_ids.includes(group.id));
      setGroups(allowed);
      if (allowed.length === 1) {
        setForm((current) => current.id || current.groupId ? current : { ...current, groupId: allowed[0].id });
      }
    }).catch((err) => setError(err instanceof Error ? err.message : 'Group data load failed'));
  }, []);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);

    try {
      const payload = buildCredentialPayload(form);
      if (form.id) {
        await credentialsApi.update(form.id, payload);
      } else {
        if (!payload.secret_value) {
          throw new Error('신규 credential은 secret value가 필요합니다.');
        }
        await credentialsApi.create({ ...payload, secret_value: payload.secret_value });
      }
      setForm(newCredentialForm(groups));
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Credential save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (credential: CredentialProfile) => {
    setForm({
      id: credential.id,
      groupId: credential.group_id || '',
      sharedGroupIds: credential.shared_group_ids || [],
      name: credential.name,
      type: credential.type,
      description: credential.description,
      scopesText: credential.scopes.join(', '),
      secretValue: '',
      metadataText: JSON.stringify(credential.metadata || {}, null, 2),
      active: credential.active,
    });
  };

  const handleDeactivate = async (credential: CredentialProfile) => {
    setError(null);
    try {
      await credentialsApi.deactivate(credential.id);
      await loadData();
      if (form.id === credential.id) {
        setForm(newCredentialForm(groups));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Credential deactivate failed');
    }
  };

  return (
    <div className="credentials-page">
      <div className="credentials-header">
        <div>
          <div className="credentials-title">
            <KeyRound size={20} />
            <h2>Credential Store</h2>
          </div>
          <p>Credential은 한 그룹이 소유하며, 다른 관리 그룹에는 Secret 노출 없이 실행 권한만 공유합니다.</p>
        </div>
        <Button variant="secondary" size="sm" icon={<RotateCw size={14} />} onClick={loadData}>
          새로고침
        </Button>
      </div>

      {error && <div className="credentials-error">{error}</div>}

      <div className="credentials-summary-row">
        <div className="credentials-summary-card">
          <span>전체 프로필</span>
          <strong>{credentials.length}</strong>
        </div>
        <div className="credentials-summary-card">
          <span>활성 프로필</span>
          <strong>{activeCount}</strong>
        </div>
        <div className="credentials-summary-card">
          <span>최근 Audit</span>
          <strong>{auditLogs.length}</strong>
        </div>
      </div>

      <div className="credentials-layout">
        <section className="credentials-panel credentials-list-panel">
          <div className="credentials-panel-header">
            <h3>프로필 목록</h3>
            <Button
              variant="ghost"
              size="sm"
              icon={<Plus size={14} />}
              onClick={() => setForm(newCredentialForm(groups))}
            >
              신규
            </Button>
          </div>
          {loading ? (
            <div className="credentials-empty">Credential 정보를 불러오는 중입니다...</div>
          ) : credentials.length === 0 ? (
            <div className="credentials-empty">등록된 credential이 없습니다.</div>
          ) : (
            <div className="credential-table">
              {credentials.map((credential) => (
                <div
                  key={credential.id}
                  className={`credential-row ${form.id === credential.id ? 'selected' : ''}`}
                >
                  <button className="credential-row-main" onClick={() => handleEdit(credential)}>
                    <span className="credential-name">{credential.name}</span>
                    <span className="credential-meta">
                      소유: {groupName(groups, credential.group_id)} · {credential.type} · {credential.scopes.length ? credential.scopes.join(', ') : 'scope 없음'}
                    </span>
                  </button>
                  {credential.access_level === 'shared' && (
                    <span className="credential-access shared"><Share2 size={11} /> 공유됨</span>
                  )}
                  <span className={`credential-status ${credential.active ? 'active' : 'inactive'}`}>
                    {credential.active ? 'active' : 'inactive'}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 size={14} />}
                    onClick={() => void handleDeactivate(credential)}
                    disabled={!credential.active || credential.access_level === 'shared'}
                  />
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="credentials-panel">
          <div className="credentials-panel-header">
            <h3>{form.id ? '프로필 수정' : '프로필 생성'}</h3>
            {form.id && <span className="credential-form-id">{form.id}</span>}
          </div>
          {form.id && credentials.find((credential) => credential.id === form.id)?.access_level === 'shared' ? (
            <SharedCredentialDetail
              credential={credentials.find((credential) => credential.id === form.id)!}
              groups={groups}
              onClose={() => setForm(newCredentialForm(groups))}
            />
          ) : <form className="credential-form" onSubmit={(event) => void handleSubmit(event)}>
            <Select
              label="Group"
              value={form.groupId}
              onChange={(event) => setForm((prev) => ({
                ...prev,
                groupId: event.target.value,
                sharedGroupIds: prev.sharedGroupIds.filter((groupId) => groupId !== event.target.value),
              }))}
              options={[
                { value: '', label: '관리 그룹 선택' },
                ...groups.map((group) => ({ value: group.id, label: group.name })),
              ]}
              required
              fullWidth
            />
            <Input
              label="Name"
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              required
              fullWidth
            />
            <Select
              label="Type"
              value={form.type}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, type: event.target.value as CredentialType }))
              }
              options={[
                { value: 'api_key', label: 'API Key' },
                { value: 'basic_auth', label: 'Basic Auth' },
                { value: 'bearer_token', label: 'Bearer Token' },
                { value: 'connection_string', label: 'Connection String' },
                { value: 'custom', label: 'Custom' },
              ]}
              fullWidth
            />
            <Input
              label="Description"
              value={form.description}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, description: event.target.value }))
              }
              fullWidth
            />
            <Input
              label="Scopes"
              placeholder="http, crm, production"
              value={form.scopesText}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, scopesText: event.target.value }))
              }
              helperText="쉼표로 구분합니다."
              fullWidth
            />
            <ScopeSuggestions
              type={form.type}
              scopesText={form.scopesText}
              onChange={(scopesText) => setForm((prev) => ({ ...prev, scopesText }))}
            />
            <CredentialSharePicker
              groups={groups}
              ownerGroupId={form.groupId}
              selectedGroupIds={form.sharedGroupIds}
              onChange={(sharedGroupIds) => setForm((prev) => ({ ...prev, sharedGroupIds }))}
            />
            <Input
              label={form.id ? 'Secret Value 변경' : 'Secret Value'}
              type="password"
              value={form.secretValue}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, secretValue: event.target.value }))
              }
              helperText={form.id ? '비워두면 기존 secret을 유지합니다.' : '저장 후에는 화면/API에서 다시 노출하지 않습니다.'}
              required={!form.id}
              fullWidth
            />
            <div className="credential-form-group">
              <label>Metadata JSON</label>
              <textarea
                value={form.metadataText}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, metadataText: event.target.value }))
                }
                spellCheck={false}
              />
            </div>
            <Checkbox
              label="Active"
              checked={form.active}
              onChange={(event) => setForm((prev) => ({ ...prev, active: event.target.checked }))}
            />
            <div className="credential-form-actions">
              <Button type="submit" disabled={saving} icon={<ShieldCheck size={14} />}>
                {saving ? '저장 중...' : '저장'}
              </Button>
              <Button variant="secondary" onClick={() => setForm(newCredentialForm(groups))}>
                취소
              </Button>
            </div>
          </form>}
        </section>
      </div>

      <section className="credentials-panel credentials-audit-panel">
        <div className="credentials-panel-header">
          <h3>Audit Log</h3>
        </div>
        <div className="credential-audit-list">
          {auditLogs.length === 0 ? (
            <div className="credentials-empty">audit log가 없습니다.</div>
          ) : (
            auditLogs.slice(0, 12).map((log) => (
              <div key={log.id} className="credential-audit-row">
                <span className="credential-audit-action">{log.action}</span>
                <span>{log.credential_id}</span>
                <span>{log.actor}</span>
                <time>{formatDateTime(log.created_at)}</time>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
};

function SharedCredentialDetail({
  credential,
  groups,
  onClose,
}: {
  credential: CredentialProfile;
  groups: PxmGroup[];
  onClose: () => void;
}) {
  return (
    <div className="shared-credential-detail">
      <div className="shared-credential-notice">
        <Share2 size={18} />
        <div>
          <strong>다른 그룹에서 공유한 Credential입니다.</strong>
          <p>워크플로우에서 사용할 수 있지만 설정·Secret·공유 범위·활성 상태는 변경할 수 없습니다.</p>
        </div>
      </div>
      <dl>
        <div><dt>이름</dt><dd>{credential.name}</dd></div>
        <div><dt>소유 그룹</dt><dd>{groupName(groups, credential.group_id)}</dd></div>
        <div><dt>유형</dt><dd>{credential.type}</dd></div>
        <div><dt>설명</dt><dd>{credential.description || '-'}</dd></div>
        <div><dt>Scope</dt><dd>{credential.scopes.join(', ') || '-'}</dd></div>
        <div><dt>상태</dt><dd>{credential.active ? 'active' : 'inactive'}</dd></div>
      </dl>
      <div className="credential-form-actions">
        <Button variant="secondary" onClick={onClose}>닫기</Button>
      </div>
    </div>
  );
}

function CredentialSharePicker({
  groups,
  ownerGroupId,
  selectedGroupIds,
  onChange,
}: {
  groups: PxmGroup[];
  ownerGroupId: string;
  selectedGroupIds: string[];
  onChange: (groupIds: string[]) => void;
}) {
  const [search, setSearch] = useState('');
  const availableGroups = useMemo(
    () => groups.filter((group) => group.id !== ownerGroupId),
    [groups, ownerGroupId],
  );
  const normalizedSearch = search.trim().toLowerCase();
  const visibleGroups = useMemo(() => availableGroups
    .filter((group) => !normalizedSearch
      || group.name.toLowerCase().includes(normalizedSearch)
      || group.id.toLowerCase().includes(normalizedSearch))
    .sort((left, right) => {
      const selectedOrder = Number(selectedGroupIds.includes(right.id)) - Number(selectedGroupIds.includes(left.id));
      return selectedOrder || left.name.localeCompare(right.name);
    }), [availableGroups, normalizedSearch, selectedGroupIds]);

  const toggleGroup = (groupId: string, checked: boolean) => {
    onChange(checked
      ? Array.from(new Set([...selectedGroupIds, groupId]))
      : selectedGroupIds.filter((id) => id !== groupId));
  };

  return (
    <div className="credential-form-group credential-share-group">
      <div className="credential-share-heading">
        <label>공유 그룹</label>
        <span>{selectedGroupIds.length}개 선택</span>
      </div>
      <p>공유 그룹은 Secret을 볼 수 없으며 워크플로우 실행에만 사용할 수 있습니다.</p>
      {availableGroups.length > 0 ? (
        <div className="credential-share-picker">
          <div className="credential-share-search">
            <Search size={14} />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="그룹 이름 또는 ID 검색"
              aria-label="공유 그룹 검색"
            />
          </div>
          <div className="credential-share-list">
            {visibleGroups.map((group) => {
              const checked = selectedGroupIds.includes(group.id);
              return (
                <label key={group.id} className={`credential-share-option ${checked ? 'selected' : ''}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => toggleGroup(group.id, event.target.checked)}
                  />
                  <span className="credential-share-check" aria-hidden="true">{checked ? '✓' : ''}</span>
                  <span className="credential-share-label">
                    <strong>{group.name}</strong>
                    <small>{group.id}</small>
                  </span>
                </label>
              );
            })}
            {visibleGroups.length === 0 && (
              <div className="credential-share-empty">검색 결과가 없습니다.</div>
            )}
          </div>
        </div>
      ) : (
        <div className="credential-share-empty standalone">공유할 수 있는 다른 관리 그룹이 없습니다.</div>
      )}
    </div>
  );
}

function buildCredentialPayload(form: CredentialFormState) {
  const payload = {
    group_id: form.groupId,
    shared_group_ids: form.sharedGroupIds,
    name: form.name.trim(),
    type: form.type,
    description: form.description.trim(),
    scopes: form.scopesText
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean),
    metadata: parseMetadata(form.metadataText),
    active: form.active,
    ...(form.secretValue ? { secret_value: form.secretValue } : {}),
  };
  if (!payload.name) {
    throw new Error('name이 필요합니다.');
  }
  if (!payload.group_id) {
    throw new Error('관리 group을 선택해야 합니다.');
  }
  return payload;
}

function newCredentialForm(groups: PxmGroup[]): CredentialFormState {
  return { ...emptyForm, groupId: groups.length === 1 ? groups[0].id : '' };
}

function groupName(groups: PxmGroup[], groupId: string | null) {
  if (!groupId) return 'Legacy / group 미지정';
  return groups.find((group) => group.id === groupId)?.name || groupId;
}

function ScopeSuggestions({
  type,
  scopesText,
  onChange,
}: {
  type: CredentialType;
  scopesText: string;
  onChange: (scopesText: string) => void;
}) {
  const suggestions = getScopeSuggestions(type);
  if (suggestions.length === 0) return null;

  const current = scopesText
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  const normalizedCurrent = new Set(current.map(normalizeScope));

  return (
    <div className="scope-suggestions">
      <div className="scope-suggestions-label">추천 scope</div>
      <div className="scope-suggestion-list">
        {suggestions.map((scope) => {
          const selected = normalizedCurrent.has(normalizeScope(scope));
          return (
            <button
              key={scope}
              type="button"
              className={`scope-suggestion-chip ${selected ? 'selected' : ''}`}
              onClick={() => {
                if (selected) return;
                onChange([...current, scope].join(', '));
              }}
            >
              {scope}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function getScopeSuggestions(type: CredentialType) {
  if (type === 'connection_string') {
    return ['mongo', 'mongodb', 'db', 'database', 'local', 'production'];
  }
  if (type === 'api_key' || type === 'bearer_token' || type === 'basic_auth') {
    return ['http', 'api', 'webhook', 'crm', 'production'];
  }
  return ['custom', 'local', 'production'];
}

function normalizeScope(scope: string) {
  return scope.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function parseMetadata(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('metadata는 JSON object여야 합니다.');
  }
  return parsed as Record<string, unknown>;
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString();
}
