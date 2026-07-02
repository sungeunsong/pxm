export type CommandRegistryDto = {
  command_id: string;
  display_name?: string;
  description?: string;
  executable: string;
  fixed_args?: string[];
  arg_order?: string[];
  argument_schema?: Record<string, any>;
  timeout_ms?: number;
  max_stdout_bytes?: number;
  max_stderr_bytes?: number;
  working_dir?: string | null;
  workspace_ids?: string[];
  enabled?: boolean;
};

export type CommandRegistryResponseDto = Required<
  Omit<CommandRegistryDto, 'working_dir'>
> & {
  working_dir: string | null;
  created_at: string;
  updated_at: string;
};
