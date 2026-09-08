import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

const workflow = { id: 'workflow-a', group_id: 'group-a', created_by: 'author', updated_by: 'former-user', created_at: '2026-07-06', updated_at: '2026-09-07' };
function setup() {
  const templates = { findOne: jest.fn().mockResolvedValue(workflow) };
  const authz = { getUser: jest.fn(async (id: string) => {
    if (id === 'former-user') throw new NotFoundException();
    return { id, display_name: '작성자', status: 'active', password_hash: 'never-return-this' };
  }) };
  const controller = new TemplatesController(templates as any, {} as any, {} as any, {} as any, {} as any, {} as any, authz as any);
  return { controller, templates, authz };
}
function req(role: string, group = 'group-a') {
  return { workflowActor: { actor_type: 'user', actor_id: 'manager', roles: [role], group_ids: [group], scopes: [], allowed_workflow_ids: [] } } as any;
}
describe('Workflow attribution', () => {
  it('returns names and IDs for known authors while preserving an unknown former ID without user secrets', async () => {
    const { controller } = setup();
    expect(await controller.attribution('workflow-a', req('group_manager'))).toEqual({
      creator: { id: 'author', display_name: '작성자', status: 'active' },
      updater: { id: 'former-user', display_name: null, status: 'missing' },
      created_at: workflow.created_at, updated_at: workflow.updated_at, imported_from: null,
    });
  });
  it('does not look up identities for another group manager', async () => {
    const { controller, authz } = setup();
    await expect(controller.attribution('workflow-a', req('group_manager', 'group-b'))).rejects.toBeInstanceOf(NotFoundException);
    expect(authz.getUser).not.toHaveBeenCalled();
  });
  it('does not expose management attribution to a requester', async () => {
    const { controller, authz } = setup();
    await expect(controller.attribution('workflow-a', req('user'))).rejects.toBeInstanceOf(ForbiddenException);
    expect(authz.getUser).not.toHaveBeenCalled();
  });
  it('keeps absent historical actors unknown instead of attributing work to admin', async () => {
    const repo = { getDefinition: jest.fn().mockResolvedValue({ id: 'old', nodes: [], edges: [] }) };
    const service = new TemplatesService(repo as any, {} as any, {} as any, {} as any, {} as any);
    const old = await service.findOne('old');
    expect(old?.created_by).toBeUndefined();
    expect(old?.updated_by).toBeUndefined();
    const { controller, templates, authz } = setup();
    templates.findOne.mockResolvedValue({ ...workflow, created_by: undefined, updated_by: undefined } as any);
    const result = await controller.attribution('workflow-a', req('group_manager'));
    expect(result.creator.status).toBe('unknown');
    expect(authz.getUser).not.toHaveBeenCalled();
  });
});
