import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PublicApiErrorDto {
  @ApiProperty({ example: 403 }) statusCode!: number;
  @ApiProperty({ example: 'Forbidden' }) error!: string;
  @ApiProperty({ example: 'MISSING_SCOPE' }) code!: string;
  @ApiProperty({ example: 'workflow:execute scope is required' }) message!: string;
  @ApiPropertyOptional({ type: [String] }) details?: string[];
  @ApiPropertyOptional({ example: 'workflow:execute' }) required_scope?: string;
  @ApiProperty({ example: 'client-request-42' }) request_id!: string;
  @ApiProperty({ format: 'date-time' }) timestamp!: string;
  @ApiProperty({ example: '/api/v1/templates/workflow-1/start' }) path!: string;
}

export class WorkflowDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() description?: string;
  @ApiPropertyOptional() group?: string;
  @ApiPropertyOptional({ nullable: true }) group_id?: string | null;
  @ApiProperty({ type: [String] }) tags!: string[];
  @ApiProperty() version!: number;
  @ApiProperty({ enum: ['DRAFT', 'PUBLISHED', 'DISABLED'] }) lifecycle_status!: string;
  @ApiProperty({ type: 'array', items: { type: 'object', additionalProperties: true } }) nodes!: Record<string, unknown>[];
  @ApiProperty({ type: 'array', items: { type: 'object', additionalProperties: true } }) edges!: Record<string, unknown>[];
}

export class StartWorkflowDto {
  @ApiPropertyOptional({ enum: ['async', 'sync'], default: 'async' }) mode?: 'async' | 'sync';
  @ApiPropertyOptional({ minimum: 100, maximum: 30000 }) sync_timeout_ms?: number;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) input?: Record<string, unknown>;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, example: { requestTitle: '구매 승인', amount: 125000 } }) formData?: Record<string, unknown>;
  @ApiPropertyOptional() preset?: string;
  @ApiPropertyOptional() preset_id?: string;
  @ApiPropertyOptional() preset_alias?: string;
}

export class StartWorkflowResponseDto {
  @ApiProperty({ format: 'uuid' }) instance_id!: string;
  @ApiProperty({ format: 'uuid' }) template_id!: string;
  @ApiProperty() template_name!: string;
  @ApiProperty({ example: 'CREATED' }) status!: string;
  @ApiProperty({ enum: ['async', 'sync'] }) mode!: string;
  @ApiProperty() idempotent_replay!: boolean;
  @ApiProperty({ example: '/api/v1/instances/instance-id/result' }) result_url!: string;
  @ApiProperty({ example: '/api/v1/instances/instance-id/trace' }) trace_url!: string;
  @ApiProperty({ example: '/api/v1/instances/instance-id/stream' }) stream_url!: string;
}

export class InstanceDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiPropertyOptional({ format: 'uuid' }) process_definition_id?: string;
  @ApiProperty({ example: 'RUNNING' }) state!: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) context?: Record<string, unknown>;
  @ApiPropertyOptional({ format: 'date-time' }) created_at?: string;
  @ApiPropertyOptional({ format: 'date-time' }) updated_at?: string;
}

export class InstanceStatsDto {
  @ApiProperty({ example: 128 }) total!: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { CREATED: 2, RUNNING: 8, WAITING: 4, PAUSED: 1, COMPLETED: 108, FAILED: 3, TERMINATED: 2, UNKNOWN: 0 },
  })
  by_state!: Record<string, number>;
  @ApiProperty({ enum: ['all', 'authorized'], description: 'all은 전체, authorized는 요청 actor가 접근 가능한 전체 실행 범위' })
  scope!: 'all' | 'authorized';
}

export class InstanceOutcomeReasonDto {
  @ApiProperty({ example: 'APPROVAL_REJECTED', description: '프로그램에서 분기할 안정적인 결과 코드' }) code!: string;
  @ApiPropertyOptional({
    nullable: true,
    example: 'upstream_error',
    description: 'FAILURE의 원인 분류: configuration | upstream_error | timeout | script_error | subworkflow_failed | internal. 업무 결과(반려 등)는 business',
  })
  failure_type?: string | null;
  @ApiPropertyOptional({ description: '같은 입력으로 다시 실행하면 성공할 수 있는지. 자동 재시도 판단은 이 값을 기준으로 한다' }) retryable?: boolean;
  @ApiPropertyOptional({ nullable: true }) message?: string | null;
  @ApiPropertyOptional({ nullable: true }) node_id?: string | null;
}

