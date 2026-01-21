import { Provider } from '@nestjs/common';
import { Pool } from 'pg';

export const PG_POOL = Symbol('PG_POOL');

export const pgPoolProvider: Provider = {
  provide: PG_POOL,
  useFactory: () => {
    const pool = new Pool({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT ?? 5432),
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      max: Number(process.env.PGPOOL_MAX ?? 10),
    });
    return pool;
  },
};
