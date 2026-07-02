export interface CommandRegistryItem {
  command_id: string;
  display_name: string;
  description: string;
  executable: string;
  fixed_args: string[];
  arg_order: string[];
  argument_schema: Record<string, unknown>;
  timeout_ms: number;
  max_stdout_bytes: number;
  max_stderr_bytes: number;
  working_dir: string | null;
  workspace_ids: string[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export type CommandRegistryPayload = Partial<CommandRegistryItem> & {
  command_id: string;
  executable: string;
};

const adminHeaders = {
  'Content-Type': 'application/json',
  'x-actor-id': 'admin',
  'x-actor-roles': 'admin',
};

export const commandsApi = {
  async list(activeOnly = false): Promise<CommandRegistryItem[]> {
    const response = await fetch(`/api/commands?activeOnly=${activeOnly ? 'true' : 'false'}`);
    if (!response.ok) {
      throw new Error(`commands api failed: ${response.status}`);
    }
    return response.json();
  },

  async save(payload: CommandRegistryPayload): Promise<CommandRegistryItem> {
    const response = await fetch('/api/commands', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(data?.message || `command save failed: ${response.status}`);
    }
    return data;
  },

  async update(commandId: string, payload: Partial<CommandRegistryPayload>): Promise<CommandRegistryItem> {
    const response = await fetch(`/api/commands/${encodeURIComponent(commandId)}`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(data?.message || `command update failed: ${response.status}`);
    }
    return data;
  },

  async disable(commandId: string): Promise<void> {
    const response = await fetch(`/api/commands/${encodeURIComponent(commandId)}`, {
      method: 'DELETE',
      headers: adminHeaders,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.message || `command disable failed: ${response.status}`);
    }
  },
};
