import { Provider } from '@nestjs/common';
import { MongoClient, Db } from 'mongodb';

export const MONGO_DB = Symbol('MONGO_DB');

export const mongoDbProvider: Provider = {
  provide: MONGO_DB,
  useFactory: async (): Promise<Db> => {
    const mongoUrl = process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017';
    const dbName = process.env.MONGO_DB_NAME || 'pxm_db';
    
    console.log(`[BFF] Connecting to MongoDB at ${mongoUrl} (DB: ${dbName})...`);
    const client = new MongoClient(mongoUrl);
    await client.connect();

    const admin = client.db('admin');
    const hello = await admin.command({ hello: 1 }).catch(() => null);
    if (!hello?.setName && process.env.ALLOW_MONGO_STANDALONE !== 'true') {
      console.warn(
        '[BFF] MongoDB is not running as a replica set. Engine runtime transactions require replica set or managed cluster mode.',
      );
    }

    return client.db(dbName);
  },
};
