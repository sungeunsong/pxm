import { Controller, Get } from '@nestjs/common';
import { EngineQueueRepositoryPort } from '../db/ports/db.ports';

@Controller('engine')
export class EngineController {
  constructor(private readonly queueRepo: EngineQueueRepositoryPort) {}

  @Get('queue/stats')
  async queueStats() {
    return this.queueRepo.getQueueStats();
  }
}
