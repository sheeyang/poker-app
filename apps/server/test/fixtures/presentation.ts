import { dealBeats, showdownBeats, streetBeats } from '@poker/contracts';

/**
 * How long the deal of `players` Participants lasts, two cards each with both blinds in, and `refills` of them
 * refilled: the shared deal beats' total, so a test never hardcodes the deal's length.
 */
export function dealMs(players: number, refills = 0): number {
  const ids = Array.from({ length: players }, (_, i) => `p${i}`);
  return dealBeats({ dealt: ids.map(participantId => ({ participantId, cardCount: 2 })), blinds: ids.slice(0, 2), refills: ids.slice(0, refills).map(participantId => ({ participantId, amount: 1000 })) }).totalMs;
}

const ids = (count: number) => Array.from({ length: count }, (_, i) => `p${i}`);

/** How long a street reveal lasts that sweeps `swept` wagers and reveals `cardCount` board cards (the flop unless given). */
export const streetMs = (swept: number, cardCount = 3): number => streetBeats({ swept: ids(swept), cardCount }).totalMs;

/** How long a showdown lasts that sweeps `swept` wagers and turns up `shown` hands of two cards (heads-up unless given). */
export const showdownMs = (swept: number, shown = 2): number => showdownBeats({ swept: ids(swept), shown: ids(shown).map(participantId => ({ participantId, cardCount: 2 })) }).totalMs;
