import { Inject, Injectable } from '@nestjs/common';
import type { Db, Filter } from 'mongodb';
import { MONGO_DB } from '../mongo.provider';
import {
  EntryPoint,
  EntryPointConflictError,
  EntryPointPatch,
  EntryPointQuery,
  EntryPointRepositoryPort,
} from '../ports/entry-points.port';

const COLLECTION = 'pxm_entry_points';

@Injectable()
export class MongoEntryPointRepository implements EntryPointRepositoryPort {
  private indexesReady = false;

  constructor(@Inject(MONGO_DB) private readonly db: Db) {}

  async createEntryPoint(entry: EntryPoint): Promise<EntryPoint> {
    await this.ensureIndexes();
    const { id, ...rest } = entry;
    try {
      await this.collection().insertOne({ _id: id, ...rest });
    } catch (error) {
      throw translateDuplicate(error);
    }
    return entry;
  }

  async getEntryPoint(id: string): Promise<EntryPoint | null> {
    await this.ensureIndexes();
    const doc = await this.collection().findOne({ _id: id });
    return doc ? mapEntryPointDoc(doc) : null;
  }

  async listEntryPoints(query: EntryPointQuery = {}): Promise<EntryPoint[]> {
    await this.ensureIndexes();
    const filter: Filter<any> = {};
    if (query.kind) filter.kind = query.kind;
    if (query.group_ids) filter.group_id = { $in: query.group_ids };
    if (query.definition_id) filter.definition_id = query.definition_id;
    if (query.status) filter.status = query.status;
    if (query.tool_name) filter['tool.name'] = query.tool_name;
    if (query.route) {
      filter['route.method'] = query.route.method;
      filter['route.path'] = query.route.path;
    }
    const docs = await this.collection()
      .find(filter)
      .sort({ updated_at: -1, _id: 1 })
      .toArray();
    return docs.map(mapEntryPointDoc);
  }

  async updateEntryPoint(
    id: string,
    patch: EntryPointPatch,
  ): Promise<EntryPoint | null> {
    await this.ensureIndexes();
    try {
      const result = await this.collection().findOneAndUpdate(
        { _id: id },
        { $set: { ...patch, updated_at: new Date().toISOString() } },
        { returnDocument: 'after' },
      );
      return result ? mapEntryPointDoc(result) : null;
    } catch (error) {
      throw translateDuplicate(error);
    }
  }

  async deleteEntryPoint(id: string): Promise<boolean> {
    await this.ensureIndexes();
    const result = await this.collection().deleteOne({ _id: id });
    return result.deletedCount > 0;
  }

  private collection() {
    return this.db.collection<any>(COLLECTION);
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesReady) return;
    const collection = this.collection();
    await collection.createIndex(
      { group_id: 1, 'tool.name': 1 },
      {
        unique: true,
        name: 'ux_pxm_entry_points_tool_name',
        partialFilterExpression: { kind: 'tool' },
      },
    );
    await collection.createIndex(
      { 'route.method': 1, 'route.path': 1 },
      {
        unique: true,
        name: 'ux_pxm_entry_points_route',
        partialFilterExpression: { kind: 'route' },
      },
    );
    await collection.createIndex(
      { group_id: 1, status: 1, updated_at: -1 },
      { name: 'idx_pxm_entry_points_group_status' },
    );
    await collection.createIndex(
      { definition_id: 1, pinned_version: 1 },
      { name: 'idx_pxm_entry_points_definition' },
    );
    this.indexesReady = true;
  }
}

function translateDuplicate(error: unknown): unknown {
  if ((error as { code?: number })?.code === 11000)
    return new EntryPointConflictError();
  return error;
}

export function mapEntryPointDoc(doc: any): EntryPoint {
  return {
    id: doc._id,
    kind: doc.kind,
    group_id: doc.group_id,
    tenant_id: doc.tenant_id ?? null,
    definition_id: doc.definition_id,
    pinned_version: Number(doc.pinned_version),
    input_schema: doc.input_schema ?? { type: 'object', properties: {} },
    input_schema_source:
      doc.input_schema_source === 'manual' ? 'manual' : 'derived',
    output_schema: doc.output_schema ?? null,
    output_contract:
      doc.output_contract === 'declared' ? 'declared' : 'free_form',
    side_effect: doc.side_effect,
    status: doc.status,
    description: doc.description ?? '',
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    resource_digest: doc.resource_digest ?? null,
    history_policy: {
      body: doc.history_policy?.body === 'masked' ? 'masked' : 'none',
    },
    tool: doc.tool ?? null,
    route: doc.route ?? null,
    created_by: doc.created_by ?? null,
    updated_by: doc.updated_by ?? null,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}
