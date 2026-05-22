import { Controller, Get, Post, Body, Param, Query, NotFoundException } from '@nestjs/common';
import {
  WorkflowTaskRepositoryPort,
  WorkflowInstanceRepositoryPort,
} from '../db/ports/db.ports';

@Controller('tasks')
export class TasksController {
  constructor(
    private readonly taskRepo: WorkflowTaskRepositoryPort,
    private readonly instanceRepo: WorkflowInstanceRepositoryPort,
  ) {}

  // 내 할 일 목록 조회
  @Get()
  async getTasks(@Query('assignee') assignee = 'admin') {
    return this.taskRepo.listTasks(assignee);
  }

  // 승인/반려 처리
  @Post(':id/complete')
  async completeTask(
    @Param('id') id: string,
    @Body() body: { action: 'approve' | 'reject' },
  ) {
    const action = body.action || 'approve';
    const status = action === 'approve' ? 'APPROVED' : 'REJECTED';

    // 1. Task 조회 및 검증
    const task = await this.taskRepo.getTask(id);
    if (!task || task.status !== 'OPEN') {
      throw new NotFoundException('Task not found or already completed');
    }

    // 2. Task 상태 업데이트
    await this.taskRepo.updateTaskStatus(id, status);

    const instanceId = task.instance_id;
    const nodeId = task.node_id;

    console.log(
      `[API] Task completed: ${id} (${action}) -> Resuming instance ${instanceId}`,
    );

    // 3. 엔진 재개 (RESUME Job 생성)
    await this.instanceRepo.createJob({
      instanceId,
      type: 'RESUME',
      runAt: new Date(),
      payload: { action, completed_node_id: nodeId },
    });

    // 4. 인스턴스 상태 RUNNING으로 변경
    await this.instanceRepo.updateInstanceStatus(instanceId, 'RUNNING');

    return { success: true };
  }
}
