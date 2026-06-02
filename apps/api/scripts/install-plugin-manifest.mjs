#!/usr/bin/env node
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';

const manifestArg = process.argv.slice(2).find((arg) => arg !== '--');

if (!manifestArg) {
  fail('Usage: node scripts/install-plugin-manifest.mjs <plugin-package-dir|manifest-json>');
}

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inputPath = resolve(process.cwd(), manifestArg);
const manifestPath = resolveManifestPath(inputPath);
const manifest = readManifest(manifestPath);
const controls = readControls(apiRoot);
validateManifest(manifest, manifestPath, controls);

const manifestDir = resolve(apiRoot, 'plugin-manifests');
mkdirSync(manifestDir, { recursive: true });

const targetPath = resolve(manifestDir, `${manifest.plugin_id}.json`);
copyFileSync(manifestPath, targetPath);
writeAudit(apiRoot, controls, {
  action: 'install',
  plugin_id: manifest.plugin_id,
  version: manifest.version,
  source: manifest.trusted_source ?? 'local',
  manifest_path: targetPath,
});

console.log(`Installed ${manifest.plugin_id}@${manifest.version}`);
console.log(`Manifest: ${targetPath}`);

function resolveManifestPath(input) {
  if (!existsSync(input)) {
    fail(`Manifest path does not exist: ${input}`);
  }

  if (input.endsWith('.json')) {
    return input;
  }

  const candidate = resolve(input, 'plugin.json');
  if (!existsSync(candidate)) {
    fail(`Plugin package must contain plugin.json: ${candidate}`);
  }
  return candidate;
}

function readManifest(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${file}: invalid JSON: ${error.message}`);
  }
}

function validateManifest(manifest, label, controls) {
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
    if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
      fail(`${label}: ${field} must be a non-empty string`);
    }
  }

  if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/.test(manifest.plugin_id)) {
    fail(`${label}: plugin_id must be dot-delimited lowercase id`);
  }

  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    fail(`${label}: version must use semver MAJOR.MINOR.PATCH`);
  }

  if (manifest.node_type !== 'service') {
    fail(`${label}: node_type must be service`);
  }

  if (!['builtin', 'hosted', 'external_http', 'mock'].includes(manifest.executor_type)) {
    fail(`${label}: unsupported executor_type ${manifest.executor_type}`);
  }

  const trustedSource = manifest.trusted_source ?? 'local';
  if (
    controls.require_trusted_source &&
    !controls.trusted_sources.includes(trustedSource) &&
    process.env.PXM_PLUGIN_ALLOW_UNTRUSTED !== 'true'
  ) {
    fail(`${label}: untrusted plugin source ${trustedSource}`);
  }

  if (
    manifest.signature !== undefined &&
    typeof manifest.signature !== 'string'
  ) {
    fail(`${label}: signature must be a string`);
  }

  validateObjectSchema(manifest.config_schema, `${label}: config_schema`);
  if (manifest.input_schema !== undefined) {
    validateObjectSchema(manifest.input_schema, `${label}: input_schema`);
  }
  if (manifest.output_schema !== undefined) {
    validateObjectSchema(manifest.output_schema, `${label}: output_schema`);
  }
}

function readControls(apiRoot) {
  const controlsPath = resolve(apiRoot, 'plugin-controls.json');
  if (!existsSync(controlsPath)) {
    return {
      trusted_sources: ['local'],
      require_trusted_source: false,
      audit_log_path: '../../logs/plugin-audit.jsonl',
    };
  }

  const raw = readManifest(controlsPath);
  return {
    trusted_sources: raw.trusted_sources ?? ['local'],
    require_trusted_source: raw.require_trusted_source ?? false,
    audit_log_path: raw.audit_log_path ?? '../../logs/plugin-audit.jsonl',
  };
}

function writeAudit(apiRoot, controls, event) {
  const auditPath = resolve(apiRoot, controls.audit_log_path ?? '../../logs/plugin-audit.jsonl');
  mkdirSync(dirname(auditPath), { recursive: true });
  appendFileSync(
    auditPath,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      actor: process.env.USER || process.env.USERNAME || 'unknown',
      ...event,
    })}\n`,
  );
}

function validateObjectSchema(schema, label) {
  if (!isPlainObject(schema)) {
    fail(`${label} must be an object`);
  }
  if (schema.type !== 'object') {
    fail(`${label}.type must be object`);
  }
  if (!isPlainObject(schema.properties)) {
    fail(`${label}.properties must be an object`);
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== 'string'))
  ) {
    fail(`${label}.required must be a string array`);
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  console.error(`${basename(process.argv[1])}: ${message}`);
  process.exit(1);
}
