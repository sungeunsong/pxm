import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/pg.provider';
import { CreateTemplateDto, UpdateTemplateDto, TemplateResponseDto } from './dto/template.dto';

@Injectable()
export class TemplatesService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async create(dto: CreateTemplateDto): Promise<TemplateResponseDto> {
    const result = await this.pool.query(
      `INSERT INTO workflow_template (name, description, nodes, edges)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [dto.name, dto.description, JSON.stringify(dto.nodes), JSON.stringify(dto.edges)]
    );
    return this.mapToDto(result.rows[0]);
  }

  async findAll(activeOnly = true): Promise<TemplateResponseDto[]> {
    const query = activeOnly
      ? `SELECT * FROM workflow_template WHERE is_active = true ORDER BY created_at DESC`
      : `SELECT * FROM workflow_template ORDER BY created_at DESC`;
    
    const result = await this.pool.query(query);
    return result.rows.map(row => this.mapToDto(row));
  }

  async findOne(id: string): Promise<TemplateResponseDto | null> {
    const result = await this.pool.query(
      `SELECT * FROM workflow_template WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.mapToDto(result.rows[0]) : null;
  }

  async update(id: string, dto: UpdateTemplateDto): Promise<TemplateResponseDto | null> {
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (dto.name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(dto.name);
    }
    if (dto.description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(dto.description);
    }
    if (dto.nodes !== undefined) {
      updates.push(`nodes = $${paramIndex++}`);
      values.push(JSON.stringify(dto.nodes));
    }
    if (dto.edges !== undefined) {
      updates.push(`edges = $${paramIndex++}`);
      values.push(JSON.stringify(dto.edges));
    }
    if (dto.is_active !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(dto.is_active);
    }

    if (updates.length === 0) {
      return this.findOne(id);
    }

    updates.push(`updated_at = now()`);
    updates.push(`version = version + 1`);
    values.push(id);

    const result = await this.pool.query(
      `UPDATE workflow_template 
       SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING *`,
      values
    );

    return result.rows[0] ? this.mapToDto(result.rows[0]) : null;
  }

  async delete(id: string): Promise<boolean> {
    // Soft delete - is_active를 false로 설정
    const result = await this.pool.query(
      `UPDATE workflow_template SET is_active = false, updated_at = now() WHERE id = $1`,
      [id]
    );
    return result.rowCount > 0;
  }

  private mapToDto(row: any): TemplateResponseDto {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      nodes: row.nodes,
      edges: row.edges,
      version: row.version,
      is_active: row.is_active,
      created_by: row.created_by,
      updated_by: row.updated_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
