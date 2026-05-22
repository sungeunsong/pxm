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
    return client.db(dbName);
  },
};
