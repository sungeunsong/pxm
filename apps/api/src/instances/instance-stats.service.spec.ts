import type {
  OutboxRepositoryPort,
  WorkflowHistoryActor,
  WorkflowInstanceRepositoryPort,
  WorkflowRepositoryPort,
} from '../db/ports/db.ports';
import type { AuthzService } from '../authz/authz.service';
import { InstancesService } from './instances.service';

describe('InstancesService instance stats', () => {
  it('passes the authenticated actor to the repository aggregate', async () => {
    const actor = {
      actor_id: 'manager-1',
      roles: ['group_manager'],
    } as WorkflowHistoryActor;
    const expected = {
      total: 3,
      by_state: { RUNNING: 3 },
      scope: 'authorized',
    };
    const instanceRepo = {
      getInstanceStats: jest.fn().mockResolvedValue(expected),
    };
    const service = new InstancesService(
      instanceRepo as unknown as WorkflowInstanceRepositoryPort,
      {} as WorkflowRepositoryPort,
      {} as OutboxRepositoryPort,
      {} as AuthzService,
    );

    await expect(service.getStats(actor)).resolves.toBe(expected);
    expect(instanceRepo.getInstanceStats).toHaveBeenCalledWith(actor);
  });
});
