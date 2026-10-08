"""Independent M1 Strategy vectors; Python stdlib only, no engine imports."""
import hashlib
import hmac
import json
import struct

MASTER = "heads-up-fixture"
PARTICIPANT = "alice"
DECISION = "hand-1/decision-1"
CHOICES = ["Fold", "Call", "Raise40", "Raise147"]


def source_vector(namespace):
    identities = ["poker-random-v1", namespace, PARTICIPANT, DECISION]
    message = json.dumps(identities, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    effective_seed = hmac.new(MASTER.encode("utf-8"), message, hashlib.sha256).digest()
    block = hmac.new(effective_seed, b"poker-rng-v1" + struct.pack(">Q", 0), hashlib.sha256).digest()
    words = struct.unpack(">8I", block)
    units = [word / 2**32 for word in words]
    return {
        "namespace": namespace,
        "tuple": identities,
        "message": message.decode("utf-8"),
        "seed": effective_seed.hex(),
        "words": words,
        "units": units,
        "uniform_samples_from_each_word": [CHOICES[int(unit * 4)] for unit in units],
    }


if __name__ == "__main__":
    for namespace in ("policy", "selector"):
        print(json.dumps(source_vector(namespace), separators=(",", ":")))
