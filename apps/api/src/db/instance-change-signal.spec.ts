import { EventEmitter } from 'events';
import {
  MongoInstanceChangeSignal,
  PollingInstanceChangeSignal,
} from './instance-change-signal';

function fakeDb() {
  const stream = Object.assign(new EventEmitter(), {
    close: jest.fn().mockResolvedValue(undefined),
  });
  const watch = jest.fn(() => stream);
  return { db: { collection: () => ({ watch }) } as any, stream, watch };
}

describe('MongoInstanceChangeSignal', () => {
  it('해당 인스턴스가 바뀌면 기다리던 쪽을 바로 깨운다', async () => {
    const { db, stream } = fakeDb();
    const signal = new MongoInstanceChangeSignal(db);
    const watch = signal.watch('instance-1');
    const started = Date.now();
    const waiting = watch.wait(5_000);
    stream.emit('change', { documentKey: { _id: 'instance-1' } });
    await expect(waiting).resolves.toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    watch.close();
  });

  it('등록한 뒤 대기 전에 온 변경도 놓치지 않는다', async () => {
    const { db, stream } = fakeDb();
    const signal = new MongoInstanceChangeSignal(db);
    const watch = signal.watch('instance-1');
    stream.emit('change', { documentKey: { _id: 'instance-1' } });
    await expect(watch.wait(5_000)).resolves.toBe(true);
    watch.close();
  });

  it('다른 인스턴스의 변경으로는 깨어나지 않는다', async () => {
    const { db, stream } = fakeDb();
    const signal = new MongoInstanceChangeSignal(db);
    const watch = signal.watch('instance-1');
    const waiting = watch.wait(30);
    stream.emit('change', { documentKey: { _id: 'instance-2' } });
    await expect(waiting).resolves.toBe(false);
    watch.close();
  });

  it('스트림은 대기마다 열지 않고 하나를 공유한다', () => {
    const { db, watch } = fakeDb();
    const signal = new MongoInstanceChangeSignal(db);
    signal.watch('a').close();
    signal.watch('b').close();
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it('스트림 오류가 나면 시간 대기로 동작한다', async () => {
    const { db, stream } = fakeDb();
    const signal = new MongoInstanceChangeSignal(db);
    const watch = signal.watch('instance-1');
    stream.emit('error', new Error('not a replica set'));
    await expect(watch.wait(20)).resolves.toBe(false);
    watch.close();
  });
});

describe('PollingInstanceChangeSignal', () => {
  it('시간이 지나면 변경 없음으로 돌아온다', async () => {
    const watch = new PollingInstanceChangeSignal().watch();
    await expect(watch.wait(10)).resolves.toBe(false);
  });
});
