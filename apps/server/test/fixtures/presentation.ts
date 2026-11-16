import { dealBeats, payoutBeats, showdownBeats, streetBeats } from '@poker/contracts';

/** `count` Participant IDs, as the shared beats need them: only how many there are changes a phase's length. */
const ids = (count: number) => Array.from({ length: count }, (_, i) => `p${i}`);

/**
 * How long the deal of `players` Participants lasts, two cards each with both blinds in and no refill: the shared deal
 * beats' total, so a test never hardcodes the deal's length.
 */
export function dealMs(players: number): number {
  const dealt = ids(players);
  return dealBeats({ dealt: dealt.map(participantId => ({ participantId, cardCount: 2 })), blinds: dealt.slice(0, 2), refills: [] }).totalMs;
}

/** How long a street reveal lasts that sweeps `swept` wagers and reveals `cardCount` board cards (the flop unless given). */
export const streetMs = (swept: number, cardCount = 3): number => streetBeats({ swept: ids(swept), cardCount }).totalMs;

/** How long a showdown lasts that sweeps `swept` wagers and turns up `shown` hands of two cards (heads-up unless given). */
export const showdownMs = (swept: number, shown = 2): number => showdownBeats({ swept: ids(swept), shown: ids(shown).map(participantId => ({ participantId, cardCount: 2 })) }).totalMs;

/** How long a payout to `winners` Participants lasts: the shared payout beats' total, as for one winner unless given. */
export function payoutMs(winners = 1): number {
  return payoutBeats({ awards: ids(winners).map(participantId => ({ participantId, won: 100, returned: 0 })) }).totalMs;
}
