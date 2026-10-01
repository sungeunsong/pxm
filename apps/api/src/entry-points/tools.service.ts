import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { STATUS_CODES } from 'http';
import {
  WorkflowInstanceRepositoryPort,
  WorkflowTaskRepositoryPort,
  type PxmGroup,
  type WorkflowHistoryActor,
  type WorkflowInstanceAccess,
} from '../db/ports/db.ports';
import {
  EntryPoint,
  EntryPointRepositoryPort,
  EntryPointSideEffect,
} from '../db/ports/entry-points.port';
import { AuthzService } from '../authz/authz.service';
import { canViewGroupResources } from '../authz/management-auth';
import { InstancesService } from '../instances/instances.service';
import { TemplatesService } from '../templates/templates.service';
import { normalizeWorkflowInputValues } from '../templates/templates.controller';
import {
  WorkflowStartService,
  normalizeIdempotencyKey,
  normalizeSyncTimeoutMs,
} from '../templates/workflow-start.service';
import { errorBody } from '../observability/remediation';

export type ToolNaming = 'auto' | 'qualified' | 'plain';
type ToolScope = 'tool:read' | 'tool:invoke';

export type ToolInvokeBody = {
  arguments?: unknown;
  group_id?: string;
  mode?: 'sync' | 'async';
  sync_timeout_ms?: number;
  on_behalf_of?: unknown;
  trace_context?: unknown;
};

/** 응답 상태 코드·헤더·본문. 실행 실패도 이 모양으로 돌려준다(Retry-After를 붙이기 위해) */
export type ToolInvokeOutcome = {
  http_status: number;
  headers: Record<string, string>;
  body: Record<string, any>;
};

type ResolvedTool = {
  entry: EntryPoint;
  group: PxmGroup | null;
  qualified_name: string;
};

/** failure_type → HTTP. 재시도 판단은 HTTP가 아니라 retryable로 한다 (ai-tool-publish-design.md 8.4) */
const FAILURE_HTTP_STATUS: Record<string, number> = {
  configuration: 422,
  upstream_error: 502,
  timeout: 504,
  script_error: 500,
  subworkflow_failed: 502,
  internal: 500,
};
const RETRY_AFTER_SECONDS = '5';

/**
 * AI 하네스가 부르는 Tool 공개 API의 본체. 입구는 얇게 둔다:
 * 이름 해석 → 권한 → 입력 검증 → 고정 버전 실행 → 결과 대기 → 응답 변환.
 * 권한은 연결 워크플로우 실행 권한의 별칭이다. API Key는 tool:* 권한 범위로 용도만 나눈다.
 */
@Injectable()
export class ToolsService {
  constructor(
    private readonly repo: EntryPointRepositoryPort,
    private readonly templates: TemplatesService,
    private readonly authz: AuthzService,
    private readonly workflowStart: WorkflowStartService,
    private readonly instances: InstancesService,
    private readonly taskRepo: WorkflowTaskRepositoryPort,
    private readonly instanceRepo: WorkflowInstanceRepositoryPort,
  ) {}

