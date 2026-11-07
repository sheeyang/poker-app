import { describe, expect, it } from 'vitest';
import type { ObservableTableSession } from '@poker/contracts';
import { anchorOf, replayAt, shiftTimes } from '../src/demo/time.js';

const session = (schedule: object, serverTime = 1_000_000): ObservableTableSession => ({ schedule, serverTime, tableSessionId: 't', pokerRevision: 3 }) as unknown as ObservableTableSession;

describe('Demo Table replay', () => {
  it('anchors on the open Action Window, then the Next-Hand Countdown, then the view time', () => {
    expect(anchorOf(session({ phases: [], actionWindow: { opensAt: 900_000 }, nextHandCountdown: { startsAt: 5 } }))).toBe(900_000);
    expect(anchorOf(session({ phases: [], actionWindow: null, nextHandCountdown: { startsAt: 950_000 } }))).toBe(950_000);
    expect(anchorOf(session({ phases: [], actionWindow: null }))).toBe(1_000_000);
  });

  it('moves every server timestamp together and nothing else', () => {
    const shifted = shiftTimes({ serverTime: 10, pokerRevision: 10, schedule: { phases: [{ startsAt: 1, endsAt: 2, durationMs: 1 }], actionWindow: { opensAt: 3, deadlineAt: 33 } } }, 100);
    expect(shifted).toEqual({ serverTime: 110, pokerRevision: 10, schedule: { phases: [{ startsAt: 101, endsAt: 102, durationMs: 1 }], actionWindow: { opensAt: 103, deadlineAt: 133 } } });
  });

  it('replays a view so its open Action Window starts now, keeping the Action Time Limit intact', () => {
    const recorded = session({ phases: [{ startsAt: 800_000, endsAt: 899_000 }], actionWindow: { opensAt: 900_000, deadlineAt: 930_000 } });
    const replayed = replayAt(recorded, 5_000_000);
    expect(replayed.schedule.actionWindow).toEqual({ opensAt: 5_000_000, deadlineAt: 5_030_000 });
    expect(replayed.schedule.phases[0]!.endsAt).toBeLessThan(5_000_000);
  });
});
