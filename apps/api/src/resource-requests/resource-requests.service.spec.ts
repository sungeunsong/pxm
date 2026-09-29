import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { WorkflowHistoryActor } from '../db/ports/db.ports';
import { ResourceRequestsService } from './resource-requests.service';

function fakeDb(groups: Array<{ _id: string; name: string }>) {
  const requests: any[] = [];
  const matches = (doc: any, filter: Record<string, any>) =>
    Object.entries(filter).every(([key, expected]) => {
      const actual = key.split('.').reduce((value, part) => value?.[part], doc);
      if (expected && typeof expected === 'object' && '$in' in expected) return expected.$in.includes(actual);
      if (expected && typeof expected === 'object' && '$ne' in expected) return actual !== expected.$ne;
      return actual === expected;
    });
  const requestCollection = {
    createIndex: jest.fn(),
    findOne: jest.fn(async (filter: any) => requests.find((doc) => matches(doc, filter)) || null),
    insertOne: jest.fn(async (doc: any) => { requests.push(doc); }),
    find: jest.fn((filter: any) => ({
      sort: () => ({ limit: () => ({ toArray: async () => requests.filter((doc) => matches(doc, filter)) }) }),
    })),
    findOneAndUpdate: jest.fn(async (filter: any, update: any) => {
      const doc = requests.find((item) => matches(item, filter));
      if (!doc) return null;
      Object.assign(doc, update.$set);
      return doc;
    }),
    updateOne: jest.fn(async (filter: any, update: any) => {
      const doc = requests.find((item) => matches(item, filter));
      if (doc) Object.assign(doc, update.$set);
    }),
  };
  const groupCollection = { findOne: jest.fn(async (filter: any) => groups.find((group) => group._id === filter._id) || null) };
  return {
    requests,
    db: { collection: (name: string) => (name === 'pxm_groups' ? groupCollection : requestCollection) } as any,
  };
}

const actor = (id: string, roles: string[], managerOf: string[] = []): WorkflowHistoryActor => ({
  actor_type: 'user',
  actor_id: id,
  api_key_id: null,
  roles,
  scopes: [],
  workspace_ids: ['default'],
  group_ids: managerOf,
  group_roles: Object.fromEntries(managerOf.map((group) => [group, 'group_manager'])),
  owned_workflow_ids: [],
  allowed_workflow_ids: [],
  allowed_instance_ids: [],
  business_actor: null,
} as WorkflowHistoryActor);

