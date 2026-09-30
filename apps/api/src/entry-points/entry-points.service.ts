import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PxmGroup, WorkflowHistoryActor } from '../db/ports/db.ports';
import {
  EntryPoint,
  EntryPointConflictError,
  EntryPointKind,
  EntryPointPatch,
  EntryPointRepositoryPort,
  EntryPointResourceDigest,
  EntryPointSideEffect,
  EntryPointStatus,
} from '../db/ports/entry-points.port';
import { AuthzService } from '../authz/authz.service';
import {
  assertCanManageGroup,
  canViewGroupResources,
} from '../authz/management-auth';
import { ManagementAuditService } from '../audit/management-audit.service';
import { TemplatesService } from '../templates/templates.service';
import {
  CompatibilityReport,
  WorkflowCompatibilityService,
} from '../templates/workflow-compatibility.service';
import type { TemplateResponseDto } from '../templates/dto/template.dto';
import { errorBody } from '../observability/remediation';
import {
  SchemaCheck,
  SchemaIssue,
  checkManualSchemaAgainstForm,
  checkSchemaDialect,
  deriveInputSchema,
  resolveOutputSchema,
} from './entry-point-schema';
import { diffEntryPointSchemas } from './schema-diff';

export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;
/** OpenAI·Anthropic 모두 Tool 이름을 64자로 제한한다 */
const MODEL_TOOL_NAME_LIMIT = 64;
const SIDE_EFFECTS: EntryPointSideEffect[] = [
  'read_only',
  'mutating',
  'requires_approval',
];
const STATUSES: EntryPointStatus[] = ['draft', 'active', 'disabled'];

export type PublishEntryPointInput = {
  kind: EntryPointKind;
  definition_id: string;
  description: string;
  side_effect?: EntryPointSideEffect;
  status?: EntryPointStatus;
  tags?: string[];
  /** 주면 파생 스키마 대신 쓴다(input_schema_source: manual) */
  input_schema?: Record<string, any>;
  tool?: { name: string; display_name?: string | null };
};

export type UpdateEntryPointInput = {
  description?: string;
  side_effect?: EntryPointSideEffect;
  status?: EntryPointStatus;
  tags?: string[];
  display_name?: string | null;
};

export type EntryPointView = EntryPoint & {
  namespace: string | null;
  qualified_name: string | null;
  group_name: string | null;
  workflow: {
    id: string;
    name: string | null;
    lifecycle_status: string | null;
    active_published_version: number | null;
    /** 배포 버전이 고정 버전보다 새로우면 true. 교체는 rebind로만 한다 */
    newer_version_available: boolean;
  };
};

type PublishPlan = {
  template: TemplateResponseDto;
  version: number;
  nodes: any[];
  group: PxmGroup;
  input_schema: Record<string, any>;
  input_schema_source: 'derived' | 'manual';
  output_schema: Record<string, any> | null;
  suggested_side_effect: EntryPointSideEffect;
  resource_digest: EntryPointResourceDigest;
  compatibility: CompatibilityReport;
  blocks: SchemaIssue[];
  warnings: SchemaIssue[];
};

/**
 * 진입점 게시·관리. 실행은 하지 않는다(PXM-70).
 * 권한: 진입점은 연결 워크플로우 권한의 별칭이다. 관리는 워크플로우 소유 그룹의 관리자만 한다.
 */
@Injectable()
export class EntryPointsService {
  constructor(
    private readonly repo: EntryPointRepositoryPort,
    private readonly templates: TemplatesService,
    private readonly authz: AuthzService,
    private readonly compatibility: WorkflowCompatibilityService,
    private readonly audit: ManagementAuditService,
  ) {}

  /** 저장하지 않고 게시 결과(스키마, 차단·경고)를 미리 본다 */
  async preview(actor: WorkflowHistoryActor, input: PublishEntryPointInput) {
    const plan = await this.plan(actor, input);
    return this.planResponse(plan, input);
  }

