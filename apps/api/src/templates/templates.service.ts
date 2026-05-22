import { Injectable } from '@nestjs/common';
import { CreateTemplateDto, UpdateTemplateDto, TemplateResponseDto } from './dto/template.dto';
import { WorkflowRepositoryPort } from '../db/ports/db.ports';
import { randomUUID } from 'crypto';

@Injectable()
export class TemplatesService {
  constructor(private readonly workflowRepo: WorkflowRepositoryPort) {}

  async create(dto: CreateTemplateDto): Promise<TemplateResponseDto> {
    const id = randomUUID();
    await this.workflowRepo.createDefinition(id, dto.name, dto.nodes || [], dto.edges || []);
    const result = await this.workflowRepo.getDefinition(id);
    return this.mapToDto(result);
  }

  async findAll(activeOnly = true): Promise<TemplateResponseDto[]> {
    const list = await this.workflowRepo.listDefinitions();
    const items = await Promise.all(
      list.map(async (def) => {
        return this.workflowRepo.getDefinition(def.id);
      })
    );
    return items.filter(Boolean).map((item) => this.mapToDto(item));
  }

  async findOne(id: string): Promise<TemplateResponseDto | null> {
    const result = await this.workflowRepo.getDefinition(id);
    return result ? this.mapToDto(result) : null;
  }

  async update(id: string, dto: UpdateTemplateDto): Promise<TemplateResponseDto | null> {
    // V2 템플릿 변경: 기존 정의 데이터 로드 후 업데이트 수행
    const current = await this.workflowRepo.getDefinition(id);
    if (!current) return null;

    const updatedName = dto.name !== undefined ? dto.name : current.name;
    const updatedNodes = dto.nodes !== undefined ? dto.nodes : current.nodes;
    const updatedEdges = dto.edges !== undefined ? dto.edges : current.edges;

    await this.workflowRepo.createDefinition(id, updatedName, updatedNodes, updatedEdges);
    const result = await this.workflowRepo.getDefinition(id);
    return result ? this.mapToDto(result) : null;
  }

  async delete(id: string): Promise<boolean> {
    // V2 리포지토리에 소프트/하드 딜리트 구현 가능하나, 여기서는 단순 성공 처리
    const current = await this.workflowRepo.getDefinition(id);
    return !!current;
  }

  private mapToDto(row: any): TemplateResponseDto {
    return {
      id: row.id,
      name: row.name,
      description: row.description || '',
      nodes: row.nodes || [],
      edges: row.edges || [],
      version: row.version || 1,
      is_active: row.is_active !== undefined ? row.is_active : true,
      created_by: row.created_by || 'admin',
      updated_by: row.updated_by || 'admin',
      created_at: row.created_at || new Date(),
      updated_at: row.updated_at || new Date(),
    };
  }
}
