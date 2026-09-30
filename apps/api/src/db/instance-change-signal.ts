import { Logger, type OnModuleDestroy } from '@nestjs/common';
import type { ChangeStream, Db } from 'mongodb';

/**
 * 인스턴스가 바뀌면 기다리던 쪽을 바로 깨운다.
 *
 * 동기 실행은 인스턴스가 끝날 때까지 결과를 기다린다. 예전에는 250ms마다 DB를 다시 읽었고,
 * 그만큼 응답이 늦어졌다. 이 포트는 변경이 생기면 곧바로 알려준다.
 * 신호를 놓치더라도 호출부가 최대 대기 시간마다 다시 확인하므로 정확성은 영향받지 않는다.
 */
export interface InstanceChangeWatch {
  /** 변경이 있었으면 true, timeoutMs가 지나면 false. 등록 이후 이미 온 변경도 바로 true로 돌려준다. */
  wait(timeoutMs: number): Promise<boolean>;
  close(): void;
}

export abstract class InstanceChangeSignalPort {
  /** 결과를 읽기 전에 먼저 등록해야 읽는 사이에 생긴 변경을 놓치지 않는다. */
  abstract watch(instanceId: string): InstanceChangeWatch;
}

/** 신호 없이 시간만 기다린다. PostgreSQL(LISTEN/NOTIFY 구현 전)과 단독 MongoDB에서 쓴다. */
export class PollingInstanceChangeSignal extends InstanceChangeSignalPort {
  watch(): InstanceChangeWatch {
    let timer: NodeJS.Timeout | null = null;
    return {
      wait: (timeoutMs) =>
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      close: () => {
        if (timer) clearTimeout(timer);
      },
    };
  }
}

type Waiter = { changed: boolean; wake: (() => void) | null };

/**
 * MongoDB change stream 하나로 모든 대기를 처리한다. 대기마다 스트림을 열지 않는다.
 * 처음 대기가 생길 때 연다. 열 수 없으면(replica set 아님) 일정 시간 주기 확인으로 동작한다.
 */
export class MongoInstanceChangeSignal
  extends InstanceChangeSignalPort
  implements OnModuleDestroy
{
  private readonly logger = new Logger('InstanceChangeSignal');
  private readonly waiters = new Map<string, Set<Waiter>>();
  private stream: ChangeStream | null = null;
  private retryAfter = 0;

  constructor(private readonly db: Db) {
    super();
  }

  watch(instanceId: string): InstanceChangeWatch {
    this.ensureStream();
    const waiter: Waiter = { changed: false, wake: null };
    const set = this.waiters.get(instanceId) ?? new Set<Waiter>();
    set.add(waiter);
    this.waiters.set(instanceId, set);
    let timer: NodeJS.Timeout | null = null;

    return {
      wait: (timeoutMs) => {
        if (waiter.changed) {
          waiter.changed = false;
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          timer = setTimeout(() => {
            waiter.wake = null;
            resolve(false);
          }, timeoutMs);
          waiter.wake = () => {
            if (timer) clearTimeout(timer);
            waiter.wake = null;
            waiter.changed = false;
            resolve(true);
          };
        });
      },
      close: () => {
        if (timer) clearTimeout(timer);
        const current = this.waiters.get(instanceId);
        current?.delete(waiter);
        if (current && current.size === 0) this.waiters.delete(instanceId);
      },
    };
  }

  async onModuleDestroy() {
    await this.stream?.close().catch(() => undefined);
    this.stream = null;
  }

  private ensureStream() {
    if (this.stream || Date.now() < this.retryAfter) return;
    try {
      const stream = this.db
        .collection('v2_process_instances')
        .watch([{ $match: { operationType: { $in: ['update', 'replace'] } } }]);
      stream.on('change', (event: { documentKey?: { _id?: string } }) =>
        this.notify(String(event.documentKey?._id ?? '')),
      );
      stream.on('error', (error) => this.reset(error));
      stream.on('close', () => {
        if (this.stream === stream) this.stream = null;
      });
      this.stream = stream;
    } catch (error) {
      this.reset(error);
    }
  }

  private notify(instanceId: string) {
    for (const waiter of this.waiters.get(instanceId) ?? []) {
      waiter.changed = true;
      waiter.wake?.();
    }
  }

  private reset(error: unknown) {
    this.logger.warn(
      `change stream unavailable, falling back to polling: ${error instanceof Error ? error.message : String(error)}`,
    );
    void this.stream?.close().catch(() => undefined);
    this.stream = null;
    this.retryAfter = Date.now() + 30_000;
  }
}
