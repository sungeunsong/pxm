import { Injectable } from '@nestjs/common';
import { WorkflowRepositoryPort } from '../db/ports/db.ports';
import { AuthzService } from '../authz/authz.service';
import { CredentialsService } from '../credentials/credentials.service';
import { ScriptLibrariesService } from '../script-libraries/script-libraries.service';
import { PluginsService } from '../plugins/plugins.service';
import { CommandsService } from '../commands/commands.service';
import type { Remediation } from '../observability/remediation';
import { collectCredentialIds, extractWorkflowCallTargets } from './templates.service';

/**
 * 워크플로우를 어떤 그룹에서 저장·실행하려 할 때 필요한 자원이 그 그룹에서 쓸 수 있는지 미리 진단한다.
 *
 * 예전에는 그룹을 바꾸거나 가져오기를 하면 저장 시점에 첫 문제 하나만 오류로 알게 됐고,
 * 누구에게 무엇을 요청해야 하는지도 알 수 없었다. 이 진단은 문제를 한 번에 모두 보여주고
 * 항목마다 해결 주체와 행동을 붙인다.
 *
 * 판정은 저장 검사와 같은 함수를 쓴다(라이브러리: libraryUsabilityForGroup,
 * 자격증명: availabilityForGroup, 결재자: 대상 그룹의 활성 구성원). 진단이 "문제 없음"인데
 * 저장이 실패하는 일이 없어야 하기 때문이다.
 */
export type CompatibilityStatus = 'ok' | 'action_required' | 'blocked' | 'warning';

export type CompatibilityItem = {
  kind: 'script_library' | 'credential' | 'approver' | 'plugin' | 'command' | 'workflow_call' | 'group';
  ref: string;
  label: string;
  node_ids: string[];
  status: CompatibilityStatus;
  message: string;
  remediation?: Remediation;
};

export type CompatibilityReport = {
  workflow_id: string;
  target_group_id: string | null;
  target_group_name: string | null;
  items: CompatibilityItem[];
  summary: Record<CompatibilityStatus, number> & {
    /** 차단·조치 필요 항목이 없어 대상 그룹에서 저장·실행할 수 있다 */
    ready: boolean;
  };
};

type NodeLike = { id?: string; data?: Record<string, any>; config?: Record<string, any>; node_type?: string; type?: string };

@Injectable()
export class WorkflowCompatibilityService {
  constructor(
    private readonly workflowRepo: WorkflowRepositoryPort,
    private readonly authzService: AuthzService,
    private readonly credentialsService: CredentialsService,
    private readonly scriptLibrariesService: ScriptLibrariesService,
    private readonly pluginsService: PluginsService,
    private readonly commandsService: CommandsService,
  ) {}

  async evaluate(workflowId: string, nodes: NodeLike[], targetGroupId: string | null): Promise<CompatibilityReport> {
    const groupName = targetGroupId
      ? await this.authzService.getGroup(targetGroupId).then((group) => group.name).catch(() => null)
      : null;
    const items: CompatibilityItem[] = [];

    if (!targetGroupId) {
      items.push({
        kind: 'group',
        ref: 'group',
        label: '관리 그룹',
        node_ids: [],
        status: 'blocked',
        message: '관리 그룹이 지정되지 않았습니다. 그룹 없이는 자격증명과 PXM 결재자를 쓸 수 없습니다.',
        remediation: { actor: 'self', action: '워크플로우 설정에서 관리 그룹을 지정하세요.' },
      });
    }

    items.push(...(await this.scriptLibraries(nodes, targetGroupId)));
    items.push(...(await this.credentials(nodes, targetGroupId, groupName)));
    items.push(...(await this.approvers(nodes, targetGroupId, groupName)));
    items.push(...this.plugins(nodes));
    items.push(...(await this.commands(nodes)));
    items.push(...(await this.workflowCalls(nodes, targetGroupId)));

    const count = (status: CompatibilityStatus) => items.filter((item) => item.status === status).length;
    return {
      workflow_id: workflowId,
      target_group_id: targetGroupId,
      target_group_name: groupName,
      items,
      summary: {
        ok: count('ok'),
        action_required: count('action_required'),
        blocked: count('blocked'),
        warning: count('warning'),
        ready: count('action_required') === 0 && count('blocked') === 0,
      },
    };
  }

