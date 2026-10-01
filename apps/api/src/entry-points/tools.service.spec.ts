import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { EntryPoint } from '../db/ports/entry-points.port';
import type { WorkflowHistoryActor } from '../db/ports/db.ports';
import { ToolsService } from './tools.service';

function apiKeyActor(
  overrides: Partial<WorkflowHistoryActor> = {},
): WorkflowHistoryActor {
  return {
    actor_type: 'service_account',
    actor_id: 'sa-1',
    api_key_id: 'key-1',
    roles: [],
    scopes: ['tool:read', 'tool:invoke'],
    workspace_ids: [],
    group_ids: ['g1'],
    owned_workflow_ids: [],
    allowed_workflow_ids: ['wf-1', 'wf-2'],
    allowed_instance_ids: [],
    ...overrides,
  };
}

function entry(overrides: Partial<EntryPoint>): EntryPoint {
  return {
    id: 'ep-1',
    kind: 'tool',
    group_id: 'g1',
    tenant_id: null,
    definition_id: 'wf-1',
    pinned_version: 2,
    input_schema: {
      type: 'object',
      properties: { user_id: { type: 'string' } },
    },
    input_schema_source: 'derived',
    output_schema: null,
    output_contract: 'free_form',
    side_effect: 'requires_approval',
    status: 'active',
    description: '권한 신청',
    tags: ['access'],
    resource_digest: null,
    history_policy: { body: 'none' },
    tool: { name: 'request_access' },
    route: null,
    created_by: null,
    updated_by: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const nodes = [
  {
    id: 'start',
    data: {
      nodeType: 'start',
      formSchema: { fields: [{ id: 'user_id', type: 'text', required: true }] },
    },
  },
  { id: 'end', data: { nodeType: 'end' } },
];

function build(
  entries: EntryPoint[],
  options: {
    result?: Record<string, any>;
    openTasks?: any[];
    lifecycle?: string;
  } = {},
) {
  const groups: Record<string, any> = {
    g1: { id: 'g1', name: '보안운영팀', namespace: 'secops', status: 'active' },
    g2: { id: 'g2', name: '인프라팀', namespace: 'infra', status: 'active' },
  };
  const repo = { listEntryPoints: jest.fn(async () => entries) };
  const templates = {
    findOne: jest.fn(async (id: string) => ({
      id,
      is_active: true,
      lifecycle_status: options.lifecycle ?? 'PUBLISHED',
      version: 3,
    })),
    findVersionForExecution: jest.fn(async (id: string, version: number) => ({
      id,
      version,
      nodes,
      edges: [],
      group_id: 'g1',
    })),
  };
  const authz = {
    getGroup: jest.fn(async (id: string) => groups[id]),
    getUser: jest.fn(async () => ({ display_name: '김결재' })),
  };
  const workflowStart = {
    start: jest.fn(async () => ({
      instance_id: 'inst-1',
      idempotent_replay: false,
      external_approval: null,
    })),
  };
  const instances = {
    waitForResult: jest.fn(
      async (
        _id: string,
        _timeout: number,
        _interval: unknown,
        settled?: (latest: any) => Promise<boolean>,
      ) => {
        const latest = options.result ?? {
          status: 'COMPLETED',
          outcome: 'SUCCESS',
          result: { granted: true },
        };
        if (settled && (await settled(latest)))
          return { timedOut: false, settled: true, ...latest };
        return { timedOut: false, ...latest };
      },
    ),
  };
  const taskRepo = {
    listTaskHistory: jest.fn(async () => ({
      items: options.openTasks ?? [],
      has_more: false,
    })),
  };
  const instanceRows: Record<string, any> = {
    'inst-tool': {
      id: 'inst-tool',
      definition_id: 'wf-1',
      group_id: 'g1',
      context: {
        runtime: {
          snapshot: {
            entry_point: {
              kind: 'tool',
              name: 'request_access',
              qualified_name: 'secops__request_access',
            },
          },
        },
      },
    },
    'inst-plain': {
      id: 'inst-plain',
      definition_id: 'wf-1',
      group_id: 'g1',
      context: { runtime: { snapshot: {} } },
    },
  };
  const instanceRepo = {
    getInstance: jest.fn(async (id: string) => instanceRows[id] ?? null),
  };
  Object.assign(instances, {
    getResult: jest.fn(
      async () =>
        options.result ?? {
          status: 'COMPLETED',
          outcome: 'SUCCESS',
          result: { granted: true },
        },
    ),
  });
  const service = new ToolsService(
    repo as any,
    templates as any,
    authz as any,
    workflowStart as any,
    instances as any,
    taskRepo as any,
    instanceRepo as any,
  );
  return { service, workflowStart, templates };
}

const context = { access: () => ({ group_id: 'g1' }), requestId: 'req-1' };

describe('ToolsService list', () => {
  it('lists active tools the key may run, as LLM-ready definitions', async () => {
    const { service } = build([
      entry({}),
      entry({ id: 'ep-off', tool: { name: 'off_tool' }, status: 'disabled' }),
      entry({
        id: 'ep-other-wf',
        tool: { name: 'hidden' },
        definition_id: 'wf-9',
      }),
      entry({
        id: 'ep-other-group',
        tool: { name: 'infra_tool' },
        group_id: 'g2',
      }),
    ]);
    const result = await service.list(apiKeyActor());
    expect(result).toEqual({
      has_name_conflict: false,
      tools: [
        expect.objectContaining({
          name: 'request_access',
          qualified_name: 'secops__request_access',
          namespace: 'secops',
          group_name: '보안운영팀',
          side_effect: 'requires_approval',
          pinned_version: 2,
          name_conflict: false,
        }),
      ],
    });
  });

  it('uses qualified names only for conflicting tools in auto mode', async () => {
    const { service } = build([
      entry({}),
      entry({ id: 'ep-2', group_id: 'g2', definition_id: 'wf-2' }),
      entry({ id: 'ep-3', tool: { name: 'unique_tool' } }),
    ]);
    const actor = apiKeyActor({ group_ids: ['g1', 'g2'] });
    const auto = await service.list(actor);
    expect(auto.has_name_conflict).toBe(true);
    expect(auto.tools.map((tool) => tool.name).sort()).toEqual([
      'infra__request_access',
      'secops__request_access',
      'unique_tool',
    ]);
    const qualified = await service.list(actor, { naming: 'qualified' });
    expect(qualified.tools.map((tool) => tool.name)).toContain(
      'secops__unique_tool',
    );
    await expect(
      service.list(actor, { naming: 'plain' }),
    ).rejects.toMatchObject({ response: { code: 'TOOL_NAME_CONFLICT' } });
  });

  it('filters by side effect and tags', async () => {
    const { service } = build([
      entry({}),
      entry({
        id: 'ep-2',
        tool: { name: 'read_tool' },
        side_effect: 'read_only',
        tags: [],
      }),
    ]);
    expect(
      (
        await service.list(apiKeyActor(), { side_effect: 'read_only' })
      ).tools.map((tool) => tool.name),
    ).toEqual(['read_tool']);
    expect(
      (await service.list(apiKeyActor(), { tags: 'access,other' })).tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(['request_access']);
  });

  it('requires the tool:read scope', async () => {
    const { service } = build([entry({})]);
    await expect(
      service.list(apiKeyActor({ scopes: ['workflow:execute'] })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ToolsService invoke', () => {
  it('runs the pinned version and returns the result', async () => {
    const { service, workflowStart, templates } = build([entry({})]);
    const outcome = await service.invoke(
      apiKeyActor(),
      'request_access',
      { arguments: { user_id: 'E1' } },
      context,
    );
    expect(templates.findVersionForExecution).toHaveBeenCalledWith('wf-1', 2);
    expect(workflowStart.start).toHaveBeenCalledWith(
      expect.objectContaining({
        formData: { user_id: 'E1' },
        idempotencyScope: 'entry_point:ep-1',
        reason: 'tool_invoke',
        entryPoint: expect.objectContaining({
          id: 'ep-1',
          qualified_name: 'secops__request_access',
          pinned_version: 2,
        }),
      }),
    );
    expect(outcome).toMatchObject({
      http_status: 200,
      body: {
        status: 'ok',
        outcome: 'SUCCESS',
        result: { granted: true },
        request_id: 'req-1',
      },
    });
  });

  it('resolves qualified names and refuses ambiguous plain names', async () => {
    const entries = [
      entry({}),
      entry({ id: 'ep-2', group_id: 'g2', definition_id: 'wf-2' }),
    ];
    const actor = apiKeyActor({ group_ids: ['g1', 'g2'] });
    const { service, workflowStart } = build(entries);
    await expect(
      service.invoke(
        actor,
        'request_access',
        { arguments: { user_id: 'E1' } },
        context,
      ),
    ).rejects.toMatchObject({
      response: { code: 'TOOL_NAME_AMBIGUOUS' },
    });
    await service.invoke(
      actor,
      'infra__request_access',
      { arguments: { user_id: 'E1' } },
      context,
    );
    expect(workflowStart.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ idempotencyScope: 'entry_point:ep-2' }),
    );
    await service.invoke(
      actor,
      'request_access',
      { arguments: { user_id: 'E1' }, group_id: 'g1' },
      context,
    );
    expect(workflowStart.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ idempotencyScope: 'entry_point:ep-1' }),
    );
  });

  it('hides tools outside the key permissions', async () => {
    const { service } = build([entry({ definition_id: 'wf-9' })]);
    await expect(
      service.invoke(apiKeyActor(), 'request_access', {}, context),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.invoke(
        apiKeyActor({ scopes: ['tool:read'] }),
        'request_access',
        {},
        context,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses disabled tools and unavailable versions', async () => {
    await expect(
      build([entry({ status: 'disabled' })]).service.invoke(
        apiKeyActor(),
        'request_access',
        {},
        context,
      ),
    ).rejects.toMatchObject({
      response: { code: 'TOOL_DISABLED' },
    });
    await expect(
      build([entry({})], { lifecycle: 'DISABLED' }).service.invoke(
        apiKeyActor(),
        'request_access',
        { arguments: { user_id: 'E1' } },
        context,
      ),
    ).rejects.toMatchObject({ response: { code: 'TOOL_VERSION_UNAVAILABLE' } });
  });

  it('returns structured input errors without starting', async () => {
    const { service, workflowStart } = build([entry({})]);
    const error = await service
      .invoke(
        apiKeyActor(),
        'request_access',
        { arguments: { extra: 1 } },
        context,
      )
      .catch((err) => err);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.response).toMatchObject({
      code: 'TOOL_INPUT_INVALID',
      retryable: false,
      details: expect.arrayContaining([
        expect.objectContaining({ path: 'extra' }),
        expect.objectContaining({ path: 'user_id' }),
      ]),
    });
    expect(workflowStart.start).not.toHaveBeenCalled();
  });

  it('rejects on_behalf_of until it can be verified', async () => {
    const { service } = build([entry({})]);
    await expect(
      service.invoke(
        apiKeyActor(),
        'request_access',
        {
          arguments: { user_id: 'E1' },
          on_behalf_of: { provider: 'promptic', subject: 'u1' },
        },
        context,
      ),
    ).rejects.toMatchObject({ response: { code: 'ON_BEHALF_OF_UNSUPPORTED' } });
  });

  it('reports pending approval as 202 instead of waiting', async () => {
    const { service } = build([entry({})], {
      result: { status: 'WAITING', outcome: null },
      openTasks: [
        {
          node_id: 'approve',
          node_label: '팀장 결재',
          approver_channel: 'pxm_user',
          assignee: 'u-1',
        },
      ],
    });
    const outcome = await service.invoke(
      apiKeyActor(),
      'request_access',
      { arguments: { user_id: 'E1' } },
      context,
    );
    expect(outcome).toMatchObject({
      http_status: 202,
      body: {
        status: 'pending_approval',
        pending: {
          reason: 'approval_required',
          node_id: 'approve',
          approvers: ['김결재'],
        },
      },
    });
  });

  it('reports running for async mode and sync timeouts', async () => {
    const asyncOutcome = await build([entry({})]).service.invoke(
      apiKeyActor(),
      'request_access',
      { arguments: { user_id: 'E1' }, mode: 'async' },
      context,
    );
    expect(asyncOutcome).toMatchObject({
      http_status: 202,
      body: { status: 'running' },
    });
    const timedOut = await build([entry({})], {
      result: { status: 'RUNNING', timedOut: true },
    }).service.invoke(
      apiKeyActor(),
      'request_access',
      { arguments: { user_id: 'E1' } },
      context,
    );
    expect(timedOut).toMatchObject({
      http_status: 202,
      body: { status: 'running' },
    });
  });

  it('maps business failures to 200 error that must not be retried', async () => {
    const rejected = await build([entry({})], {
      result: { status: 'COMPLETED', outcome: 'REJECTED' },
    }).service.invoke(
      apiKeyActor(),
      'request_access',
      { arguments: { user_id: 'E1' } },
      context,
    );
    expect(rejected).toMatchObject({
      http_status: 200,
      body: {
        status: 'error',
        error: {
          kind: 'business',
          code: 'APPROVAL_REJECTED',
          retryable: false,
        },
      },
    });
  });

  it('maps execution failures by failure type with Retry-After when retryable', async () => {
    const upstream = await build([entry({})], {
      result: {
        status: 'FAILED',
        outcome: 'FAILURE',
        outcome_reason: {
          failure_type: 'upstream_error',
          retryable: true,
          node_id: 'svc',
          message: '연동 실패',
        },
      },
    }).service.invoke(
      apiKeyActor(),
      'request_access',
      { arguments: { user_id: 'E1' } },
      context,
    );
    expect(upstream).toMatchObject({
      http_status: 502,
      headers: { 'Retry-After': '5' },
      body: {
        code: 'TOOL_EXECUTION_FAILED',
        failure_type: 'upstream_error',
        retryable: true,
        failed_node_id: 'svc',
        request_id: 'req-1',
      },
    });
    const config = await build([entry({})], {
      result: {
        status: 'FAILED',
        outcome: 'FAILURE',
        outcome_reason: { failure_type: 'configuration', retryable: false },
      },
    }).service.invoke(
      apiKeyActor(),
      'request_access',
      { arguments: { user_id: 'E1' } },
      context,
    );
    expect(config).toMatchObject({
      http_status: 422,
      headers: {},
      body: { retryable: false },
    });
    const terminated = await build([entry({})], {
      result: { status: 'TERMINATED', outcome: 'CANCELLED' },
    }).service.invoke(
      apiKeyActor(),
      'request_access',
      { arguments: { user_id: 'E1' } },
      context,
    );
    expect(terminated).toMatchObject({
      http_status: 409,
      body: { code: 'TOOL_EXECUTION_TERMINATED' },
    });
  });

  it('lets managers test inactive tools', async () => {
    const { service, workflowStart } = build([]);
    const outcome = await service.test(
      apiKeyActor({ api_key_id: null }),
      entry({ status: 'draft' }),
      { arguments: { user_id: 'E1' } },
      context,
    );
    expect(outcome.body.status).toBe('ok');
    expect(workflowStart.start).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'tool_test',
        entryPoint: expect.objectContaining({ test: true }),
      }),
    );
  });

  it('rejects malformed arguments', async () => {
    await expect(
      build([entry({})]).service.invoke(
        apiKeyActor(),
        'request_access',
        { arguments: [1] },
        context,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      build([entry({ status: 'draft' })]).service.invoke(
        apiKeyActor(),
        'request_access',
        {},
        context,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('ToolsService invocation status', () => {
  it('returns the same shape as invoke for tool-started instances', async () => {
    const { service } = build([], {
      result: { status: 'WAITING', outcome: null },
      openTasks: [
        {
          node_id: 'approve',
          node_label: '결재',
          approver_channel: 'external_email',
          assignee: 'x@example.com',
        },
      ],
    });
    const outcome = await service.invocation(
      apiKeyActor(),
      'inst-tool',
      'req-2',
    );
    expect(outcome).toMatchObject({
      http_status: 202,
      body: {
        tool: 'request_access',
        status: 'pending_approval',
        pending: { approvers: ['외부 결재자'] },
        result_url: '/api/v1/tools/invocations/inst-tool',
      },
    });
    expect(
      (await build([]).service.invocation(apiKeyActor(), 'inst-tool', 'req-3'))
        .body,
    ).toMatchObject({ status: 'ok' });
  });

  it('hides instances not started by a tool or outside the key permissions', async () => {
    const { service } = build([]);
    await expect(
      service.invocation(apiKeyActor(), 'inst-plain', 'r'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.invocation(
        apiKeyActor({ allowed_workflow_ids: ['wf-2'] }),
        'inst-tool',
        'r',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.invocation(apiKeyActor(), 'missing', 'r'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.invocation(
        apiKeyActor({ scopes: ['tool:read'] }),
        'inst-tool',
        'r',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ToolsService review regressions', () => {
  it('ignores inactive tools when deciding whether a plain name is ambiguous', async () => {
    const entries = [
      entry({}),
      entry({
        id: 'ep-2',
        group_id: 'g2',
        definition_id: 'wf-2',
        status: 'disabled',
      }),
    ];
    const actor = apiKeyActor({ group_ids: ['g1', 'g2'] });
    const { service, workflowStart } = build(entries);
    expect((await service.list(actor)).has_name_conflict).toBe(false);
    await service.invoke(
      actor,
      'request_access',
      { arguments: { user_id: 'E1' } },
      context,
    );
    expect(workflowStart.start).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyScope: 'entry_point:ep-1' }),
    );
    await expect(
      service.invoke(
        actor,
        'infra__request_access',
        { arguments: { user_id: 'E1' } },
        context,
      ),
    ).rejects.toMatchObject({
      response: { code: 'TOOL_DISABLED' },
    });
  });

  it('gives trace and stream links only to callers that can read them', async () => {
    const toolOnly = await build([entry({})]).service.invoke(
      apiKeyActor(),
      'request_access',
      { arguments: { user_id: 'E1' } },
      context,
    );
    expect(toolOnly.body.trace_url).toBeUndefined();
    expect(toolOnly.body.result_url).toBe('/api/v1/tools/invocations/inst-1');
    const reader = await build([entry({})]).service.invoke(
      apiKeyActor({ scopes: ['tool:invoke', 'workflow:read'] }),
      'request_access',
      { arguments: { user_id: 'E1' } },
      context,
    );
    expect(reader.body).toMatchObject({
      trace_url: '/api/v1/instances/inst-1/trace',
      stream_url: '/api/v1/instances/inst-1/stream',
    });
  });
});
