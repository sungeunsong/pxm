import { BadRequestException, Injectable } from '@nestjs/common';
import {
  CreateTemplateDto,
  UpdateTemplateDto,
  TemplateResponseDto,
  WorkflowExportDocument,
} from './dto/template.dto';
import { WorkflowDefinitionMetadata, WorkflowDefinitionVersion, WorkflowRepositoryPort } from '../db/ports/db.ports';
import { randomUUID } from 'crypto';
import { SchedulesService } from '../schedules/schedules.service';
import { DbWatchService } from '../db-watch/db-watch.service';
import { CredentialsService } from '../credentials/credentials.service';

@Injectable()
export class TemplatesService {
  constructor(
    private readonly workflowRepo: WorkflowRepositoryPort,
    private readonly schedulesService: SchedulesService,
    private readonly dbWatchService: DbWatchService,
    private readonly credentialsService: CredentialsService,
  ) {}

  async create(dto: CreateTemplateDto): Promise<TemplateResponseDto> {
    const id = randomUUID();
    await this.assertCredentialBindings(dto.nodes || [], dto.group_id);
    await this.assertNoWorkflowCallCycle(id, dto.nodes || []);
    await this.workflowRepo.createDefinition(
      id,
      dto.name,
      dto.nodes || [],
      dto.edges || [],
      this.normalizeMetadata(dto),
    );
    await this.schedulesService.syncDefinitionSchedules(id, dto.name, dto.nodes || []);
    await this.dbWatchService.syncDefinitionWatchJobs(id, dto.name, dto.nodes || []);
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
    const mapped = items.filter(Boolean).map((item) => this.mapToDto(item));
    return activeOnly ? mapped.filter((item) => item.is_active !== false) : mapped;
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
    const updatedMetadata = this.normalizeMetadata({
      description: dto.description !== undefined ? dto.description : current.description,
      group: dto.group !== undefined ? dto.group : current.group,
      group_id: dto.group_id !== undefined ? dto.group_id : current.group_id,
      tags: dto.tags !== undefined ? dto.tags : current.tags,
      version_note: dto.version_note !== undefined ? dto.version_note : current.version_note,
      created_by: current.created_by || current.metadata?.created_by || null,
      updated_by: dto.updated_by || current.updated_by || current.metadata?.updated_by || null,
    });

    await this.assertCredentialBindings(updatedNodes || [], updatedMetadata.group_id);
    await this.assertNoWorkflowCallCycle(id, updatedNodes || []);
    await this.workflowRepo.createDefinition(id, updatedName, updatedNodes, updatedEdges, updatedMetadata);
    await this.schedulesService.syncDefinitionSchedules(id, updatedName, updatedNodes || []);
    await this.dbWatchService.syncDefinitionWatchJobs(id, updatedName, updatedNodes || []);
    const result = await this.workflowRepo.getDefinition(id);
    return result ? this.mapToDto(result) : null;
  }

  async delete(id: string): Promise<boolean> {
    const current = await this.workflowRepo.getDefinition(id);
    if (!current) return false;

    const deleted = await this.workflowRepo.deleteDefinition(id);
    if (!deleted) return false;

    await this.schedulesService.syncDefinitionSchedules(id, current.name || '', []);
    await this.dbWatchService.syncDefinitionWatchJobs(id, current.name || '', []);
    return true;
  }

  async export(id: string): Promise<WorkflowExportDocument | null> {
    const template = await this.findOne(id);
    if (!template) return null;

    const redactedPaths: string[] = [];
    const nodes = redactSecrets(template.nodes || [], redactedPaths, 'workflow.nodes');
    const edges = redactSecrets(template.edges || [], redactedPaths, 'workflow.edges');

    return {
      schema_version: 'pxm.workflow.v1',
      exported_at: new Date().toISOString(),
      workflow: {
        definition_id: template.id,
        version: template.version || 1,
        exported_version_note: template.version_note || '',
        name: template.name,
        metadata: {
          description: template.description || '',
          group: template.group || '',
          group_id: template.group_id || null,
          tags: template.tags || [],
          version_note: template.version_note || '',
          imported_from: template.imported_from,
        },
        nodes,
        edges,
        plugin_dependencies: extractPluginDependencies(nodes),
      },
      security: {
        secrets_policy: 'redacted',
        redacted_paths: redactedPaths,
      },
    };
  }

