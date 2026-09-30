import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../pg.provider';
import {
  EntryPoint,
  EntryPointConflictError,
  EntryPointPatch,
  EntryPointQuery,
  EntryPointRepositoryPort,
} from '../ports/entry-points.port';

/**
 * 스키마는 infra/db/migrations/013_entry_points.sql과 같다.
 * pxm_* 테이블처럼 API가 처음 쓸 때도 만들어 둔다.
 */
@Injectable()
export class PostgresEntryPointRepository implements EntryPointRepositoryPort {
  private tableReady = false;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async createEntryPoint(entry: EntryPoint): Promise<EntryPoint> {
    await this.ensureTable();
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO pxm_entry_points (${COLUMNS.join(', ')})
         VALUES (${COLUMNS.map((_, index) => `$${index + 1}`).join(', ')})
         RETURNING *`,
        toRow(entry),
      );
      return mapEntryPointRow(rows[0]);
    } catch (error) {
      throw translateDuplicate(error);
    }
  }

  async getEntryPoint(id: string): Promise<EntryPoint | null> {
    await this.ensureTable();
    const { rows } = await this.pool.query(
      `SELECT * FROM pxm_entry_points WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapEntryPointRow(rows[0]) : null;
  }

  async listEntryPoints(query: EntryPointQuery = {}): Promise<EntryPoint[]> {
    await this.ensureTable();
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (query.kind) add('kind = ?', query.kind);
    if (query.group_ids) add('group_id = ANY(?)', query.group_ids);
    if (query.definition_id) add('definition_id = ?', query.definition_id);
    if (query.status) add('status = ?', query.status);
    if (query.tool_name) add('tool_name = ?', query.tool_name);
    if (query.route) {
      add('route_method = ?', query.route.method);
      add('route_path = ?', query.route.path);
    }
    const { rows } = await this.pool.query(
      `SELECT * FROM pxm_entry_points ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, id`,
      params,
    );
    return rows.map(mapEntryPointRow);
  }

  async updateEntryPoint(
    id: string,
    patch: EntryPointPatch,
  ): Promise<EntryPoint | null> {
    const current = await this.getEntryPoint(id);
    if (!current) return null;
    const next: EntryPoint = {
      ...current,
      ...patch,
      updated_at: new Date().toISOString(),
    };
    try {
      const assignments = COLUMNS.filter(
        (column) =>
          column !== 'id' && column !== 'created_at' && column !== 'created_by',
      );
      const values = toRow(next);
      const { rows } = await this.pool.query(
        `UPDATE pxm_entry_points
         SET ${assignments.map((column, index) => `${column} = $${index + 2}`).join(', ')}
         WHERE id = $1
         RETURNING *`,
        [id, ...assignments.map((column) => values[COLUMNS.indexOf(column)])],
      );
      return rows[0] ? mapEntryPointRow(rows[0]) : null;
    } catch (error) {
      throw translateDuplicate(error);
    }
  }

  async deleteEntryPoint(id: string): Promise<boolean> {
    await this.ensureTable();
    const { rowCount } = await this.pool.query(
      `DELETE FROM pxm_entry_points WHERE id = $1`,
      [id],
    );
    return (rowCount || 0) > 0;
  }

  private async ensureTable(): Promise<void> {
    if (this.tableReady) return;
    await this.pool.query(ENTRY_POINTS_DDL);
    this.tableReady = true;
  }
}

const COLUMNS = [
  'id',
  'kind',
  'group_id',
  'tenant_id',
  'definition_id',
  'pinned_version',
  'input_schema',
  'input_schema_source',
  'output_schema',
  'output_contract',
  'side_effect',
  'status',
  'description',
  'tags',
  'resource_digest',
  'history_policy',
  'tool',
  'route',
  'tool_name',
  'route_method',
  'route_path',
  'created_by',
  'updated_by',
  'created_at',
  'updated_at',
] as const;

export const ENTRY_POINTS_DDL = `
  CREATE TABLE IF NOT EXISTS pxm_entry_points (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('tool', 'route')),
    group_id TEXT NOT NULL,
    tenant_id TEXT NULL,
    definition_id TEXT NOT NULL,
    pinned_version INTEGER NOT NULL,
    input_schema JSONB NOT NULL,
    input_schema_source TEXT NOT NULL DEFAULT 'derived',
    output_schema JSONB NULL,
    output_contract TEXT NOT NULL DEFAULT 'free_form',
    side_effect TEXT NOT NULL,
    status TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    resource_digest JSONB NULL,
    history_policy JSONB NOT NULL DEFAULT '{"body":"none"}'::jsonb,
    tool JSONB NULL,
    route JSONB NULL,
    tool_name TEXT NULL,
    route_method TEXT NULL,
    route_path TEXT NULL,
    created_by TEXT NULL,
    updated_by TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_pxm_entry_points_tool_name
    ON pxm_entry_points (group_id, tool_name) WHERE kind = 'tool';
  CREATE UNIQUE INDEX IF NOT EXISTS ux_pxm_entry_points_route
    ON pxm_entry_points (route_method, route_path) WHERE kind = 'route';
  CREATE INDEX IF NOT EXISTS idx_pxm_entry_points_group_status
    ON pxm_entry_points (group_id, status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_pxm_entry_points_definition
    ON pxm_entry_points (definition_id, pinned_version);
`;

function toRow(entry: EntryPoint): unknown[] {
  const row: Record<(typeof COLUMNS)[number], unknown> = {
    id: entry.id,
    kind: entry.kind,
    group_id: entry.group_id,
    tenant_id: entry.tenant_id,
    definition_id: entry.definition_id,
    pinned_version: entry.pinned_version,
    input_schema: JSON.stringify(entry.input_schema),
    input_schema_source: entry.input_schema_source,
    output_schema:
      entry.output_schema === null ? null : JSON.stringify(entry.output_schema),
    output_contract: entry.output_contract,
    side_effect: entry.side_effect,
    status: entry.status,
    description: entry.description,
    tags: JSON.stringify(entry.tags),
    resource_digest:
      entry.resource_digest === null
        ? null
        : JSON.stringify(entry.resource_digest),
    history_policy: JSON.stringify(entry.history_policy),
    tool: entry.tool === null ? null : JSON.stringify(entry.tool),
    route: entry.route === null ? null : JSON.stringify(entry.route),
    tool_name: entry.tool?.name ?? null,
    route_method: entry.route?.method ?? null,
    route_path: entry.route?.path ?? null,
    created_by: entry.created_by,
    updated_by: entry.updated_by,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  };
  return COLUMNS.map((column) => row[column]);
}

function translateDuplicate(error: unknown): unknown {
  if ((error as { code?: string })?.code === '23505')
    return new EntryPointConflictError();
  return error;
}

function iso(value: any): string {
  return value?.toISOString?.() ?? value;
}

export function mapEntryPointRow(row: any): EntryPoint {
  return {
    id: row.id,
    kind: row.kind,
    group_id: row.group_id,
    tenant_id: row.tenant_id ?? null,
    definition_id: row.definition_id,
    pinned_version: Number(row.pinned_version),
    input_schema: row.input_schema,
    input_schema_source:
      row.input_schema_source === 'manual' ? 'manual' : 'derived',
    output_schema: row.output_schema ?? null,
    output_contract:
      row.output_contract === 'declared' ? 'declared' : 'free_form',
    side_effect: row.side_effect,
    status: row.status,
    description: row.description ?? '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    resource_digest: row.resource_digest ?? null,
    history_policy: {
      body: row.history_policy?.body === 'masked' ? 'masked' : 'none',
    },
    tool: row.tool ?? null,
    route: row.route ?? null,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}
