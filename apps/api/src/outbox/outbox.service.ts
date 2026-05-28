import { Injectable } from '@nestjs/common';
import { OutboxRepositoryPort } from '../db/ports/db.ports';

export type OutboxRow = {
  id: number;
  instance_id: string;
  event_type: string;
  payload: any;
  created_at: string;
};

@Injectable()
export class OutboxService {
  constructor(private readonly outboxRepo: OutboxRepositoryPort) {}

  async fetchAfter(
    instanceId: string,
    afterId: number,
    limit = 100,
  ): Promise<OutboxRow[]> {
    return this.outboxRepo.fetchAfter(instanceId, afterId, limit);
  }

  async fetchTrace(instanceId: string, limit = 200): Promise<OutboxRow[]> {
    return this.outboxRepo.fetchTrace(instanceId, limit);
  }
}
