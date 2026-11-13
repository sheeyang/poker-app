import { dealBeats, payoutBeats } from '@poker/contracts';

/**
 * How long the deal of `players` Participants lasts, two cards each with both blinds in, and `refills` of them
 * refilled: the shared deal beats' total, so a test never hardcodes the deal's length.
 */
export function dealMs(players: number, refills = 0): number {
  const ids = Array.from({ length: players }, (_, i) => `p${i}`);
  return dealBeats({ dealt: ids.map(participantId => ({ participantId, cardCount: 2 })), blinds: ids.slice(0, 2), refills: ids.slice(0, refills).map(participantId => ({ participantId, amount: 1000 })) }).totalMs;
}

/** How long a payout to `winners` Participants lasts: the shared payout beats' total, as for one winner unless given. */
export function payoutMs(winners = 1): number {
  return payoutBeats({ awards: Array.from({ length: winners }, (_, i) => ({ participantId: `p${i}`, won: 100, returned: 0 })) }).totalMs;
}
