const { MongoClient } = require('mongodb');

async function main() {
  const client = new MongoClient('mongodb://127.0.0.1:27017/?retryWrites=false');
  await client.connect();
  const db = client.db('pxm_db');
  
  console.log('=== Listing collections ===');
  const collections = await db.listCollections().toArray();
  console.log(collections.map(c => c.name));
  
  console.log('\n=== Dumping a process definition ===');
  const def = await db.collection('v2_process_definitions').findOne({});
  console.log(JSON.stringify(def, null, 2));
  
  await client.close();
}

main().catch(console.error);