export class InstanceResultDto {
  @ApiProperty({ format: 'uuid' }) instance_id!: string;
  @ApiProperty({ example: 'COMPLETED', description: '실행 상태. 업무 결과는 outcome을 본다' }) status!: string;
  @ApiPropertyOptional({
    nullable: true,
    enum: ['SUCCESS', 'REJECTED', 'FAILURE', 'CANCELLED'],
    description: '업무 결과. 종료 전에는 null. 결재 반려는 status가 COMPLETED여도 REJECTED다',
  })
  outcome?: 'SUCCESS' | 'REJECTED' | 'FAILURE' | 'CANCELLED' | null;
  @ApiPropertyOptional({ nullable: true, type: InstanceOutcomeReasonDto }) outcome_reason?: InstanceOutcomeReasonDto | null;
  @ApiPropertyOptional({ nullable: true, type: 'object', additionalProperties: true }) result?: Record<string, unknown> | null;
  @ApiPropertyOptional({ nullable: true }) result_path?: string | null;
  @ApiPropertyOptional({ nullable: true, format: 'date-time' }) completed_at?: string | null;
  @ApiPropertyOptional({ nullable: true, format: 'date-time' }) updated_at?: string | null;
}

export class TerminateInstanceResponseDto {
  @ApiProperty({ example: true }) success!: boolean;
  @ApiProperty({ format: 'uuid' }) instance_id!: string;
  @ApiProperty({ type: [String], description: '이번 요청에서 종료 상태로 바뀐 실행 ID. 이미 종료된 실행이면 빈 배열입니다.' })
  terminated_instances!: string[];
  @ApiProperty({ example: false }) idempotent_replay!: boolean;
}

export class TraceEventDto {
  @ApiProperty() id!: number;
  @ApiPropertyOptional() event_type?: string;
  @ApiPropertyOptional() node_id?: string;
  @ApiPropertyOptional() node_label?: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) payload?: Record<string, unknown>;
  @ApiPropertyOptional({ format: 'date-time' }) created_at?: string;
}

export class ApprovalHoldDto {
  @ApiProperty() actor_id!: string;
  @ApiPropertyOptional({ nullable: true }) comment?: string | null;
  @ApiProperty({ format: 'date-time' }) held_at!: string;
}

export class ApprovalTaskDto {
  @ApiProperty() task_id!: string;
  @ApiProperty() instance_id!: string;
  @ApiPropertyOptional({ nullable: true }) workflow_id?: string | null;
  @ApiPropertyOptional({ nullable: true }) workflow_name?: string | null;
  @ApiPropertyOptional({ nullable: true }) node_label?: string | null;
  @ApiProperty({ example: 'OPEN' }) status!: string;
  @ApiProperty() assignee!: string;
  @ApiProperty({ example: 'pxm_user' }) approver_channel!: string;
  @ApiPropertyOptional({ type: [String] }) approval_channels?: string[];
  @ApiPropertyOptional({ nullable: true }) action?: string | null;
  @ApiPropertyOptional({ nullable: true }) comment?: string | null;
  @ApiPropertyOptional({ nullable: true, type: ApprovalHoldDto }) hold?: ApprovalHoldDto | null;
  @ApiPropertyOptional({ format: 'date-time' }) created_at?: string;
  @ApiPropertyOptional({ nullable: true, format: 'date-time' }) completed_at?: string | null;
}

export class ApprovalTaskPageDto {
  @ApiProperty({ type: [ApprovalTaskDto] }) items!: ApprovalTaskDto[];
  @ApiPropertyOptional({ nullable: true }) next_cursor!: string | null;
}

export class CompleteApprovalDto {
  @ApiProperty({ enum: ['approve', 'reject'] }) action!: 'approve' | 'reject';
  @ApiPropertyOptional({ maxLength: 2000 }) comment?: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) result?: Record<string, unknown>;
}

export class WorkflowResultWebhookSourceDto {
  @ApiProperty({ example: 'acrapoint' }) provider!: string;
  @ApiProperty({ example: 'ACRA-2026-0042' }) request_id!: string;
  @ApiProperty({ example: 1 }) revision!: number;
}

export class WorkflowResultWebhookDataDto {
  @ApiProperty() instance_id!: string;
  @ApiProperty() approval_request_id!: string;
  @ApiProperty() task_id!: string;
  @ApiProperty({ enum: ['APPROVED', 'REJECTED', 'CANCELED'] }) status!: string;
  @ApiProperty({ enum: ['approved', 'rejected', 'canceled'] }) outcome!: string;
  @ApiProperty({ type: WorkflowResultWebhookSourceDto }) source!: WorkflowResultWebhookSourceDto;
}

