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

  function buildController() {
    const templatesService = {
      findOne: jest.fn().mockResolvedValue(template),
      findPublished: jest.fn().mockResolvedValue(template),
      update: jest.fn(),
      publish: jest.fn().mockResolvedValue(template),
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
});
