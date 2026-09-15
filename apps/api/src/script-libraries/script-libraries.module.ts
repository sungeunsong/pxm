import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { ScriptLibrariesController } from './script-libraries.controller';
import { ScriptLibrariesService } from './script-libraries.service';

@Module({
  imports: [DbModule],
  controllers: [ScriptLibrariesController],
  providers: [ScriptLibrariesService],
  exports: [ScriptLibrariesService],
})
export class ScriptLibrariesModule {}
