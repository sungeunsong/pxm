import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { actorFromRequest } from '../instances/history-auth';
import { ScriptLibrariesService } from './script-libraries.service';

@Controller('script-libraries')
export class ScriptLibrariesController {
  constructor(private readonly scriptLibraries: ScriptLibrariesService) {}

  @Get()
  list() {
    return this.scriptLibraries.list(false);
  }

  @Get('admin')
  adminList(@Req() request: Request) {
    requireAdmin(request);
    return this.scriptLibraries.list(true);
  }

  @Post()
  prepare(
    @Body() body: { package_name?: string; version?: string },
    @Req() request: Request,
  ) {
    requireAdmin(request);
    return this.scriptLibraries.prepare(body, actorLabel(request));
  }

  @Post(':id/approve')
  approve(
    @Param('id') id: string,
    @Body() body: { allowed_group_ids?: string[] },
    @Req() request: Request,
  ) {
    requireAdmin(request);
    return this.scriptLibraries.approve(id, body, actorLabel(request));
  }

  @Post(':id/disable')
  disable(@Param('id') id: string, @Req() request: Request) {
    requireAdmin(request);
    return this.scriptLibraries.disable(id, actorLabel(request));
  }
}

function requireAdmin(request: Request) {
  if (!actorFromRequest(request).roles.includes('admin')) {
    throw new ForbiddenException('Admin role is required');
  }
}

function actorLabel(request: Request) {
  return actorFromRequest(request).actor_id || 'admin';
}
