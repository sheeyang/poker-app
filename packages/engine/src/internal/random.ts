import { createHmac } from 'node:crypto';

export type RandomNamespace = 'deck' | 'policy' | 'selector';
/** Version 1: UTF-8 master key, canonical ordered JSON tuple; see docs/random-v1.md. */
export function deriveSeed(masterSeed: string, namespace: RandomNamespace, ...identities: readonly (string | number)[]): string {
  if (typeof masterSeed !== 'string' || masterSeed.length === 0 || !['deck', 'policy', 'selector'].includes(namespace) || identities.some(id => typeof id !== 'string' && !(Number.isSafeInteger(id) && id >= 0))) throw new Error('Supply v1 random namespace and ordered string or nonnegative integer identities.');
  return createHmac('sha256', Buffer.from(masterSeed, 'utf8'))
    .update(JSON.stringify(['poker-random-v1', namespace, ...identities]), 'utf8').digest('hex');
}
/** Counter HMAC stream. Streams are local to each use; none is stored in CashGame state. */
export function createRandomSource(seed: string) {
  if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error('A v1 effective seed must be 32 bytes of lowercase hexadecimal.');
  const key = Buffer.from(seed, 'hex');
  let counter = 0n;
  let block = Buffer.alloc(0);
  let offset = 0;
  const uint32 = (): number => {
    if (offset === block.length) {
      if (counter > 0xffffffffffffffffn) throw new Error('Random counter exhausted.');
      const bytes = Buffer.alloc(8);
      bytes.writeBigUInt64BE(counter++);
      block = createHmac('sha256', key).update('poker-rng-v1', 'utf8').update(bytes).digest();
      offset = 0;
    }
    const word = block.readUInt32BE(offset);
    offset += 4;
    return word;
  };
  return {
    uint32,
    range(exclusiveMaximum: number): number {
      if (!Number.isSafeInteger(exclusiveMaximum) || exclusiveMaximum < 1 || exclusiveMaximum > 0x100000000) throw new Error('Random range must be an integer from 1 through 2^32.');
      const limit = 0x100000000 - (0x100000000 % exclusiveMaximum);
      let word: number;
      do { word = uint32(); } while (word >= limit);
      return word % exclusiveMaximum;
    },
    unit(): number { return uint32() / 0x100000000; },
  };
}
export function shuffledDeck(masterSeed: string, handSequence: number): string[] {
  const deck = ['c', 'd', 'h', 's'].flatMap(suit => ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'].map(rank => rank + suit));
  const random = createRandomSource(deriveSeed(masterSeed, 'deck', handSequence));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = random.range(i + 1);
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck;
}
