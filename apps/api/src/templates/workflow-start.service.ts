import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import {
  WorkflowInstanceRepositoryPort,
  type WorkflowHistoryActor,
  type WorkflowInstanceAccess,
} from '../db/ports/db.ports';
import { AuthzService } from '../authz/authz.service';
import {
  dynamicApprovalRequestPath,
  externalApprovalIdempotencyTtlMs,
  externalApprovalKeyHash,
  externalApprovalRequestHash,
  normalizeExternalApprovalRequest,
  stableStringify,
} from '../instances/external-approval-start';
import type { TemplateResponseDto } from './dto/template.dto';

export type WorkflowStartRequest = {
  /** 실행할 정의. 런타임 번들이 포함된 실행용 DTO(findForExecution / findVersionForExecution) */
  template: TemplateResponseDto;
  actor: WorkflowHistoryActor;
  /** 요청에서 만든 접근 정보(instanceAccessFromRequest). 그룹·버전은 여기서 정의 기준으로 덮어쓴다 */
  access: WorkflowInstanceAccess;
  /** 입력 폼 기준으로 정규화한 입력 */
  formData: Record<string, any>;
  inputPreset?: { id: string; alias: string; name: string } | null;
  inputOverrideKeys?: string[];
  idempotencyKey?: string | null;
  /** 같은 키라도 입구가 다르면 다른 요청이다. 워크플로우 실행은 정의 id, 진입점은 `entry_point:{id}` */
  idempotencyScope: string;
  /** START job payload.reason */
  reason: string;
  /** 진입점으로 들어온 실행이면 runtime.snapshot.entry_point에 남긴다 */
  entryPoint?: Record<string, any> | null;
};

export type WorkflowStartResult = {
  instance_id: string;
  idempotent_replay: boolean;
  external_approval: {
    provider: string;
    request_id: string;
    revision: number;
  } | null;
};

/**
 * 인스턴스 생성만 맡는다: 실행 컨텍스트 구성, 외부 결재 키, 중복 실행 방지, START job 등록.
 * 권한 판정·입력 정규화·응답 모양은 부르는 입구(실행 API, Tool 호출)가 정한다.
 * 실행 버전은 template.version이다. 엔진은 access.workflow_version_id로 그 버전을 읽는다.
 */
@Injectable()
export class WorkflowStartService {
  constructor(
    private readonly instanceRepo: WorkflowInstanceRepositoryPort,
    private readonly authzService: AuthzService,
  ) {}

