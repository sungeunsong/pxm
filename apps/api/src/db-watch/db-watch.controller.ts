import { BadRequestException, Body, Controller, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { actorFromRequest } from '../instances/history-auth';
import { DbWatchService } from './db-watch.service';

type TestDbWatchConnectionRequest = {
  database?: string | null;
  collection?: string | null;
  credential_id?: string | null;
  mode?: 'polling' | 'change_stream' | string | null;
  cursor_field?: string | null;
  filter?: Record<string, any> | null;
};

@Controller('db-watch')
export class DbWatchController {
  constructor(private readonly dbWatchService: DbWatchService) {}

  @Post('test')
  async testConnection(@Body() body: TestDbWatchConnectionRequest, @Req() req: Request) {
    try {
      return await this.dbWatchService.testConnection(body || {}, actorFromRequest(req));
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'DB watch connection test failed');
    }
  }
}
