import { describe, expect, it } from 'vitest';
import { advanceScheduledWork } from '../scheduler';
describe('scheduled work fairness', () => {
  it('finds the one due family across the wrap instead of letting always-available maintenance delay it', async () => {
    const calls: string[] = [];
    await advanceScheduledWork(
      2,
      [
        async () => {
          calls.push('commands');
          return true;
        },
        async () => {
          calls.push('idle');
          return false;
        },
      ],
      async () => {
        calls.push('maintenance');
      },
    );
    expect(calls).toEqual(['idle', 'commands']);
  });
  it('reserves maintenance without starving a work family as its cursor wraps', async () => {
    const calls: number[] = [];
    let maintenance = 0;
    const work = Array.from({ length: 5 }, (_, index) => async () => {
      calls.push(index);
      return true;
    });
    for (let turn = 1; turn <= 30; turn++)
      await advanceScheduledWork(turn, work, async () => {
        maintenance++;
      });
    expect(maintenance).toBe(3);
    expect(calls).toEqual(Array.from({ length: 27 }, (_, index) => index % 5));
  });
  it('runs one maintenance slice when every work family is idle', async () => {
    let count = 0;
    await advanceScheduledWork(1, [async () => false, async () => false], async () => {
      count++;
    });
    expect(count).toBe(1);
  });
  it('keeps heavy maintenance out of an invocation that has already scanned idle work', async () => {
    let heavy = 0,
      light = 0;
    const work = [async () => false, async () => false];
    await advanceScheduledWork(
      1,
      work,
      async () => {
        heavy++;
      },
      async () => {
        light++;
      },
    );
    expect({ heavy, light }).toEqual({ heavy: 0, light: 1 });
    await advanceScheduledWork(
      10,
      work,
      async () => {
        heavy++;
      },
      async () => {
        light++;
      },
    );
    expect({ heavy, light }).toEqual({ heavy: 1, light: 1 });
  });
});