  async import(document: any, actorId = 'system'): Promise<TemplateResponseDto> {
    const parsed = parseWorkflowExportDocument(document);
    return this.create({
      name: parsed.workflow.name,
      description: parsed.workflow.metadata.description,
      group: parsed.workflow.metadata.group,
      group_id: parsed.workflow.metadata.group_id,
      tags: parsed.workflow.metadata.tags,
      version_note: parsed.workflow.metadata.version_note,
      imported_from: buildImportSourceMetadata(parsed),
      nodes: parsed.workflow.nodes,
      edges: parsed.workflow.edges,
      created_by: actorId,
      updated_by: actorId,
    });
  }

  async listVersions(id: string): Promise<WorkflowDefinitionVersion[] | null> {
    const current = await this.workflowRepo.getDefinition(id);
    if (!current) return null;
    return this.workflowRepo.listDefinitionVersions(id);
  }

  async getVersion(id: string, version: number): Promise<TemplateResponseDto | null> {
    const result = await this.workflowRepo.getDefinitionVersion(id, version);
    return result ? this.mapToDto(result) : null;
  }

  async diffVersions(id: string, fromVersion: number, toVersion?: number): Promise<WorkflowVersionDiffResponse | null> {
    const from = await this.workflowRepo.getDefinitionVersion(id, fromVersion);
    const to = toVersion
      ? await this.workflowRepo.getDefinitionVersion(id, toVersion)
      : await this.workflowRepo.getDefinition(id);

    if (!from || !to) return null;

    const before = comparableWorkflow(from);
    const after = comparableWorkflow(to);
    return {
      definition_id: id,
      from_version: from.version,
      to_version: to.version || null,
      from: summarizeVersion(from),
      to: summarizeVersion(to),
      changes: diffValues(before, after),
    };
  }

  async rollback(id: string, version: number, actorId = 'system'): Promise<TemplateResponseDto | null> {
    const snapshot = await this.workflowRepo.getDefinitionVersion(id, version);
    if (!snapshot) return null;

    await this.assertCredentialBindings(
      snapshot.nodes || [],
      snapshot.group_id || snapshot.metadata?.group_id || null,
    );
    await this.assertNoWorkflowCallCycle(id, snapshot.nodes || []);
    const restored = await this.workflowRepo.restoreDefinitionVersion(id, version, { updated_by: actorId });
    if (!restored) return null;

    await this.schedulesService.syncDefinitionSchedules(id, restored.name, restored.nodes || []);
    await this.dbWatchService.syncDefinitionWatchJobs(id, restored.name, restored.nodes || []);
    return this.mapToDto(restored);
  }

  private mapToDto(row: any): TemplateResponseDto {
    const metadata = this.normalizeMetadata({
      ...(row.metadata || {}),
      description: row.description ?? row.metadata?.description,
      group: row.group ?? row.metadata?.group,
      group_id: row.group_id ?? row.metadata?.group_id,
      tags: row.tags ?? row.metadata?.tags,
      version_note: row.version_note ?? row.metadata?.version_note,
    });

    return {
      id: row.id,
      name: row.name,
      description: metadata.description || '',
      group: metadata.group || '',
      group_id: metadata.group_id || null,
      tags: metadata.tags || [],
      version_note: metadata.version_note || '',
      imported_from: metadata.imported_from,
      nodes: row.nodes || [],
      edges: row.edges || [],
      version: row.version || 1,
      is_active: row.is_active !== undefined ? row.is_active : row.status !== 'DELETED',
      created_by: row.created_by || row.metadata?.created_by || 'admin',
      updated_by: row.updated_by || row.metadata?.updated_by || 'admin',
      created_at: row.created_at || new Date(),
      updated_at: row.updated_at || new Date(),
    };
  }

