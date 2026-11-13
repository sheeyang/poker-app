import { describe, expect, it } from 'vitest';
import { tableMotion } from '../src/index.js';

/** The table's motion with no Presentation Phase as the M5 motion work timed it, in milliseconds. */
const m5 = {
  betFlight: 300, betAmountAppears: 290, betToPot: 340, caption: 150,
  muckFlight: 340, muckStagger: 40, check: 240,
  sweepAt: 120, sweepFlight: 280, sweepStagger: 40, sweepAmountFade: 140, potAfterSweep: 260, potBrightens: 160,
  seatArrives: 240, sitFade: 140, sitArrivesAt: 80, leaveFade: 200, leaveArrivesAt: 140, moveVacatedArrivesAt: 200,
  chipsFlight: 560, chipsLabel: 1100, stackRoll: 700,
  seatChangeFade: 160, seatChangeArrivesAt: 120, seatChangeArrives: 220, seatChangeLabel: 1600,
  status: 180,
};

describe('table motion with no Presentation Phase', () => {
  it('plays bets, folds, checks, the sweep, seats, added chips, your seat change and statuses at 1.5× the M5 tempo', () => {
    expect(Object.keys(tableMotion).sort()).toEqual(Object.keys(m5).sort());
    for (const [beat, ms] of Object.entries(m5)) expect(tableMotion[beat as keyof typeof m5], beat).toBe(ms * 1.5);
  });
});
