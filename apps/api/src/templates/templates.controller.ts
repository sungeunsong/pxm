import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Headers, HttpStatus, NotFoundException, Param, ParseIntPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { TemplatesService } from './templates.service';
import { CreateTemplateDto, UpdateTemplateDto } from './dto/template.dto';
import { WorkflowInputPresetRepositoryPort, type WorkflowInputPreset, WorkflowInstanceRepositoryPort, WorkflowScheduleRepositoryPort } from '../db/ports/db.ports';
import { InstancesService } from '../instances/instances.service';
import { actorFromRequest, instanceAccessFromRequest } from '../instances/history-auth';
import { createHash, randomUUID } from 'crypto';
import { assertCanManageGroup, isAdmin } from '../authz/management-auth';
import { ManagementAuditService } from '../audit/management-audit.service';
import { AuthzService } from '../authz/authz.service';

@Controller('templates')
export class TemplatesController {
  constructor(
    private readonly templatesService: TemplatesService,
    private readonly instanceRepo: WorkflowInstanceRepositoryPort,
    private readonly instancesService: InstancesService,
    private readonly scheduleRepo: WorkflowScheduleRepositoryPort,
    private readonly inputPresetRepo: WorkflowInputPresetRepositoryPort,
    private readonly audit: ManagementAuditService,
    private readonly authzService: AuthzService,
  ) {}

  @Post()
  async create(@Body() dto: CreateTemplateDto, @Req() req: Request) {
    const actor = actorFromRequest(req);
    assertCanManageGroup(actor, dto.group_id);
    const template = await this.templatesService.create({
      ...dto,
      created_by: actor.actor_id || 'system',
      updated_by: actor.actor_id || 'system',
    });
    await this.audit.append({
      action: 'workflow.created',
      resource_type: 'workflow',
      resource_id: template.id,
      group_id: template.group_id,
      actor_id: actor.actor_id,
    });
    return template;
  }

  @Get()
  async findAll(@Query('activeOnly') activeOnly: string | undefined, @Req() req: Request) {
    const active = activeOnly !== 'false';
    const actor = actorFromRequest(req);
    const canManage = isAdmin(actor) || actor.roles.includes('group_manager');
    const templates = canManage ? await this.templatesService.findAll(active) : await this.templatesService.findPublishedAll();
    return templates.filter((template) => canReadTemplate(actor, template));
  }

  @Get('input-presets')
  async listAllInputPresets(@Req() req: Request) {
    const actor = actorFromRequest(req);
    const canManage = isAdmin(actor) || actor.roles.includes('group_manager');
    const templates = (canManage ? await this.templatesService.findAll(true) : await this.templatesService.findPublishedAll()).filter((template) => canReadTemplate(actor, template));
    const templateById = new Map(templates.map((template) => [template.id, template]));
    const presets = await this.inputPresetRepo.listAllInputPresets();

    return presets.flatMap((preset) => {
      const template = templateById.get(preset.workflow_id);
      if (!template || !canUseInputPreset(actor, preset)) return [];
      return [
        {
          ...preset,
          scope: normalizeInputPresetScope(preset.scope),
          owner_group_id: template.group_id || null,
          workflow_name: template.name,
          workflow_version: template.version || 1,
          workflow_group_name: template.group || null,
          can_manage: canManageInputPreset(actor, preset),
        },
      ];
    });
  }

  @Post('import')
  async import(@Body() body: any, @Req() req: Request) {
    const actor = actorFromRequest(req);
    assertCanManageGroup(actor, body?.workflow?.metadata?.group_id || null);
    try {
      const template = await this.templatesService.import(body, actor.actor_id || 'system');
      await this.audit.append({
        action: 'workflow.imported',
        resource_type: 'workflow',
        resource_id: template.id,
        group_id: template.group_id,
        actor_id: actor.actor_id,
      });
      return template;
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid workflow import document');
    }
  }

  @Get(':id/export')
  async export(@Param('id') id: string, @Req() req: Request) {
    await this.assertReadableTemplate(id, req);
    const actor = actorFromRequest(req);
    const canManage = isAdmin(actor) || actor.roles.includes('group_manager');
    const document = await this.templatesService.export(id, !canManage);
    if (!document) {
      throw new NotFoundException('Template not found');
    }
    return document;
  }

