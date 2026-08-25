import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { actorFromRequest } from '../instances/history-auth';
import { AuthzService } from './authz.service';
import {
  CreateApiKeyDto,
  CreateExternalPrincipalMappingDto,
  SetGroupMembershipDto,
  SetExternalPrincipalMappingStatusDto,
  UpdateExternalPrincipalMappingDto,
  UpsertGroupDto,
  UpsertServiceAccountDto,
  UpsertUserDto,
} from './dto/authz.dto';
import {
  assertAdmin,
  assertCanIssueUser,
  assertCanManageGroup,
  isAdmin,
  managerGroupIds,
  manageableGroupId,
} from './management-auth';
import { ManagementAuditService } from '../audit/management-audit.service';
import { CredentialsService } from '../credentials/credentials.service';

@Controller('authz')
export class AuthzController {
  constructor(
    private readonly authzService: AuthzService,
    private readonly audit: ManagementAuditService,
    private readonly credentials: CredentialsService,
  ) {}

  @Post('groups')
  async upsertGroup(@Body() dto: UpsertGroupDto, @Req() req: Request) {
    const actor = actorFromRequest(req); assertAdmin(actor);
    const group = await this.authzService.upsertGroup({ ...dto, actor: actor.actor_id || undefined });
    await this.audit.append({ action: dto.id ? 'group.updated' : 'group.created', resource_type: 'group', resource_id: group.id, group_id: group.id, actor_id: actor.actor_id });
    return group;
  }

  @Get('groups')
  async listGroups(
    @Query('includeDeleted') includeDeleted: string | undefined,
    @Query('manageableOnly') manageableOnly: string | undefined,
    @Req() req: Request,
  ) {
    const actor = actorFromRequest(req);
    const groups = await this.authzService.listGroups(actor.roles.includes('admin') && includeDeleted === 'true');
    if (actor.roles.includes('admin')) return groups;
    const visibleGroupIds = manageableOnly === 'true' ? managerGroupIds(actor) : actor.group_ids || [];
    if (visibleGroupIds.length > 0) return groups.filter(group => visibleGroupIds.includes(group.id));
    assertCanManageGroup(actor, null);
    return [];
  }

  @Get('groups/:id')
  async getGroup(@Param('id') id: string, @Req() req: Request) {
    assertCanManageGroup(actorFromRequest(req), id);
    return this.authzService.getGroup(id);
  }

  @Delete('groups/:id')
  async deleteGroup(
    @Param('id') id: string,
    @Query('actor') actor?: string,
    @Req() req?: Request,
  ) {
    const authenticated = actorFromRequest(req); assertAdmin(authenticated);
    const result = await this.authzService.deleteGroup(id, authenticated.actor_id || actor);
    await this.credentials.revokeGroupShares(id, authenticated.actor_id || actor || 'system');
    await this.audit.append({ action: 'group.deleted', resource_type: 'group', resource_id: id, group_id: id, actor_id: authenticated.actor_id });
    return result;
  }

  @Post('groups/:id/restore')
  async restoreGroup(
    @Param('id') id: string,
    @Query('actor') actor?: string,
    @Req() req?: Request,
  ) {
    const authenticated = actorFromRequest(req); assertAdmin(authenticated);
    const result = await this.authzService.restoreGroup(id, authenticated.actor_id || actor);
    await this.audit.append({ action: 'group.restored', resource_type: 'group', resource_id: id, group_id: id, actor_id: authenticated.actor_id });
    return result;
  }

  @Post('users')
  async upsertUser(@Body() dto: UpsertUserDto, @Req() req: Request) {
    const membershipGroupIds = dto.memberships?.map((membership) => membership.group_id) || [];
    const assignedRole = dto.memberships?.some((membership) => membership.role === 'group_manager')
      ? 'group_manager'
      : dto.role;
    const actor = actorFromRequest(req); assertCanIssueUser(actor, assignedRole, membershipGroupIds.length ? membershipGroupIds : dto.group_ids || []);
    let safeDto = dto;
    if (!isAdmin(actor) && dto.id) {
      const existing = await this.authzService.getUser(dto.id).catch(() => null);
      if (existing) {
        safeDto = {
          ...dto,
          display_name: existing.display_name,
          email: existing.email,
          role: existing.role,
          status: existing.status,
          password: undefined,
        };
      }
    }
    const user = await this.authzService.upsertUser({ ...safeDto, actor: actor.actor_id || undefined });
    await Promise.all((user.group_ids.length ? user.group_ids : [null]).map((groupId) => this.audit.append({
      action: dto.id ? 'user.updated' : 'user.created', resource_type: 'user', resource_id: user.id,
      group_id: groupId, actor_id: actor.actor_id, details: { role: user.role, group_ids: user.group_ids, memberships: user.memberships },
    })));
    return user;
  }

