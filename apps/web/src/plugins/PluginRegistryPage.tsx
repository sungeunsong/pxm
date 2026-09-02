import React, { useEffect, useMemo, useState } from 'react';
import { Plus, RotateCw, Save, Trash2 } from 'lucide-react';
import { Button } from '../components';
import { useFeedback } from '../components/feedback/feedback-context';
import { pluginsApi, type PluginManifest } from '../api/plugins';
import './PluginRegistryPage.css';

const defaultManifest = {
  plugin_id: 'connector.example.action',
  version: '1.0.0',
  display_name: 'Example Action',
  description: 'Example registry plugin.',
  category: 'Custom',
  node_type: 'service',
  icon: 'plug',
  config_schema: {
    type: 'object',
    properties: {},
  },
  executor_type: 'mock',
  executor_ref: 'mock.example_action',
  trusted_source: 'local',
  secrets_policy: {},
  input_schema: {
    type: 'object',
    properties: {},
  },
  output_schema: {
    type: 'object',
    properties: {},
  },
  timeout_ms: 5000,
  tags: ['custom'],
};

export const PluginRegistryPage: React.FC = () => {
  const { confirm: confirmDialog } = useFeedback();
  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [selected, setSelected] = useState<PluginManifest | null>(null);
  const [manifestText, setManifestText] = useState(JSON.stringify(defaultManifest, null, 2));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const registryCount = useMemo(
    () => plugins.filter((plugin) => plugin.manifest_source === 'registry').length,
    [plugins],
  );

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await pluginsApi.registryList();
      setPlugins(items);
      if (selected) {
        const next = items.find(
          (item) => item.plugin_id === selected.plugin_id && item.version === selected.version,
        );
        setSelected(next || null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Plugin registry load failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleNew = () => {
    setSelected(null);
    setManifestText(JSON.stringify(defaultManifest, null, 2));
  };

  const handleSelect = (plugin: PluginManifest) => {
    setSelected(plugin);
    setManifestText(JSON.stringify(stripRegistryMeta(plugin), null, 2));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const parsed = JSON.parse(manifestText);
      const saved = await pluginsApi.saveRegistryManifest(parsed);
      await loadData();
      setSelected(saved);
      setManifestText(JSON.stringify(stripRegistryMeta(saved), null, 2));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Plugin manifest save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selected || selected.manifest_source !== 'registry') return;
    const proceed = await confirmDialog({
      title: 'manifest를 삭제할까요?',
      description: `${selected.plugin_id}@${selected.version}이(가) registry에서 제거됩니다.`,
      confirmLabel: '삭제',
      tone: 'danger',
    });
    if (!proceed) return;
    setError(null);
    try {
      await pluginsApi.deleteRegistryManifest(selected.plugin_id, selected.version);
      setSelected(null);
      setManifestText(JSON.stringify(defaultManifest, null, 2));
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Plugin manifest delete failed');
    }
  };

  const selectedReadOnly = selected?.manifest_source === 'file';

  return (
    <div className="plugin-registry-page">
      <div className="plugin-registry-header">
        <div>
          <p>운영자가 추가하는 plugin manifest를 등록하고 서버 재시작 없이 반영합니다.</p>
        </div>
        <div className="plugin-registry-actions">
          <Button variant="ghost" size="sm" icon={<Plus size={14} />} onClick={handleNew}>
            신규
          </Button>
          <Button variant="secondary" size="sm" icon={<RotateCw size={14} />} onClick={loadData}>
            새로고침
          </Button>
        </div>
      </div>

      {error && <div className="plugin-registry-error">{error}</div>}

      <div className="plugin-registry-summary-row">
        <div className="plugin-registry-summary-card">
          <span>전체 manifest</span>
          <strong>{plugins.length}</strong>
        </div>
        <div className="plugin-registry-summary-card">
          <span>Registry manifest</span>
          <strong>{registryCount}</strong>
        </div>
        <div className="plugin-registry-summary-card">
          <span>File manifest</span>
          <strong>{plugins.length - registryCount}</strong>
        </div>
      </div>

      <div className="plugin-registry-layout">
        <section className="plugin-registry-panel plugin-registry-list-panel">
          <div className="plugin-registry-panel-header">
            <h3>Manifest 목록</h3>
          </div>
          {loading ? (
            <div className="plugin-registry-empty">Plugin registry를 불러오는 중입니다...</div>
          ) : (
            <div className="plugin-registry-table">
              {plugins.map((plugin) => (
                <button
                  key={`${plugin.plugin_id}@${plugin.version}`}
                  className={`plugin-registry-row ${
                    selected?.plugin_id === plugin.plugin_id && selected.version === plugin.version
                      ? 'selected'
                      : ''
                  }`}
                  onClick={() => handleSelect(plugin)}
                >
                  <span className="plugin-registry-row-main">
                    <span className="plugin-registry-name">{plugin.display_name}</span>
                    <span className="plugin-registry-meta">
                      {plugin.plugin_id}@{plugin.version}
                    </span>
                  </span>
                  <span className={`plugin-registry-source ${plugin.manifest_source || 'file'}`}>
                    {plugin.manifest_source || 'file'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="plugin-registry-panel">
          <div className="plugin-registry-panel-header">
            <h3>{selected ? 'Manifest JSON' : '신규 Manifest JSON'}</h3>
            {selectedReadOnly && <span className="plugin-registry-readonly">file manifest는 읽기 전용입니다.</span>}
          </div>
          <textarea
            className="plugin-registry-editor"
            value={manifestText}
            onChange={(event) => setManifestText(event.target.value)}
            readOnly={selectedReadOnly}
            spellCheck={false}
          />
          <div className="plugin-registry-form-actions">
            <Button
              variant="primary"
              icon={<Save size={14} />}
              onClick={handleSave}
              disabled={saving || selectedReadOnly}
            >
              {saving ? '저장 중...' : '저장 / Hot Reload'}
            </Button>
            <Button
              variant="ghost"
              icon={<Trash2 size={14} />}
              onClick={handleDelete}
              disabled={!selected || selected.manifest_source !== 'registry'}
            >
              삭제
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
};

function stripRegistryMeta(plugin: PluginManifest) {
  const {
    available_versions: _availableVersions,
    pinned_version: _pinnedVersion,
    workspace_ids: _workspaceIds,
    trusted: _trusted,
    editable: _editable,
    manifest_source: _manifestSource,
    ...manifest
  } = plugin;
  return manifest;
}
