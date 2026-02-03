import { Controller, Get, Post, Body, Param, Query, Inject, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/pg.provider';

@Controller('tasks')
export class TasksController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // 내 할 일 목록 조회
  @Get()
  async getTasks(@Query('assignee') assignee = 'admin') {
    const { rows } = await this.pool.query(
      `select t.*, 
              pi.id as instance_id, 
              (pi.ctx->'formData')::jsonb as form_data 
       from tasks t
       join process_instance pi on t.instance_id = pi.id
       where t.assignee = $1 and t.status = 'OPEN'
       order by t.created_at desc`,
      [assignee]
    );
    return rows;
  }

  // 승인/반려 처리
  @Post(':id/complete')
  async completeTask(@Param('id') id: string, @Body() body: { action: 'approve' | 'reject' }) {
    const action = body.action || 'approve';
    const status = action === 'approve' ? 'APPROVED' : 'REJECTED';
    
    // 1. Task 상태 업데이트
    const { rows } = await this.pool.query(
      `update tasks set status = $1, updated_at = now() 
       where id = $2 and status = 'OPEN' 
       returning instance_id, node_id`,
      [status, id]
    );

    if (rows.length === 0) {
      throw new NotFoundException('Task not found or already completed');
    }

    const { instance_id: instanceId, node_id: nodeId } = rows[0];

    console.log(`[API] Task completed: ${id} (${action}) -> Resuming instance ${instanceId}`);

    // 2. 엔진 재개 (RESUME Job 생성)
    // payload에 action 정보 포함 (나중에 Gateway에서 쓸 수 있음)
    // 주의: 엔진이 Approval 노드를 완료 처리(NODE_COMPLETED)하고 다음으로 넘어가게 하려면
    // 엔진 로직이 RESUME Job을 받았을 때 현재 노드가 Approval이면 완료 처리하고 넘어가야 함.
    // 현재 engine/main.rs 구현상 RESUME Job은 단순히 다음 노드를 찾는 역할(find_next_node)을 수행하거나
    // 명시적인 처리가 필요함.
    
    // 일단 RESUME job을 보내면 엔진 loop가 돌면서 다시 해당 노드를 검사하거나 다음으로 넘어감.
    // main.rs의 RESUME 처리 로직을 보면:
    // "RESUME" => { ... find_next_node ... }
    // 아, Approval 노드에서 멈췄으므로(cursor가 아직 Approval 노드),
    // RESUME Job이 실행되면 다시 Approval 노드를 실행할 수도 있음(무한루프 위험).
    // 따라서 엔진이 RESUME Job을 처리할 때, 현재 노드가 Approval이고 상태가 WAITING이면 "아 완료됐구나" 하고 넘어가야 함.
    
    // 또는 여기서 NODE_COMPLETED 이벤트를 미리 쏴주는 것도 방법.
    
    await this.pool.query(
      `insert into engine_jobs (instance_id, type, run_at, status, payload)
       values ($1, 'RESUME', now(), 'READY', $2)`,
      [instanceId, JSON.stringify({ action, completed_node_id: nodeId })]
    );

    // 3. 인스턴스 상태 RUNNING으로 변경
    await this.pool.query(
        `update process_instance set status = 'RUNNING' where id = $1`,
        [instanceId]
    );

    return { success: true };
  }
}