  async start(request: WorkflowStartRequest): Promise<WorkflowStartResult> {
    const { template, actor, formData } = request;
    const startNode = template.nodes.find(
      (node: any) => node.data?.nodeType === 'start',
    );
    if (!startNode) {
      throw new BadRequestException('Start node not found in template');
    }

    const instanceId = randomUUID();
    const approvalRequestPath = dynamicApprovalRequestPath(template.nodes);
    const externalApproval = normalizeExternalApprovalRequest(
      formData,
      approvalRequestPath,
    );
    const externalApprovalRequestDigest = externalApproval
      ? externalApprovalRequestHash(template.id, formData, approvalRequestPath)
      : null;
    const access = {
      ...request.access,
      group_id: template.group_id || request.access.group_id,
      workflow_version_id: template.version
        ? `${template.id}:${template.version}`
        : null,
    };
    if (externalApproval) {
      await this.authzService.resolveExternalApprovalPrincipals(
        formData,
        approvalRequestPath,
        access.group_id,
        template.nodes,
      );
    }
    const groupSnapshot = template.group_id
      ? await this.authzService.getGroup(template.group_id).catch(() => null)
      : null;
    const apiKeySnapshot = actor.api_key_id
      ? await this.authzService.getApiKey(actor.api_key_id).catch(() => null)
      : null;
    const ctx = {
      runtime: {
        cursor: startNode.id,
        nodes: template.nodes,
        edges: template.edges,
        template_id: template.id,
        template_name: template.name,
        snapshot: {
          workflow: {
            id: template.id,
            name: template.name,
            version: template.version || 1,
          },
          group: template.group_id
            ? {
                id: template.group_id,
                name:
                  groupSnapshot?.name || template.group || template.group_id,
              }
            : null,
          caller: { type: actor.actor_type, id: actor.actor_id },
          api_key: apiKeySnapshot
            ? {
                id: apiKeySnapshot.id,
                name: apiKeySnapshot.name,
                prefix: apiKeySnapshot.key_prefix,
              }
            : null,
          business_actor: actor.business_actor || null,
          ...(request.entryPoint ? { entry_point: request.entryPoint } : {}),
        },
        access,
        input_preset: request.inputPreset
          ? {
              id: request.inputPreset.id,
              alias: request.inputPreset.alias,
              name: request.inputPreset.name,
              override_keys: request.inputOverrideKeys ?? [],
            }
          : null,
      },
      data: {
        formData,
        outputs: {},
      },
    };

    const startTokenId = randomUUID();
    const job = {
      type: 'START',
      run_at: new Date(),
      payload: { node_id: startNode.id, reason: request.reason },
    };
    if (!request.idempotencyKey && !externalApproval) {
      await this.instanceRepo.executeInstanceMutation({
        create_instances: [
          {
            id: instanceId,
            definition_id: template.id,
            status: 'CREATED',
            context: ctx,
            access,
          },
        ],
        tokens: [
          {
            id: startTokenId,
            instance_id: instanceId,
            node_id: startNode.id,
            status: 'ACTIVE',
          },
        ],
        jobs: [{ instance_id: instanceId, ...job }],
      });
      return {
        instance_id: instanceId,
        idempotent_replay: false,
        external_approval: null,
      };
    }

    const principal = actor.api_key_id
      ? `api_key:${actor.api_key_id}`
      : `${actor.actor_type}:${actor.actor_id || 'anonymous'}`;
    const keyHash = externalApproval
      ? externalApprovalKeyHash(externalApproval)
      : sha256(
          `workflow-start:v1:${principal}:${request.idempotencyScope}:${request.idempotencyKey}`,
        );
    const requestHash = externalApproval
      ? externalApprovalRequestDigest!
      : sha256(
          stableStringify({
            workflow_id: template.id,
            preset_id: request.inputPreset?.id || null,
            input: formData,
          }),
        );
    const result = await this.instanceRepo.createIdempotentStart({
      key_hash: keyHash,
      request_hash: requestHash,
      expires_at: new Date(
        Date.now() +
          (externalApproval
            ? externalApprovalIdempotencyTtlMs()
            : startIdempotencyTtlMs()),
      ),
      instance: {
        id: instanceId,
        definition_id: template.id,
        status: 'CREATED',
        context: ctx,
        access,
      },
      token: { id: startTokenId, node_id: startNode.id, status: 'ACTIVE' },
      job,
    });
    if (result.outcome === 'conflict') {
      throw new ConflictException(
        externalApproval
          ? 'External approval request key was already used with different workflow input; increment revision to resubmit'
          : 'Idempotency-Key was already used with different workflow input',
      );
    }
    return {
      instance_id: result.instance_id,
      idempotent_replay: result.outcome === 'replayed',
      external_approval: externalApproval
        ? {
            provider: externalApproval.provider,
            request_id: externalApproval.requestId,
            revision: externalApproval.revision,
          }
        : null,
    };
  }
}

export function normalizeSyncTimeoutMs(value?: number): number {
  const defaultTimeout = Number(process.env.START_SYNC_TIMEOUT_MS ?? 10000);
  const maxTimeout = Number(process.env.START_SYNC_MAX_TIMEOUT_MS ?? 30000);
  const timeout =
    Number.isFinite(value) && value ? Number(value) : defaultTimeout;
  return Math.min(Math.max(timeout, 100), maxTimeout);
}

export function normalizeIdempotencyKey(value?: string): string | null {
  if (value === undefined) return null;
  const key = value.trim();
  if (!key || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new BadRequestException(
      'Idempotency-Key must contain 1 to 200 printable characters',
    );
  }
  return key;
}

function startIdempotencyTtlMs(): number {
  const hours = Number(process.env.START_IDEMPOTENCY_TTL_HOURS ?? 24);
  const normalizedHours = Number.isFinite(hours) && hours > 0 ? hours : 24;
  return normalizedHours * 60 * 60 * 1000;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
