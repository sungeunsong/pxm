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
    assertAdmin(actorFromRequest(req));
    return this.authzService.upsertGroup(dto);
  }

  @Get('groups')
  async listGroups(@Query('includeDeleted') includeDeleted?: string) {
    return this.authzService.listGroups(includeDeleted === 'true');
  }

  @Get('groups/:id')
  async getGroup(@Param('id') id: string) {
    return this.authzService.getGroup(id);
  }

  @Delete('groups/:id')
  async deleteGroup(
    @Param('id') id: string,
    @Query('actor') actor?: string,
    @Req() req?: Request,
  ) {
    assertAdmin(actorFromRequest(req));
    return this.authzService.deleteGroup(id, actor);
  }

  @Post('groups/:id/restore')
  async restoreGroup(
    @Param('id') id: string,
    @Query('actor') actor?: string,
    @Req() req?: Request,
  ) {
    assertAdmin(actorFromRequest(req));
    return this.authzService.restoreGroup(id, actor);
  }

  @Post('users')
  async upsertUser(@Body() dto: UpsertUserDto, @Req() req: Request) {
    assertCanIssueUser(actorFromRequest(req), dto.role, dto.group_ids || []);
    return this.authzService.upsertUser(dto);
  }

  @Get('users')
  async listUsers(@Query('groupId') groupId: string | undefined, @Req() req: Request) {
    return this.authzService.listUsers(manageableGroupId(actorFromRequest(req), groupId));
  }

  @Get('users/:id')
  async getUser(@Param('id') id: string) {
    return this.authzService.getUser(id);
  }

  @Post('service-accounts')
  async upsertServiceAccount(@Body() dto: UpsertServiceAccountDto, @Req() req: Request) {
    assertCanManageGroup(actorFromRequest(req), dto.group_id);
    return this.authzService.upsertServiceAccount(dto);
  }

  @Get('service-accounts')
  async listServiceAccounts(@Query('groupId') groupId: string | undefined, @Req() req: Request) {
    return this.authzService.listServiceAccounts(manageableGroupId(actorFromRequest(req), groupId));
  }

  @Get('service-accounts/:id')
  async getServiceAccount(@Param('id') id: string) {
    return this.authzService.getServiceAccount(id);
  }

  @Post('api-keys')
  async createApiKey(@Body() dto: CreateApiKeyDto, @Req() req: Request) {
    assertCanManageGroup(actorFromRequest(req), dto.group_id);
    return this.authzService.createApiKey(dto);
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
    return this.authzService.disableApiKey(id, actor);
  }
}
