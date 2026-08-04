import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { actorFromRequest } from '../instances/history-auth';
import { CredentialsService } from './credentials.service';
import { CreateCredentialDto, LookupSshHostKeyDto, UpdateCredentialDto } from './dto/credential.dto';

@Controller('credentials')
export class CredentialsController {
  constructor(private readonly credentialsService: CredentialsService) {}

  @Post()
  async create(@Body() dto: CreateCredentialDto, @Req() req: Request) {
    return this.credentialsService.create(dto, actorFromRequest(req));
  }

  @Post('ssh/host-key')
  async lookupSshHostKey(@Body() dto: LookupSshHostKeyDto, @Req() req: Request) {
    return this.credentialsService.lookupSshHostKey(dto, actorFromRequest(req));
  }

  @Get()
  async list(
    @Query('activeOnly') activeOnly: string | undefined,
    @Query('groupId') groupId: string | undefined,
    @Req() req: Request,
  ) {
    return this.credentialsService.list(activeOnly === 'true', actorFromRequest(req), groupId);
  }

  @Get('audit')
  async audit(@Query('groupId') groupId: string | undefined, @Req() req: Request) {
    return this.credentialsService.audit(actorFromRequest(req), undefined, groupId);
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: Request) {
    return this.credentialsService.get(id, actorFromRequest(req));
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateCredentialDto, @Req() req: Request) {
    return this.credentialsService.update(id, dto, actorFromRequest(req));
  }

  @Delete(':id')
  async delete(@Param('id') id: string, @Req() req: Request) {
    return this.credentialsService.delete(id, actorFromRequest(req));
  }

  @Get(':id/audit')
  async credentialAudit(@Param('id') id: string, @Req() req: Request) {
    return this.credentialsService.audit(actorFromRequest(req), id);
  }
}
