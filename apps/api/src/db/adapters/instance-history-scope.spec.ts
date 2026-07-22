import type { Db } from 'mongodb';
import type { Pool } from 'pg';
import type { WorkflowHistoryActor } from '../ports/db.ports';
import { MongodbAdapter } from './mongodb.adapter';
import { PostgresAdapter } from './postgres.adapter';

describe('instance history scope', () => {
  const sessionUser = actor({
    actor_id: 'api-demo-user',
    roles: ['user'],
    group_ids: ['group-1'],
  });
  const apiKeyUser = actor({
    actor_id: 'api-demo-user',
    roles: ['user'],
    scopes: ['workflow:read'],
    group_ids: ['group-1'],
    allowed_workflow_ids: ['workflow-1'],
    api_key_id: 'key-1',
  });

  it('lets a MongoDB session user list instances they requested', async () => {
    const find = jest.fn().mockReturnValue(emptyMongoCursor());
    const db = { collection: jest.fn().mockReturnValue({ find }) } as unknown as Db;

    await new MongodbAdapter(db).listInstances(sessionUser);

    expect(find).toHaveBeenCalledWith({
      $or: [
        { requester_id: 'api-demo-user' },
        { 'context.runtime.access.requester_id': 'api-demo-user' },
      ],
    });
  });

  it('does not let a MongoDB API key bypass its workflow allowlist through requester ownership', async () => {
    const find = jest.fn().mockReturnValue(emptyMongoCursor());
    const db = { collection: jest.fn().mockReturnValue({ find }) } as unknown as Db;

    await new MongodbAdapter(db).listInstances(apiKeyUser);

    expect(find).toHaveBeenCalledWith({
      $or: [{ process_definition_id: { $in: ['workflow-1'] } }],
    });
  });

  it('lets a PostgreSQL session user list instances they requested', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;

    await new PostgresAdapter(pool).listInstances(sessionUser);

    expect(query.mock.calls[0][0]).toContain("i.context->'runtime'->'access'->>'requester_id' = $1");
    expect(query.mock.calls[0][1]).toEqual(['api-demo-user']);
  });

  it('does not let a PostgreSQL API key bypass its workflow allowlist through requester ownership', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;

    await new PostgresAdapter(pool).listInstances(apiKeyUser);

    expect(query.mock.calls[0][0]).not.toContain("requester_id' =");
    expect(query.mock.calls[0][0]).toContain('i.process_definition_id::text = ANY($1::text[])');
    expect(query.mock.calls[0][1]).toEqual([['workflow-1']]);
  });
});

function emptyMongoCursor() {
  return {
    sort: jest.fn().mockReturnValue({
      limit: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
    }),
  };
}

function actor(overrides: Partial<WorkflowHistoryActor>): WorkflowHistoryActor {
  return {
    actor_type: 'user',
    actor_id: null,
    roles: [],
    scopes: [],
    workspace_ids: [],
    group_ids: [],
    owned_workflow_ids: [],
    allowed_workflow_ids: [],
    allowed_instance_ids: [],
    api_key_id: null,
    business_actor: null,
    ...overrides,
  };
}
