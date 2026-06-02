import { Module } from '@nestjs/common';
import { PluginHostController } from './plugin-host.controller';
import { PluginHostService } from './plugin-host.service';

@Module({
  controllers: [PluginHostController],
  providers: [PluginHostService],
})
export class AppModule {}
