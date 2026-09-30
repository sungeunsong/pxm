import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { actorFromRequest } from '../instances/history-auth';
import type { EntryPointKind } from '../db/ports/entry-points.port';
import {
  EntryPointsService,
  type PublishEntryPointInput,
  type UpdateEntryPointInput,
} from './entry-points.service';

/**
 * 진입점(AI Tool·게이트웨이 라우트) 관리. 콘솔 전용이며 API Key로는 쓸 수 없다.
 * 호출용 공개 API(/api/v1/tools)는 PXM-70에서 따로 둔다.
 */
@Controller('entry-points')
export class EntryPointsController {
  constructor(private readonly service: EntryPointsService) {}

  @Get()
  list(
    @Query('kind') kind: string | undefined,
    @Query('group_id') groupId: string | undefined,
    @Query('definition_id') definitionId: string | undefined,
    @Req() req: Request,
  ) {
    return this.service.list(actorFromRequest(req), {
      kind:
        kind === 'tool' || kind === 'route'
          ? (kind as EntryPointKind)
          : undefined,
      group_id: groupId?.trim() || undefined,
      definition_id: definitionId?.trim() || undefined,
    });
  }

  /** 저장하지 않고 파생 스키마와 차단·경고를 돌려준다 */
  @Post('preview')
  preview(@Body() body: PublishEntryPointInput, @Req() req: Request) {
    return this.service.preview(
      actorFromRequest(req),
      body || ({} as PublishEntryPointInput),
    );
  }

  @Post()
  publish(@Body() body: PublishEntryPointInput, @Req() req: Request) {
    return this.service.publish(
      actorFromRequest(req),
      body || ({} as PublishEntryPointInput),
    );
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() req: Request) {
    return this.service.get(actorFromRequest(req), id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: UpdateEntryPointInput,
    @Req() req: Request,
  ) {
    return this.service.update(actorFromRequest(req), id, body || {});
  }

  /** 고정 버전을 현재 배포 버전으로 바꾼다. dry_run이면 비교만 한다 */
  @Post(':id/rebind')
  rebind(
    @Param('id') id: string,
    @Body() body: { dry_run?: boolean; confirm_breaking?: boolean } | undefined,
    @Req() req: Request,
  ) {
    return this.service.rebind(actorFromRequest(req), id, {
      dry_run: body?.dry_run === true,
      confirm_breaking: body?.confirm_breaking === true,
    });
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: Request) {
    return this.service.remove(actorFromRequest(req), id);
  }
}
