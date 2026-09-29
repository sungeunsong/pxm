import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Db } from 'mongodb';
import { MONGO_DB } from '../db/mongo.provider';
import type { WorkflowHistoryActor } from '../db/ports/db.ports';
import { assertCanManageGroup, isAdmin, managerGroupIds } from '../authz/management-auth';
import { CredentialsService } from '../credentials/credentials.service';
import { ScriptLibrariesService } from '../script-libraries/script-libraries.service';
import { ManagementAuditService } from '../audit/management-audit.service';
import { errorBody } from '../observability/remediation';

/**
 * 제품 안의 자원 요청.
 *
 * 호환성 진단에서 "승인·공유 필요"로 나온 자원을 메신저 대신 제품 안에서 해결 주체에게 요청하고
 * 진행 상태를 추적한다. 권한 모델은 바꾸지 않는다. 승인하면 기존 권한 필드에 반영한다:
 *   - JS 라이브러리 → allowed_group_ids에 요청 그룹 추가 (최고관리자 처리)
 *   - 자격증명     → shared_group_ids에 요청 그룹 추가 (자격증명 소유 그룹 관리자 처리)
 */
export type ResourceRequestType = 'script_library' | 'credential';
export type ResourceRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type ResourceRequest = {
  id: string;
  resource_type: ResourceRequestType;
  resource_ref: { package_name?: string; version?: string; credential_id?: string };
  resource_label: string;
  target_group_id: string;
  target_group_name: string | null;
  approver_role: 'admin' | 'group_manager';
  approver_group_id: string | null;
  approver_group_name: string | null;
  workflow_id: string | null;
  reason: string;
  status: ResourceRequestStatus;
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_comment: string | null;
};

type ResourceRequestDocument = Omit<ResourceRequest, 'id'> & { _id: string };

export type CreateResourceRequest = {
  resource_type?: unknown;
  resource_ref?: unknown;
  target_group_id?: unknown;
  workflow_id?: unknown;
  reason?: unknown;
};

const COLLECTION = 'pxm_resource_requests';

@Injectable()
export class ResourceRequestsService implements OnModuleInit {
  constructor(
    @Inject(MONGO_DB) private readonly db: Db,
    private readonly credentialsService: CredentialsService,
    private readonly scriptLibrariesService: ScriptLibrariesService,
    private readonly audit: ManagementAuditService,
  ) {}

  async onModuleInit() {
    await Promise.all([
      this.requests.createIndex({ status: 1, approver_role: 1, approver_group_id: 1, requested_at: -1 }),
      this.requests.createIndex({ requested_by: 1, requested_at: -1 }),
      this.requests.createIndex({ resource_type: 1, target_group_id: 1, status: 1 }),
    ]);
  }

  async create(input: CreateResourceRequest, actor: WorkflowHistoryActor): Promise<ResourceRequest> {
    const targetGroupId = requireString(input.target_group_id, 'target_group_id');
    // 요청은 그 그룹에서 워크플로우를 설계·관리하는 사람이 보낸다.
    assertCanManageGroup(actor, targetGroupId);
    const targetGroup = await this.group(targetGroupId);
    if (!targetGroup) throw new BadRequestException('target group not found or inactive');
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 1000) : '';
    const workflowId = typeof input.workflow_id === 'string' && input.workflow_id.trim() ? input.workflow_id.trim() : null;
    const ref = (input.resource_ref && typeof input.resource_ref === 'object' ? input.resource_ref : {}) as Record<string, unknown>;

