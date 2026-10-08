"""Independent literal all-in board-tie vectors; no production imports.

Run normally for engine seed names, or with --hex for creation's 32-byte seeds.
Only Python standard-library HMAC, SHA-256, and integer arithmetic are used.
"""
import hashlib
import hmac
import itertools
import json
import sys


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


for count, holes_at, board_at in [(3, [(0, 3), (1, 4), (2, 5)], [7, 8, 9, 11, 13]), (5, [(0, 5), (1, 6)], [11, 12, 13, 15, 17])]:
    for index in itertools.count():
        master = f"{index:064x}" if "--hex" in sys.argv else f"all-in-board-tie-{count}-{index}"
        cards = deck(master)
        board = [cards[i] for i in board_at]
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
