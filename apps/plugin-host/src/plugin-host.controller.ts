import { Body, Controller, Get, Post } from '@nestjs/common';
import { PluginHostService } from './plugin-host.service';
import type { PluginInvokeRequest } from './plugin-host.types';

@Controller()
export class PluginHostController {
  constructor(private readonly pluginHostService: PluginHostService) {}

  @Get('health')
  health() {
    return this.pluginHostService.health();
  }

  @Post('invoke')
  invoke(@Body() request: PluginInvokeRequest) {
    return this.pluginHostService.invoke(request);
  }
}