    let draft: Omit<ResourceRequestDocument, '_id' | 'status' | 'requested_by' | 'requested_at' | 'decided_by' | 'decided_at' | 'decision_comment'>;
    if (input.resource_type === 'script_library') {
      const packageName = requireString(ref.package_name, 'resource_ref.package_name');
      const version = requireString(ref.version, 'resource_ref.version');
      const library = await this.scriptLibrariesService.findByRef(packageName, version);
      if (!library || library.status !== 'approved') {
        throw new BadRequestException(errorBody(
          'SCRIPT_LIBRARY_NOT_APPROVED',
          `승인된 JS 라이브러리 버전이 아닙니다: ${packageName}@${version}`,
          { actor: 'admin', action: '그룹 사용 요청이 아니라 버전 준비·승인이 필요합니다. 최고관리자에게 JS 라이브러리 등록을 요청하세요.' },
        ));
      }
      if (library.allowed_group_ids.length === 0 || library.allowed_group_ids.includes(targetGroupId)) {
        throw new ConflictException(errorBody('RESOURCE_ALREADY_AVAILABLE', '이미 이 그룹에서 쓸 수 있는 라이브러리입니다.'));
      }
      draft = {
        resource_type: 'script_library',
        resource_ref: { package_name: packageName, version },
        resource_label: `${packageName}@${version}`,
        target_group_id: targetGroupId,
        target_group_name: targetGroup.name,
        approver_role: 'admin',
        approver_group_id: null,
        approver_group_name: null,
        workflow_id: workflowId,
        reason,
      };
    } else if (input.resource_type === 'credential') {
      const credentialId = requireString(ref.credential_id, 'resource_ref.credential_id');
      const availability = await this.credentialsService.availabilityForGroup(credentialId, targetGroupId);
      if (availability.status === 'not_found') throw new NotFoundException('Credential not found');
      if (availability.status === 'ok') {
        throw new ConflictException(errorBody('RESOURCE_ALREADY_AVAILABLE', '이미 이 그룹에서 쓸 수 있는 자격증명입니다.'));
      }
      if (availability.status === 'inactive') {
        throw new BadRequestException(errorBody(
          'CREDENTIAL_INACTIVE',
          '비활성화된 자격증명은 공유를 요청할 수 없습니다.',
          { actor: 'group_manager', action: '소유 그룹 관리자에게 다시 활성화를 요청하거나 다른 자격증명을 쓰세요.', group_id: availability.owner_group_id },
        ));
      }
      const ownerGroup = availability.owner_group_id ? await this.group(availability.owner_group_id) : null;
      draft = {
        resource_type: 'credential',
        resource_ref: { credential_id: credentialId },
        resource_label: availability.name || credentialId,
        target_group_id: targetGroupId,
        target_group_name: targetGroup.name,
        approver_role: 'group_manager',
        approver_group_id: availability.owner_group_id,
        approver_group_name: ownerGroup?.name || null,
        workflow_id: workflowId,
        reason,
      };
    } else {
      throw new BadRequestException('resource_type must be script_library or credential');
    }

    // 같은 자원을 같은 그룹이 이미 기다리고 있으면 새로 만들지 않는다.
    const existing = await this.requests.findOne({
      resource_type: draft.resource_type,
      target_group_id: draft.target_group_id,
      status: 'pending',
      ...(draft.resource_type === 'credential'
        ? { 'resource_ref.credential_id': draft.resource_ref.credential_id }
        : { 'resource_ref.package_name': draft.resource_ref.package_name, 'resource_ref.version': draft.resource_ref.version }),
    });
    if (existing) return toView(existing);