  @Get(':id/versions')
  async versions(@Param('id') id: string, @Req() req: Request) {
    await this.assertManageableTemplate(id, req);
    const versions = await this.templatesService.listVersions(id);
    if (!versions) {
      throw new NotFoundException('Template not found');
    }
    return versions;
  }

  @Get(':id/versions/diff')
  async versionDiff(@Param('id') id: string, @Query('from', ParseIntPipe) from: number, @Query('to') to?: string, @Req() req?: Request) {
    await this.assertManageableTemplate(id, req);
    const toVersion = to ? Number.parseInt(to, 10) : undefined;
    if (to && !Number.isFinite(toVersion)) {
      throw new BadRequestException('to must be a number');
    }

    const diff = await this.templatesService.diffVersions(id, from, toVersion);
    if (!diff) {
      throw new NotFoundException('Template version not found');
    }
    return diff;
  }

  @Get(':id/versions/:version')
  async version(@Param('id') id: string, @Param('version', ParseIntPipe) version: number, @Req() req: Request) {
    await this.assertManageableTemplate(id, req);
    const template = await this.templatesService.getVersion(id, version);
    if (!template) {
      throw new NotFoundException('Template version not found');
    }
    return template;
  }

  @Post(':id/versions/:version/rollback')
  async rollbackVersion(@Param('id') id: string, @Param('version', ParseIntPipe) version: number, @Req() req: Request) {
    await this.assertManageableTemplate(id, req);
    const actor = actorFromRequest(req);
    const template = await this.templatesService.rollback(id, version, actor.actor_id || 'system');
    if (!template) {
      throw new NotFoundException('Template version not found');
    }
    await this.audit.append({
      action: 'workflow.rolled_back',
      resource_type: 'workflow',
      resource_id: id,
      group_id: template.group_id,
      actor_id: actor.actor_id,
      details: { restored_version: version, new_version: template.version },
    });
    return template;
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Req() req: Request) {
    return this.assertReadableTemplate(id, req);
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateTemplateDto, @Req() req: Request) {
    const current = await this.templatesService.findOne(id);
    if (!current) {
      throw new Error('Template not found');
    }
    const actor = actorFromRequest(req);
    assertCanManageGroup(actor, current.group_id);
    assertCanManageGroup(actor, dto.group_id !== undefined ? dto.group_id : current.group_id);
    const template = await this.templatesService.update(id, {
      ...dto,
      updated_by: actor.actor_id || 'system',
    });
    if (!template) {
      throw new Error('Template not found');
    }
    await this.audit.append({
      action: current.group_id !== template.group_id ? 'workflow.group_changed' : 'workflow.updated',
      resource_type: 'workflow',
      resource_id: id,
      group_id: template.group_id,
      actor_id: actor.actor_id,
      details: {
        previous_group_id: current.group_id || null,
        group_id: template.group_id || null,
      },
    });
    return template;
  }

