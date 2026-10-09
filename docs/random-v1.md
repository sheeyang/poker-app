# Deterministic randomness v1

Version `v1` records lock the following byte-level algorithms. Randomness is
reconstructed from the master seed and accepted commands; effective seeds, decks,
generator state, and draws are never additional replay authorities. The master
seed is a nonempty JavaScript string encoded as UTF-8 (the Node UTF-8 encoder
replaces unpaired surrogates with U+FFFD). It is available only to trusted code.

## Independent derivation

`deriveSeed(masterSeed, namespace, ...identities)` returns the lowercase hex of
HMAC-SHA256. The key is the UTF-8 master seed. The message is UTF-8 encoding of
`JSON.stringify(["poker-random-v1", namespace, ...identities])`, with no whitespace
or newline. Identities are ordered strings or nonnegative safe integer numbers.
JSON string escaping and tuple boundaries distinguish otherwise ambiguous inputs.

The namespaces are `deck`, `policy`, and `selector`, directly under the master
key. Deck identities contain only the one-based authoritative Hand sequence.
Policy and selector jobs use ParticipantId and DecisionId in that order; job
orchestration may append declared implementation/version/configuration identity
strings. Callers must keep their identity ordering stable. Random work in one
namespace never consumes another namespace's stream or influences Hand identity.
The engine exposes the pure derivation/source functions to trusted consumers;
the browser receives neither master nor effective job seeds through game views.

## Generator and integer sampling

An effective seed is exactly 32 bytes expressed as 64 lowercase hex characters.
The generator uses those decoded bytes as an HMAC-SHA256 key. Block `k`, starting
at unsigned counter zero, is HMAC of the concatenation of UTF-8 `poker-rng-v1`
and the counter encoded in eight big-endian bytes. Each block supplies eight
unsigned big-endian 32-bit integers in byte order. Exhaustion of the 64-bit
counter fails explicitly. A fresh source starts at the first word of block zero.

`range(n)` accepts integer `1 <= n <= 2^32`. Let `limit = 2^32 - (2^32 % n)`.
Discard words `u >= limit` until one is smaller, and return `u % n`. This is
rejection sampling, so each accepted integer in `[0,n)` has equal probability.
`unit()` returns one unsigned word divided by `2^32`, in `[0,1)`; it consumes
exactly one word. No ambient random generator or clock enters these algorithms.

## Deck, shuffle, and dealing

Canonical cards use ranks `2 3 4 5 6 7 8 9 T J Q K A` within each suit in order
`c d h s` (clubs, diamonds, hearts, spades): `2c` through `Ac`, then diamonds,
hearts, and spades. Shuffle with descending Fisher-Yates: for indices `51` down
through `1`, draw `j = range(i+1)` and swap cards `i` and `j`. Draw from index zero
upward. Each Hand constructs its own source from its derived deck seed.

Heads-up, the button/small blind receives the first card. Two clockwise passes
give deck indices `(0,2)` to the button and `(1,3)` to the big blind. Multiway
passes begin after the button. Membership and positions freeze before capped
antes and blinds. A preflop fold consumes only the four heads-up hole-card draws;
future streets and burns remain unused. Hand `n` has identity `hand-n`; decision
`d` in that Hand has identity `hand-n/decision-d`. These counters describe poker
facts, independently of setup-command counts or server revisions.

## Independent vectors

The Python standard-library calculation in
[fixtures/random-v1.py](fixtures/random-v1.py) does not import the production
engine. The public engine tests retain its literal results, rather than computing
expectations with production random functions.

For master seed `heads-up-fixture`, namespace `deck`, Hand sequence `1`:

- Effective seed: `7301fd6c111afc254b1a55f746ab1427967ce525ecae4d9ea2bbc14ae9b243ab`
- First words: `3739461826, 2798863395, 228657779, 3613768761, 2724625569, 826852747, 3854371043, 470371394`
- `range(2147483649)` rejects the first two words and returns `228657779`.
- First deck draws: `4s 2c 5d Ah`.
- SHA-256 of all deck cards joined by single ASCII spaces, without newline:
  `7fbef7ad3ad9079e67fe7cf47071cbc7174f8a348444dbd5e720c7ed12705cb6`

Complete deck:

```text
4s 2c 5d Ah 3d 9c 4d Tc Qh Jc 5s 3c 9s 6d 8d 3s 7d Ks 7h Kc As 2h Jh 6c 7s Ts 8h Th Kd 4h 3h Kh Ad 9d Js Ac 7c Qc Qd 8c 4c 5c 8s 2d Qs 2s 6h 9h 6s 5h Td Jd
```

## M1 Policy and Action Selector identities

M1 Bot orchestration uses exactly `ParticipantId, DecisionId` after its namespace.
It appends no Strategy/version/configuration suffix. Declared implementation,
version, configuration, input fingerprint and effective seeds are retained and
checked separately as part of the Bot request identity. Changing a descriptor
keeps the independent domain seed but changes the request/assignment identity;
retrying the same decision retains the same effective seeds. Each selection
constructs a fresh source, so equal declared inputs and seeds repeat the action.

Independent Python fixtures live in [fixtures/strategy-v1.py](fixtures/strategy-v1.py).
For the UTF-8 master key `heads-up-fixture`, ParticipantId `alice`, DecisionId
`hand-1/decision-1`, the exact messages are:

```text
["poker-random-v1","policy","alice","hand-1/decision-1"]
["poker-random-v1","selector","alice","hand-1/decision-1"]
```

Policy effective seed:
`9306c6cddb37a44ae7bc272f280146af0412e7786fefec56c73ca607c3c9cac6`;
first word `723867575`, first unit `0.16853855340741575`.
Selector effective seed:
`50e60c430ba5b8f52529a1b5eb24082a3925f9e03e37cc18128aa37fed0247fa`;
first word `2273501134`, first unit `0.5293407323770225`.

ProbabilitySelector scans validated canonical choices using cumulative
left-closed/right-open intervals, consumes one unit from a fresh source, and
returns the final choice if only floating-point accumulation leaves a residual.
For equally likely Fold, Call, Raise-to 40, Raise-to 147, this selector seed picks
Raise-to 40. HighestProbabilitySelector consumes no seed and keeps Fold in that
tie. UniformChoicePolicy consumes no Policy randomness.
