"""Independent v1 vector calculation using only Python's standard library."""
import hashlib
import hmac
import json

message = json.dumps(["poker-random-v1", "deck", 1], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
seed = hmac.new(b"heads-up-fixture", message, hashlib.sha256).digest()

def words():
    for counter in range(2**64):
        block = hmac.new(seed, b"poker-rng-v1" + counter.to_bytes(8, "big"), hashlib.sha256).digest()
        for offset in range(0, 32, 4):
            yield int.from_bytes(block[offset:offset + 4], "big")

stream = words()
deck = [rank + suit for suit in "cdhs" for rank in "23456789TJQKA"]
for index in range(51, 0, -1):
    n = index + 1
    limit = 2**32 - (2**32 % n)
    while (word := next(stream)) >= limit:
        pass
    chosen = word % n
    deck[index], deck[chosen] = deck[chosen], deck[index]

print(seed.hex())
print([next_word for _, next_word in zip(range(8), words())])
print(" ".join(deck))
print(hashlib.sha256(" ".join(deck).encode("ascii")).hexdigest())
