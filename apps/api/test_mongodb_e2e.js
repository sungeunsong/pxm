const { MongoClient } = require('mongodb');
const http = require('http');

const MONGO_URL = process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGO_DB_NAME || 'pxm_db';
const TEMPLATE_ID = 'e8b28cf9-c3d6-444a-a3a8-6f176b9868e3';

async function main() {
  console.log('[Test] Connecting to MongoDB...');
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db(DB_NAME);

  console.log('[Test] Seeding IT Access Request Definition into v2_process_definitions...');
  const now = new Date().toISOString();
  await db.collection('v2_process_definitions').updateOne(
    { _id: TEMPLATE_ID },
    {
      $set: {
        name: 'IT Access Request (MongoDB Test)',
        nodes: [
          {
            node_id: 'start_1',
            node_type: 'start',
            config: { id: 'start_1', data: { nodeType: 'start' } }
          },
          {
            node_id: 'approve_1',
            node_type: 'approval',
            config: { id: 'approve_1', data: { nodeType: 'approval', assignee: 'admin' } }
          },
          {
            node_id: 'end_1',
            node_type: 'end',
            config: { id: 'end_1', data: { nodeType: 'end' } }
          }
        ],
        edges: [
          {
            id: 'edge_1',
            source_node_id: 'start_1',
            target_node_id: 'approve_1',
            condition_expr: null,
            is_default: true,
            eval_order: 0
          },
          {
            id: 'edge_2',
            source_node_id: 'approve_1',
            target_node_id: 'end_1',
            condition_expr: 'action == "approve"',
            is_default: true,
            eval_order: 1
          }
        ],
        updated_at: now
      },
      $setOnInsert: {
        created_at: now
      }
    },
    { upsert: true }
  );

  console.log('[Test] Seed completed successfully!');
  await client.close();
}

main().catch(console.error);
