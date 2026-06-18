import { Injectable } from '@nestjs/common';
import { CreateInstanceDto } from './dto/create-instance.dto';
import { randomUUID } from 'crypto';
import { WorkflowInstanceRepositoryPort } from '../db/ports/db.ports';

@Injectable()
export class InstancesService {
  constructor(
    private readonly instanceRepo: WorkflowInstanceRepositoryPort,
  ) {}

  async createInstance(dto: CreateInstanceDto) {
    const instanceId = randomUUID();
    const definitionId = dto.template_id ?? randomUUID();
    const ctx = dto.ctx ?? {};

    // 1) V2 process instance 생성
    await this.instanceRepo.createInstance(
      instanceId,
      definitionId,
      'CREATED',
      ctx,
    );

    // 2) V2 engine job START 생성
    await this.instanceRepo.createJob({
      instanceId,
      type: 'START',
      runAt: new Date(),
      payload: { reason: 'api_create' },
    });

    // 3) V2 시작 토큰 생성 (Explicit Token 기반 구동용)
    const tokenId = randomUUID();
    await this.instanceRepo.createToken({
      id: tokenId,
      instanceId,
      nodeId: 'start', // 기본 시작 지점
      status: 'READY',
    });

    return { instance_id: instanceId };
  }

  async findAll() {
    return this.instanceRepo.listInstances();
  }

  async findOne(id: string) {
    return this.instanceRepo.getInstance(id);
  }

  async getResult(id: string) {
    const instance = await this.instanceRepo.getInstance(id);
    if (!instance) {
      return null;
    }

    const context = instance.context ?? instance.ctx ?? {};
    const result = context.result ?? context.data?.result ?? null;
    return {
      instance_id: id,
      status: instance.state ?? instance.status,
      result,
      result_path: context.result_path ?? null,
      completed_at: instance.completed_at ?? null,
      updated_at: instance.updated_at ?? null,
    };
  }
}
