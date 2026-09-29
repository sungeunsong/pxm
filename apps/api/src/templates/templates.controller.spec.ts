import { NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import type { WorkflowHistoryActor } from '../db/ports/db.ports';
import { TemplatesController } from './templates.controller';

describe('TemplatesController public API contract', () => {
  const template = {
    id: 'workflow-1',
    name: 'Purchase approval',
    group_id: 'group-a',
    nodes: [{ id: 'start', data: { nodeType: 'start' } }],
    edges: [],
    version: 1,
    active_published_version: 1,
  };

  function request(actor: WorkflowHistoryActor): Request {
    return { workflowActor: actor } as unknown as Request;
  }

  function apiKeyActor(overrides: Partial<WorkflowHistoryActor> = {}): WorkflowHistoryActor {
    return {
      actor_type: 'service_account',
      actor_id: 'service-1',
      api_key_id: 'key-1',
      roles: [],
      scopes: ['workflow:read'],
      workspace_ids: [],
      group_ids: ['group-a'],
      owned_workflow_ids: [],
      allowed_workflow_ids: ['workflow-1'],
      allowed_instance_ids: [],
      business_actor: null,
      ...overrides,
    };
  }

  function buildController(templateOverride: Record<string, unknown> = {}) {
    const currentTemplate = { ...template, ...templateOverride };
    const templatesService = {
      findOne: jest.fn().mockResolvedValue(currentTemplate),
      findPublished: jest.fn().mockResolvedValue(currentTemplate),
      findForExecution: jest.fn().mockResolvedValue(currentTemplate),
      update: jest.fn(),
      publish: jest.fn().mockResolvedValue(currentTemplate),
    };
    const audit = { append: jest.fn().mockResolvedValue(undefined) };
    const controller = new TemplatesController(
      templatesService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      audit as any,
      {} as any,
    );
    return { audit, controller, templatesService };
  }

  it('returns 403 with the required scope when a readable workflow cannot be executed', async () => {
    const { controller } = buildController();

    await expect(
      controller.start('workflow-1', {}, undefined, request(apiKeyActor())),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        statusCode: 403,
        code: 'MISSING_SCOPE',
        required_scope: 'workflow:execute',
      }),
    });
  });

  it('keeps an API key allowlist miss hidden as 404', async () => {
    const { controller } = buildController();

    await expect(
      controller.start('workflow-1', {}, undefined, request(apiKeyActor({
        scopes: ['workflow:read', 'workflow:execute'],
        allowed_workflow_ids: [],
      }))),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects API input that does not match the Start form before creating an instance', async () => {
    const { controller } = buildController({
      nodes: [{
        id: 'start',
        data: { nodeType: 'start', formSchema: { fields: [{ id: 'amount', type: 'number', required: true }] } },
      }],
    });

    await expect(controller.start(
      'workflow-1',
      { input: { amount: 'ten' as unknown as number } },
      undefined,
      request(apiKeyActor({ scopes: ['workflow:read', 'workflow:execute'] })),
    )).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'WORKFLOW_INPUT_INVALID',
        details: expect.arrayContaining([expect.stringContaining('number')]),
      }),
    });
  });

  it('deploys the saved workflow when the optional body is omitted', async () => {
    const { audit, controller, templatesService } = buildController();
    const admin = apiKeyActor({
      actor_type: 'user',
      actor_id: 'admin-1',
      api_key_id: null,
      roles: ['admin'],
      scopes: [],
      group_ids: [],
      allowed_workflow_ids: [],
    });

    await expect(controller.deploy('workflow-1', undefined, request(admin))).resolves.toEqual({
      success: true,
      template,
    });
    expect(templatesService.update).not.toHaveBeenCalled();
    expect(templatesService.publish).toHaveBeenCalledWith('workflow-1', 'admin-1');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      action: 'workflow.deployed',
      resource_id: 'workflow-1',
    }));
  });

  it('deploys the saved workflow when the body is empty', async () => {
    const { controller, templatesService } = buildController();
    const admin = apiKeyActor({
      actor_type: 'user', actor_id: 'admin-1', api_key_id: null, roles: ['admin'],
      scopes: [], group_ids: [], allowed_workflow_ids: [],
    });

    await expect(controller.deploy('workflow-1', {}, request(admin))).resolves.toMatchObject({ success: true });
    expect(templatesService.update).not.toHaveBeenCalled();
  });

  it('saves valid graph changes before deployment', async () => {
    const { controller, templatesService } = buildController();
    const admin = apiKeyActor({
      actor_type: 'user', actor_id: 'admin-1', api_key_id: null, roles: ['admin'],
      scopes: [], group_ids: [], allowed_workflow_ids: [],
    });
    const nodes = [{ id: 'start', data: { nodeType: 'start' } }];

    await expect(controller.deploy('workflow-1', { nodes, edges: [] }, request(admin)))
      .resolves.toMatchObject({ success: true });
    expect(templatesService.update).toHaveBeenCalledWith(
      'workflow-1',
      expect.objectContaining({ nodes, edges: [], updated_by: 'admin-1' }),
    );
    expect(templatesService.publish).toHaveBeenCalledWith('workflow-1', 'admin-1');
  });
});

