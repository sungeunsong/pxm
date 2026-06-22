import React, { useEffect, useMemo, useState } from 'react';
import { KeyRound, Plus, RotateCw, ShieldCheck, Trash2 } from 'lucide-react';
import { Button, Input, Select, Checkbox } from '../components';
import {
  credentialsApi,
  type CredentialAuditLog,
  type CredentialProfile,
  type CredentialType,
} from '../api/credentials';
import './CredentialsPage.css';

type CredentialFormState = {
  id?: string;
  name: string;
  type: CredentialType;
  description: string;
  scopesText: string;
  secretValue: string;
  metadataText: string;
  active: boolean;
};

const emptyForm: CredentialFormState = {
  name: '',
  type: 'api_key',
  description: '',
  scopesText: '',
  secretValue: '',
  metadataText: '{}',
  active: true,
};

export const CredentialsPage: React.FC = () => {
  const [credentials, setCredentials] = useState<CredentialProfile[]>([]);
  const [auditLogs, setAuditLogs] = useState<CredentialAuditLog[]>([]);
  const [form, setForm] = useState<CredentialFormState>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setForm(emptyForm);
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
        setForm(emptyForm);
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
          <p>외부 API, DB, 토큰 값을 프로필로 관리하고 워크플로우 노드에서는 ID만 참조합니다.</p>
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
              onClick={() => setForm(emptyForm)}
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
                      {credential.type} · {credential.scopes.length ? credential.scopes.join(', ') : 'scope 없음'}
                    </span>
                  </button>
                  <span className={`credential-status ${credential.active ? 'active' : 'inactive'}`}>
                    {credential.active ? 'active' : 'inactive'}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 size={14} />}
                    onClick={() => void handleDeactivate(credential)}
                    disabled={!credential.active}
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
          <form className="credential-form" onSubmit={(event) => void handleSubmit(event)}>
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
              <Button variant="secondary" onClick={() => setForm(emptyForm)}>
                취소
              </Button>
            </div>
          </form>
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

function buildCredentialPayload(form: CredentialFormState) {
  const payload = {
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
  return payload;
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
