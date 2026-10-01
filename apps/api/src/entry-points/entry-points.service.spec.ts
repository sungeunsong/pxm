import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  EntryPoint,
  EntryPointQuery,
} from '../db/ports/entry-points.port';
import type { WorkflowHistoryActor } from '../db/ports/db.ports';
import { EntryPointsService } from './entry-points.service';

function actor(
  overrides: Partial<WorkflowHistoryActor> = {},
): WorkflowHistoryActor {
  return {
    actor_type: 'user',
    actor_id: 'manager-1',
    roles: ['group_manager'],
    workspace_ids: [],
    group_ids: ['g1'],
    group_roles: { g1: 'group_manager' },
    owned_workflow_ids: [],
    allowed_workflow_ids: [],
    allowed_instance_ids: [],
    ...overrides,
  };
}

function nodesV(version: number) {
  const fields: any[] = [
    { id: 'user_id', type: 'text', label: '사용자', required: true },
  ];
  if (version >= 2)
    fields.push({ id: 'reason', type: 'text', label: '사유', required: true });
  return [
    { id: 'start', data: { nodeType: 'start', formSchema: { fields } } },
    { id: 'approve', data: { nodeType: 'approval' } },
    { id: 'end', data: { nodeType: 'end' } },
  ];
}

function build(options: { lifecycle?: string; activeVersion?: number } = {}) {
  const store = new Map<string, EntryPoint>();
  const workflow = {
    id: 'wf-1',
    name: '권한 신청',
    group_id: 'g1',
    is_active: true,
    version: options.activeVersion ?? 1,
    lifecycle_status: options.lifecycle ?? 'PUBLISHED',
    active_published_version: options.activeVersion ?? 1,
    nodes: nodesV(options.activeVersion ?? 1),
  };
  const repo = {
    createEntryPoint: jest.fn(async (entry: EntryPoint) => {
      store.set(entry.id, entry);
      return entry;
    }),
    getEntryPoint: jest.fn(async (id: string) => store.get(id) ?? null),
    listEntryPoints: jest.fn(async (query: EntryPointQuery = {}) =>
      [...store.values()].filter(
        (item) =>
          (!query.kind || item.kind === query.kind) &&
          (!query.group_ids || query.group_ids.includes(item.group_id)) &&
          (!query.tool_name || item.tool?.name === query.tool_name),
      ),
    ),
    updateEntryPoint: jest.fn(async (id: string, patch: any) => {
      const current = store.get(id);
      if (!current) return null;
      const next = { ...current, ...patch };
      store.set(id, next);
      return next;
    }),
    deleteEntryPoint: jest.fn(async (id: string) => store.delete(id)),
  };
  const templates = {
    findOne: jest.fn(async (id: string) =>
      id === workflow.id ? workflow : null,
    ),
    getVersion: jest.fn(async (id: string, version: number) =>
      id === workflow.id
        ? { ...workflow, version, nodes: nodesV(version) }
        : null,
    ),
  };
  const groups: Record<string, any> = {
    g1: { id: 'g1', name: 'SecOps', namespace: 'secops', status: 'active' },
    g2: { id: 'g2', name: 'Other', namespace: 'other', status: 'active' },
  };
  const authz = {
    getGroup: jest.fn(async (id: string) => groups[id]),
    ensureGroupNamespace: jest.fn(async (group: any) => group),
  };
  const compatibility = {
    evaluate: jest.fn(async () => ({
      items: [
        {
          kind: 'credential',
          ref: 'cred-1',
          label: '자격증명',
          status: 'ok',
          message: '',
          node_ids: [],
        },
      ],
    })),
  };
  const audit = { append: jest.fn(async () => undefined) };
  const service = new EntryPointsService(
    repo as any,
    templates as any,
    authz as any,
    compatibility as any,
    audit as any,
  );
  return { service, repo, store, workflow, audit, groups };
}

const toolInput = {
  kind: 'tool' as const,
  definition_id: 'wf-1',
  description: '권한을 신청한다',
  tool: { name: 'request_access' },
};

