import { useEffect, useMemo, useState } from 'react';
import { Braces, Check, Copy, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { templatesApi, type WorkflowTemplate } from '../api/templates';
import { authzApi, type PxmGroup } from '../api/authz';
import type { SessionUser } from '../api/session';
import { Button } from '../components';
import {
  createInputPreset,
  deleteInputPreset,
  listAllInputPresets,
  type InputPreset,
  updateInputPreset,
} from '../input-presets';
import './ExecutionPresetsPage.css';

type Props = { currentUser: SessionUser };
type Draft = {
  id?: string;
  workflow_id: string;
  name: string;
  alias: string;
  description: string;
  scope: InputPreset['scope'];
  shared_group_ids: string[];
  valuesText: string;
  can_manage: boolean;
  was_shared?: boolean;
};

type PresetInputField = {
  id: string;
  type: string;
  required: boolean;
  defaultValue?: unknown;
  options?: string[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
};

export function ExecutionPresetsPage({ currentUser }: Props) {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [presets, setPresets] = useState<InputPreset[]>([]);
  const [groups, setGroups] = useState<PxmGroup[]>([]);
  const [query, setQuery] = useState('');
  const [workflowFilter, setWorkflowFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aliasTouched, setAliasTouched] = useState(false);
  const [copied, setCopied] = useState<'alias' | 'workflow' | 'api' | null>(null);

  const manageableGroupIds = useMemo(() => new Set(
    currentUser.role === 'admin'
      ? groups.map((group) => group.id)
      : currentUser.group_ids,
  ), [currentUser, groups]);

  const manageableTemplates = useMemo(() => templates.filter((template) =>
    currentUser.role === 'admin' || (!!template.group_id && manageableGroupIds.has(template.group_id))),
  [currentUser.role, manageableGroupIds, templates]);

  const load = async () => {
    setLoading(true);
    try {
      const [templateItems, presetItems, groupItems] = await Promise.all([
        templatesApi.list(),
        listAllInputPresets(),
        authzApi.listGroups(false),
      ]);
      setTemplates(templateItems);
      setPresets(presetItems);
      setGroups(groupItems.filter((group) => group.status === 'active'));
    } catch (err) {
      setError(err instanceof Error ? err.message : '실행 프리셋을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    const hashQuery = window.location.hash.split('?')[1];
    const workflowId = hashQuery ? new URLSearchParams(hashQuery).get('workflow') : null;
    if (workflowId) setWorkflowFilter(workflowId);
  }, []);

  const filteredPresets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return presets.filter((preset) => {
      if (workflowFilter !== 'all' && preset.workflow_id !== workflowFilter) return false;
      if (!normalized) return true;
      return [preset.name, preset.alias, preset.description, preset.workflow_name, preset.workflow_group_name]
        .some((value) => String(value || '').toLowerCase().includes(normalized));
    });
  }, [presets, query, workflowFilter]);

  const selectedTemplate = templates.find((template) => template.id === draft?.workflow_id) || null;
  const inputFields = selectedTemplate ? getStartInputFields(selectedTemplate) : [];
  const inputValidation = useMemo(
    () => draft ? validatePresetInput(draft.valuesText, inputFields) : { values: null, errors: [] },
    [draft?.valuesText, inputFields],
  );

  const copy = async (kind: 'alias' | 'workflow' | 'api', value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(kind);
    window.setTimeout(() => setCopied((current) => current === kind ? null : current), 1600);
  };

  const beginCreate = () => {
    const preferred = manageableTemplates.find((template) => template.id === workflowFilter) || manageableTemplates[0];
    if (!preferred) {
      setError('프리셋을 생성할 수 있는 워크플로우가 없습니다.');
      return;
    }
    setDraft(createDraft(preferred));
    setAliasTouched(false);
    setError(null);
  };

  const beginEdit = (preset: InputPreset) => {
    setDraft({
      id: preset.id,
      workflow_id: preset.workflow_id,
      name: preset.name,
      alias: preset.alias,
      description: preset.description || '',
      scope: preset.scope === 'shared' ? 'group' : preset.scope,
      shared_group_ids: [],
      valuesText: JSON.stringify(preset.values || {}, null, 2),
      can_manage: preset.can_manage,
      was_shared: preset.scope === 'shared',
    });
    setAliasTouched(true);
    setError(null);
  };

  const changeWorkflow = (workflowId: string) => {
    const template = manageableTemplates.find((item) => item.id === workflowId);
    if (!template || draft?.id) return;
    setDraft(createDraft(template));
    setAliasTouched(false);
  };

  const save = async () => {
    if (!draft?.can_manage) return;
    setSaving(true);
    setError(null);
    try {
      if (!inputValidation.values || inputValidation.errors.length > 0) return;
      const values = inputValidation.values;
      if (draft.id) {
        await updateInputPreset(draft.workflow_id, { ...draft, id: draft.id, values });
      } else {
        await createInputPreset(draft.workflow_id, { ...draft, values });
      }
      setDraft(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '실행 프리셋 저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!draft?.id || !draft.can_manage || !confirm(`실행 프리셋 “${draft.name}”을 삭제할까요?`)) return;
    setSaving(true);
    try {
      await deleteInputPreset(draft.workflow_id, draft.id);
      setDraft(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '실행 프리셋 삭제에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="execution-presets-page">
      <section className="execution-presets-hero">
        <div>
          <div className="execution-presets-title"><Braces size={21} /><h2>API 실행 프리셋</h2></div>
          <p>워크플로우별 Start 입력값을 alias로 저장하고 API 호출에서 재사용합니다.</p>
        </div>
        <div className="execution-presets-hero-actions">
          <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={() => void load()} disabled={loading}>새로고침</Button>
          <Button icon={<Plus size={15} />} onClick={beginCreate}>새 프리셋</Button>
        </div>
      </section>

      <section className="execution-presets-content">
        <div className="execution-presets-toolbar">
          <label className="execution-presets-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="이름, alias, 워크플로우 검색" /></label>
          <select value={workflowFilter} onChange={(event) => setWorkflowFilter(event.target.value)}>
            <option value="all">모든 워크플로우</option>
            {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
          </select>
          <div className="execution-presets-count"><strong>{filteredPresets.length}</strong><span>개 프리셋</span><i /> <strong>{new Set(filteredPresets.map((preset) => preset.workflow_id)).size}</strong><span>개 워크플로우</span></div>
        </div>
        {error && !draft && <div className="execution-presets-error">{error}</div>}
        <div className="execution-presets-table-wrap">
          <table className="execution-presets-table">
            <thead><tr><th>프리셋</th><th>워크플로우</th><th>사용 범위</th><th>입력 키</th><th>수정일</th><th /></tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={6} className="execution-presets-empty">불러오는 중입니다.</td></tr> : filteredPresets.length === 0 ? <tr><td colSpan={6} className="execution-presets-empty">조건에 맞는 실행 프리셋이 없습니다.</td></tr> : filteredPresets.map((preset) => (
                <tr key={preset.id} onClick={() => beginEdit(preset)}>
                  <td><strong>{preset.name}</strong><code>{preset.alias}</code></td>
                  <td><strong>{preset.workflow_name || preset.workflow_id}</strong><small>v{preset.workflow_version || '-'} · {preset.workflow_group_name || '그룹 미지정'}</small></td>
                  <td><span className={`preset-scope-badge ${preset.scope}`}>{scopeLabel(preset.scope)}</span>{!preset.can_manage && <small>사용 전용</small>}</td>
                  <td>{Object.keys(preset.values || {}).slice(0, 3).map((key) => <code key={key}>{key}</code>)}{Object.keys(preset.values || {}).length > 3 && <small>+{Object.keys(preset.values).length - 3}</small>}</td>
                  <td>{formatDate(preset.updated_at || preset.updatedAt)}</td>
                  <td><button type="button">상세</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {draft && (
        <div className="execution-preset-editor-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setDraft(null)}>
          <section className="execution-preset-editor" role="dialog" aria-modal="true" aria-label="API 실행 프리셋 편집">
            <header><div><Braces size={18} /><strong>{draft.id ? '실행 프리셋 상세' : '새 실행 프리셋'}</strong></div><button type="button" onClick={() => setDraft(null)}><X size={18} /></button></header>
            <div className="execution-preset-editor-body">
              {!draft.can_manage && <div className="execution-presets-notice">사용 전용 프리셋입니다. API 실행에는 사용할 수 있지만 수정하거나 삭제할 수 없습니다.</div>}
              {draft.was_shared && <div className="execution-presets-warning">기존 지정 그룹 공유는 현재 워크플로우 실행 권한을 늘리지 않아 실효성이 없습니다. 저장하면 소유 그룹 범위로 정리됩니다.</div>}
              {error && <div className="execution-presets-error">{error}</div>}

              {draft.id ? (
                <div className="execution-preset-workflow-card">
                  <div><span>대상 워크플로우</span><strong>{selectedTemplate?.name || draft.workflow_id}</strong><small>v{selectedTemplate?.version || '-'} · {selectedTemplate?.group || '그룹 미지정'}</small></div>
                  <button type="button" onClick={() => void copy('workflow', draft.workflow_id)}>{copied === 'workflow' ? <Check size={14} /> : <Copy size={14} />}{copied === 'workflow' ? '복사됨' : 'ID 복사'}</button>
                </div>
              ) : (
                <label>대상 워크플로우<select value={draft.workflow_id} disabled={!draft.can_manage} onChange={(event) => changeWorkflow(event.target.value)}>{manageableTemplates.map((template) => <option key={template.id} value={template.id}>{template.name} · {template.group || '그룹 미지정'}</option>)}</select></label>
              )}

              <div className="execution-preset-field-grid">
                <label>이름<input value={draft.name} disabled={!draft.can_manage} onChange={(event) => { const name = event.target.value; setDraft({ ...draft, name, alias: !draft.id && !aliasTouched ? normalizeAlias(name) : draft.alias }); }} placeholder="운영 주문 실행" /></label>
                <label>API alias<div className="execution-preset-copy-field"><input value={draft.alias} disabled={!draft.can_manage || !!draft.id} onChange={(event) => { setAliasTouched(true); setDraft({ ...draft, alias: normalizeAlias(event.target.value) }); }} placeholder="production-order" />{draft.alias && <button type="button" onClick={() => void copy('alias', draft.alias)}>{copied === 'alias' ? <Check size={14} /> : <Copy size={14} />}</button>}</div><small>{draft.id ? 'API 호환성을 위해 생성 후에는 변경하지 않습니다.' : 'API 요청의 preset 값으로 사용합니다.'}</small></label>
              </div>
              <label>설명<input value={draft.description} disabled={!draft.can_manage} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="이 프리셋을 언제 사용하는지 적어주세요." /></label>

              <details className="execution-preset-api-sample">
                <summary><strong>curl 호출 예시</strong><button type="button" onClick={(event) => { event.preventDefault(); void copy('api', apiExample(draft)); }}>{copied === 'api' ? <Check size={13} /> : <Copy size={13} />}{copied === 'api' ? '복사됨' : '복사'}</button></summary>
                <pre>{apiExample(draft)}</pre>
              </details>

              <fieldset className="execution-preset-scope" disabled={!draft.can_manage}>
                <legend>사용 범위</legend>
                <label className={draft.scope === 'group' ? 'selected' : ''}><input type="radio" checked={draft.scope === 'group'} onChange={() => setDraft({ ...draft, scope: 'group', shared_group_ids: [] })} /><span><strong>소유 그룹</strong><small>기본값 · 워크플로우 운영 그룹의 API 호출에서 사용합니다.</small></span></label>
                <details open={draft.scope === 'private'}><summary>개인 테스트가 필요한 경우</summary><label className="execution-preset-private-option"><input type="radio" checked={draft.scope === 'private'} onChange={() => setDraft({ ...draft, scope: 'private', shared_group_ids: [] })} /> 개인 테스트용 — 생성자만 사용</label></details>
              </fieldset>

              <div className="execution-preset-schema"><div><strong>Start 입력 스키마</strong><span>{inputFields.length > 0 ? `${inputFields.length}개 필드` : '정의된 입력 필드 없음'}</span></div>{inputFields.length > 0 && <div>{inputFields.map((field) => <code key={field.id}>{field.id}{field.required ? '*' : ''} : {field.type || 'text'}</code>)}</div>}<small>프리셋 값은 이 워크플로우의 Start 입력과 함께 사용됩니다.</small></div>
              <label>입력값 JSON<textarea rows={7} className={inputValidation.errors.length > 0 ? 'invalid' : ''} value={draft.valuesText} disabled={!draft.can_manage} onChange={(event) => setDraft({ ...draft, valuesText: event.target.value })} spellCheck={false} /></label>
              {inputValidation.errors.length > 0 ? <div className="execution-preset-validation"><strong>입력값을 확인하세요.</strong>{inputValidation.errors.map((message) => <span key={message}>{message}</span>)}</div> : <div className="execution-preset-valid"><Check size={14} /> Start 입력 스키마와 일치합니다.</div>}
            </div>
            <footer>{draft.id && draft.can_manage ? <Button variant="ghost" icon={<Trash2 size={14} />} onClick={() => void remove()} disabled={saving}>삭제</Button> : <span />}<div><Button variant="secondary" onClick={() => setDraft(null)}>닫기</Button>{draft.can_manage && <Button onClick={() => void save()} disabled={saving || !draft.name.trim() || !draft.alias.trim() || inputValidation.errors.length > 0}>{saving ? '저장 중...' : '저장'}</Button>}</div></footer>
          </section>
        </div>
      )}
    </div>
  );
}

function createDraft(template: WorkflowTemplate): Draft {
  const fields = getStartInputFields(template);
  const values = Object.fromEntries(fields.filter((field) => field.type !== 'file').map((field) => [field.id, initialFieldValue(field)]));
  return { workflow_id: template.id, name: '', alias: '', description: '', scope: template.group_id ? 'group' : 'private', shared_group_ids: [], valuesText: JSON.stringify(values, null, 2), can_manage: true };
}

function getStartInputFields(template: WorkflowTemplate): PresetInputField[] {
  const start = template.nodes.find((node: any) => node.data?.nodeType === 'start');
  const fields = start?.data?.formSchema?.fields;
  return Array.isArray(fields) ? fields.filter((field) => field?.id || field?.name).map((field) => ({
    id: String(field.id || field.name),
    type: String(field.type || 'text'),
    required: field.required === true,
    defaultValue: field.defaultValue,
    options: Array.isArray(field.options) ? field.options.map(String) : undefined,
    min: field.min,
    max: field.max,
    minLength: field.minLength,
    maxLength: field.maxLength,
    pattern: field.pattern,
  })) : [];
}

function initialFieldValue(field: PresetInputField): unknown {
  if (field.defaultValue !== undefined && field.defaultValue !== '') return field.defaultValue;
  if (field.type === 'number') return Number.isFinite(field.min) ? Number(field.min) : 0;
  if (field.type === 'checkbox') return false;
  if ((field.type === 'select' || field.type === 'radio') && field.options?.length) return field.options[0];
  return '';
}

function validatePresetInput(text: string, fields: PresetInputField[]): { values: Record<string, any> | null; errors: string[] } {
  let values: Record<string, any>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { values: null, errors: ['입력값은 JSON object여야 합니다.'] };
    values = parsed;
  } catch {
    return { values: null, errors: ['JSON 문법이 올바르지 않습니다.'] };
  }

  const errors: string[] = [];
  const sensitive = findSensitivePaths(values);
  if (sensitive.length > 0) errors.push(`민감정보 키는 저장할 수 없습니다: ${sensitive.join(', ')}`);
  if (fields.length === 0) return { values, errors };

  const fieldMap = new Map(fields.map((field) => [field.id, field]));
  Object.keys(values).filter((key) => !fieldMap.has(key)).forEach((key) => errors.push(`Start 입력 스키마에 없는 키입니다: ${key}`));
  fields.forEach((field) => {
    const value = values[field.id];
    if (field.required && (value === undefined || value === null || value === '')) {
      errors.push(`필수 입력값이 비어 있습니다: ${field.id}`);
      return;
    }
    if (value === undefined || value === null || value === '') return;
    if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) errors.push(`${field.id} 값은 number여야 합니다.`);
    else if (field.type === 'checkbox' && typeof value !== 'boolean') errors.push(`${field.id} 값은 boolean이어야 합니다.`);
    else if (['text', 'textarea', 'select', 'radio', 'date'].includes(field.type) && typeof value !== 'string') errors.push(`${field.id} 값은 string이어야 합니다.`);
    else if (field.type === 'file') errors.push(`${field.id} 파일 입력은 프리셋에 저장할 수 없습니다.`);
    if (typeof value === 'number') {
      if (Number.isFinite(field.min) && value < Number(field.min)) errors.push(`${field.id} 값은 ${field.min} 이상이어야 합니다.`);
      if (Number.isFinite(field.max) && value > Number(field.max)) errors.push(`${field.id} 값은 ${field.max} 이하여야 합니다.`);
    }
    if (typeof value === 'string') {
      if (Number.isFinite(field.minLength) && value.length < Number(field.minLength)) errors.push(`${field.id} 값은 ${field.minLength}자 이상이어야 합니다.`);
      if (Number.isFinite(field.maxLength) && value.length > Number(field.maxLength)) errors.push(`${field.id} 값은 ${field.maxLength}자 이하여야 합니다.`);
      if (field.options && ['select', 'radio'].includes(field.type) && !field.options.includes(value)) errors.push(`${field.id} 값이 허용된 옵션이 아닙니다.`);
      if (field.pattern) {
        try { if (!new RegExp(field.pattern).test(value)) errors.push(`${field.id} 값의 형식이 올바르지 않습니다.`); }
        catch { errors.push(`${field.id} 필드의 pattern 설정이 올바르지 않습니다.`); }
      }
    }
  });
  return { values, errors };
}

function findSensitivePaths(value: Record<string, any>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, item]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (/(password|passwd|secret|token|api[_-]?key|credential|private[_-]?key|passphrase)/i.test(key)) return [path];
    if (item && typeof item === 'object' && !Array.isArray(item)) return findSensitivePaths(item, path);
    if (Array.isArray(item)) return item.flatMap((entry, index) => entry && typeof entry === 'object' && !Array.isArray(entry) ? findSensitivePaths(entry, `${path}[${index}]`) : []);
    return [];
  });
}

function normalizeAlias(value: string) { return value.toLowerCase().replace(/[^a-z0-9가-힣_-]+/g, '-').replace(/^-+|-+$/g, ''); }
function scopeLabel(scope: InputPreset['scope']) { return scope === 'private' ? '개인 테스트' : scope === 'group' ? '소유 그룹' : '기존 공유 설정'; }
function formatDate(value?: string) { if (!value) return '-'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '-' : new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date); }
function apiExample(draft: Draft) {
  const body = JSON.stringify({ preset: draft.alias || 'preset-alias', input: {} }, null, 2);
  return `curl -X POST '/api/templates/${draft.workflow_id}/execute' \\\n  -H 'Authorization: Bearer pxm_live_***' \\\n  -H 'Content-Type: application/json' \\\n  --data '${body}'`;
}
