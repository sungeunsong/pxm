import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { statfs } from 'node:fs/promises';
import { Public } from '../authz/public-route';
import { EngineQueueRepositoryPort } from '../db/ports/db.ports';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly queue: EngineQueueRepositoryPort) {}

  @Get()
  ok() {
    return { ok: true, status: 'live' };
  }

  @Get('live')
  live() {
    return { ok: true, status: 'live' };
  }

  @Get('ready')
  async ready() {
    try {
      const [queue, disk] = await Promise.all([
        this.queue.getQueueStats(),
        diskStatus(),
      ]);
      if (!disk.ok) throw new Error(`disk free bytes below threshold: ${disk.free_bytes}`);
      return {
        ok: true,
        status: 'ready',
        checks: {
          database: 'ok',
          disk,
          queue: {
            queued: queue.queued,
            running: queue.running,
            failed: queue.failed,
            oldest_queued_age_ms: queue.oldest_queued_age_ms,
          },
        },
      };
    } catch {
      throw new ServiceUnavailableException({
        ok: false,
        status: 'not_ready',
        reason: 'readiness check failed',
      });
    }
  }
}

async function diskStatus() {
  const path = process.env.PXM_DATA_PATH || process.cwd();
  const minimum = positiveNumber(process.env.PXM_DISK_MIN_FREE_BYTES, 1_073_741_824);
  const stats = await statfs(path);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  return { ok: freeBytes >= minimum, path, free_bytes: freeBytes, minimum_free_bytes: minimum };
}

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