    const document: ResourceRequestDocument = {
      _id: randomUUID(),
      ...draft,
      status: 'pending',
      requested_by: actor.actor_id || 'system',
      requested_at: new Date().toISOString(),
      decided_by: null,
      decided_at: null,
      decision_comment: null,
    };
    await this.requests.insertOne(document);
    await this.audit.append({
      action: 'resource_request.created',
      resource_type: 'resource_request',
      resource_id: document._id,
      group_id: document.target_group_id,
      actor_id: actor.actor_id,
      details: { resource_type: document.resource_type, resource_label: document.resource_label },
    });
    return toView(document);
  }

  /** mine: 내가 보낸 요청. to_me: 내가 처리할 수 있는 요청. */
  async list(scope: 'mine' | 'to_me', actor: WorkflowHistoryActor, status?: ResourceRequestStatus): Promise<ResourceRequest[]> {
    const statusFilter = status ? { status } : {};
    if (scope === 'mine') {
      const docs = await this.requests.find({ requested_by: actor.actor_id || '', ...statusFilter }).sort({ requested_at: -1 }).limit(200).toArray();
      return docs.map(toView);
    }
    if (actor.api_key_id) return [];
    const approverFilter = isAdmin(actor)
      ? {}
      : { approver_role: 'group_manager' as const, approver_group_id: { $in: managerGroupIds(actor) } };
    const docs = await this.requests.find({ ...approverFilter, ...statusFilter }).sort({ requested_at: -1 }).limit(200).toArray();
    return docs.map(toView);
  }

  async decide(id: string, decision: 'approve' | 'reject', comment: unknown, actor: WorkflowHistoryActor): Promise<ResourceRequest> {
    const request = await this.requests.findOne({ _id: id });
    if (!request) throw new NotFoundException('Resource request not found');
    this.assertCanDecide(request, actor);
    if (request.status !== 'pending') {
      throw new ConflictException(errorBody('RESOURCE_REQUEST_ALREADY_DECIDED', '이미 처리된 요청입니다.'));
    }
    const decisionComment = typeof comment === 'string' ? comment.trim().slice(0, 1000) : '';

    // 승인은 기존 권한 필드에 반영한 뒤에 상태를 바꾼다. 반영이 실패하면 요청은 대기로 남는다.
    if (decision === 'approve') {
      if (request.resource_type === 'script_library') {
        await this.scriptLibrariesService.allowGroupByRequest(
          request.resource_ref.package_name || '',
          request.resource_ref.version || '',
          request.target_group_id,
          actor.actor_id || 'system',
          request._id,
        );
      } else {
        await this.credentialsService.shareWithGroupByRequest(
          request.resource_ref.credential_id || '',
          request.target_group_id,
          actor,
          request._id,
        );
      }
    }

    const decided = await this.requests.findOneAndUpdate(
      { _id: id, status: 'pending' },
      {
        $set: {
          status: decision === 'approve' ? 'approved' : 'rejected',
          decided_by: actor.actor_id || 'system',
          decided_at: new Date().toISOString(),
          decision_comment: decisionComment || null,
        },
      },
      { returnDocument: 'after' },
    );
    const updated = ((decided as any)?.value ?? decided) as ResourceRequestDocument | null;
    if (!updated) throw new ConflictException(errorBody('RESOURCE_REQUEST_ALREADY_DECIDED', '이미 처리된 요청입니다.'));
    await this.audit.append({
      action: decision === 'approve' ? 'resource_request.approved' : 'resource_request.rejected',
      resource_type: 'resource_request',
      resource_id: id,
      group_id: request.target_group_id,
      actor_id: actor.actor_id,
      details: { resource_type: request.resource_type, resource_label: request.resource_label, comment: decisionComment || null },
    });
    return toView(updated);
  }

  async cancel(id: string, actor: WorkflowHistoryActor): Promise<ResourceRequest> {
    const request = await this.requests.findOne({ _id: id });
    if (!request || request.requested_by !== actor.actor_id) throw new NotFoundException('Resource request not found');
    if (request.status !== 'pending') {
      throw new ConflictException(errorBody('RESOURCE_REQUEST_ALREADY_DECIDED', '이미 처리된 요청은 취소할 수 없습니다.'));
    }
    await this.requests.updateOne({ _id: id, status: 'pending' }, { $set: { status: 'cancelled', decided_at: new Date().toISOString() } });
    return toView({ ...request, status: 'cancelled' });
  }

  private assertCanDecide(request: ResourceRequestDocument, actor: WorkflowHistoryActor) {
    if (isAdmin(actor)) return;
    if (request.approver_role === 'group_manager' && request.approver_group_id && managerGroupIds(actor).includes(request.approver_group_id)) {
      return;
    }
    throw new ForbiddenException(errorBody(
      'RESOURCE_REQUEST_APPROVER_REQUIRED',
      '이 요청을 처리할 권한이 없습니다.',
      request.approver_role === 'admin'
        ? { actor: 'admin', action: 'JS 라이브러리 사용 요청은 최고관리자가 처리합니다.' }
        : { actor: 'group_manager', action: '자격증명 공유 요청은 소유 그룹의 관리자가 처리합니다.', group_id: request.approver_group_id },
    ));
  }

  private async group(id: string): Promise<{ _id: string; name: string } | null> {
    return this.db.collection<any>('pxm_groups').findOne({ _id: id, status: { $ne: 'deleted' } });
  }

  private get requests() {
    return this.db.collection<ResourceRequestDocument>(COLLECTION);
  }
}

function toView(document: ResourceRequestDocument): ResourceRequest {
  const { _id, ...rest } = document;
  return { id: _id, ...rest };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${field} is required`);
  return value.trim();
}
