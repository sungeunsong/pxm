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
}
