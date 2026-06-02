#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [action, pluginId, value] = process.argv.slice(2).filter((arg) => arg !== '--');

if (!action || !pluginId) {
  fail(
    'Usage: node scripts/plugin-control.mjs <enable|disable|pin|unpin|allow|disallow> <plugin_id|workspace_id> [value]',
  );
}

const controlsPath = resolve(apiRoot, 'plugin-controls.json');
const controls = readControls(controlsPath);

switch (action) {
  case 'enable':
    removeItem(controls.disabled_plugins, pluginId);
    addItem(controls.enabled_plugins, pluginId);
    writeAudit(apiRoot, controls, { action: 'enable', plugin_id: pluginId });
    break;
  case 'disable':
    removeItem(controls.enabled_plugins, pluginId);
    addItem(controls.disabled_plugins, pluginId);
    writeAudit(apiRoot, controls, { action: 'disable', plugin_id: pluginId });
    break;
  case 'pin':
    if (!value) fail('pin requires a version value');
    controls.version_pins[pluginId] = value;
    writeAudit(apiRoot, controls, {
      action: 'update',
      update_type: 'pin',
      plugin_id: pluginId,
      version: value,
    });
    break;
  case 'unpin':
    delete controls.version_pins[pluginId];
    writeAudit(apiRoot, controls, {
      action: 'update',
      update_type: 'unpin',
      plugin_id: pluginId,
    });
    break;
  case 'allow':
    if (!value) fail('allow requires a plugin_id value');
    ensureAllowlist(controls, pluginId);
    addItem(controls.workspace_allowlists[pluginId], value);
    writeAudit(apiRoot, controls, {
      action: 'update',
      update_type: 'allow',
      workspace_id: pluginId,
      plugin_id: value,
    });
    break;
  case 'disallow':
    if (!value) fail('disallow requires a plugin_id value');
    ensureAllowlist(controls, pluginId);
    removeItem(controls.workspace_allowlists[pluginId], value);
    writeAudit(apiRoot, controls, {
      action: 'update',
      update_type: 'disallow',
      workspace_id: pluginId,
      plugin_id: value,
    });
    break;
  default:
    fail(`Unknown action: ${action}`);
}

writeFileSync(controlsPath, `${JSON.stringify(controls, null, 2)}\n`);
console.log(`Updated plugin controls: ${action}`);

function readControls(file) {
  const fallback = {
    default_enabled: true,
    enabled_plugins: [],
    disabled_plugins: [],
    version_pins: {},
    workspace_allowlists: { default: ['*'] },
    trusted_sources: ['local', 'official', 'customer'],
    require_trusted_source: true,
    audit_log_path: '../../logs/plugin-audit.jsonl',
  };

  if (!existsSync(file)) {
    return fallback;
  }
  return {
    ...fallback,
    ...JSON.parse(readFileSync(file, 'utf8')),
  };
}

function ensureAllowlist(controls, workspaceId) {
  controls.workspace_allowlists[workspaceId] ??= [];
  removeItem(controls.workspace_allowlists[workspaceId], '*');
}

function addItem(items, item) {
  if (!items.includes(item)) {
    items.push(item);
  }
  items.sort();
}

function removeItem(items, item) {
  const index = items.indexOf(item);
  if (index >= 0) {
    items.splice(index, 1);
  }
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

function fail(message) {
  console.error(`${basename(process.argv[1])}: ${message}`);
  process.exit(1);
}
