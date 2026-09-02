import React, { useEffect, useMemo, useState } from 'react';
import { RotateCw, Save, ShieldCheck, ShieldAlert } from 'lucide-react';
import { Button, Checkbox, Input, Select } from '../components';
import { pluginsApi, type PluginManifest } from '../api/plugins';
import './PluginControlPage.css';

type PluginControlForm = {
  plugin_id: string;
  enabled: boolean;
  pinned_version: string;
  workspaceIdsText: string;
  trusted_source: string;
};

export const PluginControlPage: React.FC = () => {
  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [selected, setSelected] = useState<PluginManifest | null>(null);
  const [form, setForm] = useState<PluginControlForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enabledCount = useMemo(
    () => plugins.filter((plugin) => plugin.enabled !== false).length,
    [plugins],
  );
  const trustedCount = useMemo(
    () => plugins.filter((plugin) => plugin.trusted).length,
    [plugins],
  );

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await pluginsApi.controlList();
      setPlugins(items);
      if (selected) {
        const nextSelected = items.find((item) => item.plugin_id === selected.plugin_id) || null;
        setSelected(nextSelected);
        setForm(nextSelected ? toForm(nextSelected) : null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Plugin control load failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleSelect = (plugin: PluginManifest) => {
    setSelected(plugin);
    setForm(toForm(plugin));
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      await pluginsApi.updateControl(form.plugin_id, {
        enabled: form.enabled,
        pinned_version: form.pinned_version || null,
        workspace_ids: splitCsv(form.workspaceIdsText),
        trusted_source: form.trusted_source || null,
      });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Plugin control save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="plugin-control-page">
      <div className="plugin-control-header">
        <div>
          <p>Flow Designer에서 사용할 플러그인의 활성 상태, 버전, workspace 정책을 관리합니다.</p>
        </div>
        <Button variant="secondary" size="sm" icon={<RotateCw size={14} />} onClick={loadData}>
          새로고침
        </Button>
      </div>

      {error && <div className="plugin-control-error">{error}</div>}

      <div className="plugin-summary-row">
        <div className="plugin-summary-card">
          <span>등록 플러그인</span>
          <strong>{plugins.length}</strong>
        </div>
        <div className="plugin-summary-card">
          <span>활성 플러그인</span>
          <strong>{enabledCount}</strong>
        </div>
        <div className="plugin-summary-card">
          <span>Trusted Source</span>
          <strong>{trustedCount}</strong>
        </div>
      </div>

      <div className="plugin-control-layout">
        <section className="plugin-panel plugin-list-panel">
          <div className="plugin-panel-header">
            <h3>플러그인 목록</h3>
          </div>
          {loading ? (
            <div className="plugin-empty">Plugin control 정보를 불러오는 중입니다...</div>
          ) : plugins.length === 0 ? (
            <div className="plugin-empty">등록된 플러그인이 없습니다.</div>
          ) : (
            <div className="plugin-table">
              {plugins.map((plugin) => (
                <button
                  key={plugin.plugin_id}
                  className={`plugin-row ${selected?.plugin_id === plugin.plugin_id ? 'selected' : ''}`}
                  onClick={() => handleSelect(plugin)}
                >
                  <span className="plugin-row-main">
                    <span className="plugin-name">{plugin.display_name}</span>
                    <span className="plugin-meta">
                      {plugin.plugin_id} · {plugin.version} · {plugin.executor_type}
                    </span>
                  </span>
                  <span className={`plugin-status ${plugin.enabled === false ? 'inactive' : 'active'}`}>
                    {plugin.enabled === false ? 'disabled' : 'enabled'}
                  </span>
                  <span className={`plugin-trust ${plugin.trusted ? 'trusted' : 'untrusted'}`}>
                    {plugin.trusted ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />}
                    {plugin.trusted_source || 'local'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="plugin-panel">
          <div className="plugin-panel-header">
            <h3>{selected ? '플러그인 정책' : '플러그인을 선택하세요'}</h3>
            {selected && <span className="plugin-form-id">{selected.plugin_id}</span>}
          </div>

          {!selected || !form ? (
            <div className="plugin-empty">좌측 목록에서 플러그인을 선택하면 정책을 수정할 수 있습니다.</div>
          ) : (
            <form className="plugin-form" onSubmit={(event) => void handleSubmit(event)}>
              <Checkbox
                label="Enabled"
                checked={form.enabled}
                onChange={(event) => setForm((prev) => prev && { ...prev, enabled: event.target.checked })}
                helperText="꺼두면 Flow Designer 플러그인 팔레트와 실행 API에서 사용할 수 없습니다."
              />

              <Select
                label="Pinned Version"
                value={form.pinned_version}
                onChange={(event) =>
                  setForm((prev) => prev && { ...prev, pinned_version: event.target.value })
                }
                options={[
                  { value: '', label: `Latest (${selected.version})` },
                  ...(selected.available_versions || [selected.version]).map((version) => ({
                    value: version,
                    label: version,
                  })),
                ]}
                helperText="비워두면 manifest 중 최신 버전을 사용합니다."
                fullWidth
              />

              <Input
                label="Workspace Allowlist"
                placeholder="default, finance"
                value={form.workspaceIdsText}
                onChange={(event) =>
                  setForm((prev) => prev && { ...prev, workspaceIdsText: event.target.value })
                }
                helperText="비워두면 기본 정책을 따릅니다. * 입력 시 모든 workspace 허용."
                fullWidth
              />

              <Input
                label="Trusted Source"
                placeholder="local / official / partner"
                value={form.trusted_source}
                onChange={(event) =>
                  setForm((prev) => prev && { ...prev, trusted_source: event.target.value })
                }
                helperText="trusted source 목록에 포함되면 trusted로 표시됩니다."
                fullWidth
              />

              <div className="plugin-form-actions">
                <Button variant="primary" icon={<Save size={14} />} type="submit" disabled={saving}>
                  {saving ? '저장 중...' : '정책 저장'}
                </Button>
              </div>
            </form>
          )}
        </section>
      </div>
    </div>
  );
};

function toForm(plugin: PluginManifest): PluginControlForm {
  return {
    plugin_id: plugin.plugin_id,
    enabled: plugin.enabled !== false,
    pinned_version: plugin.pinned_version || '',
    workspaceIdsText: (plugin.workspace_ids || []).join(', '),
    trusted_source: plugin.trusted_source || 'local',
  };
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
