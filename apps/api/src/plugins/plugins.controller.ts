import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { actorFromRequest } from '../instances/history-auth';
import { PluginsService, type PluginControlUpdateDto } from './plugins.service';

@Controller('plugins')
export class PluginsController {
  constructor(private readonly pluginsService: PluginsService) {}

  @Get()
  findAll() {
    return this.pluginsService.findAll();
  }

  @Get('control')
  controlList(@Req() req: Request) {
    requireAdmin(req);
    return this.pluginsService.findControlList();
  }

  @Get('control/audit')
  controlAudit(@Req() req: Request) {
    requireAdmin(req);
    return this.pluginsService.audit();
  }

  @Get('registry')
  registryList(@Req() req: Request) {
    requireAdmin(req);
    return this.pluginsService.findRegistry();
  }

  @Get('registry/audit')
  registryAudit(@Req() req: Request) {
    requireAdmin(req);
    return this.pluginsService.registryAudit();
  }

  @Post('registry')
  registryUpsert(@Body() body: Record<string, any>, @Req() req: Request) {
    requireAdmin(req);
    return this.pluginsService.upsertRegistryManifest(body, actorLabel(req));
  }

  @Put('registry/:plugin_id/:version')
  registryUpdate(
    @Param('plugin_id') pluginId: string,
    @Param('version') version: string,
    @Body() body: Record<string, any>,
    @Req() req: Request,
  ) {
    requireAdmin(req);
    return this.pluginsService.upsertRegistryManifest(
      { ...body, plugin_id: pluginId, version },
      actorLabel(req),
    );
  }

  @Delete('registry/:plugin_id/:version')
  registryDelete(
    @Param('plugin_id') pluginId: string,
    @Param('version') version: string,
    @Req() req: Request,
  ) {
    requireAdmin(req);
    return this.pluginsService.deleteRegistryManifest(pluginId, version, actorLabel(req));
  }

  @Post('test')
  async test(@Body() body: PluginTestRequest, @Req() req: Request) {
    return this.pluginsService.testPlugin(body, actorFromRequest(req));
  }

  @Get(':plugin_id/versions')
  findVersions(@Param('plugin_id') pluginId: string) {
    const versions = this.pluginsService.findVersions(pluginId);
    if (versions.length === 0) {
      throw new NotFoundException('Plugin not found');
    }
    return versions;
  }

  @Put(':plugin_id/control')
  updateControl(
    @Param('plugin_id') pluginId: string,
    @Body() body: PluginControlUpdateDto,
    @Req() req: Request,
  ) {
    requireAdmin(req);
    return this.pluginsService.updateControl(pluginId, body, actorLabel(req));
  }

  @Get(':plugin_id/control/audit')
  pluginControlAudit(@Param('plugin_id') pluginId: string, @Req() req: Request) {
    requireAdmin(req);
    return this.pluginsService.audit(pluginId);
  }

  @Get(':plugin_id')
  findOne(@Param('plugin_id') pluginId: string) {
    const plugin = this.pluginsService.findOne(pluginId);
    if (!plugin) {
      throw new NotFoundException('Plugin not found');
    }
    return plugin;
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

interface PluginTestRequest {
  plugin_id?: string;
  node_id?: string;
  config?: Record<string, unknown>;
  input?: Record<string, unknown>;
}
