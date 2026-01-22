import { Controller, Get, Query, HttpException, HttpStatus } from '@nestjs/common';

const counters = new Map<string, number>();

@Controller('debug')
export class FlakyController {
  @Get('flaky')
  flaky(@Query('key') key = 'default', @Query('fail') fail = '2') {
    const failCount = parseInt(fail, 10) || 2;
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);

    if (n <= failCount) {
      // 처음 failCount번은 일부러 실패 (500 상태코드 반환)
      throw new HttpException(
        {
          ok: false,
          attempt: n,
          message: `flaky fail ${n}/${failCount}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return {
      ok: true,
      attempt: n,
      data: { value: 'hello-from-flaky', ts: new Date().toISOString() },
    };
  }
}
