import { useEffect, useState } from 'react';
import { Settings2, Trash2, X } from 'lucide-react';
import { Button } from '../components';
import {
  deleteInputPreset,
  type InputPreset,
  updateInputPreset,
} from '../input-presets';
import './InputPresetManager.css';
import { useFeedback } from '../components/feedback/feedback-context';

type Props = {
  open: boolean;
  workflowId: string;
  presets: InputPreset[];
  onClose: () => void;
  onChanged: () => void;
};

type Draft = InputPreset & { valuesText: string; was_shared?: boolean };

export function InputPresetManager({ open, workflowId, presets, onClose, onChanged }: Props) {
  const { confirm: confirmDialog } = useFeedback();
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const selected = presets.find((preset) => preset.id === selectedId) || presets[0] || null;
    setSelectedId(selected?.id || '');
    setDraft(selected ? toDraft(selected) : null);
    setError(null);
  }, [open, presets, selectedId]);

  if (!open) return null;

  const selectPreset = (preset: InputPreset) => {
    setSelectedId(preset.id);
    setDraft(toDraft(preset));
    setError(null);
  };

  const save = async () => {
    if (!draft?.can_manage) return;
    setSaving(true);
    setError(null);
    try {
      const values = parseValues(draft.valuesText);
      await updateInputPreset(workflowId, { ...draft, values });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preset 저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!draft?.can_manage) return;
    const proceed = await confirmDialog({
      title: '파라미터 세트를 삭제할까요?',
      description: `"${draft.name}"이(가) 제거됩니다. 이 작업은 되돌릴 수 없습니다.`,
      confirmLabel: '삭제',
      tone: 'danger',
    });
    if (!proceed) return;
    setSaving(true);
    setError(null);
    try {
      await deleteInputPreset(workflowId, draft.id);
      setSelectedId('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preset 삭제에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="preset-manager-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="preset-manager" role="dialog" aria-modal="true" aria-label="파라미터 세트 관리">
        <header className="preset-manager-header">
          <div><Settings2 size={18} /><strong>파라미터 세트 관리</strong></div>
          <button type="button" onClick={onClose} aria-label="닫기"><X size={18} /></button>
        </header>
        <div className="preset-manager-body">
          <aside className="preset-manager-list">
            {presets.map((preset) => (
              <button key={preset.id} type="button" className={preset.id === selectedId ? 'selected' : ''} onClick={() => selectPreset(preset)}>
                <span>{preset.name}</span>
                <small>{scopeLabel(preset.scope)} · {preset.can_manage ? '관리 가능' : '사용 전용'}</small>
              </button>
            ))}
            {presets.length === 0 && <p>저장된 파라미터 세트가 없습니다.</p>}
          </aside>
          <main className="preset-manager-detail">
            {!draft ? <div className="preset-manager-empty">관리할 파라미터 세트가 없습니다.</div> : (
              <>
                {!draft.can_manage && <div className="preset-manager-readonly">공유받은 세트입니다. 값 적용만 가능하며 수정하거나 삭제할 수 없습니다.</div>}
                {draft.was_shared && <div className="preset-manager-readonly">기존 지정 그룹 공유는 워크플로우 실행 권한을 늘리지 않습니다. 저장하면 소유 그룹 범위로 정리됩니다.</div>}
                {error && <div className="preset-manager-error">{error}</div>}
                <label>이름<input value={draft.name} disabled={!draft.can_manage} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
                <label>설명<input value={draft.description || ''} disabled={!draft.can_manage} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
                <fieldset disabled={!draft.can_manage}>
                  <legend>공개 범위</legend>
                  {(['group', 'private'] as const).map((scope) => (
                    <label key={scope} className="preset-scope-option">
                      <input
                        type="radio"
                        name="preset-scope"
                        value={scope}
                        checked={draft.scope === scope}
                        disabled={!draft.can_manage}
                        onChange={() => setDraft({ ...draft, scope, shared_group_ids: [] })}
                      />
                      <span><strong>{scopeLabel(scope)}</strong><small>{scopeDescription(scope)}</small></span>
                    </label>
                  ))}
                </fieldset>
                <label>입력값 JSON<textarea value={draft.valuesText} disabled={!draft.can_manage} onChange={(event) => setDraft({ ...draft, valuesText: event.target.value })} spellCheck={false} /></label>
                <div className="preset-manager-meta">소유자 {draft.created_by || '-'} · 최근 수정 {formatDate(draft.updated_at || draft.updatedAt)}</div>
                <footer className="preset-manager-actions">
                  {draft.can_manage && <Button variant="ghost" icon={<Trash2 size={14} />} onClick={() => void remove()} disabled={saving}>삭제</Button>}
                  <span />
                  <Button variant="secondary" onClick={onClose}>닫기</Button>
                  {draft.can_manage && <Button onClick={() => void save()} disabled={saving || !draft.name.trim()}>{saving ? '저장 중...' : '저장'}</Button>}
                </footer>
              </>
            )}
          </main>
        </div>
      </section>
    </div>
  );
}

function toDraft(preset: InputPreset): Draft {
  return { ...preset, scope: preset.scope === 'shared' ? 'group' : preset.scope, shared_group_ids: [], was_shared: preset.scope === 'shared', valuesText: JSON.stringify(preset.values || {}, null, 2) };
}

function parseValues(value: string): Record<string, any> {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('입력값은 JSON object여야 합니다.');
  return parsed;
}

function scopeLabel(scope: InputPreset['scope']) {
  return scope === 'private' ? '개인 테스트' : scope === 'group' ? '소유 그룹' : '기존 공유 설정';
}

function scopeDescription(scope: InputPreset['scope']) {
  return scope === 'private' ? '생성자만 사용할 수 있습니다.' : '워크플로우 소유 그룹에서 사용합니다.';
}

function formatDate(value?: string) {
  return value ? new Date(value).toLocaleString('ko-KR') : '-';
}
