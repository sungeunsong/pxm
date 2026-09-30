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
  WorkflowInputPresetRepositoryPort,
  AuthzRepositoryPort,
} from './ports/db.ports';
import { MONGO_DB } from './mongo.provider';
import type { Db } from 'mongodb';
import { EntryPointRepositoryPort } from './ports/entry-points.port';
import { MongoEntryPointRepository } from './adapters/entry-points.mongodb';
import { PostgresEntryPointRepository } from './adapters/entry-points.postgres';
import {
  InstanceChangeSignalPort,
  MongoInstanceChangeSignal,
  PollingInstanceChangeSignal,
} from './instance-change-signal';

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
    {
      provide: WorkflowInputPresetRepositoryPort,
      useClass: isMongo ? MongodbAdapter : PostgresAdapter,
    },
    {
      provide: AuthzRepositoryPort,
      useClass: isMongo ? MongodbAdapter : PostgresAdapter,
    },
    {
      provide: EntryPointRepositoryPort,
      useClass: isMongo
        ? MongoEntryPointRepository
        : PostgresEntryPointRepository,
    },
    {
      provide: InstanceChangeSignalPort,
      inject: [MONGO_DB],
      useFactory: (db: Db) =>
        isMongo
          ? new MongoInstanceChangeSignal(db)
          : new PollingInstanceChangeSignal(),
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
    WorkflowInputPresetRepositoryPort,
    AuthzRepositoryPort,
    EntryPointRepositoryPort,
    InstanceChangeSignalPort,
  ],
})
export class DbModule {}
