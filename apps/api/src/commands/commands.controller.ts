import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { actorFromRequest } from '../instances/history-auth';
import { CommandsService } from './commands.service';
import type { CommandRegistryDto } from './dto/command-registry.dto';

@Controller('commands')
export class CommandsController {
  constructor(private readonly commandsService: CommandsService) {}

  @Get()
  async list(@Query('activeOnly') activeOnly?: string) {
    return this.commandsService.list(activeOnly === 'true');
  }

  @Get('audit')
  async audit(@Req() req: Request) {
    requireAdmin(req);
    return this.commandsService.audit();
  }

  @Get(':command_id')
  async get(@Param('command_id') commandId: string) {
    return this.commandsService.get(commandId);
  }

  @Post()
  async create(@Body() dto: CommandRegistryDto, @Req() req: Request) {
    requireAdmin(req);
    return this.commandsService.upsert(dto, actorLabel(req));
  }

  @Put(':command_id')
  async update(
    @Param('command_id') commandId: string,
    @Body() dto: Partial<CommandRegistryDto>,
    @Req() req: Request,
  ) {
    requireAdmin(req);
    return this.commandsService.update(commandId, dto, actorLabel(req));
  }

  @Delete(':command_id')
  async disable(@Param('command_id') commandId: string, @Req() req: Request) {
    requireAdmin(req);
    return this.commandsService.disable(commandId, actorLabel(req));
  }

  @Get(':command_id/audit')
  async commandAudit(@Param('command_id') commandId: string, @Req() req: Request) {
    requireAdmin(req);
    return this.commandsService.audit(commandId);
  }
}

function requireAdmin(req: Request) {
  const actor = actorFromRequest(req);
  if (!actor.roles.includes('admin')) {
    throw new ForbiddenException('Admin role is required');
  }
}

function actorLabel(req: Request) {
  const actor = actorFromRequest(req);
  return actor.actor_id || 'admin';
}
