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

export class InstanceResultDto {
  @ApiProperty({ format: 'uuid' }) instance_id!: string;
  @ApiProperty({ example: 'COMPLETED' }) status!: string;
  @ApiPropertyOptional({ nullable: true, type: 'object', additionalProperties: true }) result?: Record<string, unknown> | null;
  @ApiPropertyOptional({ nullable: true }) result_path?: string | null;
  @ApiPropertyOptional({ nullable: true, format: 'date-time' }) completed_at?: string | null;
  @ApiPropertyOptional({ nullable: true, format: 'date-time' }) updated_at?: string | null;
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
