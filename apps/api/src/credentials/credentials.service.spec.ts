import { ForbiddenException } from '@nestjs/common';
import type { WorkflowHistoryActor } from '../db/ports/db.ports';
import { CredentialsService } from './credentials.service';

const credential = {
  _id: 'credential-1',
  group_id: 'group-a',
  shared_group_ids: ['group-b'],
  name: 'Production DB',
  type: 'connection_string',
  description: '',
  scopes: ['database'],
  metadata: {},
  active: true,
  secret: { algorithm: 'aes-256-gcm', iv: 'iv', tag: 'tag', ciphertext: 'ciphertext' },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

function actor(groupId: string, role: 'group_manager' | 'user' = 'group_manager'): WorkflowHistoryActor {
  return {
    actor_type: 'user',
    actor_id: `${groupId}-actor`,
    roles: [role],
    scopes: [],
    workspace_ids: [],
    group_ids: [groupId],
    group_roles: { [groupId]: role },
    owned_workflow_ids: [],
    allowed_workflow_ids: [],
    allowed_instance_ids: [],
    api_key_id: null,
  };
}

describe('CredentialsService group sharing', () => {
  const collection = { findOne: jest.fn().mockResolvedValue(credential) };
  const db = { collection: jest.fn().mockReturnValue(collection) };
  const service = new CredentialsService(db as any);

  beforeEach(() => collection.findOne.mockResolvedValue(credential));

  it('allows a workflow in a granted group to use the credential', async () => {
    await expect(service.getForRuntime('credential-1', 'group-b')).resolves.toMatchObject({
      id: 'credential-1',
      shared_group_ids: ['group-b'],
    });
  });

  it('rejects a workflow outside the owner and granted groups', async () => {
    await expect(service.getForRuntime('credential-1', 'group-c')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns shared access to a granted group but blocks management', async () => {
    await expect(service.get('credential-1', actor('group-b'))).resolves.toMatchObject({
      access_level: 'shared',
    });
    await expect(service.update('credential-1', { description: 'changed' }, actor('group-b')))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('keeps management with the owner group', async () => {
    await expect(service.get('credential-1', actor('group-a'))).resolves.toMatchObject({
      access_level: 'owner',
    });
  });
});
