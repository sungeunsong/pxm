import { Module } from '@nestjs/common';
import { CredentialsModule } from '../credentials/credentials.module';
import { DbModule } from '../db/db.module';
import { PluginsController } from './plugins.controller';
import { PluginsService } from './plugins.service';

@Module({
  imports: [CredentialsModule, DbModule],
  controllers: [PluginsController],
  providers: [PluginsService],
  exports: [PluginsService],
})
export class PluginsModule {}
