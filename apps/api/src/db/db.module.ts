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
} from './ports/db.ports';

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
  ],
  exports: [
    WorkflowRepositoryPort,
    WorkflowInstanceRepositoryPort,
    WorkflowTaskRepositoryPort,
    OutboxRepositoryPort,
  ],
})
export class DbModule {}