describe('TemplatesController clone', () => {
  const source = {
    id: 'workflow-1',
    name: '권한 신청',
    group_id: 'group-a',
    version: 3,
    nodes: [{ id: 'js-1', data: { nodeType: 'script' } }],
    edges: [],
  };
  const managerOf = (...groups: string[]): WorkflowHistoryActor => ({
    actor_type: 'user',
    actor_id: 'manager-1',
    api_key_id: null,
    roles: ['group_manager'],
    scopes: [],
    workspace_ids: ['default'],
    group_ids: groups,
    group_roles: Object.fromEntries(groups.map((group) => [group, 'group_manager'])),
    owned_workflow_ids: [],
    allowed_workflow_ids: [],
    allowed_instance_ids: [],
    business_actor: null,
  } as WorkflowHistoryActor);

  function build(ready: boolean) {
    const report = { workflow_id: source.id, items: [], summary: { ok: 0, action_required: ready ? 0 : 1, blocked: 0, warning: 0, ready } };
    const templatesService = {
      findOne: jest.fn().mockResolvedValue(source),
      findPublished: jest.fn().mockResolvedValue(source),
      clone: jest.fn().mockResolvedValue({ id: 'workflow-2', group_id: 'group-b', name: '권한 신청 (복사본)' }),
    };
    const authzService = { getGroup: jest.fn().mockResolvedValue({ id: 'group-b', name: '인프라팀' }) };
    const compatibility = { evaluate: jest.fn().mockResolvedValue(report) };
    const audit = { append: jest.fn().mockResolvedValue(undefined) };
    const controller = new TemplatesController(
      templatesService as any, {} as any, {} as any, {} as any, {} as any, audit as any, authzService as any, compatibility as any,
    );
    return { controller, templatesService, compatibility, audit };
  }

  const req = (actor: WorkflowHistoryActor) => ({ workflowActor: actor }) as unknown as Request;

  it('대상 그룹에서 쓸 수 없는 자원이 있으면 복제하지 않고 진단 결과를 돌려준다', async () => {
    const { controller, templatesService } = build(false);
    await expect(controller.clone('workflow-1', { target_group_id: 'group-b' }, req(managerOf('group-a', 'group-b'))))
      .rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: 'CLONE_TARGET_NOT_READY', report: expect.any(Object) }) });
    expect(templatesService.clone).not.toHaveBeenCalled();
  });

  it('준비된 그룹이면 새 초안으로 복제하고 출처를 남긴다', async () => {
    const { controller, templatesService, compatibility, audit } = build(true);
    const result = await controller.clone('workflow-1', { target_group_id: 'group-b' }, req(managerOf('group-a', 'group-b')));
    expect(compatibility.evaluate).toHaveBeenCalledWith('workflow-1', source.nodes, 'group-b');
    expect(templatesService.clone).toHaveBeenCalledWith(source, { id: 'group-b', name: '인프라팀' }, '권한 신청 (복사본)', 'manager-1');
    expect(result.template.id).toBe('workflow-2');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      action: 'workflow.cloned',
      details: expect.objectContaining({ source_workflow_id: 'workflow-1', source_group_id: 'group-a' }),
    }));
  });

  it('다른 그룹 기준 점검은 복제와 같은 권한이다 (원본 읽기 + 대상 그룹 관리)', async () => {
    const { controller, compatibility } = build(true);
    const infraManager = { ...managerOf('group-b'), group_ids: ['group-a', 'group-b'], group_roles: { 'group-a': 'user', 'group-b': 'group_manager' } } as WorkflowHistoryActor;
    await controller.compatibilityForWorkflow('workflow-1', 'group-b', req(infraManager));
    expect(compatibility.evaluate).toHaveBeenCalledWith('workflow-1', source.nodes, 'group-b');
    // 원본 그룹 기준 점검은 원본 관리자만 한다.
    await expect(controller.compatibilityForWorkflow('workflow-1', 'group-a', req(infraManager))).rejects.toMatchObject({ status: 403 });
  });

  it('대상 그룹의 관리 권한이 없으면 복제할 수 없다', async () => {
    const { controller, templatesService } = build(true);
    await expect(controller.clone('workflow-1', { target_group_id: 'group-b' }, req(managerOf('group-a'))))
      .rejects.toMatchObject({ status: 403 });
    expect(templatesService.clone).not.toHaveBeenCalled();
  });
});