  private normalizeMetadata(input: Partial<WorkflowDefinitionMetadata> | any): WorkflowDefinitionMetadata {
    return {
      description: typeof input?.description === 'string' ? input.description : '',
      group: typeof input?.group === 'string' ? input.group : '',
      group_id: typeof input?.group_id === 'string' && input.group_id.trim() ? input.group_id.trim() : null,
      tags: Array.isArray(input?.tags)
        ? input.tags.map((tag) => String(tag).trim()).filter(Boolean)
        : typeof input?.tags === 'string'
          ? input.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
          : [],
      version_note: typeof input?.version_note === 'string' ? input.version_note : '',
      imported_from: normalizeImportSourceMetadata(input?.imported_from),
      created_by: typeof input?.created_by === 'string' ? input.created_by : null,
      updated_by: typeof input?.updated_by === 'string' ? input.updated_by : null,
    };
  }

  private async assertNoWorkflowCallCycle(definitionId: string, nodes: any[]): Promise<void> {
    const graph = new Map<string, string[]>();
    const definitions = await this.workflowRepo.listDefinitions();

    for (const definition of definitions) {
      const fullDefinition = await this.workflowRepo.getDefinition(definition.id);
      if (!fullDefinition?.id) {
        continue;
      }
      graph.set(fullDefinition.id, extractWorkflowCallTargets(fullDefinition.nodes || []));
    }

    graph.set(definitionId, extractWorkflowCallTargets(nodes || []));

    const visited = new Set<string>();
    const path: string[] = [];
    const findCycle = (currentId: string): string[] | null => {
      if (path.includes(currentId)) {
        return [...path.slice(path.indexOf(currentId)), currentId];
      }
      if (visited.has(currentId)) {
        return null;
      }
      visited.add(currentId);
      path.push(currentId);
      for (const targetId of graph.get(currentId) || []) {
        if (!graph.has(targetId)) {
          continue;
        }
        const cycle = findCycle(targetId);
        if (cycle) {
          return cycle;
        }
      }
      path.pop();
      return null;
    };

    const cycle = findCycle(definitionId);
    if (cycle?.includes(definitionId)) {
      throw new BadRequestException(`Workflow call cycle detected: ${cycle.join(' -> ')}`);
    }
  }

  private async assertCredentialBindings(nodes: any[], groupId?: string | null): Promise<void> {
    const credentialIds = [...collectCredentialIds(nodes)];
    if (credentialIds.length === 0) return;
    if (!groupId) {
      throw new BadRequestException('Workflow group_id is required when using credentials');
    }
    await Promise.all(
      credentialIds.map((credentialId) => this.credentialsService.getForRuntime(credentialId, groupId)),
    );
  }
}

export type WorkflowVersionDiffResponse = {
  definition_id: string;
  from_version: number;
  to_version: number | null;
  from: WorkflowVersionSummary;
  to: WorkflowVersionSummary;
  changes: WorkflowVersionChange[];
};

type WorkflowVersionSummary = {
  version: number;
  name: string;
  version_note?: string;
  node_count: number;
  edge_count: number;
  created_at?: string;
  updated_at?: string;
};

type WorkflowVersionChange = {
  path: string;
  type: 'added' | 'removed' | 'changed';
  before?: any;
  after?: any;
};

function comparableWorkflow(definition: any) {
  return sortObjectKeys({
    name: definition.name,
    metadata: {
      description: definition.description || definition.metadata?.description || '',
      group: definition.group || definition.metadata?.group || '',
      tags: definition.tags || definition.metadata?.tags || [],
      version_note: definition.version_note || definition.metadata?.version_note || '',
    },
    nodes: (definition.nodes || []).map(normalizeGraphItem).sort(compareById),
    edges: (definition.edges || []).map(normalizeGraphItem).sort(compareById),
  });
}

