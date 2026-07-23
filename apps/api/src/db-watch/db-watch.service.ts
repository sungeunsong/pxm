import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ChangeStream, ChangeStreamDocument, Db, Document, MongoClient, ObjectId } from 'mongodb';
import { WorkflowInstanceRepositoryPort, WorkflowRepositoryPort, WorkflowHistoryActor } from '../db/ports/db.ports';
import { MONGO_DB } from '../db/mongo.provider';
import { CredentialsService } from '../credentials/credentials.service';

type DbWatchOperation = 'insert' | 'update' | 'upsert';
type DbWatchMode = 'polling' | 'change_stream';

interface DbWatchJob {
  _id: string;
  definition_id: string;
  definition_name: string;
  start_node_id: string;
  database: string | null;
  collection: string;
  credential_id?: string | null;
  operation: DbWatchOperation;
  mode: DbWatchMode;
  filter: Record<string, any>;
  poll_interval_seconds: number;
  cursor_field: string;
  active: boolean;
  status: 'IDLE' | 'RUNNING' | 'FAILED';
  last_seen_value?: any;
  next_poll_at: Date;
  last_polled_at?: Date;
  last_instance_id?: string;
  last_error?: string;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class DbWatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbWatchService.name);
  private timer?: NodeJS.Timeout;
  private watchTimer?: NodeJS.Timeout;
  private running = false;
  private readonly changeStreams = new Map<string, ChangeStream>();
  private readonly credentialClients = new Map<string, { connectionString: string; client: MongoClient }>();

  constructor(
    @Inject(MONGO_DB) private readonly db: Db,
    private readonly workflowRepo: WorkflowRepositoryPort,
    private readonly instanceRepo: WorkflowInstanceRepositoryPort,
    private readonly credentialsService: CredentialsService,
  ) {}

  async onModuleInit() {
    await this.ensureIndexes();

    const enabled = process.env.DB_WATCH_START_ENABLED !== 'false';
    if (!enabled) return;

    const pollMs = positiveInt(process.env.DB_WATCH_START_POLL_MS, 1000);
    this.timer = setInterval(
      () => {
        void this.tick();
      },
      Math.max(1000, pollMs),
    );
    this.timer.unref?.();

    const watchMs = positiveInt(process.env.DB_WATCH_CHANGE_STREAM_RECONCILE_MS, 5000);
    this.watchTimer = setInterval(
      () => {
        void this.reconcileChangeStreams();
      },
      Math.max(1000, watchMs),
    );
    this.watchTimer.unref?.();

    void this.tick();
    void this.reconcileChangeStreams();
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
    }
    for (const stream of this.changeStreams.values()) {
      void stream.close();
    }
    this.changeStreams.clear();
    for (const entry of this.credentialClients.values()) {
      void entry.client.close();
    }
    this.credentialClients.clear();
  }

  async syncDefinitionWatchJobs(definitionId: string, definitionName: string, nodes: any[]): Promise<void> {
    const now = new Date();
    const jobs = (nodes || [])
      .filter((node) => node?.data?.nodeType === 'start')
      .map((node) => buildDbWatchJob(definitionId, definitionName, node, now, this.db.databaseName))
      .filter((job): job is DbWatchJob => Boolean(job));

    const collection = this.db.collection<DbWatchJob>('v2_db_watch_jobs');
    const jobIds = jobs.map((job) => job._id);

    await collection.updateMany(
      {
        definition_id: definitionId,
        ...(jobIds.length > 0 ? { _id: { $nin: jobIds } } : {}),
      },
      {
        $set: {
          active: false,
          status: 'IDLE',
          updated_at: now,
        },
      },
    );

    for (const job of jobs) {
      const existing = await collection.findOne({ _id: job._id });
      await collection.updateOne(
        { _id: job._id },
        {
          $set: {
            definition_id: job.definition_id,
            definition_name: job.definition_name,
            start_node_id: job.start_node_id,
            database: job.database,
            collection: job.collection,
            credential_id: job.credential_id || null,
            operation: job.operation,
            mode: job.mode,
            filter: job.filter,
            poll_interval_seconds: job.poll_interval_seconds,
            cursor_field: job.cursor_field,
            active: job.active,
            status: 'IDLE',
            next_poll_at: existing?.next_poll_at || job.next_poll_at,
            updated_at: now,
          },
          $setOnInsert: {
            _id: job._id,
            last_seen_value: job.last_seen_value,
            created_at: now,
          },
        },
        { upsert: true },
      );

      if (shouldRestartChangeStream(existing, job)) {
        await this.closeChangeStream(job._id);
      }
    }

    await this.reconcileChangeStreams();
  }

  async testConnection(
    config: {
      database?: string | null;
      collection?: string | null;
      credential_id?: string | null;
      mode?: DbWatchMode | string | null;
      cursor_field?: string | null;
      filter?: Record<string, any> | null;
    },
    actor: WorkflowHistoryActor,
  ): Promise<{
    ok: boolean;
    duration_ms: number;
    details: Record<string, any>;
  }> {
    const startedAt = Date.now();
    const collection = stringOrEmpty(config.collection).trim();
    if (!collection) {
      throw new Error('collection is required');
    }

    const job: DbWatchJob = {
      _id: 'db-watch-test',
      definition_id: 'db-watch-test',
      definition_name: 'DB Watch Test',
      start_node_id: 'db-watch-test',
      database: stringOrEmpty(config.database).trim() || null,
      collection,
      credential_id: stringOrEmpty(config.credential_id).trim() || null,
      operation: 'insert',
      mode: normalizeMode(config.mode),
      filter: isPlainObject(config.filter) ? config.filter : {},
      poll_interval_seconds: 10,
      cursor_field: stringOrEmpty(config.cursor_field).trim() || 'created_at',
      active: false,
      status: 'IDLE',
      next_poll_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    };

    const targetDb = await this.getTargetDb(job, actor);
    await targetDb.command({ ping: 1 });
    const target = targetDb.collection(job.collection);
    const hasMatchingDocument = await target.find(job.filter).limit(1).maxTimeMS(3000).hasNext();
    const hasCursorDocument = await target.find(buildCursorPresenceFilter(job.filter, job.cursor_field)).limit(1).maxTimeMS(3000).hasNext();
    let changeStreamOpened = false;

    if (job.mode === 'change_stream') {
      const stream = target.watch([], {
        fullDocument: 'updateLookup',
        maxAwaitTimeMS: 1000,
      });
      changeStreamOpened = true;
      await stream.close().catch(() => undefined);
    }

    return {
      ok: true,
      duration_ms: Date.now() - startedAt,
      details: {
        database: targetDb.databaseName,
        collection: job.collection,
        mode: job.mode,
        credential_id: job.credential_id,
        cursor_field: job.cursor_field,
        filter_matched_existing_document: hasMatchingDocument,
        cursor_field_found_on_matching_document: hasCursorDocument,
        change_stream_opened: changeStreamOpened,
      },
    };
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const now = new Date();
      const limit = positiveInt(process.env.DB_WATCH_START_BATCH_SIZE, 50);
      const jobs = await this.db
        .collection<DbWatchJob>('v2_db_watch_jobs')
        .find({
          active: true,
          mode: { $ne: 'change_stream' },
          next_poll_at: { $lte: now },
        })
        .sort({ next_poll_at: 1 })
        .limit(limit)
        .toArray();

      for (const job of jobs) {
        await this.runWatchJob(job);
      }
    } catch (error) {
      this.logger.error(`DB watch tick failed: ${errorMessage(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async reconcileChangeStreams(): Promise<void> {
    const jobs = await this.db
      .collection<DbWatchJob>('v2_db_watch_jobs')
      .find({
        active: true,
        mode: 'change_stream',
      })
      .toArray();

    const activeIds = new Set(jobs.map((job) => job._id));
    for (const [jobId, stream] of this.changeStreams.entries()) {
      if (!activeIds.has(jobId)) {
        await this.closeChangeStream(jobId, stream);
      }
    }

    for (const job of jobs) {
      if (!this.changeStreams.has(job._id)) {
        await this.openChangeStream(job);
      }
    }
  }

  private async openChangeStream(job: DbWatchJob): Promise<void> {
    try {
      const targetDb = await this.getTargetDb(job);
      const pipeline = buildChangeStreamPipeline(job);
      const stream = targetDb.collection(job.collection).watch(pipeline, {
        fullDocument: 'updateLookup',
      });

      stream.on('change', (change) => {
        void this.handleChangeStreamEvent(job._id, change);
      });
      stream.on('error', (error) => {
        this.logger.warn(`DB watch change stream failed: watch=${job._id} error=${errorMessage(error)}`);
        void stream.close().catch(() => undefined);
        this.changeStreams.delete(job._id);
        void this.db.collection<DbWatchJob>('v2_db_watch_jobs').updateOne(
          { _id: job._id },
          {
            $set: {
              status: 'FAILED',
              last_error: errorMessage(error),
              updated_at: new Date(),
            },
          },
        );
      });
      stream.on('close', () => {
        if (this.changeStreams.get(job._id) === stream) {
          this.changeStreams.delete(job._id);
        }
      });

      this.changeStreams.set(job._id, stream);
      await this.db.collection<DbWatchJob>('v2_db_watch_jobs').updateOne(
        { _id: job._id },
        {
          $set: {
            status: 'IDLE',
            last_error: undefined,
            updated_at: new Date(),
          },
        },
      );
      this.logger.log(`DB watch change stream opened: watch=${job._id}`);
    } catch (error) {
      await this.db.collection<DbWatchJob>('v2_db_watch_jobs').updateOne(
        { _id: job._id },
        {
          $set: {
            status: 'FAILED',
            last_error: errorMessage(error),
            updated_at: new Date(),
          },
        },
      );
    }
  }

  private async handleChangeStreamEvent(jobId: string, change: ChangeStreamDocument<Document>): Promise<void> {
    try {
      const job = await this.db.collection<DbWatchJob>('v2_db_watch_jobs').findOne({
        _id: jobId,
        active: true,
        mode: 'change_stream',
      });
      if (!job) {
        return;
      }

      const document = (change as any).fullDocument;
      if (!document || !matchesPlainFilter(document, job.filter)) {
        return;
      }

      const cursorValue = readPath(document, job.cursor_field) ?? (change as any)._id;
      const instanceId = await this.startWorkflowFromDocument(job, document, cursorValue, stableCursorKey(cursorValue));

      await this.db.collection<DbWatchJob>('v2_db_watch_jobs').updateOne(
        { _id: job._id },
        {
          $set: {
            status: 'IDLE',
            last_polled_at: new Date(),
            last_seen_value: serializeCursorValue(cursorValue),
            last_instance_id: instanceId || job.last_instance_id,
            last_error: undefined,
            updated_at: new Date(),
          },
        },
      );
    } catch (error) {
      this.logger.warn(`DB watch change event failed: watch=${jobId} error=${errorMessage(error)}`);
      await this.db.collection<DbWatchJob>('v2_db_watch_jobs').updateOne(
        { _id: jobId },
        {
          $set: {
            status: 'FAILED',
            last_error: errorMessage(error),
            updated_at: new Date(),
          },
        },
      );
    }
  }

  private async runWatchJob(job: DbWatchJob): Promise<void> {
    const jobs = this.db.collection<DbWatchJob>('v2_db_watch_jobs');
    const now = new Date();
    await jobs.updateOne(
      { _id: job._id },
      {
        $set: {
          status: 'RUNNING',
          last_polled_at: now,
          updated_at: now,
        },
      },
    );

    try {
      const targetDb = await this.getTargetDb(job);
      const target = targetDb.collection(job.collection);
      const eventLimit = positiveInt(process.env.DB_WATCH_START_EVENT_BATCH_SIZE, 25);
      const filter = buildPollFilter(job);

      if (job.last_seen_value === undefined || job.last_seen_value === null) {
        const latest = await target
          .find(filter)
          .sort({ [job.cursor_field]: -1 })
          .limit(1)
          .toArray();
        const latestValue = latest.length > 0 ? readPath(latest[0], job.cursor_field) : null;
        const nextPollAt = new Date(Date.now() + Math.max(1, job.poll_interval_seconds) * 1000);

        await jobs.updateOne(
          { _id: job._id },
          {
            $set: {
              status: 'IDLE',
              next_poll_at: nextPollAt,
              last_seen_value: serializeCursorValue(latestValue),
              last_error: undefined,
              updated_at: new Date(),
            },
          },
        );
        return;
      }

      const docs = await target
        .find(filter)
        .sort({ [job.cursor_field]: 1 })
        .limit(eventLimit)
        .toArray();

      let lastSeenValue = job.last_seen_value;
      let lastInstanceId = job.last_instance_id;
      for (const doc of docs) {
        const cursorValue = readPath(doc, job.cursor_field);
        if (cursorValue === undefined || cursorValue === null) {
          continue;
        }
        lastSeenValue = cursorValue;
        const instanceId = await this.startWorkflowFromDocument(job, doc, cursorValue);
        if (instanceId) {
          lastInstanceId = instanceId;
        }
      }

      const nextPollAt = new Date(Date.now() + Math.max(1, job.poll_interval_seconds) * 1000);
      await jobs.updateOne(
        { _id: job._id },
        {
          $set: {
            status: 'IDLE',
            next_poll_at: nextPollAt,
            last_seen_value: serializeCursorValue(lastSeenValue),
            last_instance_id: lastInstanceId,
            last_error: undefined,
            updated_at: new Date(),
          },
        },
      );
    } catch (error) {
      await jobs.updateOne(
        { _id: job._id },
        {
          $set: {
            status: 'FAILED',
            next_poll_at: new Date(Date.now() + Math.max(1, job.poll_interval_seconds) * 1000),
            last_error: errorMessage(error),
            updated_at: new Date(),
          },
        },
      );
    }
  }

  private async startWorkflowFromDocument(job: DbWatchJob, document: Document, cursorValue: any, eventKey = stableCursorKey(cursorValue)): Promise<string | null> {
    const eventId = `${job._id}:${eventKey}`;
    const eventInsert = await this.db.collection<any>('v2_db_watch_events').updateOne(
      { _id: eventId },
      {
        $setOnInsert: {
          _id: eventId,
          db_watch_job_id: job._id,
          definition_id: job.definition_id,
          start_node_id: job.start_node_id,
          cursor_field: job.cursor_field,
          cursor_value: serializeCursorValue(cursorValue),
          created_at: new Date(),
        },
      },
      { upsert: true },
    );

    if (eventInsert.upsertedCount === 0) {
      return null;
    }

    const definition = await this.workflowRepo.getPublishedDefinition(job.definition_id);
    if (!definition) {
      throw new Error(`Workflow is not published or is disabled: ${job.definition_id}`);
    }

    const startNode = (definition.nodes || []).find((node: any) => node.id === job.start_node_id) || (definition.nodes || []).find((node: any) => node?.data?.nodeType === 'start');
    if (!startNode) {
      throw new Error(`Start node not found: ${job.start_node_id}`);
    }

    const instanceId = randomUUID();
    const payloadDocument = toJsonSafe(document);
    const ctx = {
      runtime: {
        cursor: startNode.id,
        nodes: definition.nodes || [],
        edges: definition.edges || [],
        template_id: definition.id,
        template_name: definition.name,
        snapshot: {
          workflow: {
            id: definition.id,
            name: definition.name,
            version: definition.version || 1,
          },
          group: definition.group_id
            ? {
                id: definition.group_id,
                name: definition.group || definition.group_id,
              }
            : null,
          caller: { type: 'service_account', id: 'db_watch' },
          api_key: null,
        },
        trigger: {
          type: 'db_watch',
          db_watch_job_id: job._id,
          start_node_id: job.start_node_id,
          database: job.database || this.db.databaseName,
          collection: job.collection,
          operation: job.operation,
          mode: job.mode,
          cursor_field: job.cursor_field,
          cursor_value: serializeCursorValue(cursorValue),
          fired_at: new Date().toISOString(),
        },
      },
      data: {
        formData: {
          operation: job.operation,
          mode: job.mode,
          source: {
            database: job.database || this.db.databaseName,
            collection: job.collection,
          },
          cursor: {
            field: job.cursor_field,
            value: serializeCursorValue(cursorValue),
          },
          document: payloadDocument,
        },
        outputs: {},
      },
    };

    const access = {
      workspace_id: 'default',
      group_id: definition.group_id || null,
      workflow_version_id: definition.version ? `${definition.id}:${definition.version}` : null,
      caller: { type: 'service_account', id: 'db_watch', api_key_id: null },
    };
    await this.instanceRepo.executeInstanceMutation({
      create_instances: [{ id: instanceId, definition_id: definition.id, status: 'CREATED', context: ctx, access }],
      tokens: [{ id: randomUUID(), instance_id: instanceId, node_id: startNode.id, status: 'ACTIVE' }],
      jobs: [{
        instance_id: instanceId,
        type: 'START',
        run_at: new Date(),
        payload: { node_id: startNode.id, reason: 'db_watch_start', db_watch_job_id: job._id },
      }],
    });

    await this.db.collection<any>('v2_db_watch_events').updateOne(
      { _id: eventId },
      {
        $set: {
          instance_id: instanceId,
          status: 'STARTED',
          updated_at: new Date(),
        },
      },
    );

    this.logger.log(`DB watch workflow started: watch=${job._id} instance=${instanceId}`);
    return instanceId;
  }

  private async getTargetDb(job: DbWatchJob, actor?: WorkflowHistoryActor): Promise<Db> {
    if (!job.credential_id) {
      return job.database ? this.db.client.db(job.database) : this.db;
    }

    const definition = actor ? null : await this.workflowRepo.getDefinition(job.definition_id);
    const expectedGroupId = definition?.group_id || definition?.metadata?.group_id || null;
    const credential = actor ? await this.credentialsService.get(job.credential_id, actor) : await this.credentialsService.getForRuntime(job.credential_id, expectedGroupId);
    if (credential.type !== 'connection_string') {
      throw new Error(`DB watch credential must be connection_string: ${job.credential_id}`);
    }

    const connectionString = await this.credentialsService.resolveSecret(job.credential_id, {
      actor: 'db_watch',
      actor_context: actor,
      expected_group_id: actor ? undefined : expectedGroupId,
      node_id: job.start_node_id,
      workflow_id: job.definition_id,
    });
    const cached = this.credentialClients.get(job.credential_id);
    if (cached?.connectionString === connectionString) {
      return cached.client.db(job.database || undefined);
    }

    if (cached) {
      await cached.client.close().catch(() => undefined);
    }

    const client = new MongoClient(connectionString);
    await client.connect();
    this.credentialClients.set(job.credential_id, { connectionString, client });
    return client.db(job.database || undefined);
  }

  private async closeChangeStream(jobId: string, stream = this.changeStreams.get(jobId)): Promise<void> {
    if (stream) {
      await stream.close().catch(() => undefined);
    }
    this.changeStreams.delete(jobId);
  }

  private async ensureIndexes(): Promise<void> {
    await this.db.collection('v2_db_watch_jobs').createIndex({ active: 1, next_poll_at: 1 });
    await this.db.collection('v2_db_watch_jobs').createIndex({ active: 1, mode: 1 });
    await this.db.collection('v2_db_watch_jobs').createIndex({ definition_id: 1 });
    await this.db.collection('v2_db_watch_events').createIndex({ db_watch_job_id: 1, created_at: -1 });
  }
}

function buildDbWatchJob(definitionId: string, definitionName: string, node: any, now: Date, defaultDatabase: string): DbWatchJob | null {
  const data = node.data || {};
  const triggerType = data.triggerType || data.startTriggerType || 'manual';
  if (triggerType !== 'db_watch') {
    return null;
  }

  const collection = stringOrEmpty(data.dbWatchCollection).trim();
  if (!collection) {
    return null;
  }

  return {
    _id: `${definitionId}:${node.id}`,
    definition_id: definitionId,
    definition_name: definitionName,
    start_node_id: node.id,
    database: stringOrEmpty(data.dbWatchDatabase).trim() || defaultDatabase,
    collection,
    credential_id: stringOrEmpty(data.dbWatchCredentialId).trim() || null,
    operation: normalizeOperation(data.dbWatchOperation),
    mode: normalizeMode(data.dbWatchMode),
    filter: isPlainObject(data.dbWatchFilter) ? data.dbWatchFilter : {},
    poll_interval_seconds: positiveInt(data.dbWatchPollIntervalSeconds, 10),
    cursor_field: stringOrEmpty(data.dbWatchCursorField).trim() || 'created_at',
    active: data.dbWatchEnabled === true,
    status: 'IDLE',
    next_poll_at: now,
    created_at: now,
    updated_at: now,
  };
}

function shouldRestartChangeStream(existing: DbWatchJob | null, next: DbWatchJob): boolean {
  if (!existing || existing.mode !== 'change_stream') {
    return false;
  }
  if (next.mode !== 'change_stream' || !next.active) {
    return true;
  }

  return existing.database !== next.database || existing.collection !== next.collection || (existing.credential_id || null) !== (next.credential_id || null) || existing.operation !== next.operation || JSON.stringify(existing.filter || {}) !== JSON.stringify(next.filter || {});
}

function buildPollFilter(job: DbWatchJob): Record<string, any> {
  const filter = buildCursorPresenceFilter(job.filter, job.cursor_field);
  if (job.last_seen_value !== undefined && job.last_seen_value !== null) {
    filter[job.cursor_field] = {
      ...(isPlainObject(filter[job.cursor_field]) ? filter[job.cursor_field] : {}),
      $gt: deserializeCursorValue(job.last_seen_value),
    };
  }
  return filter;
}

function buildCursorPresenceFilter(sourceFilter: Record<string, any>, cursorField: string): Record<string, any> {
  const filter: Record<string, any> = {
    ...(isPlainObject(sourceFilter) ? sourceFilter : {}),
  };
  filter[cursorField] = {
    ...(isPlainObject(filter[cursorField]) ? filter[cursorField] : {}),
    $exists: true,
    $ne: null,
  };
  return filter;
}

function buildChangeStreamPipeline(job: DbWatchJob): Document[] {
  const operationTypes = job.operation === 'insert' ? ['insert'] : job.operation === 'update' ? ['update', 'replace'] : ['insert', 'update', 'replace'];

  return [
    {
      $match: {
        operationType: { $in: operationTypes },
      },
    },
  ];
}

function normalizeOperation(value: unknown): DbWatchOperation {
  if (value === 'update' || value === 'upsert') {
    return value;
  }
  return 'insert';
}

function normalizeMode(value: unknown): DbWatchMode {
  return value === 'change_stream' ? 'change_stream' : 'polling';
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function matchesPlainFilter(document: any, filter: Record<string, any>): boolean {
  if (!isPlainObject(filter) || Object.keys(filter).length === 0) {
    return true;
  }
  return Object.entries(filter).every(([key, expected]) => {
    const actual = readPath(document, key);
    if (isPlainObject(expected) && '$eq' in expected) {
      return actual === expected.$eq;
    }
    return actual === expected;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readPath(value: any, path: string): any {
  return path.split('.').reduce((current, key) => current?.[key], value);
}

function serializeCursorValue(value: any): any {
  if (value instanceof ObjectId) {
    return { $oid: value.toHexString() };
  }
  if (value instanceof Date) {
    return { $date: value.toISOString() };
  }
  return value;
}

function deserializeCursorValue(value: any): any {
  if (isPlainObject(value) && typeof value.$oid === 'string') {
    return new ObjectId(value.$oid);
  }
  if (isPlainObject(value) && typeof value.$date === 'string') {
    return new Date(value.$date);
  }
  return value;
}

function stableCursorKey(value: any): string {
  return JSON.stringify(serializeCursorValue(value));
}

function toJsonSafe(value: any): any {
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(toJsonSafe);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toJsonSafe(child)]));
  }
  return value;
}
