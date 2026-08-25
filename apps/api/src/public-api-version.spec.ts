import { VERSION_METADATA } from '@nestjs/common/constants';
import { VERSION_NEUTRAL, VersioningType } from '@nestjs/common';
import { InstancesController } from './instances/instances.controller';
import { TasksController } from './tasks/tasks.controller';
import { TemplatesController } from './templates/templates.controller';
import { enablePublicApiVersioning, PUBLIC_API_VERSIONS } from './public-api-version';

describe('public API v1 boundary', () => {
  it('enables URI versioning', () => {
    const app = { enableVersioning: jest.fn() };
    enablePublicApiVersioning(app as any);
    expect(app.enableVersioning).toHaveBeenCalledWith({ type: VersioningType.URI });
  });

  it.each([
    [TemplatesController, 'findAll'],
    [TemplatesController, 'findOne'],
    [TemplatesController, 'execute'],
    [InstancesController, 'findAll'],
    [InstancesController, 'findOne'],
    [InstancesController, 'result'],
    [InstancesController, 'trace'],
    [InstancesController, 'stream'],
    [TasksController, 'getTasks'],
    [TasksController, 'history'],
    [TasksController, 'historyItem'],
    [TasksController, 'completeTask'],
  ])('exposes %s.%s on both legacy and v1 paths', (controller, method) => {
    const versions = Reflect.getMetadata(VERSION_METADATA, (controller as any).prototype[method]);
    expect(versions).toEqual(PUBLIC_API_VERSIONS);
    expect(versions).toContain(VERSION_NEUTRAL);
    expect(versions).toContain('1');
  });

  it.each([
    [TemplatesController, 'create'],
    [TemplatesController, 'deploy'],
    [TemplatesController, 'delete'],
    [InstancesController, 'retry'],
    [InstancesController, 'terminate'],
    [TasksController, 'retryExternalApproval'],
  ])('keeps management route %s.%s off the versioned public API', (controller, method) => {
    expect(Reflect.getMetadata(VERSION_METADATA, (controller as any).prototype[method])).toBeUndefined();
  });
});
