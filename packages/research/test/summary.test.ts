import { expect, test } from 'vitest';
import { calculateScoreSummary } from '../src/index.js';
test.each([
  { decisions: [], expected: undefined },
  { decisions: [{ decisionScore: 1, actionRankScore: 1 }], expected: { decisionScore: 1, actionRankScore: 1 } },
  { decisions: [{ decisionScore: 0, actionRankScore: 0 }, { decisionScore: .3, actionRankScore: .5 }, { decisionScore: 0, actionRankScore: 0 }], expected: { decisionScore: .1, actionRankScore: 1 / 6 } },
])('complete accepted-decision scores produce independent arithmetic means: $expected', ({ decisions, expected }) => {
  const result = calculateScoreSummary(decisions);
  if (!expected) expect(result).toBeUndefined();
  else { expect(result?.decisionScore).toBeCloseTo(expected.decisionScore, 14); expect(result?.actionRankScore).toBeCloseTo(expected.actionRankScore, 14); }
});