  async list(
    actor: WorkflowHistoryActor,
    query: { naming?: string; side_effect?: string; tags?: string } = {},
  ) {
    assertScope(actor, 'tool:read');
    const naming = parseNaming(query.naming);
    const sideEffects = splitList(query.side_effect) as EntryPointSideEffect[];
    const tags = splitList(query.tags);
    const tools = (await this.usableTools(actor, 'tool:read')).filter(
      ({ entry }) =>
        entry.status === 'active' &&
        (sideEffects.length === 0 || sideEffects.includes(entry.side_effect)) &&
        (tags.length === 0 || entry.tags.some((tag) => tags.includes(tag))),
    );
    const counts = new Map<string, number>();
    for (const { entry } of tools)
      counts.set(entry.tool!.name, (counts.get(entry.tool!.name) ?? 0) + 1);
    const conflicts = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([name]) => name);
    if (naming === 'plain' && conflicts.length > 0) {
      throw new ConflictException(
        errorBody(
          'TOOL_NAME_CONFLICT',
          '같은 이름의 Tool이 여러 그룹에 있어 naming=plain으로 나열할 수 없습니다.',
          undefined,
          {
            conflicts: tools
              .filter(({ entry }) => conflicts.includes(entry.tool!.name))
              .map(({ qualified_name }) => qualified_name),
          },
        ),
      );
    }
    return {
      tools: tools.map((tool) => {
        const conflict = conflicts.includes(tool.entry.tool!.name);
        const useQualified =
          naming === 'qualified' || (naming === 'auto' && conflict);
        return toolDefinition(
          tool,
          useQualified ? tool.qualified_name : tool.entry.tool!.name,
          conflict,
        );
      }),
      has_name_conflict: conflicts.length > 0,
    };
  }

  async describe(actor: WorkflowHistoryActor, name: string, groupId?: string) {
    assertScope(actor, 'tool:read');
    const tool = await this.resolve(actor, 'tool:read', name, groupId);
    return toolDefinition(tool, tool.entry.tool!.name, false);
  }

  async invoke(
    actor: WorkflowHistoryActor,
    name: string,
    body: ToolInvokeBody,
    context: {
      idempotencyKey?: string;
      access: (formData: Record<string, any>) => WorkflowInstanceAccess;
      requestId: string;
    },
  ): Promise<ToolInvokeOutcome> {
    assertScope(actor, 'tool:invoke');
    const tool = await this.resolve(
      actor,
      'tool:invoke',
      name,
      optionalString(body?.group_id),
    );
    if (tool.entry.status !== 'active') {
      throw new ConflictException(
        errorBody('TOOL_DISABLED', 'Tool is not active', undefined, {
          retryable: false,
        }),
      );
    }
    return this.run(actor, tool, body, context);
  }

  /** 콘솔 시험 호출. 관리 권한은 부르는 쪽이 확인한다. 상태와 상관없이 고정 버전을 실제로 실행한다 */
  async test(
    actor: WorkflowHistoryActor,
    entry: EntryPoint,
    body: ToolInvokeBody,
    context: {
      access: (formData: Record<string, any>) => WorkflowInstanceAccess;
      requestId: string;
    },
  ): Promise<ToolInvokeOutcome> {
    const group = await this.authz.getGroup(entry.group_id).catch(() => null);
    const tool = { entry, group, qualified_name: qualifiedName(group, entry) };
    return this.run(actor, tool, body, { ...context, test: true });
  }

  private async run(
    actor: WorkflowHistoryActor,
    tool: ResolvedTool,
    body: ToolInvokeBody,
    context: {
      idempotencyKey?: string;
      access: (formData: Record<string, any>) => WorkflowInstanceAccess;
      requestId: string;
      test?: boolean;
    },
  ): Promise<ToolInvokeOutcome> {
    const { entry } = tool;
    if (body?.on_behalf_of !== undefined && body.on_behalf_of !== null) {
      // 최종 사용자 검증(PXM-71) 전에 받으면 권한을 좁히지 못한 채 실행된다. 조용히 무시하지 않는다
      throw new BadRequestException(
        errorBody(
          'ON_BEHALF_OF_UNSUPPORTED',
          'on_behalf_of is not supported yet',
          undefined,
          { retryable: false },
        ),
      );
    }
    const args = body?.arguments ?? {};
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new BadRequestException(
        toolInputInvalid(['arguments는 JSON object여야 합니다.']),
      );
    }
    const mode = body?.mode === 'async' ? 'async' : 'sync';
    const idempotencyKey = normalizeIdempotencyKey(context.idempotencyKey);

    const current = await this.templates.findOne(entry.definition_id);
    const template =
      current &&
      current.is_active !== false &&
      current.lifecycle_status === 'PUBLISHED'
        ? await this.templates.findVersionForExecution(
            entry.definition_id,
            entry.pinned_version,
          )
        : null;
    if (!template) {
      throw new ConflictException(
        errorBody(
          'TOOL_VERSION_UNAVAILABLE',
          '연결된 워크플로우가 배포 상태가 아니거나 고정 버전을 찾을 수 없습니다.',
          {
            actor: 'group_manager',
            action: '워크플로우를 다시 배포하거나 Tool의 버전을 교체하세요.',
            group_id: entry.group_id,
          },
          { retryable: false },
        ),
      );
    }

    const normalized = normalizeWorkflowInputValues(template.nodes, args);
    if (normalized.errors.length > 0) {
      throw new BadRequestException(toolInputInvalid(normalized.errors));
    }

    const started = await this.workflowStart.start({
      template,
      actor,
      access: context.access(normalized.values),
      formData: normalized.values,
      idempotencyKey,
      idempotencyScope: `entry_point:${entry.id}`,
      reason: context.test ? 'tool_test' : 'tool_invoke',
      entryPoint: {
        id: entry.id,
        kind: entry.kind,
        name: entry.tool?.name ?? null,
        qualified_name: tool.qualified_name,
        pinned_version: entry.pinned_version,
        test: context.test === true,
      },
    });

    const base = {
      tool: entry.tool!.name,
      qualified_name: tool.qualified_name,
      instance_id: started.instance_id,
      // Tool 전용 키(tool:invoke)도 읽을 수 있는 상태 조회. 실행 결과 API는 workflow:read가 필요하다
      result_url: `/api/v1/tools/invocations/${started.instance_id}`,
      ...instanceLinks(actor, started.instance_id),
      idempotent_replay: started.idempotent_replay,
      request_id: context.requestId,
    };
    const headers: Record<string, string> = started.idempotent_replay
      ? { 'Idempotency-Replayed': 'true' }
      : {};

    if (mode === 'async') {
      return {
        http_status: HttpStatus.ACCEPTED,
        headers,
        body: { ...base, status: 'running', result: null },
      };
    }

    let pending: Record<string, any> | null = null;
    const latest = await this.instances.waitForResult(
      started.instance_id,
      normalizeSyncTimeoutMs(body?.sync_timeout_ms),
      undefined,
      async (snapshot) => {
        if (String(snapshot?.status).toUpperCase() !== 'WAITING') return false;
        pending = await this.pendingApproval(started.instance_id);
        return pending !== null;
      },
    );
    const outcome = this.toOutcome(base, latest, pending);
    return { ...outcome, headers: { ...headers, ...outcome.headers } };
  }

  private toOutcome(
    base: Record<string, any>,
    latest: Record<string, any>,
    pending: Record<string, any> | null,
  ): ToolInvokeOutcome {
    const state = String(latest?.status || '').toUpperCase();
    const outcome = latest?.outcome ?? null;
    const reason = latest?.outcome_reason ?? null;

    if (latest?.settled && pending) {
      return {
        http_status: HttpStatus.ACCEPTED,
        headers: {},
        body: { ...base, status: 'pending_approval', result: null, pending },
      };
    }
    if (
      latest?.timedOut ||
      !['COMPLETED', 'FAILED', 'TERMINATED'].includes(state)
    ) {
      return {
        http_status: HttpStatus.ACCEPTED,
        headers: {},
        body: { ...base, status: 'running', result: null },
      };
    }
    if (state === 'COMPLETED' && (outcome === 'SUCCESS' || outcome === null)) {
      return {
        http_status: HttpStatus.OK,
        headers: {},
        body: {
          ...base,
          status: 'ok',
          outcome: 'SUCCESS',
          result: latest.result ?? null,
        },
      };
    }
    if (
      state === 'COMPLETED' &&
      (outcome === 'REJECTED' || outcome === 'FAILURE')
    ) {
      // 워크플로우는 정상 완료했고 업무 결과가 실패다. 재시도 대상이 아니다
      return {
        http_status: HttpStatus.OK,
        headers: {},
        body: {
          ...base,
          status: 'error',
          outcome,
          result: latest.result ?? null,
          error: {
            kind: 'business',
            code:
              outcome === 'REJECTED'
                ? 'APPROVAL_REJECTED'
                : reason?.code || 'BUSINESS_FAILURE',
            message:
              reason?.message ||
              (outcome === 'REJECTED'
                ? '결재가 반려되었습니다.'
                : '업무 처리 결과가 실패입니다.'),
            retryable: false,
          },
        },
      };
    }
    if (state === 'TERMINATED' || outcome === 'CANCELLED') {
      return {
        http_status: HttpStatus.CONFLICT,
        headers: {},
        body: errorResponse(HttpStatus.CONFLICT, base, {
          code: 'TOOL_EXECUTION_TERMINATED',
          message: '실행이 중간에 종료되었습니다.',
          failure_type: null,
          retryable: false,
        }),
      };
    }
    const failureType =
      typeof reason?.failure_type === 'string'
        ? reason.failure_type
        : 'internal';
    const retryable = reason?.retryable === true;
    const status = FAILURE_HTTP_STATUS[failureType] ?? 500;
    return {
      http_status: status,
      headers: retryable ? { 'Retry-After': RETRY_AFTER_SECONDS } : {},
      body: errorResponse(status, base, {
        code: 'TOOL_EXECUTION_FAILED',
        message: reason?.message || '노드 실행이 실패했습니다.',
        failure_type: failureType,
        retryable,
        failed_node_id: reason?.node_id ?? null,
      }),
    };
  }

  /**
   * 202(결재 대기·진행 중)를 받은 뒤 결과를 확인한다. 응답 모양은 invoke와 같다.
   * Tool로 시작한 실행만 대상이고, 지금 그 워크플로우를 실행할 수 있는 호출자만 본다.
   */
  async invocation(
    actor: WorkflowHistoryActor,
    instanceId: string,
    requestId: string,
  ): Promise<ToolInvokeOutcome> {
    assertScope(actor, 'tool:invoke');
    const instance = await this.instanceRepo
      .getInstance(instanceId)
      .catch(() => null);
    const context = instance?.context ?? instance?.ctx ?? {};
    const snapshot = context.runtime?.snapshot?.entry_point;
    const definitionId = String(
      instance?.process_definition_id || instance?.definition_id || '',
    );
    const groupId =
      instance?.group_id || context.runtime?.access?.group_id || null;
    const visible =
      instance &&
      snapshot?.kind === 'tool' &&
      groupId &&
      (actor.api_key_id
        ? actor.group_ids?.includes(groupId) &&
          actor.allowed_workflow_ids.includes(definitionId)
        : canViewGroupResources(actor, groupId));
    if (!visible) {
      throw new NotFoundException(
        errorBody(
          'TOOL_INVOCATION_NOT_FOUND',
          'Tool invocation not found',
          undefined,
          { retryable: false },
        ),
      );
    }
    const base = {
      tool: snapshot.name,
      qualified_name: snapshot.qualified_name,
      instance_id: instanceId,
      result_url: `/api/v1/tools/invocations/${instanceId}`,
      ...instanceLinks(actor, instanceId),
      idempotent_replay: false,
      request_id: requestId,
    };
    const latest = await this.instances.getResult(instanceId);
    const pending =
      String(latest?.status).toUpperCase() === 'WAITING'
        ? await this.pendingApproval(instanceId)
        : null;
    return this.toOutcome(
      base,
      { ...latest, timedOut: false, settled: pending !== null },
      pending,
    );
  }

  private async pendingApproval(
    instanceId: string,
  ): Promise<Record<string, any> | null> {
    const page = await this.taskRepo.listTaskHistory({
      instance_id: instanceId,
      statuses: ['OPEN'],
      limit: 20,
    });
    if (page.items.length === 0) return null;
    const approvers = await Promise.all(
      page.items.map(async (task) => {
        if (task.approver_channel === 'external_email') return '외부 결재자';
        const user = await this.authz.getUser(task.assignee).catch(() => null);
        return user?.display_name || '결재자';
      }),
    );
    return {
      reason: 'approval_required',
      node_id: page.items[0].node_id,
      node_label: page.items[0].node_label,
      approvers: [...new Set(approvers)],
    };
  }

  /** 이름 해석 (4.4): 한정 이름이면 그룹까지 확정, 일반 이름은 쓸 수 있는 Tool 안에서 하나일 때만 */
  private async resolve(
    actor: WorkflowHistoryActor,
    scope: ToolScope,
    name: string,
    groupId?: string,
  ): Promise<ResolvedTool> {
    const separator = name.indexOf('__');
    const namespace = separator > 0 ? name.slice(0, separator) : null;
    const toolName = separator > 0 ? name.slice(separator + 2) : name;
    const candidates = (await this.usableTools(actor, scope)).filter(
      ({ entry, group }) =>
        entry.tool!.name === toolName &&
        (!namespace || group?.namespace === namespace) &&
        (!groupId || entry.group_id === groupId),
    );
    if (candidates.length === 0) {
      // 없는 것과 권한 밖은 구분하지 않는다
      throw new NotFoundException(
        errorBody('TOOL_NOT_FOUND', 'Tool not found', undefined, {
          retryable: false,
        }),
      );
    }
    // 목록에 나오는 것은 활성 Tool뿐이다. 이름이 겹치는지도 활성 Tool끼리만 본다
    const active = candidates.filter(({ entry }) => entry.status === 'active');
    if (active.length === 1) return active[0];
    if (active.length === 0 && candidates.length > 0) return candidates[0];
    if (active.length > 1) {
      throw new ConflictException(
        errorBody(
          'TOOL_NAME_AMBIGUOUS',
          '같은 이름의 Tool이 여러 그룹에 있습니다. 한정 이름이나 group_id로 지정하세요.',
          undefined,
          {
            retryable: false,
            candidates: active.map(({ qualified_name, entry }) => ({
              qualified_name,
              group_id: entry.group_id,
            })),
          },
        ),
      );
    }
    return active[0];
  }

  /** 이 호출자가 쓸 수 있는 Tool (상태와 무관) */
  private async usableTools(
    actor: WorkflowHistoryActor,
    scope: ToolScope,
  ): Promise<ResolvedTool[]> {
    const entries = (await this.repo.listEntryPoints({ kind: 'tool' })).filter(
      (entry) => canUseTool(actor, entry, scope),
    );
    const groups = new Map<string, PxmGroup | null>();
    for (const groupId of new Set(entries.map((entry) => entry.group_id))) {
      groups.set(groupId, await this.authz.getGroup(groupId).catch(() => null));
    }
    return entries
      .filter((entry) => groups.get(entry.group_id)?.status !== 'deleted')
      .map((entry) => {
        const group = groups.get(entry.group_id) ?? null;
        return { entry, group, qualified_name: qualifiedName(group, entry) };
      });
  }
}

