import React, { useEffect, useMemo, useState } from 'react';
import { ListRestart, Plus, RotateCw, Save, Terminal, Trash2 } from 'lucide-react';
import { Button, Checkbox, Input } from '../components';
import { commandsApi, type CommandRegistryItem, type CommandRegistryPayload } from '../api/commands';
import './CommandRegistryPage.css';

type CommandFormState = {
  command_id: string;
  display_name: string;
  description: string;
  executable: string;
  fixedArgsText: string;
  argOrderText: string;
  argumentSchemaText: string;
  timeout_ms: number | string;
  max_stdout_bytes: number | string;
  max_stderr_bytes: number | string;
  working_dir: string;
  workspaceIdsText: string;
  enabled: boolean;
};

const emptyForm: CommandFormState = {
  command_id: '',
  display_name: '',
  description: '',
  executable: '',
  fixedArgsText: '',
  argOrderText: '',
  argumentSchemaText: '{\n  \n}',
  timeout_ms: 1000,
  max_stdout_bytes: 16384,
  max_stderr_bytes: 16384,
  working_dir: '',
  workspaceIdsText: '',
  enabled: true,
};

export const CommandRegistryPage: React.FC = () => {
  const [commands, setCommands] = useState<CommandRegistryItem[]>([]);
  const [form, setForm] = useState<CommandFormState>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeCount = useMemo(() => commands.filter((command) => command.enabled).length, [commands]);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      setCommands(await commandsApi.list(false));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Command registry load failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleEdit = (command: CommandRegistryItem) => {
    setForm({
      command_id: command.command_id,
      display_name: command.display_name,
      description: command.description,
      executable: command.executable,
      fixedArgsText: command.fixed_args.join(', '),
      argOrderText: command.arg_order.join(', '),
      argumentSchemaText: JSON.stringify(command.argument_schema || {}, null, 2),
      timeout_ms: command.timeout_ms,
      max_stdout_bytes: command.max_stdout_bytes,
      max_stderr_bytes: command.max_stderr_bytes,
      working_dir: command.working_dir || '',
      workspaceIdsText: command.workspace_ids.join(', '),
      enabled: command.enabled,
    });
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = buildPayload(form);
      await commandsApi.save(payload);
      setForm(emptyForm);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Command save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDisable = async (commandId: string) => {
    setError(null);
    try {
      await commandsApi.disable(commandId);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Command disable failed');
    }
  };

  return (
    <div className="command-registry-page">
      <div className="command-registry-header">
        <div>
          <div className="command-registry-title">
            <Terminal size={20} />
            <h2>Command Registry</h2>
          </div>
          <p>workflow에서 사용할 수 있는 allowlist command를 최고관리자가 등록합니다.</p>
        </div>
        <Button variant="secondary" size="sm" icon={<RotateCw size={14} />} onClick={loadData}>
          새로고침
        </Button>
      </div>

      {error && <div className="command-registry-error">{error}</div>}

      <div className="command-summary-row">
        <div className="command-summary-card">
          <span>등록 command</span>
          <strong>{commands.length}</strong>
        </div>
        <div className="command-summary-card">
          <span>활성 command</span>
          <strong>{activeCount}</strong>
        </div>
        <div className="command-summary-card">
          <span>실행 방식</span>
          <strong>allowlist</strong>
        </div>
      </div>

      <div className="command-registry-layout">
        <section className="command-panel command-list-panel">
          <div className="command-panel-header">
            <h3>Command 목록</h3>
            <Button variant="ghost" size="sm" icon={<Plus size={14} />} onClick={() => setForm(emptyForm)}>
              신규
            </Button>
          </div>
          {loading ? (
            <div className="command-empty">Command registry를 불러오는 중입니다...</div>
          ) : commands.length === 0 ? (
            <div className="command-empty">등록된 command가 없습니다.</div>
          ) : (
            <div className="command-table">
              {commands.map((command) => (
                <div
                  key={command.command_id}
                  className={`command-row ${form.command_id === command.command_id ? 'selected' : ''}`}
                >
                  <button className="command-row-main" onClick={() => handleEdit(command)}>
                    <span className="command-name">{command.display_name}</span>
                    <span className="command-meta">{command.command_id} · {command.executable}</span>
                  </button>
                  <span className={`command-status ${command.enabled ? 'active' : 'inactive'}`}>
                    {command.enabled ? 'active' : 'inactive'}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 size={14} />}
                    onClick={() => void handleDisable(command.command_id)}
                    disabled={!command.enabled}
                    aria-label={`${command.display_name} 명령어 비활성화`}
                    title="비활성화"
                  />
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="command-panel">
          <div className="command-panel-header">
            <h3>{form.command_id ? 'Command 수정' : 'Command 등록'}</h3>
          </div>
          <form className="command-form" onSubmit={(event) => void handleSubmit(event)}>
            <Input
              label="Command ID"
              placeholder="ops.generate_report"
              value={form.command_id}
              onChange={(event) => setForm((prev) => ({ ...prev, command_id: event.target.value }))}
              required
              fullWidth
            />
            <Input
              label="Display Name"
              value={form.display_name}
              onChange={(event) => setForm((prev) => ({ ...prev, display_name: event.target.value }))}
              fullWidth
            />
            <Input
              label="Executable"
              placeholder="/opt/pxm/bin/generate-report"
              value={form.executable}
              onChange={(event) => setForm((prev) => ({ ...prev, executable: event.target.value }))}
              required
              fullWidth
            />
            <Input
              label="Description"
              value={form.description}
              onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
              fullWidth
            />
            <Input
              label="Fixed Args"
              placeholder="--format, json"
              value={form.fixedArgsText}
              onChange={(event) => setForm((prev) => ({ ...prev, fixedArgsText: event.target.value }))}
              helperText="쉼표로 구분합니다."
              fullWidth
            />
            <Input
              label="Argument Order"
              placeholder="request_id, format"
              value={form.argOrderText}
              onChange={(event) => setForm((prev) => ({ ...prev, argOrderText: event.target.value }))}
              helperText="Command Node Arguments JSON의 key를 이 순서로 executable 인자로 전달합니다."
              fullWidth
            />
            <div className="command-form-group">
              <label>Argument Schema JSON</label>
              <textarea
                value={form.argumentSchemaText}
                onChange={(event) => setForm((prev) => ({ ...prev, argumentSchemaText: event.target.value }))}
                spellCheck={false}
              />
            </div>
            <div className="command-form-grid">
              <Input
                label="Timeout ms"
                type="number"
                value={form.timeout_ms}
                onChange={(event) => setForm((prev) => ({ ...prev, timeout_ms: event.target.value }))}
                fullWidth
              />
              <Input
                label="Max stdout bytes"
                type="number"
                value={form.max_stdout_bytes}
                onChange={(event) => setForm((prev) => ({ ...prev, max_stdout_bytes: event.target.value }))}
                fullWidth
              />
              <Input
                label="Max stderr bytes"
                type="number"
                value={form.max_stderr_bytes}
                onChange={(event) => setForm((prev) => ({ ...prev, max_stderr_bytes: event.target.value }))}
                fullWidth
              />
            </div>
            <Input
              label="Working Directory"
              value={form.working_dir}
              onChange={(event) => setForm((prev) => ({ ...prev, working_dir: event.target.value }))}
              fullWidth
            />
            <Input
              label="Workspace IDs"
              placeholder="default, ops"
              value={form.workspaceIdsText}
              onChange={(event) => setForm((prev) => ({ ...prev, workspaceIdsText: event.target.value }))}
              helperText="비워두면 전체 workspace에서 선택 가능합니다."
              fullWidth
            />
            <Checkbox
              label="Enabled"
              checked={form.enabled}
              onChange={(event) => setForm((prev) => ({ ...prev, enabled: event.target.checked }))}
            />
            <div className="command-form-actions">
              <Button type="submit" disabled={saving} icon={<Save size={14} />}>
                {saving ? '저장 중...' : '저장'}
              </Button>
              <Button variant="secondary" onClick={() => setForm(emptyForm)} icon={<ListRestart size={14} />}>
                초기화
              </Button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
};

function buildPayload(form: CommandFormState): CommandRegistryPayload {
  const argumentSchema = parseJsonObject(form.argumentSchemaText);
  return {
    command_id: form.command_id.trim(),
    display_name: form.display_name.trim() || form.command_id.trim(),
    description: form.description.trim(),
    executable: form.executable.trim(),
    fixed_args: splitCsv(form.fixedArgsText),
    arg_order: splitCsv(form.argOrderText),
    argument_schema: argumentSchema,
    timeout_ms: Number(form.timeout_ms) || 1000,
    max_stdout_bytes: Number(form.max_stdout_bytes) || 16384,
    max_stderr_bytes: Number(form.max_stderr_bytes) || 16384,
    working_dir: form.working_dir.trim() || null,
    workspace_ids: splitCsv(form.workspaceIdsText),
    enabled: form.enabled,
  };
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJsonObject(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Argument schema must be a JSON object');
  }
  return parsed;
}
