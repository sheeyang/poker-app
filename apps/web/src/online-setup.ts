import { defaultPlayingStrategy, type ActionTimeLimitSeconds, type CreateTableSessionRequest, type StrategyDescriptor } from '@poker/contracts';

/** What the Online creation form edits: blinds in chips, stacks and buy-in limits in big blinds. */
export interface OnlineSetup {
  readonly seatCount: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante: number;
  readonly startingStackBB: number;
  readonly minimumBuyInBB: number;
  readonly maximumBuyInBB: number;
  readonly actionTimeLimitSeconds: ActionTimeLimitSeconds;
  readonly allowLiveAnalysis: boolean;
  readonly allowSeatChanges: boolean;
  readonly bots: number;
  readonly botStrategy: StrategyDescriptor;
}
export const defaultOnlineSetup: OnlineSetup = {
  seatCount: 6, smallBlind: 10, bigBlind: 20, ante: 0, startingStackBB: 100, minimumBuyInBB: 20, maximumBuyInBB: 200,
  actionTimeLimitSeconds: 30, allowLiveAnalysis: true, allowSeatChanges: true, bots: 0, botStrategy: defaultPlayingStrategy,
};

/** Why this setup cannot be created, in words for the person filling in the form; undefined when it can. */
export function onlineSetupProblem(setup: OnlineSetup): string | undefined {
  const whole = (value: number) => Number.isSafeInteger(value);
  if (!whole(setup.seatCount) || setup.seatCount < 2 || setup.seatCount > 9) return 'Choose 2 to 9 seats.';
  if (!whole(setup.smallBlind) || setup.smallBlind < 1) return 'The small blind must be a whole number of chips, at least 1.';
  if (!whole(setup.bigBlind) || setup.bigBlind < setup.smallBlind) return 'The big blind must be a whole number of chips, at least the small blind.';
  if (!whole(setup.ante) || setup.ante < 0) return 'The ante must be a whole number of chips, 0 or more.';
  if (!whole(setup.minimumBuyInBB) || setup.minimumBuyInBB < 1) return 'The minimum buy-in must be at least 1 big blind.';
  if (!whole(setup.startingStackBB) || setup.startingStackBB < setup.minimumBuyInBB) return 'The starting stack cannot be below the minimum buy-in.';
  if (!whole(setup.maximumBuyInBB) || setup.maximumBuyInBB < setup.startingStackBB || !whole(setup.bigBlind * setup.maximumBuyInBB)) return 'The maximum buy-in cannot be below the starting stack.';
  if (!whole(setup.bots) || setup.bots < 0 || setup.bots > setup.seatCount - 1) return 'Leave at least one seat for a person: add at most ' + (setup.seatCount - 1) + ' Bots.';
}

export function onlineCreationRequest(setup: OnlineSetup, requestId: string): CreateTableSessionRequest | undefined {
  if (onlineSetupProblem(setup)) return undefined;
  return {
    requestId, mode: 'online',
    configuration: {
      seatCount: setup.seatCount, smallBlind: setup.smallBlind, bigBlind: setup.bigBlind, ante: setup.ante,
      minimumBuyIn: setup.bigBlind * setup.minimumBuyInBB, defaultBuyIn: setup.bigBlind * setup.startingStackBB, maximumBuyIn: setup.bigBlind * setup.maximumBuyInBB,
      allowSeatChanges: setup.allowSeatChanges,
    },
    options: { actionTimeLimitSeconds: setup.actionTimeLimitSeconds, allowLiveAnalysis: setup.allowLiveAnalysis },
    bots: Array.from({ length: setup.bots }, (_, index) => ({ name: `Bot ${index + 1}`, playingStrategy: setup.botStrategy })),
  };
}
