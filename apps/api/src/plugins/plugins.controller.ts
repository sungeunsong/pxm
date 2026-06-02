import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { PluginsService } from './plugins.service';

@Controller('plugins')
export class PluginsController {
  constructor(private readonly pluginsService: PluginsService) {}

  @Get()
  findAll() {
    return this.pluginsService.findAll();
  }

  @Get(':plugin_id/versions')
  findVersions(@Param('plugin_id') pluginId: string) {
    const versions = this.pluginsService.findVersions(pluginId);
    if (versions.length === 0) {
      throw new NotFoundException('Plugin not found');
    }
    return versions;
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
