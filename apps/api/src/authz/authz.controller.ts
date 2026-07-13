import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { actorFromRequest } from '../instances/history-auth';
import { AuthzService } from './authz.service';
import {
  CreateApiKeyDto,
  UpsertGroupDto,
  UpsertServiceAccountDto,
  UpsertUserDto,
} from './dto/authz.dto';
import {
  assertAdmin,
  assertCanIssueUser,
  assertCanManageGroup,
  manageableGroupId,
} from './management-auth';

@Controller('authz')
export class AuthzController {
  constructor(private readonly authzService: AuthzService) {}

  @Post('groups')
  async upsertGroup(@Body() dto: UpsertGroupDto, @Req() req: Request) {
    const actor = actorFromRequest(req); assertAdmin(actor);
    return this.authzService.upsertGroup({ ...dto, actor: actor.actor_id || undefined });
  }

  @Get('groups')
  async listGroups(@Query('includeDeleted') includeDeleted: string | undefined, @Req() req: Request) {
    const actor = actorFromRequest(req);
    const groups = await this.authzService.listGroups(actor.roles.includes('admin') && includeDeleted === 'true');
    if (actor.roles.includes('admin')) return groups;
    if (actor.roles.includes('group_manager')) return groups.filter(group => (actor.group_ids || []).includes(group.id));
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
    return this.authzService.deleteGroup(id, authenticated.actor_id || actor);
  }

  @Post('groups/:id/restore')
  async restoreGroup(
    @Param('id') id: string,
    @Query('actor') actor?: string,
    @Req() req?: Request,
  ) {
    const authenticated = actorFromRequest(req); assertAdmin(authenticated);
    return this.authzService.restoreGroup(id, authenticated.actor_id || actor);
  }

  @Post('users')
  async upsertUser(@Body() dto: UpsertUserDto, @Req() req: Request) {
    const actor = actorFromRequest(req); assertCanIssueUser(actor, dto.role, dto.group_ids || []);
    return this.authzService.upsertUser({ ...dto, actor: actor.actor_id || undefined });
  }

  @Get('users')
  async listUsers(@Query('groupId') groupId: string | undefined, @Req() req: Request) {
    return this.authzService.listUsers(manageableGroupId(actorFromRequest(req), groupId));
  }

  @Get('users/:id')
  async getUser(@Param('id') id: string, @Req() req: Request) {
    const user = await this.authzService.getUser(id);
    for (const groupId of user.group_ids) assertCanManageGroup(actorFromRequest(req), groupId);
    return user;
  }

  @Post('service-accounts')
  async upsertServiceAccount(@Body() dto: UpsertServiceAccountDto, @Req() req: Request) {
    assertCanManageGroup(actorFromRequest(req), dto.group_id);
    return this.authzService.upsertServiceAccount({ ...dto, actor: actorFromRequest(req).actor_id || undefined });
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
    assertCanManageGroup(actorFromRequest(req), dto.group_id);
    return this.authzService.createApiKey({ ...dto, actor: actorFromRequest(req).actor_id || undefined });
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
    return this.authzService.disableApiKey(id, actorFromRequest(req).actor_id || actor);
  }
}