describe('ResourceRequestsService', () => {
  const groups = [{ _id: 'infra', name: '인프라팀' }, { _id: 'secops', name: '보안운영팀' }];

  function build(options: { credential?: any; library?: any } = {}) {
    const { db, requests } = fakeDb(groups);
    const credentials = {
      availabilityForGroup: jest.fn().mockResolvedValue(options.credential ?? { status: 'not_shared', name: 'hr-db', owner_group_id: 'secops' }),
      shareWithGroupByRequest: jest.fn().mockResolvedValue(undefined),
    };
    const libraries = {
      findByRef: jest.fn().mockResolvedValue(options.library ?? { status: 'approved', allowed_group_ids: ['secops'] }),
      allowGroupByRequest: jest.fn().mockResolvedValue(undefined),
    };
    const audit = { append: jest.fn().mockResolvedValue(undefined) };
    const service = new ResourceRequestsService(db, credentials as any, libraries as any, audit as any);
    return { service, credentials, libraries, requests, audit };
  }

  const infraManager = actor('infra-mgr', ['group_manager'], ['infra']);
  const secopsManager = actor('secops-mgr', ['group_manager'], ['secops']);
  const admin = actor('admin', ['admin']);

  it('자격증명 공유 요청은 소유 그룹 관리자에게 가고, 같은 요청은 하나로 합친다', async () => {
    const { service } = build();
    const first = await service.create({ resource_type: 'credential', resource_ref: { credential_id: 'cred-1' }, target_group_id: 'infra' }, infraManager);
    expect(first).toMatchObject({
      status: 'pending',
      approver_role: 'group_manager',
      approver_group_id: 'secops',
      approver_group_name: '보안운영팀',
      target_group_name: '인프라팀',
      resource_label: 'hr-db',
    });
    const again = await service.create({ resource_type: 'credential', resource_ref: { credential_id: 'cred-1' }, target_group_id: 'infra' }, infraManager);
    expect(again.id).toBe(first.id);
    expect(await service.list('to_me', secopsManager)).toHaveLength(1);
    expect(await service.list('to_me', infraManager)).toHaveLength(0);
  });

  it('요청은 그 그룹의 관리자만 보낼 수 있다', async () => {
    const { service } = build();
    await expect(service.create({ resource_type: 'credential', resource_ref: { credential_id: 'cred-1' }, target_group_id: 'infra' }, secopsManager))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('이미 쓸 수 있는 자원은 요청을 만들지 않는다', async () => {
    const { service } = build({ credential: { status: 'ok', name: 'hr-db', owner_group_id: 'secops' } });
    await expect(service.create({ resource_type: 'credential', resource_ref: { credential_id: 'cred-1' }, target_group_id: 'infra' }, infraManager))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('소유 그룹 관리자가 승인하면 공유를 반영하고, 다른 그룹 관리자는 처리할 수 없다', async () => {
    const { service, credentials } = build();
    const request = await service.create({ resource_type: 'credential', resource_ref: { credential_id: 'cred-1' }, target_group_id: 'infra' }, infraManager);

    await expect(service.decide(request.id, 'approve', '', infraManager)).rejects.toBeInstanceOf(ForbiddenException);
    expect(credentials.shareWithGroupByRequest).not.toHaveBeenCalled();

    const approved = await service.decide(request.id, 'approve', '확인했습니다', secopsManager);
    expect(credentials.shareWithGroupByRequest).toHaveBeenCalledWith('cred-1', 'infra', secopsManager, request.id);
    expect(approved).toMatchObject({ status: 'approved', decided_by: 'secops-mgr', decision_comment: '확인했습니다' });
    await expect(service.decide(request.id, 'reject', '', secopsManager)).rejects.toBeInstanceOf(ConflictException);
  });

  it('JS 라이브러리 사용 요청은 최고관리자만 승인하고, 승인하면 그룹 허용을 반영한다', async () => {
    const { service, libraries } = build();
    const request = await service.create({ resource_type: 'script_library', resource_ref: { package_name: 'lodash', version: '4.17.21' }, target_group_id: 'infra' }, infraManager);
    expect(request).toMatchObject({ approver_role: 'admin', resource_label: 'lodash@4.17.21' });

    await expect(service.decide(request.id, 'approve', '', secopsManager)).rejects.toBeInstanceOf(ForbiddenException);
    await service.decide(request.id, 'approve', '', admin);
    expect(libraries.allowGroupByRequest).toHaveBeenCalledWith('lodash', '4.17.21', 'infra', 'admin', request.id);
  });

  it('반려하면 권한을 바꾸지 않는다', async () => {
    const { service, credentials } = build();
    const request = await service.create({ resource_type: 'credential', resource_ref: { credential_id: 'cred-1' }, target_group_id: 'infra' }, infraManager);
    const rejected = await service.decide(request.id, 'reject', '다른 자격증명을 쓰세요', secopsManager);
    expect(rejected.status).toBe('rejected');
    expect(credentials.shareWithGroupByRequest).not.toHaveBeenCalled();
  });

  it('요청자는 대기 중인 자기 요청만 취소할 수 있다', async () => {
    const { service } = build();
    const request = await service.create({ resource_type: 'credential', resource_ref: { credential_id: 'cred-1' }, target_group_id: 'infra' }, infraManager);
    await expect(service.cancel(request.id, secopsManager)).rejects.toMatchObject({ status: 404 });
    expect((await service.cancel(request.id, infraManager)).status).toBe('cancelled');
  });
});
