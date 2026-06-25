import { Module } from '@nestjs/common';
import { pgPoolProvider } from './pg.provider';
import { mongoDbProvider } from './mongo.provider';
import { PostgresAdapter } from './adapters/postgres.adapter';
import { MongodbAdapter } from './adapters/mongodb.adapter';
import {
  WorkflowRepositoryPort,
  WorkflowInstanceRepositoryPort,
  WorkflowTaskRepositoryPort,
  OutboxRepositoryPort,
  EngineQueueRepositoryPort,
  WorkflowScheduleRepositoryPort,
} from './ports/db.ports';
import { MONGO_DB } from './mongo.provider';

const dbType = process.env.DB_TYPE || 'postgres';
const isMongo = dbType === 'mongodb';

@Module({
  providers: [
    pgPoolProvider,
    mongoDbProvider,
    {
      provide: WorkflowRepositoryPort,
      useClass: isMongo ? MongodbAdapter : PostgresAdapter,
    },
    {
      provide: WorkflowInstanceRepositoryPort,
      useClass: isMongo ? MongodbAdapter : PostgresAdapter,
    },
    {
      provide: WorkflowTaskRepositoryPort,
      useClass: isMongo ? MongodbAdapter : PostgresAdapter,
    },
    {
      provide: OutboxRepositoryPort,
      useClass: isMongo ? MongodbAdapter : PostgresAdapter,
    },
    {
      provide: EngineQueueRepositoryPort,
      useClass: isMongo ? MongodbAdapter : PostgresAdapter,
    },
    {
      provide: WorkflowScheduleRepositoryPort,
      useClass: isMongo ? MongodbAdapter : PostgresAdapter,
    },
  ],
  exports: [
    MONGO_DB,
    WorkflowRepositoryPort,
    WorkflowInstanceRepositoryPort,
    WorkflowTaskRepositoryPort,
    OutboxRepositoryPort,
    EngineQueueRepositoryPort,
    WorkflowScheduleRepositoryPort,
  ],
})
export class DbModule {}