/** Tool 권한 = 연결 워크플로우 실행 권한. API Key는 그룹·워크플로우 허용 목록과 tool 권한 범위를 함께 본다 */
export function canUseTool(
  actor: WorkflowHistoryActor,
  entry: EntryPoint,
  scope: ToolScope,
): boolean {
  if (actor.api_key_id) {
    return Boolean(
      actor.scopes?.includes(scope) &&
      actor.group_ids?.includes(entry.group_id) &&
      actor.allowed_workflow_ids.includes(entry.definition_id),
    );
  }
  return canViewGroupResources(actor, entry.group_id);
}

function assertScope(actor: WorkflowHistoryActor, scope: ToolScope) {
  if (actor.api_key_id && !actor.scopes?.includes(scope)) {
    throw new ForbiddenException({
      statusCode: HttpStatus.FORBIDDEN,
      error: 'Forbidden',
      code: 'MISSING_SCOPE',
      message: `${scope} scope is required`,
      required_scope: scope,
      retryable: false,
    });
  }
}

function toolDefinition(
  tool: ResolvedTool,
  exposedName: string,
  conflict: boolean,
) {
  const { entry, group } = tool;
  return {
    name: exposedName,
    tool_name: entry.tool!.name,
    qualified_name: tool.qualified_name,
    display_name: entry.tool?.display_name ?? null,
    description: entry.description,
    input_schema: entry.input_schema,
    output_schema: entry.output_schema,
    output_contract: entry.output_contract,
    side_effect: entry.side_effect,
    tags: entry.tags,
    group_id: entry.group_id,
    group_name: group?.name ?? null,
    namespace: group?.namespace ?? null,
    name_conflict: conflict,
    pinned_version: entry.pinned_version,
  };
}

