"""Independent literal all-in tie vectors; no production imports.

Run normally for engine seed names, or with --hex for creation's 32-byte seeds.
Add --live-odd for two tied hands beating three live short all-ins.
Only Python standard-library HMAC, SHA-256, and integer arithmetic are used.
"""
import hashlib
import hmac
import itertools
import json
import sys
from collections import Counter


def deck(master):
    seed = hmac.new(master.encode(), json.dumps(["poker-random-v1", "deck", 1], separators=(",", ":")).encode(), hashlib.sha256).digest()

    def words():
        for counter in itertools.count():
            block = hmac.new(seed, b"poker-rng-v1" + counter.to_bytes(8, "big"), hashlib.sha256).digest()
            for offset in range(0, 32, 4):
                yield int.from_bytes(block[offset:offset + 4], "big")

    stream = words()
    cards = [rank + suit for suit in "cdhs" for rank in "23456789TJQKA"]
    for index in range(51, 0, -1):
        n = index + 1
        limit = 2**32 - 2**32 % n
        word = next(stream)
        while word >= limit:
            word = next(stream)
        chosen = word % n
        cards[index], cards[chosen] = cards[chosen], cards[index]
    return cards


def straight_high(cards):
    ranks = sorted(set("23456789TJQKA".index(card[0]) + 2 for card in cards))
    if ranks == [2, 3, 4, 5, 14]:
        return 5
    return ranks[-1] if len(ranks) == 5 and ranks[-1] - ranks[0] == 4 else 0


def rank_five(cards):
    ranks = sorted(("23456789TJQKA".index(card[0]) + 2 for card in cards), reverse=True)
    groups = sorted(((count, rank) for rank, count in Counter(ranks).items()), reverse=True)
    flush = len(set(card[1] for card in cards)) == 1
    straight = straight_high(cards)
    if flush and straight:
        return (8, straight)
    if groups[0][0] == 4:
        return (7, groups[0][1], groups[1][1])
    if [group[0] for group in groups] == [3, 2]:
        return (6, groups[0][1], groups[1][1])
    if flush:
        return (5, *ranks)
    if straight:
        return (4, straight)
    if groups[0][0] == 3:
        return (3, groups[0][1], *sorted((group[1] for group in groups[1:]), reverse=True))
    if [group[0] for group in groups[:2]] == [2, 2]:
        return (2, groups[0][1], groups[1][1], groups[2][1])
    if groups[0][0] == 2:
        return (1, groups[0][1], *sorted((group[1] for group in groups[1:]), reverse=True))
    return (0, *ranks)


def rank_seven(cards):
    return max(rank_five(list(five)) for five in itertools.combinations(cards, 5))


for count, holes_at, board_at in [(3, [(0, 3), (1, 4), (2, 5)], [7, 8, 9, 11, 13]), (5, [(0, 5), (1, 6)], [11, 12, 13, 15, 17])]:
    for index in itertools.count():
        master = f"{index:064x}" if "--hex" in sys.argv else f"all-in-board-tie-{count}-{index}"
        cards = deck(master)
        board = [cards[i] for i in board_at]
        if count == 5 and "--live-odd" in sys.argv:
            # Deal order A, B, E, C, D with button D. A/B must tie above
            # all three live short stacks, not merely play a tied board.
            holes = [[cards[i], cards[i + 5]] for i in [0, 1, 3, 4, 2]]
            ranks = [rank_seven(board + hole) for hole in holes]
            if ranks[0] != ranks[1] or any(rank >= ranks[0] for rank in ranks[2:]):
                continue
            print(master, "live holes A/B/C/D/E", holes, "ranks", ranks, "board", board, "burns", [cards[i] for i in [10, 14, 16]])
            print("draws", " ".join(cards[:18]))
            break
        high = straight_high(board)
        if not high or len(set(c[1] for c in board)) < 3:
            continue
        holes = [[cards[i] for i in indexes] for indexes in holes_at]
        # Distinct board ranks prevent a full house or quads with just two hole
        # cards. Exclude flushes and higher straights independently for each hand.
        if any(max(sum(c[1] == suit for c in board + hole) for suit in "cdhs") >= 5 or max(straight_high(list(five)) for five in itertools.combinations(board + hole, 5)) > high for hole in holes):
            continue
        print(master, "holes", holes, "board", board, "burns", [cards[i] for i in [count * 2, count * 2 + 4, count * 2 + 6]])
        print("draws", " ".join(cards[:count * 2 + 8]))
        break
