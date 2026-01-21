import { Module } from '@nestjs/common';
import { pgPoolProvider } from './pg.provider';

@Module({
  providers: [pgPoolProvider],
  exports: [pgPoolProvider], // <-- 중요: 다른 모듈에서 PG_POOL 쓸 수 있게 export
})
export class DbModule {}