  @Post(':id/deploy')
  async deploy(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      description?: string;
      group?: string;
      group_id?: string | null;
      tags?: string[];
      version_note?: string;
      nodes?: any[];
      edges?: any[];
    },
    @Req() req: Request,
  ) {
    const current = await this.templatesService.findOne(id);
    if (!current) {
      throw new Error('Template not found');
    }
    const actor = actorFromRequest(req);
    assertCanManageGroup(actor, current.group_id);
    assertCanManageGroup(actor, body.group_id !== undefined ? body.group_id : current.group_id);
    const shouldSave = body.nodes !== undefined || body.edges !== undefined;
    if (shouldSave) {
      await this.templatesService.update(id, {
        name: body.name,
        description: body.description,
        group: body.group,
        group_id: body.group_id,
        tags: body.tags,
        version_note: body.version_note,
        nodes: body.nodes,
        edges: body.edges,
        updated_by: actor.actor_id || 'system',
      });
    }
    const template = await this.templatesService.publish(id, actor.actor_id || 'system');
    if (!template) {
      throw new Error('Template not found');
    }
    console.log(`[BFF] Template ${id} published at v${template.version}.`);
    await this.audit.append({
      action: 'workflow.deployed',
      resource_type: 'workflow',
      resource_id: id,
      group_id: template.group_id,
      actor_id: actor.actor_id,
      details: { active_published_version: template.active_published_version },
    });
    return { success: true, template };
  }

  @Post(':id/disable')
  async disable(@Param('id') id: string, @Req() req: Request) {
    const current = await this.assertReadableTemplate(id, req);
    const actor = actorFromRequest(req);
    assertCanManageGroup(actor, current.group_id);
    const template = await this.templatesService.disable(id, actor.actor_id || 'system');
    if (!template) throw new NotFoundException('Template not found');
    await this.audit.append({
      action: 'workflow.disabled',
      resource_type: 'workflow',
      resource_id: id,
      group_id: template.group_id,
      actor_id: actor.actor_id,
    });
    return { success: true, template };
  }

  @Post(':id/reactivate')
  async reactivate(@Param('id') id: string, @Req() req: Request) {
    const current = await this.assertReadableTemplate(id, req);
    const actor = actorFromRequest(req);
    assertCanManageGroup(actor, current.group_id);
    const template = await this.templatesService.reactivate(id, actor.actor_id || 'system');
    if (!template) throw new BadRequestException('Workflow has no published version');
    await this.audit.append({
      action: 'workflow.reactivated',
      resource_type: 'workflow',
      resource_id: id,
      group_id: template.group_id,
      actor_id: actor.actor_id,
      details: { active_published_version: template.active_published_version },
    });
    return { success: true, template };
  }

  @Post(':id/schedule/toggle')
  async toggleSchedule(@Param('id') id: string, @Body() body: { enabled?: boolean }, @Req() req: Request) {
    const template = await this.templatesService.findOne(id);
    if (!template) {
      throw new NotFoundException('Template not found');
    }
    assertCanManageGroup(actorFromRequest(req), template.group_id);

    const nodes = (template.nodes || []).map((node: any) => {
      if (node.data?.nodeType !== 'start' || node.data?.triggerType !== 'schedule') {
        return node;
      }
      return {
        ...node,
        data: {
          ...node.data,
          scheduleEnabled: body?.enabled === true,
        },
      };
    });

    const updated = await this.templatesService.update(id, {
      name: template.name,
      description: template.description,
      group: template.group,
      group_id: template.group_id,
      tags: template.tags,
      version_note: template.version_note,
      nodes,
      edges: template.edges,
      updated_by: actorFromRequest(req).actor_id || 'system',
    });

    if (!updated) {
      throw new NotFoundException('Template not found');
    }

    return {
      success: true,
      enabled: body?.enabled === true,
      template: updated,
    };
  }

  @Post(':id/db-watch/toggle')
  async toggleDbWatch(@Param('id') id: string, @Body() body: { enabled?: boolean }, @Req() req: Request) {
    const template = await this.templatesService.findOne(id);
    if (!template) {
      throw new NotFoundException('Template not found');
    }
    assertCanManageGroup(actorFromRequest(req), template.group_id);

    const nodes = (template.nodes || []).map((node: any) => {
      if (node.data?.nodeType !== 'start' || node.data?.triggerType !== 'db_watch') {
        return node;
      }
      return {
        ...node,
        data: {
          ...node.data,
          dbWatchEnabled: body?.enabled === true,
        },
      };
    });

    const updated = await this.templatesService.update(id, {
      name: template.name,
      description: template.description,
      group: template.group,
      group_id: template.group_id,
      tags: template.tags,
      version_note: template.version_note,
      nodes,
      edges: template.edges,
      updated_by: actorFromRequest(req).actor_id || 'system',
    });

    if (!updated) {
      throw new NotFoundException('Template not found');
    }

    return {
      success: true,
      enabled: body?.enabled === true,
      template: updated,
    };
  }

  @Get(':id/schedule/status')
  async scheduleStatus(@Param('id') id: string, @Req() req: Request) {
    await this.assertReadableTemplate(id, req);

    return this.scheduleRepo.getDefinitionScheduleStatus(id, 10);
  }

  @Get(':id/input-presets')
  async listInputPresets(@Param('id') id: string, @Req() req: Request) {
    await this.assertReadableTemplate(id, req);
    const template = await this.templatesService.findOne(id);
    const actor = actorFromRequest(req);
    const presets = await this.inputPresetRepo.listInputPresets(id);
    return presets
      .filter((preset) => canUseInputPreset(actor, preset))
      .map((preset) => ({
        ...preset,
        scope: normalizeInputPresetScope(preset.scope),
        owner_group_id: template?.group_id || null,
        can_manage: canManageInputPreset(actor, preset),
      }));
  }

  @Get(':id/input-presets/:presetId')
  async getInputPreset(@Param('id') id: string, @Param('presetId') presetId: string, @Req() req: Request) {
    await this.assertReadableTemplate(id, req);
    const template = await this.templatesService.findOne(id);
    const preset = await this.inputPresetRepo.getInputPreset(id, presetId);
    if (!preset || !canUseInputPreset(actorFromRequest(req), preset)) {
      throw new NotFoundException('Input preset not found');
    }
    return {
      ...preset,
      scope: normalizeInputPresetScope(preset.scope),
      owner_group_id: template?.group_id || null,
      can_manage: canManageInputPreset(actorFromRequest(req), preset),
    };
  }

  @Post(':id/input-presets')
  async saveInputPreset(@Param('id') id: string, @Body() body: InputPresetRequest, @Req() req?: Request) {
    const template = await this.templatesService.findOne(id);
    if (!template) {
      throw new NotFoundException('Template not found');
    }
    if (!body?.name?.trim()) {
      throw new BadRequestException('name is required');
    }
    const presetValidationErrors = validateInputPresetValues(template.nodes || [], body.values);
    if (presetValidationErrors.length > 0) {
      throw new BadRequestException(presetValidationErrors);
    }
    const actor = actorFromRequest(req);
    if (!actor.actor_id || actor.api_key_id) {
      throw new ForbiddenException('Login user is required to save an input preset');
    }
    const requestedAlias = normalizePresetAlias(body.alias || body.name);
    const existing = body.id ? await this.inputPresetRepo.getInputPreset(id, body.id) : null;
    if (body.id && !existing) throw new NotFoundException('Input preset not found');
    if (!body.id && (await this.inputPresetRepo.getInputPreset(id, requestedAlias))) {
      throw new BadRequestException('같은 alias의 파라미터 세트가 이미 있습니다. 관리 화면에서 수정하세요.');
    }
    if (existing && !canManageInputPreset(actor, existing)) {
      throw new ForbiddenException('Input preset management permission is required');
    }
    const scope = normalizeInputPresetScope(body.scope || existing?.scope || 'private');
    if (scope === 'shared') {
      throw new BadRequestException('지정 그룹 공유는 workflow 실행 권한 공유 모델이 도입되기 전까지 지원하지 않습니다.');
    }
    if (scope !== 'private') {
      assertCanManageGroup(actor, template.group_id);
    }

    const saved = await this.inputPresetRepo.upsertInputPreset(id, {
      id: body.id,
      alias: existing?.alias || requestedAlias,
      name: body.name,
      description: body.description,
      values: sanitizePresetValues(body.values || {}),
      scope,
      group_id: scope === 'private' ? null : template.group_id || null,
      shared_group_ids: [],
      actor: actor.actor_id,
    });
    return {
      ...saved,
      owner_group_id: template.group_id || null,
      can_manage: canManageInputPreset(actor, saved),
    };
  }

  @Delete(':id/input-presets/:presetId')
  async deleteInputPreset(@Param('id') id: string, @Param('presetId') presetId: string, @Req() req: Request) {
    await this.assertReadableTemplate(id, req);
    const preset = await this.inputPresetRepo.getInputPreset(id, presetId);
    if (!preset) throw new NotFoundException('Input preset not found');
    if (!canManageInputPreset(actorFromRequest(req), preset)) {
      throw new ForbiddenException('Input preset management permission is required');
    }
    const success = await this.inputPresetRepo.deleteInputPreset(id, presetId);
    if (!success) {
      throw new NotFoundException('Input preset not found');
    }
    return { success: true };
  }

  @Delete(':id')
  async delete(@Param('id') id: string, @Req() req: Request) {
    const template = await this.templatesService.findOne(id);
    if (!template) {
      throw new Error('Template not found');
    }
    assertCanManageGroup(actorFromRequest(req), template.group_id);
    const success = await this.templatesService.delete(id);
    if (!success) {
      throw new Error('Template not found');
    }
    const actor = actorFromRequest(req);
    await this.audit.append({
      action: 'workflow.deleted',
      resource_type: 'workflow',
      resource_id: id,
      group_id: template.group_id,
      actor_id: actor.actor_id,
    });
    return { message: 'Template deleted successfully' };
  }

  @Post(':id/execute')
  async execute(@Param('id') id: string, @Body() body?: StartWorkflowRequest, @Headers('idempotency-key') idempotencyKey?: string, @Req() req?: Request, @Res({ passthrough: true }) res?: Response) {
    const actor = actorFromRequest(req);
    const allowDraft = !actor.api_key_id && actor.actor_type === 'user';
    return this.startWorkflow(id, body, idempotencyKey, req, res, allowDraft);
  }

  @Post(':id/start')
  async start(@Param('id') id: string, @Body() body?: StartWorkflowRequest, @Headers('idempotency-key') idempotencyKey?: string, @Req() req?: Request, @Res({ passthrough: true }) res?: Response) {
    return this.startWorkflow(id, body, idempotencyKey, req, res, false);
  }

  private async startWorkflow(id: string, body?: StartWorkflowRequest, idempotencyKey?: string, req?: Request, res?: Response, allowDraft = false) {
    // 템플릿 조회
    const template = allowDraft ? await this.templatesService.findOne(id) : await this.templatesService.findPublished(id);
    if (!template) {
      throw new BadRequestException('Workflow is not published or is disabled');
    }
    const actor = actorFromRequest(req);
    if (!canReadTemplate(actor, template)) throw new NotFoundException('Template not found');
    if (allowDraft) assertCanManageGroup(actor, template.group_id);
    assertCanExecuteWorkflow(actor, id);
    const normalizedIdempotencyKey = normalizeIdempotencyKey(idempotencyKey);

    // 실행 요청마다 새로운 인스턴스를 발급한다
    const instanceId = randomUUID();
    const mode = body?.mode === 'sync' ? 'sync' : 'async';

    // 시작 노드 찾기
    const startNode = template.nodes.find((n: any) => n.data?.nodeType === 'start');
    if (!startNode) {
      throw new Error('Start node not found in template');
    }

    const requestedPreset = body?.preset_id || body?.preset_alias || body?.preset;
    const inputOverrides = body?.input || body?.formData || {};
    const inputPreset = requestedPreset ? await this.inputPresetRepo.getInputPreset(template.id, requestedPreset) : null;
    if (requestedPreset && !inputPreset) {
      throw new NotFoundException('Input preset not found');
    }
    if (inputPreset && !canUseInputPreset(actor, inputPreset)) {
      throw new NotFoundException('Input preset not found');
    }

    // ctx 구조: Rust Engine이 기대하는 실행 컨텍스트
    const formData = {
      ...(inputPreset?.values || {}),
      ...inputOverrides,
    };
    const requestAccess = instanceAccessFromRequest(req, formData);
    const access = {
      ...requestAccess,
      group_id: template.group_id || requestAccess.group_id,
      workflow_version_id: template.version ? `${template.id}:${template.version}` : null,
    };
    const groupSnapshot = template.group_id ? await this.authzService.getGroup(template.group_id).catch(() => null) : null;
    const apiKeySnapshot = actor.api_key_id ? await this.authzService.getApiKey(actor.api_key_id).catch(() => null) : null;
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
                name: groupSnapshot?.name || template.group || template.group_id,
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
        },
        access,
        input_preset: inputPreset
          ? {
              id: inputPreset.id,
              alias: inputPreset.alias,
              name: inputPreset.name,
              override_keys: Object.keys(inputOverrides),
            }
          : null,
      },
      data: {
        formData,
        outputs: {},
      },
    };

    const startTokenId = randomUUID();
    let resolvedInstanceId: string = instanceId;
    let idempotentReplay = false;
    if (normalizedIdempotencyKey) {
      const principal = actor.api_key_id ? `api_key:${actor.api_key_id}` : `${actor.actor_type}:${actor.actor_id || 'anonymous'}`;
      const keyHash = sha256(`workflow-start:v1:${principal}:${template.id}:${normalizedIdempotencyKey}`);
      const requestHash = sha256(
        stableStringify({
          workflow_id: template.id,
          preset_id: inputPreset?.id || null,
          input: formData,
        }),
      );
      const result = await this.instanceRepo.createIdempotentStart({
        key_hash: keyHash,
        request_hash: requestHash,
        expires_at: new Date(Date.now() + startIdempotencyTtlMs()),
        instance: {
          id: instanceId,
          definition_id: template.id,
          status: 'CREATED',
          context: ctx,
          access,
        },
        token: {
          id: startTokenId,
          node_id: startNode.id,
          status: 'ACTIVE',
        },
        job: {
          type: 'START',
          run_at: new Date(),
          payload: {
            node_id: startNode.id,
            reason: 'template_execute',
          },
        },
      });
      if (result.outcome === 'conflict') {
        throw new ConflictException('Idempotency-Key was already used with different workflow input');
      }
      resolvedInstanceId = result.instance_id;
      idempotentReplay = result.outcome === 'replayed';
      if (idempotentReplay) res?.setHeader('Idempotency-Replayed', 'true');
    } else {
      await this.instanceRepo.executeInstanceMutation({
        create_instances: [{ id: instanceId, definition_id: template.id, status: 'CREATED', context: ctx, access }],
        tokens: [{ id: startTokenId, instance_id: instanceId, node_id: startNode.id, status: 'ACTIVE' }],
        jobs: [{
          instance_id: instanceId,
          type: 'START',
          run_at: new Date(),
          payload: { node_id: startNode.id, reason: 'template_execute' },
        }],
      });
    }

    if (!idempotentReplay) console.log(`[BFF] Executed template ${template.name}. instance_id=${resolvedInstanceId}`);

    const acceptedResponse = {
      instance_id: resolvedInstanceId,
      template_id: template.id,
      template_name: template.name,
      status: 'CREATED',
      mode,
      idempotent_replay: idempotentReplay,
      result_url: `/api/instances/${resolvedInstanceId}/result`,
      trace_url: `/api/instances/${resolvedInstanceId}/trace`,
      stream_url: `/api/instances/${resolvedInstanceId}/stream`,
    };

    if (mode === 'async') {
      res?.status(HttpStatus.ACCEPTED);
      return acceptedResponse;
    }

    const waitResult = await this.waitForInstanceResult(resolvedInstanceId, body?.sync_timeout_ms);

    if (waitResult.timedOut) {
      res?.status(HttpStatus.ACCEPTED);
      return {
        ...acceptedResponse,
        status: waitResult.status || 'RUNNING',
        timed_out: true,
      };
    }

    res?.status(HttpStatus.OK);
    return {
      ...acceptedResponse,
      status: waitResult.status,
      result: waitResult.result,
      result_path: waitResult.result_path,
      completed_at: waitResult.completed_at,
      timed_out: false,
    };
  }

  private async waitForInstanceResult(
    instanceId: string,
    requestedTimeoutMs?: number,
  ): Promise<{
    timedOut: boolean;
    status?: string;
    result?: any;
    result_path?: string | null;
    completed_at?: string | null;
  }> {
    const timeoutMs = normalizeSyncTimeoutMs(requestedTimeoutMs);
    const pollMs = Number(process.env.START_SYNC_POLL_MS ?? 250);
    const deadline = Date.now() + timeoutMs;
    let latest: any = null;

    while (Date.now() <= deadline) {
      latest = await this.instancesService.getResult(instanceId);
      if (latest?.status === 'COMPLETED' || latest?.status === 'FAILED') {
        return { timedOut: false, ...latest };
      }
      await sleep(Math.max(50, pollMs));
    }

    latest = await this.instancesService.getResult(instanceId);
    return {
      timedOut: true,
      status: latest?.status,
      result_path: latest?.result_path,
      completed_at: latest?.completed_at,
    };
  }

  private async assertReadableTemplate(id: string, req?: Request) {
    const actor = actorFromRequest(req);
    const canManage = isAdmin(actor) || actor.roles.includes('group_manager');
    const template = canManage ? await this.templatesService.findOne(id) : await this.templatesService.findPublished(id);
    if (!template || !canReadTemplate(actor, template)) {
      throw new NotFoundException('Template not found');
    }
    return template;
  }

  private async assertManageableTemplate(id: string, req?: Request) {
    const template = await this.templatesService.findOne(id);
    if (!template) throw new NotFoundException('Template not found');
    const actor = actorFromRequest(req);
    if (!canReadTemplate(actor, template)) {
      throw new NotFoundException('Template not found');
    }
    assertCanManageGroup(actor, template.group_id);
    return template;
  }
}