  async publish(actor: WorkflowHistoryActor, input: PublishEntryPointInput) {
    const plan = await this.plan(actor, input);
    if (plan.blocks.length > 0) {
      throw new UnprocessableEntityException(
        errorBody(
          'ENTRY_POINT_PUBLISH_BLOCKED',
          '게시할 수 없는 항목이 있습니다.',
          undefined,
          {
            blocks: plan.blocks,
            warnings: plan.warnings,
          },
        ),
      );
    }
    const now = new Date().toISOString();
    const entry: EntryPoint = {
      id: randomUUID(),
      kind: input.kind,
      group_id: plan.group.id,
      tenant_id: null,
      definition_id: plan.template.id,
      pinned_version: plan.version,
      input_schema: plan.input_schema,
      input_schema_source: plan.input_schema_source,
      output_schema: plan.output_schema,
      output_contract: plan.output_schema ? 'declared' : 'free_form',
      side_effect: input.side_effect ?? plan.suggested_side_effect,
      status: input.status ?? 'active',
      description: input.description.trim(),
      tags: normalizeTags(input.tags),
      resource_digest: plan.resource_digest,
      history_policy: { body: 'none' },
      tool: input.tool
        ? {
            name: input.tool.name,
            display_name: input.tool.display_name?.trim() || null,
          }
        : null,
      route: null,
      created_by: actor.actor_id || null,
      updated_by: actor.actor_id || null,
      created_at: now,
      updated_at: now,
    };
    let saved: EntryPoint;
    try {
      saved = await this.repo.createEntryPoint(entry);
    } catch (error) {
      throw translateConflict(error);
    }
    await this.audit.append({
      action: 'entry_point.published',
      resource_type: 'entry_point',
      resource_id: saved.id,
      group_id: saved.group_id,
      actor_id: actor.actor_id,
      details: {
        kind: saved.kind,
        name: saved.tool?.name ?? null,
        definition_id: saved.definition_id,
        pinned_version: saved.pinned_version,
      },
    });
    return { entry_point: await this.view(saved), warnings: plan.warnings };
  }

  async list(
    actor: WorkflowHistoryActor,
    query: {
      kind?: EntryPointKind;
      group_id?: string;
      definition_id?: string;
    } = {},
  ) {
    if (actor.api_key_id)
      throw new ForbiddenException('API key cannot use management API');
    const groupIds = query.group_id ? [query.group_id] : undefined;
    const items = await this.repo.listEntryPoints({
      kind: query.kind,
      group_ids: groupIds,
      definition_id: query.definition_id,
    });
    const visible = items.filter((item) =>
      canViewGroupResources(actor, item.group_id),
    );
    return Promise.all(visible.map((item) => this.view(item)));
  }

  async get(actor: WorkflowHistoryActor, id: string) {
    const entry = await this.readable(actor, id);
    const view = await this.view(entry);
    const snapshot = await this.snapshot(
      entry.definition_id,
      entry.pinned_version,
    ).catch(() => null);
    const diagnostics: SchemaIssue[] = [];
    if (!snapshot) {
      diagnostics.push({
        code: 'PINNED_VERSION_MISSING',
        message: `고정한 워크플로우 버전 v${entry.pinned_version}을 찾을 수 없습니다.`,
      });
    }
    if (view.workflow.lifecycle_status !== 'PUBLISHED') {
      diagnostics.push({
        code: 'WORKFLOW_NOT_PUBLISHED',
        message:
          '연결된 워크플로우가 배포 상태가 아닙니다. 호출하면 거부됩니다.',
      });
    }
    if (snapshot) {
      const report = await this.compatibility.evaluate(
        entry.definition_id,
        snapshot.nodes || [],
        entry.group_id,
      );
      diagnostics.push(...compatibilityIssues(report));
    }
    return { entry_point: view, diagnostics };
  }

  async update(
    actor: WorkflowHistoryActor,
    id: string,
    input: UpdateEntryPointInput,
  ) {
    const entry = await this.manageable(actor, id);
    const patch: EntryPointPatch = { updated_by: actor.actor_id || null };
    if (input.description !== undefined) {
      if (!input.description.trim())
        throw new BadRequestException(
          errorBody('DESCRIPTION_REQUIRED', 'description is required'),
        );
      patch.description = input.description.trim();
    }
    if (input.side_effect !== undefined)
      patch.side_effect = assertSideEffect(input.side_effect);
    if (input.status !== undefined) patch.status = assertStatus(input.status);
    if (input.tags !== undefined) patch.tags = normalizeTags(input.tags);
    if (input.display_name !== undefined && entry.tool) {
      patch.tool = {
        ...entry.tool,
        display_name: input.display_name?.trim() || null,
      };
    }
    const saved = await this.repo.updateEntryPoint(id, patch);
    if (!saved) throw new NotFoundException('Entry point not found');
    await this.audit.append({
      action: 'entry_point.updated',
      resource_type: 'entry_point',
      resource_id: id,
      group_id: saved.group_id,
      actor_id: actor.actor_id,
      details: {
        fields: Object.keys(patch).filter((key) => key !== 'updated_by'),
      },
    });
    return { entry_point: await this.view(saved) };
  }