  @Post('users/new')
  async createUser(@Body() dto: UpsertUserDto, @Req() req: Request) {
    const membershipGroupIds = dto.memberships?.map((membership) => membership.group_id) || [];
    const assignedRole = dto.memberships?.some((membership) => membership.role === 'group_manager')
      ? 'group_manager'
      : dto.role;
    const actor = actorFromRequest(req);
    assertCanIssueUser(actor, assignedRole, membershipGroupIds.length ? membershipGroupIds : dto.group_ids || []);
    const user = await this.authzService.createUser({ ...dto, actor: actor.actor_id || undefined });
    await Promise.all((user.group_ids.length ? user.group_ids : [null]).map((groupId) => this.audit.append({
      action: 'user.created', resource_type: 'user', resource_id: user.id,
      group_id: groupId, actor_id: actor.actor_id, details: { role: user.role, group_ids: user.group_ids, memberships: user.memberships },
    })));
    return user;
  }

  @Get('users')
  async listUsers(@Query('groupId') groupId: string | undefined, @Req() req: Request) {
    return this.authzService.listUsers(manageableGroupId(actorFromRequest(req), groupId));
  }

  @Get('users/directory')
  async listUserDirectory(@Query('groupId') groupId: string, @Req() req: Request) {
    assertCanManageGroup(actorFromRequest(req), groupId);
    return this.authzService.listUsers();
  }

  @Put('groups/:groupId/members/:userId')
  async setGroupMembership(
    @Param('groupId') groupId: string,
    @Param('userId') userId: string,
    @Body() dto: SetGroupMembershipDto,
    @Req() req: Request,
  ) {
    const actor = actorFromRequest(req);
    assertCanManageGroup(actor, groupId);
    const current = await this.authzService.getUser(userId);
    const currentRole = current.memberships?.find((membership) => membership.group_id === groupId)?.role;
    const protectedRole = current.role === 'admin'
      ? 'admin'
      : currentRole === 'group_manager'
        ? 'group_manager'
        : dto.role;
    assertCanIssueUser(actor, protectedRole, [groupId]);
    const user = await this.authzService.setUserMembership(userId, groupId, dto.role, actor.actor_id);
    await this.audit.append({
      action: currentRole ? 'user.membership_updated' : 'user.membership_added',
      resource_type: 'user',
      resource_id: user.id,
      group_id: groupId,
      actor_id: actor.actor_id,
      details: { previous_role: currentRole || null, role: dto.role },
    });
    return user;
  }

  @Delete('groups/:groupId/members/:userId')
  async removeGroupMembership(
    @Param('groupId') groupId: string,
    @Param('userId') userId: string,
    @Req() req: Request,
  ) {
    const actor = actorFromRequest(req);
    assertCanManageGroup(actor, groupId);
    const current = await this.authzService.getUser(userId);
    const currentRole = current.memberships?.find((membership) => membership.group_id === groupId)?.role;
    assertCanIssueUser(actor, current.role === 'admin' ? 'admin' : currentRole, [groupId]);
    const user = await this.authzService.removeUserMembership(userId, groupId, actor.actor_id);
    await this.audit.append({
      action: 'user.membership_removed',
      resource_type: 'user',
      resource_id: user.id,
      group_id: groupId,
      actor_id: actor.actor_id,
      details: { previous_role: currentRole || null },
    });
    return user;
  }

  @Get('users/:id')
  async getUser(@Param('id') id: string, @Req() req: Request) {
    const user = await this.authzService.getUser(id);
    for (const groupId of user.group_ids) assertCanManageGroup(actorFromRequest(req), groupId);
    return user;
  }

  @Get('external-principal-mappings')
  async listExternalPrincipalMappings(
    @Query('groupId') groupId: string | undefined,
    @Query('provider') provider: string | undefined,
    @Query('subject') subject: string | undefined,
    @Query('status') status: 'active' | 'disabled' | undefined,
    @Req() req: Request,
  ) {
    return this.authzService.listExternalPrincipalMappings({
      group_id: manageableGroupId(actorFromRequest(req), groupId),
      provider,
      subject,
      status,
    });
  }

  @Post('external-principal-mappings')
  async createExternalPrincipalMapping(
    @Body() dto: CreateExternalPrincipalMappingDto,
    @Req() req: Request,
  ) {
    const actor = actorFromRequest(req);
    assertCanManageGroup(actor, dto.group_id);
    const mapping = await this.authzService.createExternalPrincipalMapping(dto, actor.actor_id);
    await this.audit.append({
      action: 'external_principal_mapping.created',
      resource_type: 'external_principal_mapping',
      resource_id: mapping.id,
      group_id: mapping.group_id,
      actor_id: actor.actor_id,
      details: { after: mappingAuditSnapshot(mapping) },
    });
    return mapping;
  }

  @Put('external-principal-mappings/:id')
  async updateExternalPrincipalMapping(
    @Param('id') id: string,
    @Body() dto: UpdateExternalPrincipalMappingDto,
    @Req() req: Request,
  ) {
    const actor = actorFromRequest(req);
    const before = await this.authzService.getExternalPrincipalMapping(id);
    assertCanManageGroup(actor, before.group_id);
    assertCanManageGroup(actor, dto.group_id);
    const mapping = await this.authzService.updateExternalPrincipalMapping(id, dto, actor.actor_id);
    await this.audit.append({
      action: 'external_principal_mapping.updated',
      resource_type: 'external_principal_mapping',
      resource_id: mapping.id,
      group_id: mapping.group_id,
      actor_id: actor.actor_id,
      details: { before: mappingAuditSnapshot(before), after: mappingAuditSnapshot(mapping) },
    });
    return mapping;
  }