type StartWorkflowRequest = {
  mode?: 'async' | 'sync';
  sync_timeout_ms?: number;
  input?: Record<string, any>;
  formData?: Record<string, any>;
  preset?: string;
  preset_id?: string;
  preset_alias?: string;
};

type InputPresetRequest = {
  id?: string;
  alias?: string;
  name?: string;
  description?: string;
  values?: Record<string, any>;
  scope?: 'private' | 'group' | 'shared' | 'public';
  group_id?: string | null;
  shared_group_ids?: string[];
};

function normalizeSyncTimeoutMs(value?: number): number {
  const defaultTimeout = Number(process.env.START_SYNC_TIMEOUT_MS ?? 10000);
  const maxTimeout = Number(process.env.START_SYNC_MAX_TIMEOUT_MS ?? 30000);
  const timeout = Number.isFinite(value) && value ? Number(value) : defaultTimeout;
  return Math.min(Math.max(timeout, 100), maxTimeout);
}

function normalizeIdempotencyKey(value?: string): string | null {
  if (value === undefined) return null;
  const key = value.trim();
  if (!key || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new BadRequestException('Idempotency-Key must contain 1 to 200 printable characters');
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

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizePresetValues(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return sanitizeJsonObject(value);
}

export function validateInputPresetValues(nodes: any[], value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['입력값은 JSON object여야 합니다.'];
  }

  const errors: string[] = [];
  const sensitivePaths = findSensitivePresetPaths(value as Record<string, any>);
  if (sensitivePaths.length > 0) {
    errors.push(`민감정보 키는 프리셋에 저장할 수 없습니다: ${sensitivePaths.join(', ')}`);
  }

  const startNode = nodes.find((node) => node?.data?.nodeType === 'start');
  const fields: any[] = Array.isArray(startNode?.data?.formSchema?.fields) ? startNode.data.formSchema.fields.filter((field: any) => field?.id || field?.name) : [];
  if (fields.length === 0) return errors;

  const values = value as Record<string, any>;
  const fieldById = new Map<string, any>(fields.map((field: any) => [String(field.id || field.name), field]));
  for (const key of Object.keys(values)) {
    if (!fieldById.has(key)) errors.push(`Start 입력 스키마에 없는 키입니다: ${key}`);
  }

  for (const [id, field] of fieldById) {
    const item = values[id];
    if (field.required === true && (item === undefined || item === null || item === '')) {
      errors.push(`필수 입력값이 비어 있습니다: ${id}`);
      continue;
    }
    if (item === undefined || item === null || item === '') continue;

    const type = String(field.type || 'text');
    if (type === 'number' && (typeof item !== 'number' || !Number.isFinite(item))) {
      errors.push(`${id} 값은 number여야 합니다.`);
    } else if (type === 'checkbox' && typeof item !== 'boolean') {
      errors.push(`${id} 값은 boolean이어야 합니다.`);
    } else if (['text', 'textarea', 'select', 'radio', 'date'].includes(type) && typeof item !== 'string') {
      errors.push(`${id} 값은 string이어야 합니다.`);
    } else if (type === 'file') {
      errors.push(`${id} 파일 입력은 프리셋에 저장할 수 없습니다.`);
    }

    if (typeof item === 'number') {
      if (Number.isFinite(field.min) && item < Number(field.min)) errors.push(`${id} 값은 ${field.min} 이상이어야 합니다.`);
      if (Number.isFinite(field.max) && item > Number(field.max)) errors.push(`${id} 값은 ${field.max} 이하여야 합니다.`);
    }
    if (typeof item === 'string') {
      if (Number.isFinite(field.minLength) && item.length < Number(field.minLength)) errors.push(`${id} 값은 ${field.minLength}자 이상이어야 합니다.`);
      if (Number.isFinite(field.maxLength) && item.length > Number(field.maxLength)) errors.push(`${id} 값은 ${field.maxLength}자 이하여야 합니다.`);
      if (Array.isArray(field.options) && ['select', 'radio'].includes(type) && !field.options.includes(item)) errors.push(`${id} 값이 허용된 옵션이 아닙니다.`);
      if (field.pattern) {
        try {
          if (!new RegExp(field.pattern).test(item)) errors.push(`${id} 값의 형식이 올바르지 않습니다.`);
        } catch {
          errors.push(`${id} 필드의 pattern 설정이 올바르지 않습니다.`);
        }
      }
    }
  }
  return errors;
}

function findSensitivePresetPaths(value: Record<string, any>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, item]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isSensitivePresetKey(key)) return [path];
    if (item && typeof item === 'object' && !Array.isArray(item)) return findSensitivePresetPaths(item, path);
    if (Array.isArray(item)) {
      return item.flatMap((entry, index) => (entry && typeof entry === 'object' && !Array.isArray(entry) ? findSensitivePresetPaths(entry, `${path}[${index}]`) : []));
    }
    return [];
  });
}

