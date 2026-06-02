import { Injectable, OnModuleInit } from '@nestjs/common';
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { PluginManifestDto } from './dto/plugin-manifest.dto';

@Injectable()
export class PluginsService implements OnModuleInit {
  private manifests = new Map<string, PluginManifestDto[]>();

  onModuleInit() {
    this.loadManifests();
  }

  findAll(): PluginManifestDto[] {
    return [...this.manifests.values()]
      .map((versions) => this.latestVersion(versions))
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
  }

  findOne(pluginId: string): PluginManifestDto | null {
    const versions = this.manifests.get(pluginId);
    return versions ? this.latestVersion(versions) : null;
  }

  findVersions(pluginId: string): PluginManifestDto[] {
    return [...(this.manifests.get(pluginId) || [])];
  }

  private loadManifests() {
    const manifestDir = resolve(process.cwd(), 'plugin-manifests');
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

    return raw as PluginManifestDto;
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
