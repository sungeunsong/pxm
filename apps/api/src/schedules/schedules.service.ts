import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  WorkflowInstanceRepositoryPort,
  WorkflowRepositoryPort,
  WorkflowScheduleJob,
  WorkflowScheduleRepositoryPort,
} from '../db/ports/db.ports';

@Injectable()
export class SchedulesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulesService.name);
  private readonly owner = `api-scheduler-${process.pid}-${randomUUID()}`;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly workflowRepo: WorkflowRepositoryPort,
    private readonly instanceRepo: WorkflowInstanceRepositoryPort,
    private readonly scheduleRepo: WorkflowScheduleRepositoryPort,
  ) {}

  onModuleInit() {
    const enabled = process.env.SCHEDULE_START_ENABLED !== 'false';
    if (!enabled) return;

    const pollMs = positiveInt(process.env.SCHEDULE_START_POLL_MS, 1000);
    this.timer = setInterval(() => {
      void this.tick();
    }, Math.max(1000, pollMs));
    this.timer.unref?.();
    void this.tick();
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async syncDefinitionSchedules(
    definitionId: string,
    definitionName: string,
    nodes: any[],
  ): Promise<void> {
    const now = new Date();
    const jobs = (nodes || [])
      .filter((node) => node?.data?.nodeType === 'start')
      .map((node) => buildScheduleJob(definitionId, definitionName, node, now))
      .filter((job): job is WorkflowScheduleJob => Boolean(job));

    await this.scheduleRepo.replaceDefinitionSchedules(definitionId, jobs);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const now = new Date();
      const limit = positiveInt(process.env.SCHEDULE_START_BATCH_SIZE, 100);
      const jobs = await this.scheduleRepo.claimDueSchedules(now, this.owner, Math.max(1, limit));
      const concurrency = positiveInt(process.env.SCHEDULE_START_RUN_CONCURRENCY, 10);

      await runWithConcurrency(jobs, concurrency, (job) => this.runSchedule(job));
    } catch (error) {
      this.logger.error(
        `Schedule tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async runSchedule(job: WorkflowScheduleJob): Promise<void> {
    const nextRunAt = computeNextRunAt(job, new Date());

    try {
      const definition = await this.workflowRepo.getDefinition(job.definitionId);
      if (!definition) {
        throw new Error(`Workflow definition not found: ${job.definitionId}`);
      }

      const startNode =
        (definition.nodes || []).find((node: any) => node.id === job.startNodeId) ||
        (definition.nodes || []).find((node: any) => node?.data?.nodeType === 'start');
      if (!startNode) {
        throw new Error(`Start node not found: ${job.startNodeId}`);
      }

      const instanceId = randomUUID();
      const ctx = {
        runtime: {
          cursor: startNode.id,
          nodes: definition.nodes || [],
          edges: definition.edges || [],
          template_id: definition.id,
          template_name: definition.name,
          trigger: {
            type: 'schedule',
            schedule_job_id: job.id,
            start_node_id: job.startNodeId,
            schedule_type: job.scheduleType,
            fired_at: new Date().toISOString(),
          },
        },
        data: {
          formData: job.input || {},
          outputs: {},
        },
      };

      await this.instanceRepo.createInstance(instanceId, definition.id, 'CREATED', ctx, {
        workspace_id: 'default',
      });
      await this.instanceRepo.createJob({
        instanceId,
        type: 'START',
        runAt: new Date(),
        payload: {
          node_id: startNode.id,
          reason: 'schedule_start',
          schedule_job_id: job.id,
        },
      });
      await this.instanceRepo.createToken({
        id: randomUUID(),
        instanceId,
        nodeId: startNode.id,
        status: 'ACTIVE',
      });

      await this.scheduleRepo.markScheduleSuccess(job.id, nextRunAt, instanceId);
      this.logger.log(`Scheduled workflow started: schedule=${job.id} instance=${instanceId}`);
    } catch (error) {
      await this.scheduleRepo.markScheduleFailure(
        job.id,
        error instanceof Error ? error.message : String(error),
        nextRunAt,
      );
    }
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await worker(item);
    }
  });

  await Promise.all(workers);
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildScheduleJob(
  definitionId: string,
  definitionName: string,
  node: any,
  now: Date,
): WorkflowScheduleJob | null {
  const data = node.data || {};
  const triggerType = data.triggerType || data.startTriggerType || 'manual';
  if (triggerType !== 'schedule') {
    return null;
  }

  const scheduleType = data.scheduleType === 'cron' ? 'cron' : 'interval';
  const intervalSeconds = normalizeIntervalSeconds(data.intervalSeconds ?? data.interval_seconds);
  const cronExpression = typeof data.cronExpression === 'string' ? data.cronExpression.trim() : '';

  if (scheduleType === 'interval' && !intervalSeconds) {
    return null;
  }
  if (scheduleType === 'cron' && !cronExpression) {
    return null;
  }

  const job: WorkflowScheduleJob = {
    id: `${definitionId}:${node.id}`,
    definitionId,
    definitionName,
    startNodeId: node.id,
    scheduleType,
    intervalSeconds: scheduleType === 'interval' ? intervalSeconds : null,
    cronExpression: scheduleType === 'cron' ? cronExpression : null,
    input: isPlainObject(data.scheduleInput) ? data.scheduleInput : {},
    nextRunAt:
      scheduleType === 'interval'
        ? new Date(now.getTime() + intervalSeconds! * 1000)
        : nextCronRun(cronExpression, now),
    active: data.scheduleEnabled === true,
  };

  return job;
}

function computeNextRunAt(job: WorkflowScheduleJob, now: Date): Date {
  if (job.scheduleType === 'cron') {
    return nextCronRun(job.cronExpression || '* * * * *', now);
  }
  return new Date(now.getTime() + Math.max(1, job.intervalSeconds || 60) * 1000);
}

function normalizeIntervalSeconds(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function nextCronRun(expression: string, from: Date): Date {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('Cron expression must have 5 fields');
  }

  const start = new Date(from.getTime() + 60_000);
  start.setSeconds(0, 0);

  for (let i = 0; i < 366 * 24 * 60; i += 1) {
    const candidate = new Date(start.getTime() + i * 60_000);
    if (matchesCron(fields, candidate)) {
      return candidate;
    }
  }

  throw new Error('Unable to find next cron run within one year');
}

function matchesCron(fields: string[], date: Date): boolean {
  return (
    matchesCronField(fields[0], date.getMinutes(), 0, 59) &&
    matchesCronField(fields[1], date.getHours(), 0, 23) &&
    matchesCronField(fields[2], date.getDate(), 1, 31) &&
    matchesCronField(fields[3], date.getMonth() + 1, 1, 12) &&
    matchesCronField(fields[4], date.getDay(), 0, 7)
  );
}

function matchesCronField(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;

  return field.split(',').some((part) => {
    if (part.startsWith('*/')) {
      const step = Number(part.slice(2));
      return Number.isInteger(step) && step > 0 && (value - min) % step === 0;
    }

    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      return Number.isInteger(start) && Number.isInteger(end) && value >= start && value <= end;
    }

    const exact = Number(part);
    if (max === 7 && value === 0 && exact === 7) {
      return true;
    }
    return Number.isInteger(exact) && exact >= min && exact <= max && exact === value;
  });
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