function sanitizeJsonObject(value: Record<string, any>): Record<string, any> {
  return Object.entries(value).reduce<Record<string, any>>((acc, [key, item]) => {
    if (isSensitivePresetKey(key)) {
      return acc;
    }
    const sanitized = sanitizeJsonValue(item);
    if (sanitized !== undefined) {
      acc[key] = sanitized;
    }
    return acc;
  }, {});
}

function sanitizeJsonValue(value: any): any {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item)).filter((item) => item !== undefined);
  }
  if (value && typeof value === 'object') {
    return sanitizeJsonObject(value);
  }
  return undefined;
}

function isSensitivePresetKey(key: string) {
  return /(password|passwd|secret|token|api[_-]?key|credential|private[_-]?key|passphrase)/i.test(key);
}

function normalizePresetAlias(value: string): string {
  const alias = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return alias || `preset-${Date.now()}`;
}

function normalizeInputPresetScope(scope: WorkflowInputPreset['scope'] | 'public'): WorkflowInputPreset['scope'] {
  return scope === 'public' ? 'group' : scope;
}

export function canUseInputPreset(actor: ReturnType<typeof actorFromRequest>, preset: WorkflowInputPreset): boolean {
  if (isAdmin(actor)) return true;
  const scope = normalizeInputPresetScope(preset.scope as WorkflowInputPreset['scope'] | 'public');
  if (scope === 'private') return Boolean(actor.actor_id && preset.created_by === actor.actor_id);
  if (preset.group_id && (actor.group_ids || []).includes(preset.group_id)) return true;
  return scope === 'shared' && (preset.shared_group_ids || []).some((groupId) => (actor.group_ids || []).includes(groupId));
}

