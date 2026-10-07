export const handCategories = ['high-card', 'one-pair', 'two-pair', 'three-of-a-kind', 'straight', 'flush', 'full-house', 'four-of-a-kind', 'straight-flush'] as const;
export interface HandRank { readonly category: typeof handCategories[number]; readonly kickers: readonly number[] }

/** Positive means left wins. Suits are deliberately absent from the rank. */
export function compareHandRanks(left: HandRank, right: HandRank): number {
  const category = handCategories.indexOf(left.category) - handCategories.indexOf(right.category);
  if (category !== 0) return category;
  for (let i = 0; i < left.kickers.length; i++) {
    const difference = left.kickers[i]! - right.kickers[i]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function rankFive(cards: readonly string[]): HandRank {
  const ranks = cards.map(card => '23456789TJQKA'.indexOf(card[0]!) + 2).sort((a, b) => b - a);
  const groups = [...new Set(ranks)].map(rank => ({ rank, count: ranks.filter(value => value === rank).length })).sort((a, b) => b.count - a.count || b.rank - a.rank);
  const flush = cards.every(card => card[1] === cards[0]![1]);
  const straight = groups.length === 5 && ranks[0]! - ranks[4]! === 4 ? ranks[0]!
    : ranks.join(',') === '14,5,4,3,2' ? 5 : 0;
  if (flush && straight) return { category: 'straight-flush', kickers: [straight] };
  if (groups[0]!.count === 4) return { category: 'four-of-a-kind', kickers: groups.map(g => g.rank) };
  if (groups[0]!.count === 3 && groups[1]!.count === 2) return { category: 'full-house', kickers: groups.map(g => g.rank) };
  if (flush) return { category: 'flush', kickers: ranks };
  if (straight) return { category: 'straight', kickers: [straight] };
  if (groups[0]!.count === 3) return { category: 'three-of-a-kind', kickers: groups.map(g => g.rank) };
  if (groups[0]!.count === 2 && groups[1]!.count === 2) return { category: 'two-pair', kickers: groups.map(g => g.rank) };
  if (groups[0]!.count === 2) return { category: 'one-pair', kickers: groups.map(g => g.rank) };
  return { category: 'high-card', kickers: ranks };
}

/** Evaluates explicit five, six, or seven distinct canonical cards, without reading game state. */
export function rankHand(cards: readonly string[]): HandRank {
  if (cards.length < 5 || cards.length > 7 || new Set(cards).size !== cards.length || cards.some(card => !/^[2-9TJQKA][cdhs]$/.test(card)))
    throw new Error('Hand ranking requires five to seven distinct canonical cards.');
  let best: HandRank | undefined;
  for (let a = 0; a < cards.length - 4; a++) for (let b = a + 1; b < cards.length - 3; b++)
    for (let c = b + 1; c < cards.length - 2; c++) for (let d = c + 1; d < cards.length - 1; d++) for (let e = d + 1; e < cards.length; e++) {
      const rank = rankFive([cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!]);
      if (!best || compareHandRanks(rank, best) > 0) best = rank;
    }
  return Object.freeze({ category: best!.category, kickers: Object.freeze([...best!.kickers]) });
}