  private async scriptLibraries(nodes: NodeLike[], groupId: string | null): Promise<CompatibilityItem[]> {
    const usages = await this.scriptLibrariesService.evaluateForGroup(nodes as any[], groupId);
    return usages.map((usage) => {
      const label = `${usage.package_name}@${usage.version}`;
      const base = { kind: 'script_library' as const, ref: label, label, node_ids: usage.node_ids };
      if (usage.status === 'ok') return { ...base, status: 'ok', message: '사용 가능' };
      if (usage.status === 'not_allowed_for_group') {
        return {
          ...base,
          status: 'action_required',
          message: '대상 그룹에서 사용이 승인되지 않았습니다.',
          remediation: { actor: 'admin', action: '최고관리자에게 플랫폼 설정 → JS 라이브러리에서 이 그룹의 사용 승인을 요청하세요.', group_id: groupId },
        };
      }
      return {
        ...base,
        status: 'action_required',
        message: '승인된 JS 라이브러리 버전이 아닙니다.',
        remediation: { actor: 'admin', action: '최고관리자에게 이 버전의 준비와 승인을 요청하세요.' },
      };
    });
  }

  private async credentials(nodes: NodeLike[], groupId: string | null, groupName: string | null): Promise<CompatibilityItem[]> {
    const nodeIdsByCredential = new Map<string, string[]>();
    for (const node of nodes || []) {
      for (const credentialId of collectCredentialIds(nodeData(node))) {
        const ids = nodeIdsByCredential.get(credentialId) || [];
        if (node.id && !ids.includes(node.id)) ids.push(node.id);
        nodeIdsByCredential.set(credentialId, ids);
      }
    }
    const items: CompatibilityItem[] = [];
    for (const [credentialId, nodeIds] of nodeIdsByCredential) {
      const availability = await this.credentialsService.availabilityForGroup(credentialId, groupId);
      const label = availability.name || credentialId;
      const base = { kind: 'credential' as const, ref: credentialId, label, node_ids: nodeIds };
      if (availability.status === 'ok') {
        items.push({ ...base, status: 'ok', message: '사용 가능' });
      } else if (availability.status === 'not_shared') {
        items.push({
          ...base,
          status: 'action_required',
          message: `${groupName || '대상 그룹'}에 공유되지 않았습니다.`,
          remediation: {
            actor: 'group_manager',
            action: `자격증명을 소유한 그룹의 관리자에게 '${label}'을(를) ${groupName || '대상 그룹'}에 공유해 달라고 요청하세요.`,
            group_id: availability.owner_group_id,
          },
        });
      } else if (availability.status === 'inactive') {
        items.push({
          ...base,
          status: 'blocked',
          message: '비활성화된 자격증명입니다.',
          remediation: { actor: 'group_manager', action: '소유 그룹 관리자에게 다시 활성화를 요청하거나 다른 자격증명으로 바꾸세요.', group_id: availability.owner_group_id },
        });
      } else {
        items.push({
          ...base,
          status: 'blocked',
          message: '자격증명을 찾을 수 없습니다.',
          remediation: { actor: 'self', action: '노드 설정에서 대상 그룹이 쓸 수 있는 자격증명을 다시 고르세요.' },
        });
      }
    }
    return items;
  }

  private async approvers(nodes: NodeLike[], groupId: string | null, groupName: string | null): Promise<CompatibilityItem[]> {
    const items: CompatibilityItem[] = [];
    for (const node of nodes || []) {
      const data = nodeData(node);
      if (nodeType(node) !== 'approval') continue;
      if (data.approvalLineSource === 'dynamic' || data.approvalType === 'dynamic') continue;
      const channels: string[] = Array.isArray(data.approvalChannels)
        ? data.approvalChannels
        : data.approverChannel ? [data.approverChannel] : [];
      if (!channels.includes('pxm_user')) continue;
      const assignee = typeof data.assignee === 'string' ? data.assignee.trim() : '';
      if (!assignee) continue;
      const user = await this.authzService.getUser(assignee).catch(() => null);
      const label = user?.display_name ? `${user.display_name} (${assignee})` : assignee;
      const base = { kind: 'approver' as const, ref: assignee, label, node_ids: node.id ? [node.id] : [] };
      if (user && user.status === 'active' && groupId && user.group_ids.includes(groupId)) {
        items.push({ ...base, status: 'ok', message: '대상 그룹의 구성원' });
      } else {
        items.push({
          ...base,
          status: 'blocked',
          message: user ? `${groupName || '대상 그룹'}의 활성 구성원이 아닙니다.` : '사용자를 찾을 수 없습니다.',
          remediation: { actor: 'self', action: '결재 노드에서 대상 그룹의 구성원으로 승인자를 바꾸세요.' },
        });
      }
    }
    return items;
  }

