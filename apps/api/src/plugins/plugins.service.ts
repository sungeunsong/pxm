import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { MongoClient } from 'mongodb';
import { join, resolve } from 'path';
import { CredentialsService } from '../credentials/credentials.service';
import { PluginManifestDto } from './dto/plugin-manifest.dto';

@Injectable()
export class PluginsService implements OnModuleInit {
  private manifests = new Map<string, PluginManifestDto[]>();
  private controls: PluginControls = defaultPluginControls();

  constructor(private readonly credentialsService?: CredentialsService) {}

  onModuleInit() {
    this.loadManifests();
  }

  findAll(): PluginManifestDto[] {
    return [...this.manifests.values()]
      .map((versions) => this.latestVersion(versions))
      .filter((manifest) => this.isAllowedForWorkspace(manifest.plugin_id))
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
  }

  findOne(pluginId: string): PluginManifestDto | null {
    const versions = this.manifests.get(pluginId);
    if (!versions || !this.isAllowedForWorkspace(pluginId)) {
      return null;
    }
    return this.latestVersion(versions);
  }

  findVersions(pluginId: string): PluginManifestDto[] {
    return [...(this.manifests.get(pluginId) || [])];
  }

  async testPlugin(request: PluginTestRequest): Promise<PluginTestResponse> {
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
  ): Promise<Record<string, unknown>> {
    const credentialId = stringValue(config.credential_id);
    if (!credentialId) {
      return config;
    }
    if (!this.credentialsService) {
      throw new BadRequestException('Credential service is not available');
    }

    const secret = await this.credentialsService.resolveSecret(credentialId, {
      actor: 'plugin-test',
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

  private loadManifests() {
    const manifestDir = resolve(process.cwd(), 'plugin-manifests');
    this.controls = this.loadControls(manifestDir);
    const files = readdirSync(manifestDir)
      .filter((file) => file.endsWith('.json'))
      .sort();

    const manifests = new Map<string, PluginManifestDto[]>();
    for (const file of files) {
      const raw = JSON.parse(readFileSync(join(manifestDir, file), 'utf8'));
      const manifest = this.validateManifest(raw, file);
      const versions = manifests.get(manifest.plugin_id) || [];
      if (versions.some((item) => item.version === manifest.version)) {
        throw new Error(
          `Duplicate plugin manifest version: ${manifest.plugin_id}@${manifest.version}`,
        );
      }
      versions.push(manifest);
      manifests.set(manifest.plugin_id, versions);
    }

    for (const versions of manifests.values()) {
      versions.sort((a, b) => compareSemverDesc(a.version, b.version));
    }

    this.manifests = manifests;
  }

  private latestVersion(versions: PluginManifestDto[]): PluginManifestDto {
    const pluginId = versions[0]?.plugin_id;
    const pinnedVersion = pluginId ? this.controls.version_pins[pluginId] : undefined;
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
    const allowlist =
      this.controls.workspace_allowlists[workspaceId] ??
      this.controls.workspace_allowlists.default;
    if (!allowlist || allowlist.includes('*')) {
      return true;
    }
    return allowlist.includes(pluginId);
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
