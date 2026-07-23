import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { ClientSession, Db, Document } from 'mongodb';
import { ManagementAuditService } from '../audit/management-audit.service';
import { MONGO_DB } from '../db/mongo.provider';
import type { WorkflowHistoryActor } from '../db/ports/db.ports';
import type {
  RuntimeIntegrityFindingType,
  RuntimeIntegrityRepairDto,
  RuntimeIntegrityScanDto,
} from './dto/runtime-integrity.dto';

type RepairAction =
  | 'MARK_JOB_FAILED'
  | 'MARK_TOKEN_FAILED'
  | 'CANCEL_TASK'
  | 'REQUEUE_INSTANCE';

export type RuntimeIntegrityFinding = {
  id: string;
  type: RuntimeIntegrityFindingType;
  severity: 'high' | 'medium';
  resource_type: 'job' | 'token' | 'task' | 'instance';
  resource_id: string;
  instance_id: string | null;
  title: string;
  description: string;
  observed_updated_at: string;
  repair: {
    supported: boolean;
    action: RepairAction | null;
    label: string;
  };
};

type RepairResult = {
  outcome: 'repaired' | 'no_longer_present';
  finding_type: RuntimeIntegrityFindingType;
  resource_id: string;
  action: RepairAction;
  message: string;
  idempotent_replay: boolean;
};

const ACTIVE_JOB_STATUSES = ['QUEUED', 'RUNNING'];
const ACTIVE_TOKEN_STATUSES = ['ACTIVE', 'WAITING'];
const TERMINAL_INSTANCE_STATES = ['COMPLETED', 'FAILED', 'TERMINATED'];
const REPAIR_ACTIONS: Partial<
  Record<RuntimeIntegrityFindingType, RepairAction>
> = {
  ORPHAN_JOB: 'MARK_JOB_FAILED',
  ORPHAN_TOKEN: 'MARK_TOKEN_FAILED',
  ORPHAN_TASK: 'CANCEL_TASK',
  STALLED_INSTANCE: 'REQUEUE_INSTANCE',
};

@Injectable()
export class RuntimeIntegrityService {
  constructor(
    @Inject(MONGO_DB) private readonly db: Db,
    private readonly audit: ManagementAuditService,
  ) {}

  async scan(input: RuntimeIntegrityScanDto = {}) {
    const minAgeSeconds = input.min_age_seconds ?? 60;
    const limit = input.limit ?? 200;
    const scannedAt = new Date().toISOString();
    const cutoff = new Date(Date.now() - minAgeSeconds * 1_000).toISOString();

    const groups = await Promise.all([
      this.findOrphanJobs(cutoff, limit),
      this.findOrphanTokens(cutoff, limit),
      this.findOrphanTasks(cutoff, limit),
      this.findStalledInstances(cutoff, limit),
      this.findWaitingApprovalsWithoutTask(cutoff, limit),
      this.findInstancesMissingDefinition(cutoff, limit),
    ]);
    const findings = groups
      .flat()
      .sort((left, right) =>
        right.observed_updated_at.localeCompare(left.observed_updated_at),
      )
      .slice(0, limit);

    const byType = Object.fromEntries(
      findings.reduce((counts, finding) => {
        counts.set(finding.type, (counts.get(finding.type) || 0) + 1);
        return counts;
      }, new Map<string, number>()),
    );

    return {
      scanned_at: scannedAt,
      min_age_seconds: minAgeSeconds,
      total: findings.length,
      repairable: findings.filter((finding) => finding.repair.supported).length,
      by_type: byType,
      findings,
    };
  }

