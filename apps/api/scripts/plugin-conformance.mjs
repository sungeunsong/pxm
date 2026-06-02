#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));

if (!args.manifest) {
  fail('Usage: node scripts/plugin-conformance.mjs --manifest <path> [--endpoint <url>]');
}

const manifestPath = resolve(process.cwd(), args.manifest);
const manifest = readJson(manifestPath);
validateManifest(manifest, manifestPath);

console.log(`Manifest OK: ${manifest.plugin_id}@${manifest.version}`);

if (args.endpoint) {
  await invokeEndpoint(args.endpoint, manifest);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index];
    if (current === '--') {
      continue;
    } else if (current === '--manifest') {
      parsed.manifest = values[++index];
    } else if (current === '--endpoint') {
      parsed.endpoint = values[++index];
    } else {
      fail(`Unknown argument: ${current}`);
    }
  }
  return parsed;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${file}: invalid JSON: ${error.message}`);
  }
}

function validateManifest(manifest, label) {
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

  if (!['hosted', 'external_http', 'builtin', 'mock'].includes(manifest.executor_type)) {
    fail(`${label}: unsupported executor_type ${manifest.executor_type}`);
  }

  if (
    manifest.trusted_source !== undefined &&
    typeof manifest.trusted_source !== 'string'
  ) {
    fail(`${label}: trusted_source must be a string`);
  }

  if (manifest.signature !== undefined && typeof manifest.signature !== 'string') {
    fail(`${label}: signature must be a string`);
  }

  if (manifest.isolation_policy !== undefined) {
    if (!isPlainObject(manifest.isolation_policy)) {
      fail(`${label}: isolation_policy must be an object`);
    }
    if (
      manifest.executor_type === 'hosted' &&
      manifest.isolation_policy.mode === 'external_process'
    ) {
      fail(`${label}: hosted plugins must use shared_process isolation`);
    }
    if (
      manifest.executor_type === 'external_http' &&
      manifest.isolation_policy.mode === 'shared_process'
    ) {
      fail(`${label}: external_http plugins must use external_process isolation`);
    }
  }

  if (manifest.resource_limits !== undefined) {
    if (!isPlainObject(manifest.resource_limits)) {
      fail(`${label}: resource_limits must be an object`);
    }
    if (
      manifest.resource_limits.timeout_ms !== undefined &&
      !Number.isInteger(manifest.resource_limits.timeout_ms)
    ) {
      fail(`${label}: resource_limits.timeout_ms must be an integer`);
    }
    if (
      manifest.resource_limits.max_payload_bytes !== undefined &&
      !Number.isInteger(manifest.resource_limits.max_payload_bytes)
    ) {
      fail(`${label}: resource_limits.max_payload_bytes must be an integer`);
    }
  }

  validateSchema(manifest.config_schema, `${label}: config_schema`);
  if (manifest.output_schema !== undefined) {
    validateSchema(manifest.output_schema, `${label}: output_schema`);
  }
}

function validateSchema(schema, label) {
  if (!isPlainObject(schema)) {
    fail(`${label} must be an object`);
  }
  if (schema.type !== 'object') {
    fail(`${label}.type must be object`);
  }
  if (!isPlainObject(schema.properties)) {
    fail(`${label}.properties must be an object`);
  }
}

async function invokeEndpoint(endpoint, manifest) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      plugin_id: manifest.plugin_id,
      instance: {
        id: 'conformance-instance',
        definition_id: 'conformance-definition',
      },
      node: {
        id: 'conformance-node',
        token_id: 'conformance-token',
      },
      config: buildSampleConfig(manifest),
      context: {
        requester: 'conformance@example.com',
      },
      secrets: {},
      attempt: 1,
      retry: manifest.retry_policy ?? {},
    }),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    fail(`Endpoint returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  if (!isPlainObject(body) || typeof body.success !== 'boolean') {
    fail(`Endpoint response must include boolean success: ${JSON.stringify(body)}`);
  }
  if (body.success && body.output !== undefined && !isPlainObject(body.output)) {
    fail(`Endpoint success output must be an object: ${JSON.stringify(body)}`);
  }
  if (!body.success) {
    if (typeof body.retryable !== 'boolean') {
      fail(`Endpoint failure response must include retryable: ${JSON.stringify(body)}`);
    }
    if (!isPlainObject(body.error) || typeof body.error.code !== 'string') {
      fail(`Endpoint failure response must include error.code: ${JSON.stringify(body)}`);
    }
  }

  console.log(`Endpoint OK: ${endpoint}`);
}

function buildSampleConfig(manifest) {
  return Object.fromEntries(
    Object.entries(manifest.config_schema.properties ?? {}).map(([key, property]) => [
      key,
      sampleValue(property),
    ]),
  );
}

function sampleValue(property) {
  if (property?.default !== undefined) {
    return property.default;
  }
  if (Array.isArray(property?.enum) && property.enum.length > 0) {
    return property.enum[0];
  }
  switch (property?.type) {
    case 'boolean':
      return true;
    case 'integer':
    case 'number':
      return 1;
    case 'object':
      return {};
    case 'array':
      return [];
    default:
      return 'sample';
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  console.error(`${basename(process.argv[1])}: ${message}`);
  process.exit(1);
}
