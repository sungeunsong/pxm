import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Db } from 'mongodb';
import { MONGO_DB } from '../db/mongo.provider';
import { CommandRegistryDto, CommandRegistryResponseDto } from './dto/command-registry.dto';

type CommandDocument = CommandRegistryResponseDto & {
  _id: string;
};

type AuditDocument = {
  command_id: string;
  action: string;
  actor: string;
  payload?: Record<string, any>;
  created_at: string;
};

@Injectable()
export class CommandsService {
  constructor(@Inject(MONGO_DB) private readonly db: Db) {}

  async list(activeOnly = false): Promise<CommandRegistryResponseDto[]> {
    const filter = activeOnly ? { enabled: true } : {};
    const docs = await this.commands
      .find(filter)
      .sort({ command_id: 1 })
      .toArray();
    const merged = new Map<string, CommandRegistryResponseDto>();
    for (const command of builtInCommands()) {
      if (!activeOnly || command.enabled) {
        merged.set(command.command_id, command);
      }
    }
    for (const doc of docs) {
      const command = toResponse(doc);
      merged.set(command.command_id, command);
    }
    return [...merged.values()].sort((a, b) => a.command_id.localeCompare(b.command_id));
  }

  async get(commandId: string): Promise<CommandRegistryResponseDto> {
    const doc = await this.commands.findOne({ _id: commandId });
    if (!doc) {
      const builtIn = builtInCommands().find((command) => command.command_id === commandId);
      if (builtIn) {
        return builtIn;
      }
      throw new NotFoundException('Command not found');
    }
    return toResponse(doc);
  }

  async upsert(dto: CommandRegistryDto, actor = 'admin'): Promise<CommandRegistryResponseDto> {
    const normalized = normalizeCommand(dto);
    const { created_at: _createdAt, updated_at: _updatedAt, ...setDoc } = normalized;
    const now = new Date().toISOString();
    await this.commands.updateOne(
      { _id: normalized.command_id },
      {
        $set: {
          ...setDoc,
          updated_at: now,
        },
        $setOnInsert: {
          _id: normalized.command_id,
          created_at: now,
        },
      },
      { upsert: true },
    );
    await this.appendAudit(normalized.command_id, 'upserted', actor, {
      enabled: normalized.enabled,
      executable: normalized.executable,
    });
    return this.get(normalized.command_id);
  }

  async update(commandId: string, dto: Partial<CommandRegistryDto>, actor = 'admin') {
    const existing = await this.commands.findOne({ _id: commandId });
    if (!existing) {
      throw new NotFoundException('Command not found');
    }
    const normalized = normalizeCommand({ ...existing, ...dto, command_id: commandId });
    const { created_at: _createdAt, updated_at: _updatedAt, ...setDoc } = normalized;
    const now = new Date().toISOString();
    await this.commands.updateOne(
      { _id: commandId },
      {
        $set: {
          ...setDoc,
          updated_at: now,
        },
      },
    );
    await this.appendAudit(commandId, 'updated', actor, {
      enabled: normalized.enabled,
      executable: normalized.executable,
    });
    return this.get(commandId);
  }

  async disable(commandId: string, actor = 'admin') {
    const result = await this.commands.updateOne(
      { _id: commandId },
      {
        $set: {
          enabled: false,
          updated_at: new Date().toISOString(),
        },
      },
    );
    if (result.matchedCount === 0) {
      throw new NotFoundException('Command not found');
    }
    await this.appendAudit(commandId, 'disabled', actor);
    return { success: true };
  }

  async audit(commandId?: string) {
    const filter = commandId ? { command_id: commandId } : {};
    return this.audits.find(filter).sort({ created_at: -1 }).limit(100).toArray();
  }

  private get commands() {
    return this.db.collection<CommandDocument>('command_registry');
  }

  private get audits() {
    return this.db.collection<AuditDocument>('command_registry_audit_logs');
  }

  private async appendAudit(
    commandId: string,
    action: string,
    actor: string,
    payload?: Record<string, any>,
  ) {
    await this.audits.insertOne({
      command_id: commandId,
      action,
      actor,
      payload,
      created_at: new Date().toISOString(),
    });
  }
}

function normalizeCommand(dto: CommandRegistryDto): CommandRegistryResponseDto {
  const commandId = String(dto.command_id || '').trim();
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(commandId)) {
    throw new BadRequestException('command_id must be lowercase dot-delimited id');
  }

  const executable = String(dto.executable || '').trim();
  if (!executable.startsWith('/')) {
    throw new BadRequestException('executable must be an absolute path');
  }

  return {
    command_id: commandId,
    display_name: String(dto.display_name || commandId).trim(),
    description: String(dto.description || '').trim(),
    executable,
    fixed_args: normalizeStringArray(dto.fixed_args),
    arg_order: normalizeStringArray(dto.arg_order),
    argument_schema: dto.argument_schema && typeof dto.argument_schema === 'object'
      ? dto.argument_schema
      : {},
    timeout_ms: clampNumber(dto.timeout_ms, 50, 60_000, 1000),
    max_stdout_bytes: clampNumber(dto.max_stdout_bytes, 0, 1_048_576, 16_384),
    max_stderr_bytes: clampNumber(dto.max_stderr_bytes, 0, 1_048_576, 16_384),
    working_dir: dto.working_dir ? String(dto.working_dir) : null,
    workspace_ids: normalizeStringArray(dto.workspace_ids),
    enabled: dto.enabled !== false,
    created_at: '',
    updated_at: '',
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(number), min), max);
}

function toResponse(doc: CommandDocument): CommandRegistryResponseDto {
  return {
    command_id: doc.command_id || doc._id,
    display_name: doc.display_name || doc.command_id || doc._id,
    description: doc.description || '',
    executable: doc.executable,
    fixed_args: doc.fixed_args || [],
    arg_order: doc.arg_order || [],
    argument_schema: doc.argument_schema || {},
    timeout_ms: doc.timeout_ms || 1000,
    max_stdout_bytes: doc.max_stdout_bytes || 16_384,
    max_stderr_bytes: doc.max_stderr_bytes || 16_384,
    working_dir: doc.working_dir || null,
    workspace_ids: doc.workspace_ids || [],
    enabled: doc.enabled !== false,
    created_at: doc.created_at || '',
    updated_at: doc.updated_at || '',
  };
}

function builtInCommands(): CommandRegistryResponseDto[] {
  const now = '';
  return [
    {
      command_id: 'builtin.echo',
      display_name: 'Echo',
      description: '테스트용 문자열 출력 command입니다.',
      executable: '/usr/bin/printf',
      fixed_args: ['%s'],
      arg_order: ['message'],
      argument_schema: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            title: 'Message',
            default: 'hello from command node',
          },
        },
        required: ['message'],
      },
      timeout_ms: 1000,
      max_stdout_bytes: 4096,
      max_stderr_bytes: 4096,
      working_dir: null,
      workspace_ids: [],
      enabled: true,
      created_at: now,
      updated_at: now,
    },
    {
      command_id: 'builtin.node_version',
      display_name: 'Node.js Version',
      description: '테스트용 Node.js 버전 확인 command입니다.',
      executable: '/usr/bin/node',
      fixed_args: ['--version'],
      arg_order: [],
      argument_schema: { type: 'object', properties: {} },
      timeout_ms: 1000,
      max_stdout_bytes: 4096,
      max_stderr_bytes: 4096,
      working_dir: null,
      workspace_ids: [],
      enabled: true,
      created_at: now,
      updated_at: now,
    },
  ];
}
