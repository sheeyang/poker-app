import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { committedTimings, type TimingPath } from '@poker/contracts';
import { dropSaved, exportPreview, exportTimings, keepFlagged, reconcile, saveEdits, type Saved } from '../src/motion-lab-saved.js';

const flight = committedTimings.deal.cardFlight;
const file = readFileSync(new URL('../../../packages/contracts/src/timings.json', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const gone = 'gone.timing' as TimingPath;

describe('saved edits', () => {
  it('apply when made against the current committed value', () => {
    const r = reconcile({ 'deal.cardFlight': { value: flight + 100, base: flight } });
    expect(r.edits).toEqual({ 'deal.cardFlight': flight + 100 });
    expect(r.flagged).toEqual([]);
  });
  it('are flagged with both values when the committed base changed, and held back until decided', () => {
    const saved: Saved = { 'deal.cardFlight': { value: flight + 100, base: flight + 7 } };
    const r = reconcile(saved);
    expect(r.edits).toEqual({});
    expect(r.flagged).toEqual([{ path: 'deal.cardFlight', value: flight + 100, base: flight + 7, committed: flight }]);
    const kept = reconcile(keepFlagged(saved, 'deal.cardFlight'));
    expect(kept.flagged).toEqual([]);
    expect(kept.edits).toEqual({ 'deal.cardFlight': flight + 100 });
    expect(reconcile(dropSaved(saved, 'deal.cardFlight')).saved).toEqual({});
  });
  it('are dropped, noted, when the timing no longer exists', () => {
    const r = reconcile({ [gone]: { value: 5, base: 9 } });
    expect(r.removed).toEqual([gone]);
    expect(r.saved).toEqual({});
    expect(r.edits).toEqual({});
  });
  it('stop counting when equal to the committed value', () => {
    const r = reconcile({ 'deal.cardFlight': { value: flight, base: flight + 7 } });
    expect(r.saved).toEqual({});
    expect(r.edits).toEqual({});
    expect(r.flagged).toEqual([]);
  });
  it('record each edit against the committed value now, and keep a still-flagged one', () => {
    const flagged: Saved = { 'deal.turn': { value: 1, base: -1 } };
    const next = saveEdits(flagged, { 'deal.cardFlight': 900 });
    expect(next['deal.cardFlight']).toEqual({ value: 900, base: flight });
    expect(next['deal.turn']).toEqual({ value: 1, base: -1 });
  });
});

describe('export', () => {
  it('exports LF line endings, as the file is stored in git', () => expect(exportTimings({})).not.toContain('\r'));
  it('is exactly the committed file when nothing changed', () => expect(exportTimings({})).toBe(file));
  it('is the committed file with only the edited numbers changed', () => {
    const out = exportTimings({ 'deal.cardFlight': 900, 'settle.payout.online': 1 });
    expect(out).toBe(file.replace(`"cardFlight": ${flight}`, '"cardFlight": 900').replace(/("online": )\d+/, '$11'));
    expect(JSON.parse(out).settle.payout.online).toBe(1);
  });
  it('previews only changed timings, with their old values', () => {
    expect(exportPreview({ 'deal.cardFlight': 900, 'deal.turn': committedTimings.deal.turn })).toEqual([{ path: 'deal.cardFlight', old: flight, value: 900 }]);
    expect(exportPreview({})).toEqual([]);
  });
});
