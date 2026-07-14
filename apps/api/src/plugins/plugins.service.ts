import { BadRequestException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { Db, MongoClient } from 'mongodb';
import { join, resolve } from 'path';
import { CredentialsService } from '../credentials/credentials.service';
import type { WorkflowHistoryActor } from '../db/ports/db.ports';
import { MONGO_DB } from '../db/mongo.provider';
import { PluginManifestDto } from './dto/plugin-manifest.dto';

@Injectable()
export class PluginsService implements OnModuleInit {
  private manifests = new Map<string, PluginManifestDto[]>();
  private controls: PluginControls = defaultPluginControls();
  private controlOverrides = new Map<string, PluginControlDocument>();

  constructor(
    private readonly credentialsService: CredentialsService,
    @Inject(MONGO_DB) private readonly db: Db,
  ) {}

  async onModuleInit() {
    await this.loadManifests();
  }

  findAll(): PluginManifestDto[] {
    return [...this.manifests.values()]
      .map((versions) => this.latestVersion(versions))
      .map((manifest) => this.applyRuntimeControl(manifest))
      .filter((manifest) => manifest.enabled !== false)
      .filter((manifest) => this.isAllowedForWorkspace(manifest.plugin_id))
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
  }

  findOne(pluginId: string): PluginManifestDto | null {
    const versions = this.manifests.get(pluginId);
    if (!versions || !this.isAllowedForWorkspace(pluginId)) {
      return null;
    }
    const manifest = this.applyRuntimeControl(this.latestVersion(versions));
    return manifest.enabled === false ? null : manifest;
  }

  findVersions(pluginId: string): PluginManifestDto[] {
    return [...(this.manifests.get(pluginId) || [])].map((manifest) =>
      this.applyRuntimeControl(manifest),
    );
  }

  findControlList(): PluginControlView[] {
    return [...this.manifests.values()]
      .map((versions) => {
        const manifest = this.applyRuntimeControl(this.latestVersion(versions));
        const override = this.controlOverrides.get(manifest.plugin_id);
        return {
          ...manifest,
          available_versions: versions.map((item) => item.version),
          pinned_version: override?.pinned_version || this.controls.version_pins[manifest.plugin_id] || '',
          workspace_ids: override?.workspace_ids || [],
          trusted: this.controls.trusted_sources.includes(manifest.trusted_source || 'local'),
        };
      })
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
  }

  async updateControl(
    pluginId: string,
    dto: PluginControlUpdateDto,
    actor = 'admin',
  ): Promise<PluginControlView> {
    const versions = this.manifests.get(pluginId);
    if (!versions) {
      throw new NotFoundException('Plugin not found');
    }

    const availableVersions = versions.map((manifest) => manifest.version);
    const update: Partial<PluginControlDocument> = {};

    if (dto.enabled !== undefined) {
      if (typeof dto.enabled !== 'boolean') {
        throw new BadRequestException('enabled must be boolean');
      }
      update.enabled = dto.enabled;
    }

    if (dto.pinned_version !== undefined) {
      const pinned = stringValue(dto.pinned_version);
      if (pinned && !availableVersions.includes(pinned)) {
        throw new BadRequestException(`Unknown plugin version: ${pinned}`);
      }
      update.pinned_version = pinned || null;
    }

    if (dto.workspace_ids !== undefined) {
      if (!Array.isArray(dto.workspace_ids)) {
        throw new BadRequestException('workspace_ids must be an array');
      }
      update.workspace_ids = dto.workspace_ids.map((item) => String(item).trim()).filter(Boolean);
    }

    if (dto.trusted_source !== undefined) {
      const trustedSource = stringValue(dto.trusted_source);
      update.trusted_source = trustedSource || null;
    }

    const now = new Date().toISOString();
    await this.db.collection<PluginControlDocument>('v2_plugin_controls').updateOne(
      { _id: pluginId },
      {
        $set: {
          ...update,
          plugin_id: pluginId,
          updated_at: now,
        },
        $setOnInsert: {
          _id: pluginId,
          created_at: now,
        },
      },
      { upsert: true },
    );
    await this.db.collection('v2_plugin_control_audit').insertOne({
      plugin_id: pluginId,
      action: 'updated',
      actor,
      payload: update,
      created_at: now,
    });
    await this.reloadControls();

    const item = this.findControlList().find((plugin) => plugin.plugin_id === pluginId);
    if (!item) {
      throw new NotFoundException('Plugin not found');
    }
    return item;
  }

  async audit(pluginId?: string) {
    return this.db
      .collection('v2_plugin_control_audit')
      .find(pluginId ? { plugin_id: pluginId } : {})
      .sort({ created_at: -1 })
      .limit(100)
      .toArray();
  }

  findRegistry(): PluginRegistryView[] {
    const items: PluginRegistryView[] = [];
    for (const versions of this.manifests.values()) {
      for (const manifest of versions) {
        items.push({
          ...manifest,
          manifest_source: manifest.manifest_source === 'registry' ? 'registry' : 'file',
          editable: manifest.manifest_source === 'registry',
        });
      }
    }
    return items.sort((a, b) =>
      `${a.plugin_id}@${a.version}`.localeCompare(`${b.plugin_id}@${b.version}`),
    );
  }

  async upsertRegistryManifest(
    rawManifest: Record<string, any>,
    actor = 'admin',
  ): Promise<PluginRegistryView> {
    const manifest = this.validateManifest({ ...rawManifest }, 'registry manifest');
    const existingVersions = this.manifests.get(manifest.plugin_id) || [];
    const fileVersionExists = existingVersions.some(
      (item) => item.version === manifest.version && item.manifest_source !== 'registry',
    );
    if (fileVersionExists) {
      throw new BadRequestException(
        `File manifest version cannot be overwritten: ${manifest.plugin_id}@${manifest.version}`,
      );
    }

    const now = new Date().toISOString();
    const id = pluginVersionId(manifest.plugin_id, manifest.version);
    await this.db.collection<PluginManifestDocument>('v2_plugin_manifests').updateOne(
      { _id: id },
      {
        $set: {
          plugin_id: manifest.plugin_id,
          version: manifest.version,
          manifest,
          active: true,
          updated_at: now,
        },
        $setOnInsert: {
          _id: id,
          created_at: now,
        },
      },
      { upsert: true },
    );
    await this.db.collection('v2_plugin_manifest_audit').insertOne({
      plugin_id: manifest.plugin_id,
      version: manifest.version,
      action: 'upserted',
      actor,
      created_at: now,
    });
    await this.loadManifests();

    const item = this.findRegistry().find(
      (entry) => entry.plugin_id === manifest.plugin_id && entry.version === manifest.version,
    );
    if (!item) {
      throw new NotFoundException('Plugin manifest not found after save');
    }
    return item;
  }

  async deleteRegistryManifest(pluginId: string, version: string, actor = 'admin') {
    const manifest = this.findRegistry().find(
      (entry) => entry.plugin_id === pluginId && entry.version === version,
    );
    if (!manifest) {
      throw new NotFoundException('Plugin manifest not found');
    }
    if (manifest.manifest_source !== 'registry') {
      throw new BadRequestException('File manifest cannot be deleted from registry API');
    }

    const now = new Date().toISOString();
    await this.db.collection<PluginManifestDocument>('v2_plugin_manifests').updateOne(
      { _id: pluginVersionId(pluginId, version) },
      {
        $set: {
          active: false,
          updated_at: now,
        },
      },
    );
    await this.db.collection('v2_plugin_manifest_audit').insertOne({
      plugin_id: pluginId,
      version,
      action: 'deleted',
      actor,
      created_at: now,
    });
    await this.loadManifests();
    return { ok: true };
  }

  async registryAudit(pluginId?: string) {
    return this.db
      .collection('v2_plugin_manifest_audit')
      .find(pluginId ? { plugin_id: pluginId } : {})
      .sort({ created_at: -1 })
      .limit(100)
      .toArray();
  }

  async testPlugin(
    request: PluginTestRequest,
    actor: WorkflowHistoryActor,
  ): Promise<PluginTestResponse> {
    const pluginId = request?.plugin_id;
    if (!pluginId) {
      throw new BadRequestException('plugin_id is required');
    }

    const manifest = this.findOne(pluginId);
    if (!manifest) {
      throw new BadRequestException(`Plugin is not available: ${pluginId}`);
    }

    const startedAt = Date.now();
    const config = await this.resolveCredentialConfig(
      request.config ?? {},
      manifest.plugin_id,
      request.node_id,
      actor,
    );

    try {
      const output =
        pluginId === 'builtin.http_request'
          ? await this.testHttpRequest(config)
          : pluginId === 'connector.db.mongodb.query'
            ? await this.testMongoDbQuery(config)
            : null;

      if (!output) {
        throw new BadRequestException(`Plugin test is not supported yet: ${pluginId}`);
      }

      return {
        ok: true,
        plugin_id: pluginId,
        node_id: request.node_id,
        duration_ms: Date.now() - startedAt,
        output,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      return {
        ok: false,
        plugin_id: pluginId,
        node_id: request.node_id,
        duration_ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async testHttpRequest(config: Record<string, unknown>) {
    const url = stringValue(config.url);
    if (!url) {
      throw new BadRequestException('HTTP Request test requires url');
    }

    const method = stringValue(config.method) || 'GET';
    const headers = objectValue(config.headers);
    const timeoutMs = numberValue(config.timeout_ms ?? config.timeout) ?? 5000;
    const response = await fetch(url, {
      method,
      headers: headers ? stringifyHeaders(headers) : undefined,
      body:
        method.toUpperCase() === 'GET' || config.body === undefined
          ? undefined
          : JSON.stringify(config.body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    const body = contentType.includes('application/json') ? parseJsonLoose(text) : text;

    return {
      status_code: response.status,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  }

  private async resolveCredentialConfig(
    config: Record<string, unknown>,
    pluginId: string,
    nodeId?: string,
    actor?: WorkflowHistoryActor,
  ): Promise<Record<string, unknown>> {
    const credentialId = stringValue(config.credential_id);
    if (!credentialId) {
      return config;
    }
    if (!this.credentialsService) {
      throw new BadRequestException('Credential service is not available');
    }

    const secret = await this.credentialsService.resolveSecret(credentialId, {
      actor: actor?.actor_id || 'plugin-test',
      actor_context: actor,
      node_id: nodeId,
    });
    const binding = objectValue(config.credential_binding);
    const target = stringValue(binding?.target) || inferCredentialTarget(pluginId);
    const resolved = { ...config };

    if (target === 'connection_uri') {
      resolved.connection_uri = secret;
      return resolved;
    }

    if (
      target === 'authorization_header' ||
      target === 'basic_auth_header' ||
      target === 'api_key_header'
    ) {
      const headers = {
        ...(objectValue(config.headers) || {}),
      };
      const headerName =
        stringValue(binding?.headerName) ||
        (target === 'api_key_header' ? 'x-api-key' : 'Authorization');
      const scheme = stringValue(binding?.scheme);
      headers[headerName] = scheme ? `${scheme} ${secret}` : secret;
      resolved.headers = headers;
      return resolved;
    }

    throw new BadRequestException(`Unsupported credential binding target: ${target}`);
  }

  private async testMongoDbQuery(config: Record<string, unknown>) {
    const connectionUri =
      stringValue(config.connection_uri) ||
      stringValue(config.connectionUri) ||
      stringValue(config.connectionString) ||
      process.env.PXM_MONGODB_QUERY_URL;
    if (!connectionUri) {
      throw new BadRequestException(
        'MongoDB Query test requires connection_uri or PXM_MONGODB_QUERY_URL',
      );
    }

    const database =
      stringValue(config.database) ||
      process.env.PXM_MONGODB_QUERY_DB_NAME ||
      process.env.MONGO_DB_NAME ||
      'pxm_db';
    const collectionName = stringValue(config.collection);
    if (!collectionName) {
      throw new BadRequestException('MongoDB Query test requires collection');
    }

    const operation = (stringValue(config.operation) || 'find').toLowerCase();
    const filter = objectValue(config.filter) ?? {};
    const client = new MongoClient(connectionUri);

    try {
      await client.connect();
      const collection = client.db(database).collection(collectionName);

      if (operation === 'findone' || operation === 'find_one') {
        const row = await collection.findOne(filter);
        const rows = row ? [sanitizeJson(row)] : [];
        return {
          database,
          collection: collectionName,
          operation: 'findOne',
          row: row ? sanitizeJson(row) : null,
          rows,
          row_count: rows.length,
        };
      }

      if (operation === 'find') {
        const rows = await collection.find(filter).limit(20).toArray();
        return {
          database,
          collection: collectionName,
          operation: 'find',
          rows: sanitizeJson(rows),
          row_count: rows.length,
          limited: true,
          limit: 20,
        };
      }

      throw new BadRequestException(`Unsupported MongoDB operation: ${operation}`);
    } finally {
      await client.close();
    }
  }

  private async loadManifests() {
    const manifestDir = resolve(process.cwd(), 'plugin-manifests');
    this.controls = this.loadControls(manifestDir);
    this.controlOverrides = await this.loadMongoControlOverrides();
    const files = readdirSync(manifestDir)
      .filter((file) => file.endsWith('.json'))
      .sort();

    const manifests = new Map<string, PluginManifestDto[]>();
    for (const file of files) {
      const raw = JSON.parse(readFileSync(join(manifestDir, file), 'utf8'));
      const manifest = this.validateManifest(raw, file);
      manifest.manifest_source = 'file';
      addManifestVersion(manifests, manifest);
    }

    const registryManifests = await this.loadMongoManifests();
    for (const manifest of registryManifests) {
      addManifestVersion(manifests, manifest);
    }

    for (const versions of manifests.values()) {
      versions.sort((a, b) => compareSemverDesc(a.version, b.version));
    }

    this.manifests = manifests;
  }

  private async reloadControls() {
    this.controlOverrides = await this.loadMongoControlOverrides();
  }

  private latestVersion(versions: PluginManifestDto[]): PluginManifestDto {
    const pluginId = versions[0]?.plugin_id;
    const override = pluginId ? this.controlOverrides.get(pluginId) : undefined;
    const pinnedVersion =
      override?.pinned_version || (pluginId ? this.controls.version_pins[pluginId] : undefined);
    if (pinnedVersion) {
      return (
        versions.find((manifest) => manifest.version === pinnedVersion) ??
        versions[0]
      );
    }
    return versions[0];
  }

  private validateManifest(raw: any, file: string): PluginManifestDto {
    const requiredStringFields = [
      'plugin_id',
      'version',
      'display_name',
      'category',
      'node_type',
      'icon',
      'executor_type',
      'executor_ref',
    ];

    for (const field of requiredStringFields) {
      if (typeof raw[field] !== 'string' || raw[field].trim() === '') {
        throw new Error(`${file}: ${field} must be a non-empty string`);
      }
    }

    if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/.test(raw.plugin_id)) {
      throw new Error(`${file}: plugin_id must be dot-delimited lowercase id`);
    }

    if (!/^\d+\.\d+\.\d+$/.test(raw.version)) {
      throw new Error(`${file}: version must use semver MAJOR.MINOR.PATCH`);
    }

    if (raw.node_type !== 'service') {
      throw new Error(`${file}: node_type must be service`);
    }

    if (!['builtin', 'hosted', 'external_http', 'http', 'mock'].includes(raw.executor_type)) {
      throw new Error(`${file}: unsupported executor_type ${raw.executor_type}`);
    }

    this.validateObjectSchema(raw.config_schema, `${file}: config_schema`);
    if (raw.input_schema !== undefined) {
      this.validateObjectSchema(raw.input_schema, `${file}: input_schema`);
    }
    if (raw.output_schema !== undefined) {
      this.validateObjectSchema(raw.output_schema, `${file}: output_schema`);
    }

    if (raw.secrets_policy === undefined) {
      raw.secrets_policy = {};
    }
    if (!isPlainObject(raw.secrets_policy)) {
      throw new Error(`${file}: secrets_policy must be an object`);
    }

    if (raw.timeout_ms !== undefined && !Number.isInteger(raw.timeout_ms)) {
      throw new Error(`${file}: timeout_ms must be an integer`);
    }

    if (raw.retry_policy !== undefined && !isPlainObject(raw.retry_policy)) {
      throw new Error(`${file}: retry_policy must be an object`);
    }

    if (raw.enabled === undefined) {
      raw.enabled = this.controls.default_enabled;
    }
    if (typeof raw.enabled !== 'boolean') {
      throw new Error(`${file}: enabled must be a boolean`);
    }

    if (this.controls.enabled_plugins.includes(raw.plugin_id)) {
      raw.enabled = true;
    }
    if (this.controls.disabled_plugins.includes(raw.plugin_id)) {
      raw.enabled = false;
    }

    if (raw.trusted_source === undefined) {
      raw.trusted_source = 'local';
    }
    if (typeof raw.trusted_source !== 'string' || raw.trusted_source.trim() === '') {
      throw new Error(`${file}: trusted_source must be a non-empty string`);
    }
    if (
      this.controls.require_trusted_source &&
      !this.controls.trusted_sources.includes(raw.trusted_source)
    ) {
      throw new Error(`${file}: untrusted plugin source ${raw.trusted_source}`);
    }

    if (raw.signature !== undefined && typeof raw.signature !== 'string') {
      throw new Error(`${file}: signature must be a string`);
    }

    if (raw.isolation_policy === undefined) {
      raw.isolation_policy = defaultIsolationPolicy(raw.executor_type);
    }
    if (!isPlainObject(raw.isolation_policy)) {
      throw new Error(`${file}: isolation_policy must be an object`);
    }
    validateIsolationPolicy(raw.executor_type, raw.isolation_policy, file);

    if (raw.resource_limits === undefined) {
      raw.resource_limits = {
        timeout_ms: raw.timeout_ms ?? 5000,
        max_payload_bytes: 262144,
      };
    }
    if (!isPlainObject(raw.resource_limits)) {
      throw new Error(`${file}: resource_limits must be an object`);
    }
    if (
      raw.resource_limits.timeout_ms !== undefined &&
      !Number.isInteger(raw.resource_limits.timeout_ms)
    ) {
      throw new Error(`${file}: resource_limits.timeout_ms must be an integer`);
    }
    if (
      raw.resource_limits.max_payload_bytes !== undefined &&
      !Number.isInteger(raw.resource_limits.max_payload_bytes)
    ) {
      throw new Error(`${file}: resource_limits.max_payload_bytes must be an integer`);
    }

    return raw as PluginManifestDto;
  }

  private isAllowedForWorkspace(pluginId: string): boolean {
    const workspaceId = process.env.PXM_WORKSPACE_ID || 'default';
    const override = this.controlOverrides.get(pluginId);
    if (override?.workspace_ids?.length && !override.workspace_ids.includes('*')) {
      return override.workspace_ids.includes(workspaceId);
    }
    const allowlist =
      this.controls.workspace_allowlists[workspaceId] ??
      this.controls.workspace_allowlists.default;
    if (!allowlist || allowlist.includes('*')) {
      return true;
    }
    return allowlist.includes(pluginId);
  }

  private applyRuntimeControl(manifest: PluginManifestDto): PluginManifestDto {
    const override = this.controlOverrides.get(manifest.plugin_id);
    return {
      ...manifest,
      enabled: override?.enabled ?? manifest.enabled,
      trusted_source: override?.trusted_source || manifest.trusted_source || 'local',
    };
  }

  private async loadMongoControlOverrides(): Promise<Map<string, PluginControlDocument>> {
    const docs = await this.db
      .collection<PluginControlDocument>('v2_plugin_controls')
      .find({})
      .toArray()
      .catch(() => []);
    return new Map<string, PluginControlDocument>(
      docs.map((doc) => [doc.plugin_id || doc._id, doc] as [string, PluginControlDocument]),
    );
  }

  private async loadMongoManifests(): Promise<PluginManifestDto[]> {
    const docs = await this.db
      .collection<PluginManifestDocument>('v2_plugin_manifests')
      .find({ active: true })
      .toArray()
      .catch(() => []);

    return docs.map((doc) => {
      const manifest = this.validateManifest({ ...(doc.manifest || {}) }, `registry ${doc._id}`);
      manifest.manifest_source = 'registry';
      return manifest;
    });
  }

  private loadControls(manifestDir: string): PluginControls {
    const controlsPath = resolve(manifestDir, '../plugin-controls.json');
    if (!existsSync(controlsPath)) {
      return defaultPluginControls();
    }

    const raw = JSON.parse(readFileSync(controlsPath, 'utf8'));
    const controls = {
      ...defaultPluginControls(),
      ...raw,
      version_pins: raw.version_pins ?? {},
      workspace_allowlists: raw.workspace_allowlists ?? { default: ['*'] },
      trusted_sources: raw.trusted_sources ?? ['local'],
    };

    if (!Array.isArray(controls.enabled_plugins)) {
      throw new Error('plugin-controls.json: enabled_plugins must be an array');
    }
    if (!Array.isArray(controls.disabled_plugins)) {
      throw new Error('plugin-controls.json: disabled_plugins must be an array');
    }
    if (!isPlainObject(controls.version_pins)) {
      throw new Error('plugin-controls.json: version_pins must be an object');
    }
    if (!isPlainObject(controls.workspace_allowlists)) {
      throw new Error('plugin-controls.json: workspace_allowlists must be an object');
    }
    if (!Array.isArray(controls.trusted_sources)) {
      throw new Error('plugin-controls.json: trusted_sources must be an array');
    }

    return controls;
  }

  private validateObjectSchema(schema: any, label: string) {
    if (!isPlainObject(schema)) {
      throw new Error(`${label} must be an object`);
    }
    if (schema.type !== 'object') {
      throw new Error(`${label}.type must be object`);
    }
    if (!isPlainObject(schema.properties)) {
      throw new Error(`${label}.properties must be an object`);
    }
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        schema.required.some((item) => typeof item !== 'string'))
    ) {
      throw new Error(`${label}.required must be a string array`);
    }
  }
}

function inferCredentialTarget(pluginId: string) {
  if (pluginId === 'connector.db.mongodb.query') {
    return 'connection_uri';
  }
  if (pluginId === 'builtin.http_request') {
    return 'authorization_header';
  }
  return '';
}

interface PluginControls {
  default_enabled: boolean;
  enabled_plugins: string[];
  disabled_plugins: string[];
  version_pins: Record<string, string>;
  workspace_allowlists: Record<string, string[]>;
  trusted_sources: string[];
  require_trusted_source: boolean;
  audit_log_path?: string;
}

type PluginControlDocument = {
  _id: string;
  plugin_id: string;
  enabled?: boolean;
  pinned_version?: string | null;
  workspace_ids?: string[];
  trusted_source?: string | null;
  created_at?: string;
  updated_at?: string;
};

type PluginManifestDocument = {
  _id: string;
  plugin_id: string;
  version: string;
  manifest: Record<string, any>;
  active: boolean;
  created_at?: string;
  updated_at?: string;
};

export type PluginControlUpdateDto = {
  enabled?: boolean;
  pinned_version?: string | null;
  workspace_ids?: string[];
  trusted_source?: string | null;
};

export type PluginControlView = PluginManifestDto & {
  available_versions: string[];
  pinned_version: string;
  workspace_ids: string[];
  trusted: boolean;
};

export type PluginRegistryView = PluginManifestDto & {
  manifest_source: 'file' | 'registry';
  editable: boolean;
};

export interface PluginTestRequest {
  plugin_id?: string;
  node_id?: string;
  config?: Record<string, unknown>;
  input?: Record<string, unknown>;
}

export interface PluginTestResponse {
  ok: boolean;
  plugin_id: string;
  node_id?: string;
  duration_ms: number;
  output?: unknown;
  error?: string;
}

function defaultPluginControls(): PluginControls {
  return {
    default_enabled: true,
    enabled_plugins: [],
    disabled_plugins: [],
    version_pins: {},
    workspace_allowlists: { default: ['*'] },
    trusted_sources: ['local'],
    require_trusted_source: false,
  };
}

function addManifestVersion(
  manifests: Map<string, PluginManifestDto[]>,
  manifest: PluginManifestDto,
) {
  const versions = manifests.get(manifest.plugin_id) || [];
  if (versions.some((item) => item.version === manifest.version)) {
    throw new Error(
      `Duplicate plugin manifest version: ${manifest.plugin_id}@${manifest.version}`,
    );
  }
  versions.push(manifest);
  manifests.set(manifest.plugin_id, versions);
}

function pluginVersionId(pluginId: string, version: string) {
  return `${pluginId}@${version}`;
}

function defaultIsolationPolicy(executorType: string) {
  return {
    mode: executorType === 'external_http' ? 'external_process' : 'shared_process',
    network: 'default',
  };
}

function validateIsolationPolicy(
  executorType: string,
  policy: Record<string, unknown>,
  file: string,
) {
  if (
    policy.mode !== undefined &&
    policy.mode !== 'shared_process' &&
    policy.mode !== 'external_process'
  ) {
    throw new Error(`${file}: isolation_policy.mode is unsupported`);
  }
  if (executorType === 'hosted' && policy.mode === 'external_process') {
    throw new Error(`${file}: hosted plugins must use shared_process isolation`);
  }
  if (executorType === 'external_http' && policy.mode === 'shared_process') {
    throw new Error(`${file}: external_http plugins must use external_process isolation`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function compareSemverDesc(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = partsB[i] - partsA[i];
    if (diff !== 0) return diff;
  }
  return 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (isPlainObject(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = parseJsonLoose(value);
    return isPlainObject(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringifyHeaders(headers: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)]),
  );
}

function parseJsonLoose(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function sanitizeJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