describe('EntryPointsService publish', () => {
  it('publishes a tool pinned to the active version with a derived schema', async () => {
    const { service, audit } = build();
    const { entry_point, warnings } = await service.publish(actor(), toolInput);
    expect(entry_point).toMatchObject({
      kind: 'tool',
      group_id: 'g1',
      tenant_id: null,
      pinned_version: 1,
      side_effect: 'requires_approval',
      status: 'active',
      input_schema_source: 'derived',
      output_contract: 'free_form',
      namespace: 'secops',
      qualified_name: 'secops__request_access',
      resource_digest: { credentials: ['cred-1'] },
      workflow: { name: '권한 신청', newer_version_available: false },
    });
    expect(entry_point.input_schema.required).toEqual(['user_id']);
    expect(warnings.map((item) => item.code)).toContain(
      'OUTPUT_SCHEMA_MISSING',
    );
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'entry_point.published',
        resource_type: 'entry_point',
      }),
    );
  });

  it('refuses workflows that are not published', async () => {
    const { service } = build({ lifecycle: 'DRAFT' });
    await expect(service.publish(actor(), toolInput)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('blocks a duplicate tool name in the same group', async () => {
    const { service } = build();
    await service.publish(actor(), toolInput);
    await expect(service.publish(actor(), toolInput)).rejects.toMatchObject({
      response: {
        code: 'ENTRY_POINT_PUBLISH_BLOCKED',
        blocks: [expect.objectContaining({ code: 'TOOL_NAME_TAKEN' })],
      },
    });
  });

  it('warns when a workflow with approval is published as read_only', async () => {
    const { service } = build();
    const { warnings } = await service.publish(actor(), {
      ...toolInput,
      side_effect: 'read_only',
    });
    expect(warnings.map((item) => item.code)).toContain(
      'SIDE_EFFECT_APPROVAL_MISMATCH',
    );
  });

  it('validates input before touching the workflow', async () => {
    const { service } = build();
    await expect(
      service.publish(actor(), { ...toolInput, tool: { name: 'Bad Name' } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.publish(actor(), { ...toolInput, description: ' ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.publish(actor(), { ...toolInput, kind: 'route' }),
    ).rejects.toMatchObject({
      response: { code: 'ENTRY_POINT_KIND_UNSUPPORTED' },
    });
  });

  it('requires group manager rights on the workflow group', async () => {
    const { service } = build();
    await expect(
      service.publish(
        actor({ roles: ['user'], group_roles: { g1: 'user' } }),
        toolInput,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.publish(actor({ api_key_id: 'key-1' }), toolInput),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('previews without saving', async () => {
    const { service, repo } = build();
    const preview = await service.preview(actor(), toolInput);
    expect(preview).toMatchObject({
      publishable: true,
      pinned_version: 1,
      qualified_name: 'secops__request_access',
      suggested_side_effect: 'requires_approval',
    });
    expect(repo.createEntryPoint).not.toHaveBeenCalled();
  });
});

describe('EntryPointsService management', () => {
  it('lists only entry points of groups the actor belongs to', async () => {
    const { service, store } = build();
    const { entry_point } = await service.publish(actor(), toolInput);
    store.set('other', {
      ...store.get(entry_point.id)!,
      id: 'other',
      group_id: 'g2',
    });
    const items = await service.list(
      actor({ roles: ['user'], group_roles: { g1: 'user' } }),
    );
    expect(items.map((item) => item.id)).toEqual([entry_point.id]);
    await expect(
      service.list(actor({ api_key_id: 'key-1' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('hides entry points of other groups', async () => {
    const { service } = build();
    const { entry_point } = await service.publish(actor(), toolInput);
    await expect(
      service.get(
        actor({ group_ids: ['g2'], group_roles: { g2: 'group_manager' } }),
        entry_point.id,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates description and status but not the contract', async () => {
    const { service } = build();
    const { entry_point } = await service.publish(actor(), toolInput);
    const { entry_point: updated } = await service.update(
      actor(),
      entry_point.id,
      { description: '새 설명', status: 'disabled', display_name: '권한 신청' },
    );
    expect(updated).toMatchObject({
      description: '새 설명',
      status: 'disabled',
      tool: { name: 'request_access', display_name: '권한 신청' },
      pinned_version: 1,
    });
  });

  it('rebinds only after confirming breaking changes', async () => {
    const { service, workflow } = build();
    const { entry_point } = await service.publish(actor(), toolInput);
    workflow.active_published_version = 2;
    workflow.version = 2;

    const { entry_point: view } = await service.get(actor(), entry_point.id);
    expect(view.workflow.newer_version_available).toBe(true);

    const dry = await service.rebind(actor(), entry_point.id, {
      dry_run: true,
    });
    expect(dry).toMatchObject({
      applied: false,
      from_version: 1,
      to_version: 2,
      breaking: true,
    });
    expect(
      dry.changes.map((change) => `${change.change}:${change.field}`),
    ).toEqual(['added_required:reason']);

    await expect(
      service.rebind(actor(), entry_point.id),
    ).rejects.toBeInstanceOf(ConflictException);
    const applied = await service.rebind(actor(), entry_point.id, {
      confirm_breaking: true,
    });
    expect(applied).toMatchObject({
      applied: true,
      entry_point: { pinned_version: 2 },
    });
    expect(applied.entry_point!.input_schema.required).toEqual([
      'user_id',
      'reason',
    ]);
  });

  it('detects breaking form changes for a manual input schema', async () => {
    const { service, workflow } = build();
    const { entry_point } = await service.publish(actor(), {
      ...toolInput,
      input_schema: {
        type: 'object',
        properties: { user_id: { type: 'string', description: '조회할 사번' } },
        required: ['user_id'],
      },
    });
    expect(entry_point.input_schema_source).toBe('manual');
    workflow.active_published_version = 2;
    workflow.version = 2;

    const dry = await service.rebind(actor(), entry_point.id, {
      dry_run: true,
    });
    expect(dry).toMatchObject({ breaking: true });
    expect(
      dry.changes.map((change) => `${change.change}:${change.field}`),
    ).toEqual(['added_required:reason']);
    await expect(
      service.rebind(actor(), entry_point.id),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('deletes', async () => {
    const { service, store } = build();
    const { entry_point } = await service.publish(actor(), toolInput);
    await service.remove(actor(), entry_point.id);
    expect(store.size).toBe(0);
  });
});