  @Put('external-principal-mappings/:id/status')
  async setExternalPrincipalMappingStatus(
    @Param('id') id: string,
    @Body() dto: SetExternalPrincipalMappingStatusDto,
    @Req() req: Request,
  ) {
    const actor = actorFromRequest(req);
    const before = await this.authzService.getExternalPrincipalMapping(id);
    assertCanManageGroup(actor, before.group_id);
    const mapping = await this.authzService.setExternalPrincipalMappingStatus(id, dto.status, actor.actor_id);
    await this.audit.append({
      action: dto.status === 'active'
        ? 'external_principal_mapping.activated'
        : 'external_principal_mapping.disabled',
      resource_type: 'external_principal_mapping',
      resource_id: mapping.id,
      group_id: mapping.group_id,
      actor_id: actor.actor_id,
      details: { before: mappingAuditSnapshot(before), after: mappingAuditSnapshot(mapping) },
    });
    return mapping;
  }

  @Post('service-accounts')
  async upsertServiceAccount(@Body() dto: UpsertServiceAccountDto, @Req() req: Request) {
    const actor = actorFromRequest(req); assertCanManageGroup(actor, dto.group_id);
    const account = await this.authzService.upsertServiceAccount({ ...dto, actor: actor.actor_id || undefined });
    await this.audit.append({ action: dto.id ? 'service_account.updated' : 'service_account.created', resource_type: 'service_account', resource_id: account.id, group_id: account.group_id, actor_id: actor.actor_id });
    return account;
  }

  @Get('service-accounts')
  async listServiceAccounts(@Query('groupId') groupId: string | undefined, @Req() req: Request) {
    return this.authzService.listServiceAccounts(manageableGroupId(actorFromRequest(req), groupId));
  }

  @Get('service-accounts/:id')
  async getServiceAccount(@Param('id') id: string, @Req() req: Request) {
    const account = await this.authzService.getServiceAccount(id);
    assertCanManageGroup(actorFromRequest(req), account.group_id);
    return account;
  }

  @Post('api-keys')
  async createApiKey(@Body() dto: CreateApiKeyDto, @Req() req: Request) {
    const actor = actorFromRequest(req); assertCanManageGroup(actor, dto.group_id);
    const key = await this.authzService.createApiKey({ ...dto, actor: actor.actor_id || undefined });
    await this.audit.append({ action: 'api_key.issued', resource_type: 'api_key', resource_id: key.id, group_id: key.group_id, actor_id: actor.actor_id, details: { owner_type: key.owner_type, owner_id: key.owner_id, scopes: key.scopes, workflow_access: key.workflow_access, allowed_workflow_ids: key.allowed_workflow_ids, expires_at: key.expires_at } });
    return key;
  }

  @Get('api-keys')
  async listApiKeys(@Query('groupId') groupId: string | undefined, @Req() req: Request) {
    return this.authzService.listApiKeys(manageableGroupId(actorFromRequest(req), groupId));
  }

  @Put('api-keys/:id/disable')
  async disableApiKey(
    @Param('id') id: string,
    @Query('actor') actor?: string,
    @Req() req?: Request,
  ) {
    const key = await this.authzService.getApiKey(id);
    assertCanManageGroup(actorFromRequest(req), key.group_id);
    const authenticated = actorFromRequest(req);
    const result = await this.authzService.disableApiKey(id, authenticated.actor_id || actor);
    await this.audit.append({ action: 'api_key.disabled', resource_type: 'api_key', resource_id: id, group_id: key.group_id, actor_id: authenticated.actor_id });
    return result;
  }

  @Post('api-keys/:id/rotate')
  async rotateApiKey(@Param('id') id: string, @Req() req: Request) {
    const actor = actorFromRequest(req);
    const key = await this.authzService.getApiKey(id);
    assertCanManageGroup(actor, key.group_id);
    const replacement = await this.authzService.rotateApiKey(id, actor.actor_id);
    await this.audit.append({
      action: 'api_key.rotated', resource_type: 'api_key', resource_id: replacement.id,
      group_id: key.group_id, actor_id: actor.actor_id, details: { previous_key_id: id },
    });
    return replacement;
  }
}

function mappingAuditSnapshot(mapping: {
  provider: string;
  subject: string;
  group_id: string;
  pxm_user_id: string;
  display_name?: string | null;
  email?: string | null;
  department?: string | null;
  status: string;
  version: number;
}) {
  return {
    provider: mapping.provider,
    subject: mapping.subject,
    group_id: mapping.group_id,
    pxm_user_id: mapping.pxm_user_id,
    display_name: mapping.display_name || null,
    email: mapping.email || null,
    department: mapping.department || null,
    status: mapping.status,
    version: mapping.version,
  };
}
