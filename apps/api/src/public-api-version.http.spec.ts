import { Test } from '@nestjs/testing';
import request from 'supertest';
import { InstanceTasksController, TasksController } from './tasks/tasks.controller';
import { TasksService } from './tasks/tasks.service';
import { enablePublicApiVersioning } from './public-api-version';

describe('public API v1 HTTP routing', () => {
  it('serves public routes on v1 while keeping management routes unversioned', async () => {
    const tasks = {
      listOpenTasks: jest.fn().mockResolvedValue([]),
      retryExternalApproval: jest.fn().mockResolvedValue({ success: true }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [TasksController, InstanceTasksController],
      providers: [{ provide: TasksService, useValue: tasks }],
    }).compile();
    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    enablePublicApiVersioning(app);
    await app.init();

    try {
      await request(app.getHttpServer()).get('/api/tasks').expect(200, []);
      await request(app.getHttpServer()).get('/api/v1/tasks').expect(200, []);
      await request(app.getHttpServer()).post('/api/v1/tasks/task-1/external-approval/retry').expect(404);
      await request(app.getHttpServer()).post('/api/tasks/task-1/external-approval/retry').expect(201, { success: true });
    } finally {
      await app.close();
    }
  });
});
