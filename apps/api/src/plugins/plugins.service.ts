import { Injectable, OnModuleInit } from '@nestjs/common';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { PluginManifestDto } from './dto/plugin-manifest.dto';

@Injectable()
export class PluginsService implements OnModuleInit {
  private manifests = new Map<string, PluginManifestDto[]>();
  private controls: PluginControls = defaultPluginControls();

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