  /**
   * 고정 버전을 워크플로우의 현재 배포 버전으로 바꾼다.
   * 호출하는 쪽이 깨지는 변경이 있으면 confirm_breaking 없이 바꾸지 않는다. dry_run이면 비교만 한다.
   */
  async rebind(
    actor: WorkflowHistoryActor,
    id: string,
    options: { dry_run?: boolean; confirm_breaking?: boolean } = {},
  ) {
    const entry = await this.manageable(actor, id);
    const plan = await this.plan(
      actor,
      {
        kind: entry.kind,
        definition_id: entry.definition_id,
        description: entry.description,
        side_effect: entry.side_effect,
        input_schema:
          entry.input_schema_source === 'manual'
            ? entry.input_schema
            : undefined,
        tool: entry.tool ?? undefined,
      },
      entry.id,
    );
    const diff = diffEntryPointSchemas(
      { input: entry.input_schema, output: entry.output_schema },
      { input: plan.input_schema, output: plan.output_schema },
    );
    const result = {
      from_version: entry.pinned_version,
      to_version: plan.version,
      changes: diff.changes,
      breaking: diff.breaking,
      blocks: plan.blocks,
      warnings: plan.warnings,
    };
    if (options.dry_run) return { ...result, applied: false };
    if (plan.blocks.length > 0) {
      throw new UnprocessableEntityException(
        errorBody(
          'ENTRY_POINT_PUBLISH_BLOCKED',
          '새 버전으로 바꿀 수 없는 항목이 있습니다.',
          undefined,
          result,
        ),
      );
    }
    if (diff.breaking && options.confirm_breaking !== true) {
      throw new ConflictException(
        errorBody(
          'ENTRY_POINT_BREAKING_CHANGE',
          '호출하는 쪽이 깨질 수 있는 변경이 있습니다. 변경 내용을 확인한 뒤 confirm_breaking: true로 다시 요청하세요.',
          {
            actor: 'self',
            action: '변경 내용을 호출하는 쪽과 맞춘 뒤 교체를 확인하세요.',
          },
          result,
        ),
      );
    }
    const saved = await this.repo.updateEntryPoint(id, {
      pinned_version: plan.version,
      input_schema: plan.input_schema,
      output_schema: plan.output_schema,
      output_contract: plan.output_schema ? 'declared' : 'free_form',
      resource_digest: plan.resource_digest,
      updated_by: actor.actor_id || null,
    });
    if (!saved) throw new NotFoundException('Entry point not found');
    await this.audit.append({
      action: 'entry_point.rebound',
      resource_type: 'entry_point',
      resource_id: id,
      group_id: saved.group_id,
      actor_id: actor.actor_id,
      details: {
        from_version: entry.pinned_version,
        to_version: plan.version,
        breaking: diff.breaking,
      },
    });
    return { ...result, applied: true, entry_point: await this.view(saved) };
  }

  async remove(actor: WorkflowHistoryActor, id: string) {
    const entry = await this.manageable(actor, id);
    await this.repo.deleteEntryPoint(id);
    await this.audit.append({
      action: 'entry_point.deleted',
      resource_type: 'entry_point',
      resource_id: id,
      group_id: entry.group_id,
      actor_id: actor.actor_id,
      details: {
        kind: entry.kind,
        name: entry.tool?.name ?? null,
        definition_id: entry.definition_id,
      },
    });
    return { deleted: true };
  }

