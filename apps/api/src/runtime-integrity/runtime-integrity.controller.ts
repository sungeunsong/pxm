import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { assertAdmin } from '../authz/management-auth';
import { actorFromRequest } from '../instances/history-auth';
import {
  RuntimeIntegrityRepairDto,
  RuntimeIntegrityScanDto,
} from './dto/runtime-integrity.dto';
import { RuntimeIntegrityService } from './runtime-integrity.service';

@Controller('runtime-integrity')
export class RuntimeIntegrityController {
  constructor(private readonly integrity: RuntimeIntegrityService) {}

  @Post('scan')
  scan(@Body() body: RuntimeIntegrityScanDto, @Req() req: Request) {
    assertAdmin(actorFromRequest(req));
    return this.integrity.scan(body);
  }

  @Post('repair')
  async repair(
    @Body() body: RuntimeIntegrityRepairDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const actor = actorFromRequest(req);
    assertAdmin(actor);
    if (!idempotencyKey)
      throw new BadRequestException('Idempotency-Key header is required');
    const result = await this.integrity.repair(body, actor, idempotencyKey);
    if (result.idempotent_replay)
      response.setHeader('Idempotency-Replayed', 'true');
    return result;
  }
}
