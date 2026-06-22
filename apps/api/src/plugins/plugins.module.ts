import { Module } from '@nestjs/common';
import { CredentialsModule } from '../credentials/credentials.module';
import { PluginsController } from './plugins.controller';
import { PluginsService } from './plugins.service';

@Module({
  imports: [CredentialsModule],
  controllers: [PluginsController],
  providers: [PluginsService],
  exports: [PluginsService],
})
export class PluginsModule {}