  private async plan(
    actor: WorkflowHistoryActor,
    input: PublishEntryPointInput,
    existingId?: string,
  ): Promise<PublishPlan> {
    if (input.kind === 'route') {
      throw new BadRequestException(
        errorBody(
          'ENTRY_POINT_KIND_UNSUPPORTED',
          '게이트웨이 라우트 게시는 아직 지원하지 않습니다 (PXM-74).',
        ),
      );
    }
    if (input.kind !== 'tool')
      throw new BadRequestException(
        errorBody('ENTRY_POINT_KIND_INVALID', 'kind must be tool or route'),
      );
    if (!input.tool || !TOOL_NAME_PATTERN.test(input.tool.name ?? '')) {
      throw new BadRequestException(
        errorBody(
          'TOOL_NAME_INVALID',
          'tool.name must match ^[a-z][a-z0-9_]{2,63}$',
        ),
      );
    }
    if (!input.description?.trim()) {
      throw new BadRequestException(
        errorBody('DESCRIPTION_REQUIRED', 'description is required', {
          actor: 'self',
          action: 'AI가 언제 이 Tool을 골라야 하는지 설명을 적으세요.',
        }),
      );
    }
    if (input.side_effect !== undefined) assertSideEffect(input.side_effect);
    if (input.status !== undefined) assertStatus(input.status);

    const template = await this.templates.findOne(input.definition_id);
    if (!template || template.is_active === false)
      throw new NotFoundException('Workflow not found');
    if (!template.group_id) {
      throw new UnprocessableEntityException(
        errorBody(
          'WORKFLOW_GROUP_REQUIRED',
          '관리 그룹이 없는 워크플로우는 게시할 수 없습니다.',
          {
            actor: 'self',
            action: '워크플로우 설정에서 관리 그룹을 지정하세요.',
          },
        ),
      );
    }
    assertCanManageGroup(actor, template.group_id);
    let group = await this.authz.getGroup(template.group_id);
    group = await this.authz.ensureGroupNamespace(group);

    const blocks: SchemaIssue[] = [];
    const warnings: SchemaIssue[] = [];
    const version =
      template.lifecycle_status === 'PUBLISHED'
        ? template.active_published_version
        : null;
    if (!version) {
      throw new UnprocessableEntityException(
        errorBody(
          'WORKFLOW_NOT_PUBLISHED',
          '배포된 워크플로우만 게시할 수 있습니다.',
          {
            actor: 'self',
            action: '워크플로우를 먼저 배포하세요.',
          },
        ),
      );
    }
    const snapshot = await this.snapshot(template.id, version);
    if (!snapshot)
      throw new UnprocessableEntityException(
        errorBody(
          'WORKFLOW_VERSION_MISSING',
          `워크플로우 버전 v${version}을 찾을 수 없습니다.`,
        ),
      );
    const nodes = snapshot.nodes || [];

    if (!nodes.some((node: any) => node?.data?.nodeType === 'end')) {
      blocks.push({
        code: 'END_NODE_MISSING',
        message: 'End 노드가 없습니다.',
      });
    }

    const derived = deriveInputSchema(nodes);
    let inputSchema = derived.schema;
    let source: 'derived' | 'manual' = 'derived';
    push(derived, blocks, warnings);
    if (input.input_schema !== undefined) {
      inputSchema = input.input_schema;
      source = 'manual';
      push(checkManualSchemaAgainstForm(inputSchema, nodes), blocks, warnings);
    }
    push(checkSchemaDialect(inputSchema), blocks, warnings);

    const output = resolveOutputSchema(nodes);
    push(output, blocks, warnings);

    const hasApproval = nodes.some(
      (node: any) => node?.data?.nodeType === 'approval',
    );
    const suggested: EntryPointSideEffect = hasApproval
      ? 'requires_approval'
      : 'mutating';
    if (
      hasApproval &&
      input.side_effect &&
      input.side_effect !== 'requires_approval'
    ) {
      warnings.push({
        code: 'SIDE_EFFECT_APPROVAL_MISMATCH',
        message:
          '결재 노드가 있는데 부작용 구분이 "승인 필요"가 아닙니다. 호출하는 쪽이 승인 대기를 예상하지 못할 수 있습니다.',
      });
    }

    const qualified = `${group.namespace}__${input.tool.name}`;
    if (qualified.length > MODEL_TOOL_NAME_LIMIT) {
      warnings.push({
        code: 'QUALIFIED_NAME_TOO_LONG',
        message: `다른 그룹과 이름이 겹칠 때 쓰는 이름(${qualified})이 ${MODEL_TOOL_NAME_LIMIT}자를 넘어 일부 모델에서 쓸 수 없습니다.`,
      });
    }

    const duplicates = await this.repo.listEntryPoints({
      kind: 'tool',
      group_ids: [group.id],
      tool_name: input.tool.name,
    });
    if (duplicates.some((item) => item.id !== existingId)) {
      blocks.push({
        code: 'TOOL_NAME_TAKEN',
        field: 'tool.name',
        message: `이 그룹에 ${input.tool.name} Tool이 이미 있습니다.`,
      });
    }

    const compatibility = await this.compatibility.evaluate(
      template.id,
      nodes,
      group.id,
    );
    warnings.push(...compatibilityIssues(compatibility));

    return {
      template,
      version,
      nodes,
      group,
      input_schema: inputSchema,
      input_schema_source: source,
      output_schema: output.schema,
      suggested_side_effect: suggested,
      resource_digest: resourceDigest(compatibility),
      compatibility,
      blocks,
      warnings,
    };
  }

