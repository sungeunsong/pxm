import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Db, Filter } from 'mongodb';
import { MONGO_DB } from '../db/mongo.provider';

const execFileAsync = promisify(execFile);
const COLLECTION = 'v2_script_libraries';
const AUDIT_COLLECTION = 'v2_script_library_audit';
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 120_000;

export type ScriptLibraryStatus = 'pending' | 'approved' | 'disabled';

export interface ScriptLibraryRef {
  package_name: string;
  version: string;
}

export interface ScriptLibraryView extends ScriptLibraryRef {
  id: string;
  description: string;
  license: string;
  integrity: string;
  bundle_sha256: string;
  bundle_bytes: number;
  dependency_count: number;
  status: ScriptLibraryStatus;
  allowed_group_ids: string[];
  created_by: string;
  approved_by?: string | null;
  created_at: string;
  updated_at: string;
}

interface ScriptLibraryDocument extends ScriptLibraryView {
  _id: string;
  bundle: string;
  package_lock_sha256: string;
}

type WorkflowNodeLike = Record<string, unknown> & {
  data?: Record<string, unknown>;
  config?: Record<string, unknown>;
};

@Injectable()
export class ScriptLibrariesService {
  constructor(@Inject(MONGO_DB) private readonly db: Db) {}

  async resolveLatest(packageNameInput?: string): Promise<ScriptLibraryRef> {
    const packageName = normalizePackageName(packageNameInput);
    const registry = npmRegistry();
    try {
      const { stdout } = await execFileAsync(
        process.env.PXM_NPM_EXECUTABLE || 'npm',
        [
          'view',
          `${packageName}@latest`,
          'version',
          '--json',
          `--registry=${registry}`,
        ],
        {
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
      );
      const version = normalizeExactVersion(parseNpmVersion(stdout));
      return { package_name: packageName, version };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(
        `최신 버전을 확인하지 못했습니다. 패키지 이름과 npm 레지스트리 접근 권한을 확인해 주세요. ${message}`,
      );
    }
  }

  async list(includeInactive = false): Promise<ScriptLibraryView[]> {
    const filter: Filter<ScriptLibraryDocument> = includeInactive
      ? {}
      : { status: 'approved' };
    const rows = await this.db
      .collection<ScriptLibraryDocument>(COLLECTION)
      .find(filter)
      .sort({ package_name: 1, version: -1 })
      .toArray();
    return rows.map(toView);
  }

  async prepare(
    input: { package_name?: string; version?: string },
    actor: string,
  ): Promise<ScriptLibraryView> {
    const packageName = normalizePackageName(input.package_name);
    const version = normalizeExactVersion(input.version);
    const existing = await this.db
      .collection<ScriptLibraryDocument>(COLLECTION)
      .findOne({ package_name: packageName, version });
    if (existing) {
      throw new BadRequestException(
        `${packageName}@${version}은(는) 이미 준비되어 있습니다.`,
      );
    }

    const artifact = await prepareNpmArtifact(packageName, version);
    const now = new Date().toISOString();
    const id = randomUUID();
    const document: ScriptLibraryDocument = {
      _id: id,
      id,
      package_name: packageName,
      version,
      description: artifact.description,
      license: artifact.license,
      integrity: artifact.integrity,
      bundle_sha256: sha256(artifact.bundle),
      bundle_bytes: Buffer.byteLength(artifact.bundle, 'utf8'),
      dependency_count: artifact.dependencyCount,
      package_lock_sha256: artifact.packageLockSha256,
      bundle: artifact.bundle,
      status: 'pending',
      allowed_group_ids: [],
      created_by: actor,
      approved_by: null,
      created_at: now,
      updated_at: now,
    };
    await this.db
      .collection<ScriptLibraryDocument>(COLLECTION)
      .insertOne(document);
    await this.appendAudit(document, 'prepared', actor);
    return toView(document);
  }

  async approve(
    id: string,
    input: { allowed_group_ids?: unknown },
    actor: string,
  ): Promise<ScriptLibraryView> {
    const allowedGroupIds = normalizeGroupIds(input.allowed_group_ids);
    if (allowedGroupIds.length > 0) {
      const activeGroupCount = await this.db
        .collection<{ _id: string; status: string }>('pxm_groups')
        .countDocuments({
          _id: { $in: allowedGroupIds },
          status: 'active',
        });
      if (activeGroupCount !== allowedGroupIds.length) {
        throw new BadRequestException(
          '존재하지 않거나 삭제된 그룹은 승인 범위에 넣을 수 없습니다.',
        );
      }
    }
    const now = new Date().toISOString();
    const result = await this.db
      .collection<ScriptLibraryDocument>(COLLECTION)
      .findOneAndUpdate(
        { _id: id },
        {
          $set: {
            status: 'approved',
            allowed_group_ids: allowedGroupIds,
            approved_by: actor,
            updated_at: now,
          },
        },
        { returnDocument: 'after' },
      );
    if (!result)
      throw new NotFoundException('JS 라이브러리를 찾을 수 없습니다.');
    await this.appendAudit(result, 'approved', actor, {
      allowed_group_ids: allowedGroupIds,
    });
    return toView(result);
  }

  async disable(id: string, actor: string): Promise<ScriptLibraryView> {
    const now = new Date().toISOString();
    const result = await this.db
      .collection<ScriptLibraryDocument>(COLLECTION)
      .findOneAndUpdate(
        { _id: id },
        { $set: { status: 'disabled', updated_at: now } },
        { returnDocument: 'after' },
      );
    if (!result)
      throw new NotFoundException('JS 라이브러리를 찾을 수 없습니다.');
    await this.appendAudit(result, 'disabled', actor);
    return toView(result);
  }

  async hydrateNodes(
    nodes: WorkflowNodeLike[],
    groupId?: string | null,
  ): Promise<WorkflowNodeLike[]> {
    const refs = collectLibraryRefs(nodes);
    if (refs.length === 0) {
      return stripEmbeddedBundles(nodes);
    }

    const documents = await this.db
      .collection<ScriptLibraryDocument>(COLLECTION)
      .find({
        $or: refs.map((ref) => ({
          package_name: ref.package_name,
          version: ref.version,
        })),
      })
      .toArray();
    const byKey = new Map(
      documents.map((document) => [
        libraryKey(document.package_name, document.version),
        document,
      ]),
    );

    return (nodes || []).map((node) => {
      const data = nodeData(node);
      const nodeRefs = normalizeRefs(data.scriptLibraries);
      if (nodeRefs.length === 0) {
        const clean = { ...data };
        delete clean.scriptLibraryBundles;
        return withNodeData(node, clean);
      }
      const bundles = nodeRefs.map((ref) => {
        const document = byKey.get(libraryKey(ref.package_name, ref.version));
        if (!document || document.status !== 'approved') {
          throw new BadRequestException(
            `승인된 JS 라이브러리가 아닙니다: ${ref.package_name}@${ref.version}`,
          );
        }
        if (
          document.allowed_group_ids.length > 0 &&
          (!groupId || !document.allowed_group_ids.includes(groupId))
        ) {
          throw new BadRequestException(
            `${ref.package_name}@${ref.version}은(는) 이 워크플로우 그룹에서 사용할 수 없습니다.`,
          );
        }
        return {
          package_name: document.package_name,
          version: document.version,
          bundle_sha256: document.bundle_sha256,
          bundle: document.bundle,
        };
      });
      return withNodeData(node, {
        ...data,
        scriptLibraries: nodeRefs,
        scriptLibraryBundles: bundles,
      });
    });
  }

  stripBundles(nodes: WorkflowNodeLike[]): WorkflowNodeLike[] {
    return stripEmbeddedBundles(nodes);
  }

  private async appendAudit(
    library: ScriptLibraryDocument,
    action: string,
    actor: string,
    payload: Record<string, unknown> = {},
  ) {
    await this.db.collection(AUDIT_COLLECTION).insertOne({
      library_id: library.id,
      package_name: library.package_name,
      version: library.version,
      action,
      actor,
      payload,
      created_at: new Date().toISOString(),
    });
  }
}

async function prepareNpmArtifact(packageName: string, version: string) {
  const directory = await mkdtemp(join(tmpdir(), 'pxm-js-library-'));
  try {
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify(
        { private: true, dependencies: { [packageName]: version } },
        null,
        2,
      ),
      'utf8',
    );
    const registry = npmRegistry();
    await execFileAsync(
      process.env.PXM_NPM_EXECUTABLE || 'npm',
      [
        'install',
        `${packageName}@${version}`,
        '--save-exact',
        '--ignore-scripts',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        `--registry=${registry}`,
      ],
      {
        cwd: directory,
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 5 * 1024 * 1024,
      },
    );

    const installedPackageJson = parseRecord(
      await readFile(
        join(
          directory,
          'node_modules',
          ...packageName.split('/'),
          'package.json',
        ),
        'utf8',
      ),
      'installed package.json',
    );
    const installedVersion = stringField(installedPackageJson, 'version');
    if (installedVersion !== version) {
      throw new Error(
        `요청 버전 ${version} 대신 ${installedVersion || '알 수 없는 버전'}이 설치되었습니다.`,
      );
    }

    const bundleResult = await build({
      stdin: {
        contents: `module.exports = require(${JSON.stringify(packageName)});`,
        resolveDir: directory,
        sourcefile: 'pxm-library-entry.cjs',
      },
      bundle: true,
      platform: 'browser',
      format: 'cjs',
      target: ['es2022'],
      write: false,
      metafile: true,
      logLevel: 'silent',
      legalComments: 'none',
    });
    const bundle = bundleResult.outputFiles[0]?.text || '';
    const bundleBytes = Buffer.byteLength(bundle, 'utf8');
    if (!bundle || bundleBytes > MAX_BUNDLE_BYTES) {
      throw new Error(
        `번들 크기는 ${MAX_BUNDLE_BYTES / 1024 / 1024}MB 이하여야 합니다. 현재 ${Math.ceil(bundleBytes / 1024)}KB입니다.`,
      );
    }

    const packageLockText = await readFile(
      join(directory, 'package-lock.json'),
      'utf8',
    );
    const packageLock = parseRecord(packageLockText, 'package-lock.json');
    const packages = recordField(packageLock, 'packages');
    const packagePath = `node_modules/${packageName}`;
    const packageLockEntry = asRecord(packages[packagePath]);
    return {
      bundle,
      description: stringField(installedPackageJson, 'description'),
      license: normalizeLicense(installedPackageJson.license),
      integrity: stringField(packageLockEntry, 'integrity'),
      packageLockSha256: sha256(packageLockText),
      dependencyCount: Math.max(0, Object.keys(packages).length - 2),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BadRequestException(
      `npm 패키지를 준비하지 못했습니다. 순수 JavaScript이며 브라우저 번들이 가능한 정확한 버전인지 확인해 주세요. ${message}`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function normalizePackageName(value?: string) {
  const name = String(value || '').trim();
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new BadRequestException('올바른 npm 패키지 이름을 입력해 주세요.');
  }
  return name;
}

function normalizeExactVersion(value?: string) {
  const version = String(value || '').trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new BadRequestException('1.2.3과 같은 정확한 버전을 입력해 주세요.');
  }
  return version;
}

function parseNpmVersion(value: string): string {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'string') {
    throw new Error('npm 레지스트리가 올바른 버전을 반환하지 않았습니다.');
  }
  return parsed;
}

function npmRegistry() {
  return (
    process.env.PXM_NPM_REGISTRY_URL || 'https://registry.npmjs.org'
  ).trim();
}

function normalizeGroupIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new BadRequestException('allowed_group_ids는 배열이어야 합니다.');
  }
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

