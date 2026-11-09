import { describe, expect, it } from 'vitest';
import { baselinePlayingStrategy, defaultConfiguration, defaultTrainerConfiguration, simpleHeuristicPlayingStrategy, type ObservableTableSession } from '@poker/contracts';
import { defaultOnlineSetup, onlineCreationRequest, onlineSetupProblem } from '../src/online-setup.js';
import { canManage, modeLabel, playerName } from '../src/table-model.js';

function table(overrides: Partial<ObservableTableSession> = {}): ObservableTableSession {
  return {
    tableSessionId: 't', mode: 'online', options: { actionTimeLimitSeconds: 30, allowLiveAnalysis: true }, viewerParticipantId: 'ben', ownerParticipantId: 'ann',
    pokerRevision: 1, sessionRevision: 1, trainerConfiguration: defaultTrainerConfiguration, inspection: { adminMode: false, completedHands: [] },
    bindings: [{ participantId: 'ann', name: 'Ann', controller: { kind: 'human' } }, { participantId: 'ben', name: 'Ben', controller: { kind: 'human' } }, { participantId: 'rex', name: 'Rex', controller: { kind: 'bot', playingStrategy: baselinePlayingStrategy } }],
    view: { configuration: defaultConfiguration, history: [], state: { status: 'between-hands', buttonSeat: 1, participants: [], board: [], pots: [], actorId: null, legalActions: [] } },
    ...overrides,
  };
}

describe('creating an Online Table', () => {
  it('asks only for the table size by default: 30 second limit, Live Analysis and seat changes allowed, no Bots', () => {
    expect(onlineSetupProblem(defaultOnlineSetup)).toBeUndefined();
    expect(onlineCreationRequest(defaultOnlineSetup, 'r')).toEqual({
      requestId: 'r', mode: 'online',
      configuration: { seatCount: 6, smallBlind: 10, bigBlind: 20, ante: 0, minimumBuyIn: 400, defaultBuyIn: 2000, maximumBuyIn: 4000, allowSeatChanges: true },
      options: { actionTimeLimitSeconds: 30, allowLiveAnalysis: true },
      bots: [],
    });
  });
  it('sends the chosen options, limit and distinctly named Bots', () => {
    const setup = { ...defaultOnlineSetup, seatCount: 4, smallBlind: 5, bigBlind: 10, ante: 1, startingStackBB: 50, minimumBuyInBB: 20, maximumBuyInBB: 100, actionTimeLimitSeconds: 15 as const, allowLiveAnalysis: false, allowSeatChanges: false, bots: 2, botStrategy: simpleHeuristicPlayingStrategy };
    expect(onlineCreationRequest(setup, 'r')).toEqual({
      requestId: 'r', mode: 'online',
      configuration: { seatCount: 4, smallBlind: 5, bigBlind: 10, ante: 1, minimumBuyIn: 200, defaultBuyIn: 500, maximumBuyIn: 1000, allowSeatChanges: false },
      options: { actionTimeLimitSeconds: 15, allowLiveAnalysis: false },
      bots: [{ name: 'Bot 1', playingStrategy: simpleHeuristicPlayingStrategy }, { name: 'Bot 2', playingStrategy: simpleHeuristicPlayingStrategy }],
    });
  });
  it.each([
    [{ seatCount: 1 }], [{ seatCount: 10 }], [{ bigBlind: 5 }], [{ smallBlind: 0 }], [{ ante: -1 }],
    [{ bots: 6 }], [{ bots: -1 }], [{ startingStackBB: 10 }], [{ startingStackBB: 500 }], [{ minimumBuyInBB: 0 }],
  ])('explains why %j cannot be created', override => {
    const setup = { ...defaultOnlineSetup, ...override };
    expect(onlineSetupProblem(setup)).toEqual(expect.any(String));
    expect(onlineCreationRequest(setup, 'r')).toBeUndefined();
  });
});

describe('who a Participant may manage', () => {
  it('lets everyone manage only themselves, and the owner also manage Bots', () => {
    const guest = table(), owner = table({ viewerParticipantId: 'ann' });
    const [ann, ben, rex] = guest.bindings as [typeof guest.bindings[number], typeof guest.bindings[number], typeof guest.bindings[number]];
    expect([ann, ben, rex].map(binding => canManage(guest, binding))).toEqual([false, true, false]);
    expect([ann, ben, rex].map(binding => canManage(owner, binding))).toEqual([true, false, true]);
  });
  it('names the viewer "You" and everyone else by name, and labels the mode', () => {
    expect(table().bindings.map(binding => playerName(table(), binding))).toEqual(['Ann', 'You', 'Rex']);
    expect([modeLabel('online'), modeLabel('practice')]).toEqual(['Online', 'Practice']);
  });
});
