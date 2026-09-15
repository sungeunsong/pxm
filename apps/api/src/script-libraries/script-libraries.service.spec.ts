import { BadRequestException } from '@nestjs/common';
import type { Db } from 'mongodb';
import { ScriptLibrariesService } from './script-libraries.service';

describe('ScriptLibrariesService workflow binding', () => {
  const approved = {
    _id: 'library-1',
    id: 'library-1',
    package_name: 'lodash',
    version: '4.17.21',
    description: '',
    license: 'MIT',
    integrity: 'sha512-test',
    bundle_sha256: 'a'.repeat(64),
    bundle_bytes: 20,
    dependency_count: 1,
    package_lock_sha256: 'b'.repeat(64),
    bundle: 'module.exports = {};',
    status: 'approved',
    allowed_group_ids: ['group-a'],
    created_by: 'admin',
    approved_by: 'admin',
    created_at: '2026-09-16T00:00:00Z',
    updated_at: '2026-09-16T00:00:00Z',
  };

  function serviceWith(documents: unknown[]) {
    const collection = {
      find: () => ({ toArray: () => Promise.resolve(documents) }),
    };
    return new ScriptLibrariesService({
      collection: () => collection,
    } as unknown as Db);
  }

  const nodes = [
    {
      id: 'script',
      data: {
        nodeType: 'script',
        code: "return libs['lodash'].sum([1, 2]);",
        scriptLibraries: [{ package_name: 'lodash', version: '4.17.21' }],
      },
    },
  ];

  it('embeds only the approved exact version for an allowed group', async () => {
    const service = serviceWith([approved]);
    const hydrated = await service.hydrateNodes(nodes, 'group-a');

    expect(hydrated[0].data?.scriptLibraryBundles).toEqual([
      {
        package_name: 'lodash',
        version: '4.17.21',
        bundle_sha256: 'a'.repeat(64),
        bundle: 'module.exports = {};',
      },
    ]);
    expect(
      service.stripBundles(hydrated)[0].data?.scriptLibraryBundles,
    ).toBeUndefined();
  });

  it('rejects a library outside the workflow group', async () => {
    await expect(
      serviceWith([approved]).hydrateNodes(nodes, 'group-b'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a disabled version even when the bundle still exists', async () => {
    await expect(
      serviceWith([
        { ...approved, status: 'disabled', allowed_group_ids: [] },
      ]).hydrateNodes(nodes, null),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
