import { Controller, Get } from '@nestjs/common';
import { Public } from '../authz/public-route';

@Public()
@Controller('health')
export class HealthController {
  @Get()
  ok() {
    return { ok: true };
  }
}