export class WorkflowResultWebhookDto {
  @ApiProperty({ example: 'mongodb:66a123...' }) id!: string;
  @ApiProperty({ enum: ['APPROVAL_REQUEST_APPROVED', 'APPROVAL_REQUEST_REJECTED', 'APPROVAL_REQUEST_CANCELED'] }) type!: string;
  @ApiProperty({ format: 'date-time' }) occurred_at!: string;
  @ApiProperty({ type: WorkflowResultWebhookDataDto }) data!: WorkflowResultWebhookDataDto;
}

export class ToolDefinitionDto {
  @ApiProperty({ description: 'LLM에 넣을 이름. naming에 따라 tool_name 또는 qualified_name', example: 'request_access' }) name!: string;
  @ApiProperty({ example: 'request_access' }) tool_name!: string;
  @ApiProperty({ description: '{그룹 공개 이름}__{Tool 이름}. Tool 수명 동안 바뀌지 않는다', example: 'security-ops__request_access' }) qualified_name!: string;
  @ApiPropertyOptional({ nullable: true }) display_name?: string | null;
  @ApiProperty({ description: 'LLM이 Tool을 고를 때 읽는 설명' }) description!: string;
  @ApiProperty({ type: 'object', additionalProperties: true, description: 'JSON Schema' }) input_schema!: Record<string, unknown>;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true }) output_schema?: Record<string, unknown> | null;
  @ApiProperty({ enum: ['declared', 'free_form'] }) output_contract!: string;
  @ApiProperty({ enum: ['read_only', 'mutating', 'requires_approval'] }) side_effect!: string;
  @ApiProperty({ type: [String] }) tags!: string[];
  @ApiProperty() group_id!: string;
  @ApiPropertyOptional({ nullable: true }) group_name?: string | null;
  @ApiPropertyOptional({ nullable: true }) namespace?: string | null;
  @ApiProperty({ description: '쓸 수 있는 Tool 중 같은 tool_name이 다른 그룹에도 있음' }) name_conflict!: boolean;
  @ApiProperty() pinned_version!: number;
}

export class ToolListResponseDto {
  @ApiProperty({ type: [ToolDefinitionDto] }) tools!: ToolDefinitionDto[];
  @ApiProperty() has_name_conflict!: boolean;
}

export class ToolInvokeDto {
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, description: 'input_schema를 따르는 인자' }) arguments?: Record<string, unknown>;
  @ApiPropertyOptional({ description: '일반 이름이 여러 그룹에 있을 때 그룹을 정한다' }) group_id?: string;
  @ApiPropertyOptional({ enum: ['sync', 'async'], default: 'sync' }) mode?: 'sync' | 'async';
  @ApiPropertyOptional({ minimum: 100, maximum: 30000 }) sync_timeout_ms?: number;
}

export class ToolInvokeErrorDto {
  @ApiProperty({ enum: ['business'] }) kind!: string;
  @ApiProperty({ example: 'APPROVAL_REJECTED' }) code!: string;
  @ApiProperty() message!: string;
  @ApiProperty({ example: false }) retryable!: boolean;
}

export class ToolInvokeResponseDto {
  @ApiProperty() tool!: string;
  @ApiProperty() qualified_name!: string;
  @ApiProperty({ enum: ['ok', 'error', 'pending_approval', 'running'] }) status!: string;
  @ApiProperty({ format: 'uuid' }) instance_id!: string;
  @ApiPropertyOptional({ enum: ['SUCCESS', 'REJECTED', 'FAILURE'], nullable: true }) outcome?: string | null;
  @ApiPropertyOptional({ nullable: true, description: '업무 결과 (End 노드 결과)' }) result?: unknown;
  @ApiPropertyOptional({ type: ToolInvokeErrorDto, description: 'status=error일 때 업무 실패 내용. 재시도 대상이 아니다' }) error?: ToolInvokeErrorDto;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, description: 'status=pending_approval일 때 결재 대기 정보' }) pending?: Record<string, unknown>;
  @ApiProperty() result_url!: string;
  @ApiPropertyOptional({ description: 'workflow:read가 있을 때만 준다' }) trace_url?: string;
  @ApiPropertyOptional({ description: 'workflow:read가 있을 때만 준다' }) stream_url?: string;
  @ApiProperty() idempotent_replay!: boolean;
  @ApiProperty() request_id!: string;
}