/** 실행 추적·스트림 API는 workflow:read가 필요하다. 읽을 수 없는 호출자에게는 주소를 주지 않는다 */
function instanceLinks(
  actor: WorkflowHistoryActor,
  instanceId: string,
): Record<string, string> {
  if (actor.api_key_id && !actor.scopes?.includes('workflow:read')) return {};
  return {
    trace_url: `/api/v1/instances/${instanceId}/trace`,
    stream_url: `/api/v1/instances/${instanceId}/stream`,
  };
}

function qualifiedName(group: PxmGroup | null, entry: EntryPoint): string {
  return group?.namespace
    ? `${group.namespace}__${entry.tool!.name}`
    : entry.tool!.name;
}

function toolInputInvalid(errors: string[]) {
  return errorBody(
    'TOOL_INPUT_INVALID',
    'arguments does not match input_schema',
    undefined,
    {
      failure_type: 'configuration',
      retryable: false,
      // AI가 스스로 고칠 수 있게 항목별로 준다
      details: errors.map((message) => ({
        path: fieldFromMessage(message),
        message,
      })),
    },
  );
}

function fieldFromMessage(message: string): string | null {
  const suffix = message.match(/:\s*([A-Za-z0-9_.-]+)$/);
  if (suffix) return suffix[1];
  const prefix = message.match(/^([A-Za-z0-9_.-]+)\s/);
  return prefix ? prefix[1] : null;
}

function errorResponse(
  status: number,
  base: Record<string, any>,
  error: Record<string, any>,
) {
  return {
    statusCode: status,
    error: STATUS_CODES[status] || 'Error',
    ...error,
    tool: base.tool,
    qualified_name: base.qualified_name,
    instance_id: base.instance_id,
    ...(base.trace_url ? { trace_url: base.trace_url } : {}),
    request_id: base.request_id,
  };
}

function parseNaming(value?: string): ToolNaming {
  if (value === undefined || value === '' || value === 'auto') return 'auto';
  if (value === 'qualified' || value === 'plain') return value;
  throw new BadRequestException(
    errorBody('NAMING_INVALID', 'naming must be auto, qualified or plain'),
  );
}

function splitList(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
