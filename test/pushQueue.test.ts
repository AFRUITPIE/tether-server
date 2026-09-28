import { describe, expect, test } from 'bun:test';
import { PushQueue } from '../src/threads/pushQueue.ts';

/** Everything `q` yields until it ends. */
async function drain<T>(q: PushQueue<T>) {
  const got: T[] = [];
  for await (const item of q) got.push(item);
  return got;
}

describe('PushQueue', () => {
  test('items pushed before anyone reads are yielded in order', async () => {
    const q = new PushQueue<number>();
    q.push(1);
    q.push(2);
    q.end();
    expect(await drain(q)).toEqual([1, 2]);
  });

  test('a reader waiting on an empty queue gets the next item pushed', async () => {
    const q = new PushQueue<string>();
    const it = q[Symbol.asyncIterator]();
    const first = it.next();
    const second = it.next();
    q.push('a');
    q.push('b');
    expect(await first).toEqual({ value: 'a', done: false });
    expect(await second).toEqual({ value: 'b', done: false });
  });

  test('ending it finishes waiting readers, after what was already pushed', async () => {
    const q = new PushQueue<number>();
    const reading = drain(q);
    q.push(1);
    await Bun.sleep(0);
    q.push(2);
    q.end();
    expect(await reading).toEqual([1, 2]);
  });

  test('it stays ended, and refuses more', async () => {
    const q = new PushQueue<number>();
    q.end();
    expect(() => q.push(1)).toThrow('queue closed');
    expect(await q[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true });
  });
});