function summarizeVersion(definition: any): WorkflowVersionSummary {
  return {
    version: definition.version || 1,
    name: definition.name,
    version_note: definition.version_note || definition.metadata?.version_note || '',
    node_count: Array.isArray(definition.nodes) ? definition.nodes.length : 0,
    edge_count: Array.isArray(definition.edges) ? definition.edges.length : 0,
    created_at: definition.created_at,
    updated_at: definition.updated_at,
  };
}

function normalizeGraphItem(item: any) {
  return sortObjectKeys(item || {});
}

function compareById(a: any, b: any) {
  return String(a?.id || a?.source || '').localeCompare(String(b?.id || b?.source || ''));
}

function diffValues(before: any, after: any, path = ''): WorkflowVersionChange[] {
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return [];
  }

  if (!isPlainObject(before) || !isPlainObject(after)) {
    return [{ path: path || '$', type: 'changed', before, after }];
  }

  const changes: WorkflowVersionChange[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    const childPath = path ? `${path}.${key}` : key;
    if (!(key in before)) {
      changes.push({ path: childPath, type: 'added', after: after[key] });
      continue;
    }
    if (!(key in after)) {
      changes.push({ path: childPath, type: 'removed', before: before[key] });
      continue;
    }
    changes.push(...diffValues(before[key], after[key], childPath));
  }
  return changes;
}

function sortObjectKeys(value: any): any {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.keys(value)
    .sort()
    .reduce<Record<string, any>>((acc, key) => {
      acc[key] = sortObjectKeys(value[key]);
      return acc;
    }, {});
}

function isPlainObject(value: any): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const SECRET_KEY_PATTERN = /(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|connection_uri|authorization|credential)/i;

function shouldRedactSecretKey(key: string): boolean {
  if (/^credential[_-]?id$/i.test(key)) {
    return false;
  }
  return SECRET_KEY_PATTERN.test(key);
}

function redactSecrets<T>(value: T, redactedPaths: string[], path: string): T {
  if (Array.isArray(value)) {
    return value.map((item, index) => redactSecrets(item, redactedPaths, `${path}[${index}]`)) as T;
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const result: Record<string, any> = {};
  for (const [key, child] of Object.entries(value as Record<string, any>)) {
    const childPath = `${path}.${key}`;
    if (shouldRedactSecretKey(key)) {
      if (child !== undefined && child !== null && child !== '') {
        redactedPaths.push(childPath);
      }
      result[key] = null;
      continue;
    }
    result[key] = redactSecrets(child, redactedPaths, childPath);
  }
  return result as T;
}

function extractPluginDependencies(nodes: any[]) {
  const dependencies = new Map<string, { plugin_id: string; version?: string; node_ids: string[] }>();

  for (const node of nodes || []) {
    const pluginId = node?.data?.plugin_id || node?.plugin_id;
    if (typeof pluginId !== 'string' || !pluginId.trim()) {
      continue;
    }
    const version = node?.data?.plugin_version || node?.plugin_version;
    const key = `${pluginId}@${typeof version === 'string' ? version : ''}`;
    const current =
      dependencies.get(key) ||
      {
        plugin_id: pluginId,
        ...(typeof version === 'string' && version ? { version } : {}),
        node_ids: [],
      };
    if (node?.id) {
      current.node_ids.push(String(node.id));
    }
    dependencies.set(key, current);
  }

  return [...dependencies.values()];
}

function extractWorkflowCallTargets(nodes: any[]): string[] {
  return (nodes || [])
    .filter((node) => (node?.data?.nodeType || node?.node_type || node?.type) === 'workflow_call')
    .map((node) => node?.data?.targetWorkflowId || node?.data?.targetDefinitionId || node?.targetWorkflowId)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());
}