  async repair(
    input: RuntimeIntegrityRepairDto,
    actor: WorkflowHistoryActor,
    idempotencyKey: string,
  ): Promise<RepairResult> {
    const action = REPAIR_ACTIONS[input.finding_type];
    if (!action) {
      throw new BadRequestException(
        '이 항목은 자동 복구를 지원하지 않습니다. 원인을 확인한 뒤 수동으로 처리해 주세요.',
      );
    }
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    if (idempotencyKey.length > 200) {
      throw new BadRequestException(
        'Idempotency-Key must be 200 characters or fewer',
      );
    }

    const eventId = `runtime-integrity:${createHash('sha256').update(idempotencyKey).digest('hex')}`;
    const session = this.db.client.startSession();
    let result: RepairResult | null = null;
    try {
      await session.withTransaction(async () => {
        const existing = await this.db
          .collection<any>('management_audit_logs')
          .findOne({ _id: eventId }, { session });
        if (existing?.details?.repair_result) {
          if (
            existing.resource_id !== input.resource_id ||
            existing.details.finding_type !== input.finding_type
          ) {
            throw new ConflictException(
              'Idempotency-Key was already used for another runtime repair',
            );
          }
          result = {
            ...existing.details.repair_result,
            idempotent_replay: true,
          };
          return;
        }

        result = await this.applyRepair(input, action, session);
        await this.audit.append(
          {
            event_id: eventId,
            action: 'runtime_integrity.repair',
            resource_type: 'runtime_integrity',
            resource_id: input.resource_id,
            actor_id: actor.actor_id || null,
            api_key_id: actor.api_key_id || null,
            details: {
              finding_type: input.finding_type,
              reason: input.reason,
              repair_result: result,
            },
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    if (!result)
      throw new Error('Runtime integrity repair did not produce a result');
    return result;
  }

  private async applyRepair(
    input: RuntimeIntegrityRepairDto,
    action: RepairAction,
    session: ClientSession,
  ): Promise<RepairResult> {
    const now = new Date().toISOString();
    const base = {
      finding_type: input.finding_type,
      resource_id: input.resource_id,
      action,
      idempotent_replay: false,
    };

    if (input.finding_type === 'ORPHAN_JOB') {
      const resourceId = numericId(input.resource_id);
      const job = await this.db.collection<any>('v2_engine_jobs').findOne(
        {
          _id: resourceId,
          status: { $in: ACTIVE_JOB_STATUSES },
          updated_at: input.observed_updated_at,
        },
        { session },
      );
      if (!job || (await this.hasInstance(job.instance_id, session))) {
        return {
          ...base,
          outcome: 'no_longer_present',
          message: '작업 상태가 바뀌어 복구하지 않았습니다.',
        };
      }
      const update = await this.db.collection<any>('v2_engine_jobs').updateOne(
        {
          _id: resourceId,
          status: { $in: ACTIVE_JOB_STATUSES },
          updated_at: input.observed_updated_at,
        },
        {
          $set: {
            status: 'FAILED',
            updated_at: now,
            integrity_repair: repairMetadata(input, now),
          },
        },
        { session },
      );
      return update.modifiedCount === 1
        ? {
            ...base,
            outcome: 'repaired',
            message: '연결이 끊긴 작업을 실패 상태로 정리했습니다.',
          }
        : {
            ...base,
            outcome: 'no_longer_present',
            message: '작업 상태가 바뀌어 복구하지 않았습니다.',
          };
    }

    if (input.finding_type === 'ORPHAN_TOKEN') {
      const token = await this.db.collection<any>('v2_tokens').findOne(
        {
          _id: input.resource_id,
          status: { $in: ACTIVE_TOKEN_STATUSES },
          updated_at: input.observed_updated_at,
        },
        { session },
      );
      if (!token || (await this.hasInstance(token.instance_id, session))) {
        return {
          ...base,
          outcome: 'no_longer_present',
          message: '토큰 상태가 바뀌어 복구하지 않았습니다.',
        };
      }
      const update = await this.db.collection<any>('v2_tokens').updateOne(
        {
          _id: input.resource_id,
          status: { $in: ACTIVE_TOKEN_STATUSES },
          updated_at: input.observed_updated_at,
        },
        {
          $set: {
            status: 'FAILED',
            updated_at: now,
            integrity_repair: repairMetadata(input, now),
          },
        },
        { session },
      );
      return update.modifiedCount === 1
        ? {
            ...base,
            outcome: 'repaired',
            message: '연결이 끊긴 실행 토큰을 실패 상태로 정리했습니다.',
          }
        : {
            ...base,
            outcome: 'no_longer_present',
            message: '토큰 상태가 바뀌어 복구하지 않았습니다.',
          };
    }

    if (input.finding_type === 'ORPHAN_TASK') {
      const task = await this.db.collection<any>('v2_tasks').findOne(
        {
          _id: input.resource_id,
          status: 'OPEN',
          updated_at: input.observed_updated_at,
        },
        { session },
      );
      if (!task || (await this.hasInstance(task.instance_id, session))) {
        return {
          ...base,
          outcome: 'no_longer_present',
          message: '승인 작업 상태가 바뀌어 복구하지 않았습니다.',
        };
      }
      const update = await this.db.collection<any>('v2_tasks').updateOne(
        {
          _id: input.resource_id,
          status: 'OPEN',
          updated_at: input.observed_updated_at,
        },
        {
          $set: {
            status: 'CANCELED',
            updated_at: now,
            integrity_repair: repairMetadata(input, now),
          },
        },
        { session },
      );
      return update.modifiedCount === 1
        ? {
            ...base,
            outcome: 'repaired',
            message: '연결이 끊긴 승인 작업을 취소 상태로 정리했습니다.',
          }
        : {
            ...base,
            outcome: 'no_longer_present',
            message: '승인 작업 상태가 바뀌어 복구하지 않았습니다.',
          };
    }

    const instance = await this.db
      .collection<any>('v2_process_instances')
      .findOne(
        {
          _id: input.resource_id,
          state: 'RUNNING',
          updated_at: input.observed_updated_at,
          $or: [
            { lock_until: null },
            { lock_until: { $exists: false } },
            { lock_until: { $lt: now } },
          ],
        },
        { session },
      );
    if (!instance) {
      return {
        ...base,
        outcome: 'no_longer_present',
        message: '실행 상태가 바뀌어 복구하지 않았습니다.',
      };
    }
    const [activeJobs, activeTokens] = await Promise.all([
      this.db.collection('v2_engine_jobs').countDocuments(
        {
          instance_id: input.resource_id,
          status: { $in: ACTIVE_JOB_STATUSES },
        },
        { session },
      ),
      this.db
        .collection('v2_tokens')
        .countDocuments(
          { instance_id: input.resource_id, status: 'ACTIVE' },
          { session },
        ),
    ]);
    if (activeJobs > 0 || activeTokens === 0) {
      return {
        ...base,
        outcome: 'no_longer_present',
        message: '실행할 작업이 생겼거나 활성 토큰이 없어 복구하지 않았습니다.',
      };
    }

    const counter = await this.db
      .collection<any>('v2_counters')
      .findOneAndUpdate(
        { _id: 'v2_engine_jobs' },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after', session },
      );
    const sequence = Number(counter?.seq || Date.now());
    await this.db.collection<any>('v2_engine_jobs').insertOne(
      {
        _id: sequence,
        instance_id: input.resource_id,
        token_id: null,
        job_type: 'RESUME',
        run_at: now,
        attempt: 0,
        status: 'QUEUED',
        payload: { reason: 'runtime_integrity_repair' },
        created_at: now,
        updated_at: now,
      },
      { session },
    );
    await this.db.collection<any>('v2_process_instances').updateOne(
      {
        _id: input.resource_id,
        state: 'RUNNING',
        updated_at: input.observed_updated_at,
      },
      {
        $set: {
          updated_at: now,
          integrity_repair: repairMetadata(input, now),
        },
      },
      { session },
    );
    await this.db.collection<any>('v2_event_outbox').insertOne(
      {
        instance_id: input.resource_id,
        token_id: null,
        node_id: null,
        event_type: 'RUNTIME_INTEGRITY_REPAIRED',
        payload: { finding_type: input.finding_type, action },
        created_at: now,
      },
      { session },
    );
    return {
      ...base,
      outcome: 'repaired',
      message: '멈춘 실행을 다시 처리할 작업을 만들었습니다.',
    };
  }

  private async findOrphanJobs(
    cutoff: string,
    limit: number,
  ): Promise<RuntimeIntegrityFinding[]> {
    const rows = await this.findOrphanRows(
      'v2_engine_jobs',
      {
        status: { $in: ACTIVE_JOB_STATUSES },
      },
      cutoff,
      limit,
    );
    return rows.map((row) =>
      finding({
        type: 'ORPHAN_JOB',
        severity: 'high',
        resourceType: 'job',
        resourceId: row._id,
        instanceId: row.instance_id,
        title: '연결이 끊긴 Engine 작업',
        description:
          '처리할 작업은 남아 있지만 연결된 워크플로우 실행 정보가 없습니다.',
        updatedAt: row.updated_at || row.created_at,
        action: 'MARK_JOB_FAILED',
        repairLabel: '실패 작업으로 정리',
      }),
    );
  }

  private async findOrphanTokens(
    cutoff: string,
    limit: number,
  ): Promise<RuntimeIntegrityFinding[]> {
    const rows = await this.findOrphanRows(
      'v2_tokens',
      {
        status: { $in: ACTIVE_TOKEN_STATUSES },
      },
      cutoff,
      limit,
    );
    return rows.map((row) =>
      finding({
        type: 'ORPHAN_TOKEN',
        severity: 'high',
        resourceType: 'token',
        resourceId: row._id,
        instanceId: row.instance_id,
        title: '연결이 끊긴 실행 토큰',
        description:
          '진행 중인 토큰은 남아 있지만 연결된 워크플로우 실행 정보가 없습니다.',
        updatedAt: row.updated_at || row.created_at,
        action: 'MARK_TOKEN_FAILED',
        repairLabel: '실패 토큰으로 정리',
      }),
    );
  }

  private async findOrphanTasks(
    cutoff: string,
    limit: number,
  ): Promise<RuntimeIntegrityFinding[]> {
    const rows = await this.findOrphanRows(
      'v2_tasks',
      { status: 'OPEN' },
      cutoff,
      limit,
    );
    return rows.map((row) =>
      finding({
        type: 'ORPHAN_TASK',
        severity: 'high',
        resourceType: 'task',
        resourceId: row._id,
        instanceId: row.instance_id,
        title: '연결이 끊긴 승인 작업',
        description:
          '처리 대기 중인 승인 작업은 남아 있지만 연결된 워크플로우 실행 정보가 없습니다.',
        updatedAt: row.updated_at || row.created_at,
        action: 'CANCEL_TASK',
        repairLabel: '승인 작업 취소',
      }),
    );
  }

  private async findStalledInstances(
    cutoff: string,
    limit: number,
  ): Promise<RuntimeIntegrityFinding[]> {
    const now = new Date().toISOString();
    const rows = await this.db
      .collection<any>('v2_process_instances')
      .aggregate([
        {
          $match: {
            state: 'RUNNING',
            $expr: {
              $lt: [{ $ifNull: ['$updated_at', '$created_at'] }, cutoff],
            },
            $or: [
              { lock_until: null },
              { lock_until: { $exists: false } },
              { lock_until: { $lt: now } },
            ],
          },
        },
        {
          $lookup: {
            from: 'v2_engine_jobs',
            localField: '_id',
            foreignField: 'instance_id',
            as: 'jobs',
          },
        },
        {
          $lookup: {
            from: 'v2_tokens',
            localField: '_id',
            foreignField: 'instance_id',
            as: 'tokens',
          },
        },
        {
          $match: {
            jobs: {
              $not: { $elemMatch: { status: { $in: ACTIVE_JOB_STATUSES } } },
            },
            tokens: { $elemMatch: { status: 'ACTIVE' } },
          },
        },
        { $limit: limit },
      ])
      .toArray();
    return rows.map((row) =>
      finding({
        type: 'STALLED_INSTANCE',
        severity: 'high',
        resourceType: 'instance',
        resourceId: row._id,
        instanceId: row._id,
        title: '처리 작업 없이 멈춘 실행',
        description:
          '실행할 활성 토큰은 있지만 Engine이 가져갈 작업이 없습니다.',
        updatedAt: row.updated_at || row.created_at,
        action: 'REQUEUE_INSTANCE',
        repairLabel: '다시 처리 대기열에 넣기',
      }),
    );
  }

  private async findWaitingApprovalsWithoutTask(
    cutoff: string,
    limit: number,
  ): Promise<RuntimeIntegrityFinding[]> {
    const rows = await this.db
      .collection<any>('v2_process_instances')
      .aggregate([
        {
          $match: {
            state: 'WAITING',
            $expr: {
              $lt: [{ $ifNull: ['$updated_at', '$created_at'] }, cutoff],
            },
          },
        },
        {
          $lookup: {
            from: 'v2_tokens',
            localField: '_id',
            foreignField: 'instance_id',
            as: 'tokens',
          },
        },
        {
          $lookup: {
            from: 'v2_tasks',
            localField: '_id',
            foreignField: 'instance_id',
            as: 'tasks',
          },
        },
        {
          $lookup: {
            from: 'v2_process_definitions',
            localField: 'process_definition_id',
            foreignField: '_id',
            as: 'definitions',
          },
        },
        {
          $match: {
            tokens: { $elemMatch: { status: 'WAITING' } },
            tasks: { $not: { $elemMatch: { status: 'OPEN' } } },
            'definitions.0': { $exists: true },
          },
        },
        { $limit: limit },
      ])
      .toArray();

    return rows.flatMap((row) => {
      const definitionNodes = Array.isArray(row.definitions?.[0]?.nodes)
        ? row.definitions[0].nodes
        : [];
      const approvalNodeIds = new Set(
        definitionNodes
          .filter(
            (node: any) =>
              (node.node_type ||
                node.type ||
                node.config?.nodeType ||
                node.data?.nodeType) === 'approval',
          )
          .map((node: any) => String(node.node_id || node.id)),
      );
      const missingApproval = row.tokens.some(
        (token: any) =>
          token.status === 'WAITING' &&
          approvalNodeIds.has(String(token.node_id)),
      );
      if (!missingApproval) return [];
      return [
        finding({
          type: 'WAITING_APPROVAL_WITHOUT_TASK',
          severity: 'high',
          resourceType: 'instance',
          resourceId: row._id,
          instanceId: row._id,
          title: '승인 작업이 없는 승인 대기 실행',
          description:
            '승인 노드에서 기다리고 있지만 관리자가 처리할 승인 작업이 없습니다. 승인자 설정을 확인해야 합니다.',
          updatedAt: row.updated_at || row.created_at,
          action: null,
          repairLabel: '수동 확인 필요',
        }),
      ];
    });
  }

  private async findInstancesMissingDefinition(
    cutoff: string,
    limit: number,
  ): Promise<RuntimeIntegrityFinding[]> {
    const rows = await this.db
      .collection<any>('v2_process_instances')
      .aggregate([
        {
          $match: {
            state: { $nin: TERMINAL_INSTANCE_STATES },
            $expr: {
              $lt: [{ $ifNull: ['$updated_at', '$created_at'] }, cutoff],
            },
          },
        },
        {
          $lookup: {
            from: 'v2_process_definitions',
            localField: 'process_definition_id',
            foreignField: '_id',
            as: 'definitions',
          },
        },
        { $match: { 'definitions.0': { $exists: false } } },
        { $limit: limit },
      ])
      .toArray();
    return rows.map((row) =>
      finding({
        type: 'INSTANCE_MISSING_DEFINITION',
        severity: 'high',
        resourceType: 'instance',
        resourceId: row._id,
        instanceId: row._id,
        title: '워크플로우 정의가 없는 실행',
        description:
          '실행 정보는 남아 있지만 어떤 워크플로우를 실행해야 하는지 정의를 찾을 수 없습니다.',
        updatedAt: row.updated_at || row.created_at,
        action: null,
        repairLabel: '수동 확인 필요',
      }),
    );
  }

  private async findOrphanRows(
    collectionName: string,
    match: Document,
    cutoff: string,
    limit: number,
  ): Promise<any[]> {
    return this.db
      .collection(collectionName)
      .aggregate([
        {
          $match: {
            ...match,
            $expr: {
              $lt: [{ $ifNull: ['$updated_at', '$created_at'] }, cutoff],
            },
          },
        },
        {
          $lookup: {
            from: 'v2_process_instances',
            localField: 'instance_id',
            foreignField: '_id',
            as: 'instances',
          },
        },
        { $match: { 'instances.0': { $exists: false } } },
        { $limit: limit },
        { $project: { instances: 0 } },
      ])
      .toArray();
  }

  private async hasInstance(
    instanceId: string,
    session: ClientSession,
  ): Promise<boolean> {
    if (!instanceId) return false;
    return Boolean(
      await this.db
        .collection('v2_process_instances')
        .findOne({ _id: instanceId } as any, {
          session,
          projection: { _id: 1 },
        }),
    );
  }
}

function finding(input: {
  type: RuntimeIntegrityFindingType;
  severity: 'high' | 'medium';
  resourceType: RuntimeIntegrityFinding['resource_type'];
  resourceId: unknown;
  instanceId: unknown;
  title: string;
  description: string;
  updatedAt: string;
  action: RepairAction | null;
  repairLabel: string;
}): RuntimeIntegrityFinding {
  const resourceId = String(input.resourceId);
  return {
    id: `${input.type}:${resourceId}`,
    type: input.type,
    severity: input.severity,
    resource_type: input.resourceType,
    resource_id: resourceId,
    instance_id: input.instanceId == null ? null : String(input.instanceId),
    title: input.title,
    description: input.description,
    observed_updated_at: input.updatedAt,
    repair: {
      supported: input.action !== null,
      action: input.action,
      label: input.repairLabel,
    },
  };
}

function numericId(value: string): string | number {
  const number = Number(value);
  return Number.isSafeInteger(number) && String(number) === value
    ? number
    : value;
}

function repairMetadata(input: RuntimeIntegrityRepairDto, repairedAt: string) {
  return {
    finding_type: input.finding_type,
    reason: input.reason,
    repaired_at: repairedAt,
  };
}
