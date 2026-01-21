import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';

@Controller('instances')
export class SseController {
  @Get(':id/stream')
  stream(@Param('id') id: string, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // hello ping
    res.write(`event: hello\n`);
    res.write(
      `data: ${JSON.stringify({ instance_id: id, timestamp: new Date().toISOString() })}\n\n`,
    );

    const interval = setInterval(() => {
      res.write(`event: ping\n`);
      res.write(`data: ${JSON.stringify({ t: Date.now() })}\n\n`);
    }, 5000);

    reqOnClose(res, () => clearInterval(interval));
  }
}

function reqOnClose(res: Response, fn: () => void) {
  // express Response has req
  const req = (res as any).req;
  req?.on?.('close', fn);
}
