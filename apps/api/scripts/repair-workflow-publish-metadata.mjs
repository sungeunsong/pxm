import { MongoClient } from 'mongodb';
import pg from 'pg';

const apply = process.argv.includes('--apply');
const dbType = (process.env.DB_TYPE || 'mongodb').toLowerCase();

function positiveVersion(value) {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : null;
}

function validTimestamp(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

function sameValue(left, right) {
  return left === right || (left == null && right == null);
}

function printSummary(summary) {
  console.log(
    JSON.stringify(
      { mode: apply ? 'apply' : 'dry-run', db_type: dbType, ...summary },
      null,
      2,
    ),
  );
}

async function repairMongo() {
  const client = new MongoClient(
    process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/?replicaSet=rs0',
  );
  await client.connect();
  try {
    const db = client.db(process.env.MONGO_DB_NAME || 'pxm_db');
    const definitions = await db
      .collection('v2_process_definitions')
      .find({
        status: { $ne: 'DELETED' },
        $or: [
          { lifecycle_status: 'PUBLISHED' },
          {
            lifecycle_status: { $exists: false },
            'metadata.lifecycle_status': 'PUBLISHED',
          },
          {
            lifecycle_status: null,
            'metadata.lifecycle_status': 'PUBLISHED',
          },
        ],
      })
      .toArray();
    const report = [];

    for (const definition of definitions) {
      const currentVersion = positiveVersion(definition.version);
      const storedVersion = positiveVersion(
        definition.active_published_version ??
          definition.metadata?.active_published_version,
      );
      const versionCandidates = [
        ...new Set([storedVersion, currentVersion].filter(Boolean)),
      ];
      let snapshot = null;
      for (const version of versionCandidates) {
        snapshot = await db
          .collection('v2_process_definition_versions')
          .findOne({ definition_id: definition._id, version });
        if (snapshot) break;
      }

      if (!snapshot) {
        report.push({
          id: definition._id,
          action: 'skipped',
          reason: 'no matching immutable version snapshot',
        });
        continue;
      }

      const canReuseExistingPublication =
        storedVersion == null || storedVersion === snapshot.version;

      const audit = await db.collection('management_audit_logs').findOne(
        {
          action: 'workflow.deployed',
          resource_type: 'workflow',
          resource_id: definition._id,
          'details.active_published_version': snapshot.version,
        },
        { sort: { created_at: -1 } },
      );
      const timestampCandidates = [
        [
          'existing',
          canReuseExistingPublication
            ? validTimestamp(
                definition.published_at ?? definition.metadata?.published_at,
              )
            : null,
        ],
        ['deployment-audit', validTimestamp(audit?.created_at)],
        ['version-snapshot', validTimestamp(snapshot.created_at)],
        ['definition-updated', validTimestamp(definition.updated_at)],
        ['definition-created', validTimestamp(definition.created_at)],
      ];
      const [timestampSource, publishedAt] =
        timestampCandidates.find(([, value]) => value) || [];
      if (!publishedAt) {
        report.push({
          id: definition._id,
          action: 'skipped',
          reason: 'no trustworthy publication timestamp',
        });
        continue;
      }
      const publishedBy =
        (canReuseExistingPublication
          ? (definition.published_by ?? definition.metadata?.published_by)
          : null) ??
        audit?.actor_id ??
        snapshot.created_by ??
        snapshot.metadata?.created_by ??
        null;
      const alreadyConsistent =
        definition.lifecycle_status === 'PUBLISHED' &&
        definition.metadata?.lifecycle_status === 'PUBLISHED' &&
        definition.active_published_version === snapshot.version &&
        definition.metadata?.active_published_version === snapshot.version &&
        definition.published_at === publishedAt &&
        definition.metadata?.published_at === publishedAt &&
        sameValue(definition.published_by, publishedBy) &&
        sameValue(definition.metadata?.published_by, publishedBy);
      if (alreadyConsistent) continue;

      const item = {
        id: definition._id,
        action: apply ? 'updated' : 'would-update',
        active_published_version: snapshot.version,
        published_at_source: timestampSource,
      };
      if (apply) {
        const result = await db.collection('v2_process_definitions').updateOne(
          {
            _id: definition._id,
            version: definition.version,
            status: { $ne: 'DELETED' },
          },
          {
            $set: {
              lifecycle_status: 'PUBLISHED',
              active_published_version: snapshot.version,
              published_at: publishedAt,
              published_by: publishedBy,
              'metadata.lifecycle_status': 'PUBLISHED',
              'metadata.active_published_version': snapshot.version,
              'metadata.published_at': publishedAt,
              'metadata.published_by': publishedBy,
            },
          },
        );
        if (result.modifiedCount !== 1) {
          item.action = 'skipped';
          item.reason = 'definition changed concurrently';
        }
      }
      report.push(item);
    }

    printSummary({
      published_definitions: definitions.length,
      changes: report.filter(
        (item) => item.action === 'updated' || item.action === 'would-update',
      ).length,
      report,
    });
  } finally {
    await client.close();
  }
}

async function repairPostgres() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows: definitions } = await pool.query(
      `SELECT id, version, status, metadata, created_at, updated_at
       FROM v2_process_definitions
       WHERE status <> 'DELETED' AND metadata->>'lifecycle_status' = 'PUBLISHED'`,
    );
    const report = [];

    for (const definition of definitions) {
      const storedVersion = positiveVersion(
        definition.metadata?.active_published_version,
      );
      const candidates = [
        ...new Set(
          [storedVersion, positiveVersion(definition.version)].filter(Boolean),
        ),
      ];
      let snapshot = null;
      for (const version of candidates) {
        const result = await pool.query(
          `SELECT version, metadata, created_at FROM v2_process_definition_versions
           WHERE definition_id = $1::uuid AND version = $2`,
          [definition.id, version],
        );
        if (result.rows[0]) {
          snapshot = result.rows[0];
          break;
        }
      }
      if (!snapshot) {
        report.push({
          id: definition.id,
          action: 'skipped',
          reason: 'no matching immutable version snapshot',
        });
        continue;
      }

      const timestampCandidates = [
        ['existing', validTimestamp(definition.metadata?.published_at)],
        [
          'version-snapshot',
          validTimestamp(new Date(snapshot.created_at).toISOString()),
        ],
        [
          'definition-updated',
          validTimestamp(new Date(definition.updated_at).toISOString()),
        ],
        [
          'definition-created',
          validTimestamp(new Date(definition.created_at).toISOString()),
        ],
      ];
      const [timestampSource, publishedAt] =
        timestampCandidates.find(([, value]) => value) || [];
      if (!publishedAt) {
        report.push({
          id: definition.id,
          action: 'skipped',
          reason: 'no trustworthy publication timestamp',
        });
        continue;
      }
      const publishedBy =
        definition.metadata?.published_by ??
        snapshot.metadata?.created_by ??
        snapshot.metadata?.updated_by ??
        null;
      const metadata = {
        ...definition.metadata,
        lifecycle_status: 'PUBLISHED',
        active_published_version: snapshot.version,
        published_at: publishedAt,
        published_by: publishedBy,
      };
      const alreadyConsistent =
        JSON.stringify(metadata) === JSON.stringify(definition.metadata);
      if (alreadyConsistent) continue;

      const item = {
        id: definition.id,
        action: apply ? 'updated' : 'would-update',
        active_published_version: snapshot.version,
        published_at_source: timestampSource,
      };
      if (apply) {
        const result = await pool.query(
          `UPDATE v2_process_definitions SET metadata = $3::jsonb
           WHERE id = $1::uuid AND version = $2 AND status <> 'DELETED'`,
          [definition.id, definition.version, JSON.stringify(metadata)],
        );
        if (result.rowCount !== 1) {
          item.action = 'skipped';
          item.reason = 'definition changed concurrently';
        }
      }
      report.push(item);
    }

    printSummary({
      published_definitions: definitions.length,
      changes: report.filter(
        (item) => item.action === 'updated' || item.action === 'would-update',
      ).length,
      report,
    });
  } finally {
    await pool.end();
  }
}

(dbType === 'postgres' ? repairPostgres() : repairMongo()).catch((error) => {
  console.error('[workflow-publish-metadata] repair failed');
  console.error(error);
  process.exitCode = 1;
});