export function canManageInputPreset(actor: ReturnType<typeof actorFromRequest>, preset: WorkflowInputPreset): boolean {
  if (isAdmin(actor)) return true;
  if (actor.api_key_id) return false;
  if (actor.actor_id && preset.created_by === actor.actor_id && normalizeInputPresetScope(preset.scope as any) === 'private') {
    return true;
  }
  if (!preset.group_id) return false;
  try {
    assertCanManageGroup(actor, preset.group_id);
    return true;
  } catch {
    return false;
  }
}

function assertCanExecuteWorkflow(actor: ReturnType<typeof actorFromRequest>, workflowId: string) {
  if (!actor.api_key_id) {
    return;
  }
  if (!actor.scopes?.includes('workflow:execute')) {
    throw new NotFoundException('Template not found');
  }
  if (!actor.allowed_workflow_ids.includes(workflowId)) {
    throw new NotFoundException('Template not found');
  }
}

function canReadTemplate(actor: ReturnType<typeof actorFromRequest>, template: { id: string; group_id?: string | null }) {
  if (!actor.actor_id && actor.roles.includes('operator')) {
    return process.env.NODE_ENV !== 'production' && process.env.AUTHZ_ALLOW_DEVELOPMENT_BYPASS === 'true';
  }
  if (!actor.api_key_id && actor.roles.includes('admin')) return true;
  if (actor.api_key_id) {
    return Boolean((actor.scopes?.includes('workflow:read') || actor.scopes?.includes('workflow:execute')) && template.group_id && actor.group_ids?.includes(template.group_id) && actor.allowed_workflow_ids.includes(template.id));
  }
  return Boolean(template.group_id && actor.group_ids?.includes(template.group_id));
}
