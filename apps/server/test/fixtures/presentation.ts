import { dealBeats } from '@poker/contracts';

/**
 * How long the deal of `players` Participants lasts, two cards each with both blinds in, and `refills` of them
 * refilled: the shared deal beats' total, so a test never hardcodes the deal's length.
 */
export function dealMs(players: number, refills = 0): number {
  const ids = Array.from({ length: players }, (_, i) => `p${i}`);
  return dealBeats({ dealt: ids.map(participantId => ({ participantId, cardCount: 2 })), blinds: ids.slice(0, 2), refills: ids.slice(0, refills).map(participantId => ({ participantId, amount: 1000 })) }).totalMs;
}