function parseWorkflowExportDocument(document: any): WorkflowExportDocument {
  if (!document || typeof document !== 'object') {
    throw new Error('Import document must be a JSON object');
  }
  if (document.schema_version !== 'pxm.workflow.v1') {
    throw new Error('Unsupported workflow schema_version');
  }

  const workflow = document.workflow;
  if (!workflow || typeof workflow !== 'object') {
    throw new Error('workflow is required');
  }
  if (typeof workflow.name !== 'string' || !workflow.name.trim()) {
    throw new Error('workflow.name is required');
  }
  if (!Array.isArray(workflow.nodes)) {
    throw new Error('workflow.nodes must be an array');
  }
  if (!Array.isArray(workflow.edges)) {
    throw new Error('workflow.edges must be an array');
  }

  const nodeIds = new Set<string>();
  for (const node of workflow.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id.trim()) {
      throw new Error('Every node must have an id');
    }
    if (!node.data || typeof node.data.nodeType !== 'string') {
      throw new Error(`Node ${node.id} must have data.nodeType`);
    }
    nodeIds.add(node.id);
  }

  for (const edge of workflow.edges) {
    if (!edge || typeof edge.source !== 'string' || typeof edge.target !== 'string') {
      throw new Error('Every edge must have source and target');
    }
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new Error(`Edge ${edge.id || `${edge.source}->${edge.target}`} references unknown node`);
    }
  }

  const metadata = workflow.metadata || {};
  return {
    schema_version: 'pxm.workflow.v1',
    exported_at: typeof document.exported_at === 'string' ? document.exported_at : new Date().toISOString(),
    workflow: {
      definition_id: typeof workflow.definition_id === 'string' ? workflow.definition_id : undefined,
      version: Number.isInteger(workflow.version) && workflow.version > 0 ? workflow.version : undefined,
      exported_version_note:
        typeof workflow.exported_version_note === 'string'
          ? workflow.exported_version_note
          : typeof metadata.version_note === 'string'
            ? metadata.version_note
            : '',
      name: workflow.name.trim(),
      metadata: {
        description: typeof metadata.description === 'string' ? metadata.description : '',
        group: typeof metadata.group === 'string' ? metadata.group : '',
        group_id: typeof metadata.group_id === 'string' && metadata.group_id.trim()
          ? metadata.group_id.trim()
          : null,
        tags: Array.isArray(metadata.tags) ? metadata.tags.map((tag) => String(tag).trim()).filter(Boolean) : [],
        version_note: typeof metadata.version_note === 'string' ? metadata.version_note : '',
        imported_from: normalizeImportSourceMetadata(metadata.imported_from),
      },
      nodes: workflow.nodes,
      edges: workflow.edges,
      plugin_dependencies: Array.isArray(workflow.plugin_dependencies)
        ? workflow.plugin_dependencies
        : extractPluginDependencies(workflow.nodes),
    },
    security: {
      secrets_policy: 'redacted',
      redacted_paths: Array.isArray(document.security?.redacted_paths)
        ? document.security.redacted_paths.map(String)
        : [],
    },
  };
}

function buildImportSourceMetadata(document: WorkflowExportDocument) {
  return normalizeImportSourceMetadata({
    schema_version: document.schema_version,
    definition_id: document.workflow.definition_id,
    version: document.workflow.version,
    exported_version_note: document.workflow.exported_version_note || document.workflow.metadata.version_note,
    exported_at: document.exported_at,
  });
}

function normalizeImportSourceMetadata(value: any) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const version = Number(value.version);
  const metadata = {
    schema_version: typeof value.schema_version === 'string' ? value.schema_version : 'pxm.workflow.v1',
    definition_id: typeof value.definition_id === 'string' ? value.definition_id : undefined,
    version: Number.isInteger(version) && version > 0 ? version : undefined,
    exported_version_note:
      typeof value.exported_version_note === 'string' ? value.exported_version_note : undefined,
    exported_at: typeof value.exported_at === 'string' ? value.exported_at : undefined,
  };

  return Object.values(metadata).some((item) => item !== undefined) ? metadata : undefined;
}

function collectCredentialIds(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectCredentialIds(item, result));
    return result;
  }
  if (!value || typeof value !== 'object') return result;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalizedKey.endsWith('credentialid') && typeof child === 'string' && child.trim()) {
      result.add(child.trim());
      continue;
    }
    collectCredentialIds(child, result);
  }
  return result;
}