  private planResponse(plan: PublishPlan, input: PublishEntryPointInput) {
    return {
      publishable: plan.blocks.length === 0,
      definition_id: plan.template.id,
      pinned_version: plan.version,
      group_id: plan.group.id,
      namespace: plan.group.namespace ?? null,
      qualified_name: input.tool
        ? `${plan.group.namespace}__${input.tool.name}`
        : null,
      input_schema: plan.input_schema,
      input_schema_source: plan.input_schema_source,
      output_schema: plan.output_schema,
      output_contract: plan.output_schema ? 'declared' : 'free_form',
      suggested_side_effect: plan.suggested_side_effect,
      resource_digest: plan.resource_digest,
      blocks: plan.blocks,
      warnings: plan.warnings,
    };
  }

  private async snapshot(
    definitionId: string,
    version: number,
  ): Promise<TemplateResponseDto | null> {
    const snapshot = await this.templates.getVersion(definitionId, version);
    if (snapshot) return snapshot;
    const current = await this.templates.findOne(definitionId);
    return current && Number(current.version) === version ? current : null;
  }

  private async readable(
    actor: WorkflowHistoryActor,
    id: string,
  ): Promise<EntryPoint> {
    if (actor.api_key_id)
      throw new ForbiddenException('API key cannot use management API');
    const entry = await this.repo.getEntryPoint(id);
    // 볼 수 없는 진입점은 있는지도 알리지 않는다
    if (!entry || !canViewGroupResources(actor, entry.group_id))
      throw new NotFoundException('Entry point not found');
    return entry;
  }

  private async manageable(
    actor: WorkflowHistoryActor,
    id: string,
  ): Promise<EntryPoint> {
    const entry = await this.readable(actor, id);
    assertCanManageGroup(actor, entry.group_id);
    return entry;
  }

  private async view(entry: EntryPoint): Promise<EntryPointView> {
    const [group, template] = await Promise.all([
      this.authz.getGroup(entry.group_id).catch(() => null),
      this.templates.findOne(entry.definition_id).catch(() => null),
    ]);
    const namespace = group?.namespace ?? null;
    const active =
      template?.lifecycle_status === 'PUBLISHED'
        ? template.active_published_version
        : null;
    return {
      ...entry,
      namespace,
      qualified_name:
        entry.tool && namespace ? `${namespace}__${entry.tool.name}` : null,
      group_name: group?.name ?? null,
      workflow: {
        id: entry.definition_id,
        name: template?.name ?? null,
        lifecycle_status: template?.lifecycle_status ?? null,
        active_published_version: active ?? null,
        newer_version_available: Boolean(
          active && active > entry.pinned_version,
        ),
      },
    };
  }
}

function push(
  check: SchemaCheck,
  blocks: SchemaIssue[],
  warnings: SchemaIssue[],
) {
  blocks.push(...check.blocks);
  warnings.push(...check.warnings);
}

function compatibilityIssues(report: CompatibilityReport): SchemaIssue[] {
  return report.items
    .filter((item) => item.status !== 'ok')
    .map((item) => ({
      code: `RESOURCE_${item.status.toUpperCase()}`,
      field: item.ref,
      message: `${item.label}: ${item.message}`,
    }));
}

function resourceDigest(report: CompatibilityReport): EntryPointResourceDigest {
  const refs = (kind: string) =>
    [
      ...new Set(
        report.items
          .filter((item) => item.kind === kind)
          .map((item) => item.ref),
      ),
    ].sort();
  return {
    computed_at: new Date().toISOString(),
    plugins: refs('plugin'),
    script_libraries: refs('script_library'),
    credentials: refs('credential'),
    commands: refs('command'),
    workflow_calls: refs('workflow_call'),
  };
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return [
    ...new Set(
      tags
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);
}

function assertSideEffect(value: string): EntryPointSideEffect {
  if (!SIDE_EFFECTS.includes(value as EntryPointSideEffect)) {
    throw new BadRequestException(
      errorBody(
        'SIDE_EFFECT_INVALID',
        `side_effect must be one of ${SIDE_EFFECTS.join(', ')}`,
      ),
    );
  }
  return value as EntryPointSideEffect;
}

function assertStatus(value: string): EntryPointStatus {
  if (!STATUSES.includes(value as EntryPointStatus)) {
    throw new BadRequestException(
      errorBody(
        'STATUS_INVALID',
        `status must be one of ${STATUSES.join(', ')}`,
      ),
    );
  }
  return value as EntryPointStatus;
}

function translateConflict(error: unknown): unknown {
  if (error instanceof EntryPointConflictError) {
    return new ConflictException(
      errorBody(
        'TOOL_NAME_TAKEN',
        '이 그룹에 같은 이름의 Tool이 이미 있습니다.',
      ),
    );
  }
  return error;
}