function normalizeRefs(value: unknown): ScriptLibraryRef[] {
  if (!Array.isArray(value)) return [];
  const refs = value.map((item) => {
    const ref = asRecord(item);
    return {
      package_name: normalizePackageName(stringField(ref, 'package_name')),
      version: normalizeExactVersion(stringField(ref, 'version')),
    };
  });
  const keys = new Set<string>();
  return refs.filter((ref) => {
    const key = libraryKey(ref.package_name, ref.version);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

function collectLibraryRefs(nodes: WorkflowNodeLike[]): ScriptLibraryRef[] {
  const refs = nodes.flatMap((node) => {
    const data = nodeData(node);
    return normalizeRefs(data.scriptLibraries);
  });
  const unique = new Map(
    refs.map((ref) => [libraryKey(ref.package_name, ref.version), ref]),
  );
  return [...unique.values()];
}

function stripEmbeddedBundles(nodes: WorkflowNodeLike[]): WorkflowNodeLike[] {
  return nodes.map((node) => {
    const data = nodeData(node);
    if (!Object.prototype.hasOwnProperty.call(data, 'scriptLibraryBundles'))
      return node;
    const clean = { ...data };
    delete clean.scriptLibraryBundles;
    return withNodeData(node, clean);
  });
}

function withNodeData(
  node: WorkflowNodeLike,
  data: Record<string, unknown>,
): WorkflowNodeLike {
  if (isRecord(node.data)) return { ...node, data };
  if (isRecord(node.config)) return { ...node, config: data };
  return { ...node, ...data };
}

function nodeData(node: WorkflowNodeLike): Record<string, unknown> {
  if (isRecord(node.data)) return node.data;
  if (isRecord(node.config)) return node.config;
  return node;
}

function libraryKey(packageName: string, version: string) {
  return `${packageName}@${version}`;
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeLicense(value: unknown) {
  if (typeof value === 'string') return value;
  return stringField(asRecord(value), 'type');
}

function parseRecord(text: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error(`${label} must contain a JSON object`);
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function recordField(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return asRecord(value[key]);
}

function stringField(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === 'string' ? value[key] : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toView(document: ScriptLibraryDocument): ScriptLibraryView {
  return {
    id: document.id,
    package_name: document.package_name,
    version: document.version,
    description: document.description,
    license: document.license,
    integrity: document.integrity,
    bundle_sha256: document.bundle_sha256,
    bundle_bytes: document.bundle_bytes,
    dependency_count: document.dependency_count,
    status: document.status,
    allowed_group_ids: document.allowed_group_ids || [],
    created_by: document.created_by,
    approved_by: document.approved_by,
    created_at: document.created_at,
    updated_at: document.updated_at,
  };
}