  private plugins(nodes: NodeLike[]): CompatibilityItem[] {
    const nodeIdsByPlugin = new Map<string, string[]>();
    for (const node of nodes || []) {
      const pluginId = nodeData(node).plugin_id;
      if (nodeType(node) !== 'service' || typeof pluginId !== 'string' || !pluginId.trim()) continue;
      const ids = nodeIdsByPlugin.get(pluginId) || [];
      if (node.id) ids.push(node.id);
      nodeIdsByPlugin.set(pluginId, ids);
    }
    return [...nodeIdsByPlugin.entries()].map(([pluginId, nodeIds]) => {
      const manifest = this.pluginsService.findOne(pluginId);
      const base = { kind: 'plugin' as const, ref: pluginId, label: manifest?.display_name || pluginId, node_ids: nodeIds };
      return manifest
        ? { ...base, status: 'ok' as const, message: '사용 가능' }
        : {
            ...base,
            status: 'blocked' as const,
            message: '사용할 수 없는 플러그인입니다(미등록 또는 사용 중지).',
            remediation: { actor: 'admin' as const, action: '최고관리자에게 플랫폼 설정 → 플러그인 제어에서 사용 허용을 요청하세요.' },
          };
    });
  }

  private async commands(nodes: NodeLike[]): Promise<CompatibilityItem[]> {
    const items: CompatibilityItem[] = [];
    for (const node of nodes || []) {
      const commandId = nodeData(node).commandId;
      if (nodeType(node) !== 'command' || typeof commandId !== 'string' || !commandId.trim()) continue;
      const command = await this.commandsService.get(commandId).catch(() => null);
      const base = { kind: 'command' as const, ref: commandId, label: command?.display_name || commandId, node_ids: node.id ? [node.id] : [] };
      if (!command || command.enabled === false) {
        items.push({
          ...base,
          status: 'blocked',
          message: command ? '사용 중지된 명령입니다.' : '등록되지 않은 명령입니다.',
          remediation: { actor: 'admin', action: '최고관리자에게 플랫폼 설정 → 명령어 관리에서 등록 또는 사용을 요청하세요.' },
        });
      } else {
        // Command는 아직 그룹별 실행 허가가 없다. 첫 운영 설치 전에 막아야 할 보안 항목이라 경고로 알린다.
        items.push({ ...base, status: 'warning', message: '그룹 제한 없이 모든 그룹의 워크플로우가 실행할 수 있는 명령입니다.' });
      }
    }
    return items;
  }

  private async workflowCalls(nodes: NodeLike[], groupId: string | null): Promise<CompatibilityItem[]> {
    const items: CompatibilityItem[] = [];
    for (const targetId of new Set(extractWorkflowCallTargets(nodes as any[]))) {
      const target = await this.workflowRepo.getDefinition(targetId).catch(() => null);
      const nodeIds = (nodes || [])
        .filter((node) => nodeType(node) === 'workflow_call' && [nodeData(node).targetWorkflowId, nodeData(node).targetDefinitionId].includes(targetId))
        .map((node) => node.id)
        .filter((id): id is string => Boolean(id));
      const base = { kind: 'workflow_call' as const, ref: targetId, label: target?.name || targetId, node_ids: nodeIds };
      if (!target) {
        items.push({
          ...base,
          status: 'blocked',
          message: '호출할 워크플로우를 찾을 수 없습니다.',
          remediation: { actor: 'self', action: 'Workflow Call 노드의 대상 워크플로우를 다시 고르세요.' },
        });
        continue;
      }
      const targetGroup = target.group_id || target.metadata?.group_id || null;
      items.push(targetGroup && targetGroup === groupId
        ? { ...base, status: 'ok', message: '같은 그룹의 워크플로우' }
        : { ...base, status: 'warning', message: '다른 그룹 소속 워크플로우를 호출합니다. 호출 대상 그룹의 자원과 결재선이 쓰입니다.' });
    }
    return items;
  }
}

function nodeData(node: NodeLike): Record<string, any> {
  return node?.data || node?.config || (node as Record<string, any>) || {};
}

function nodeType(node: NodeLike): string {
  return String(nodeData(node).nodeType || node?.node_type || node?.type || '');
}
