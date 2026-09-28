# How to pick contestants

**Menu section:** Contestants

The Contestants page is the registry of every policy that can take a lane: deterministic **algorithms** and live **decision models**. Use it to find out exactly what a contestant is, then put it in a race or a controlled pairing.

## Steps

1. **Open Contestants** (`P`). Filter with *All*, *Models* or *Algorithms*, or search by name, version or family.
2. **Read the card.**
   - **Kind:** *Algorithm*, or *Live model* (served by the runner).
   - **Provenance.** How it's identified depends on its kind, which keeps the two honest:
     - **algorithms:** by their source and a hash of the code that actually runs, plus their parameters;
     - **live models:** by endpoint, pinned model, encoding, limits and fallback, plus live status (*Available* or *Offline*, with the reason).
   - **Record:** runs, waves cleared first–second–tied, and how many opponents and scenarios it has faced.
   - **Show code** or **Show encoding**: the exact rule for an algorithm, or the question template a model is asked.
3. **Check the shared contract.** Open *Shared contract* at the top. It's the observation every contestant receives and the action it must return. It's the same for all of them. Individual passenger weights are never part of it, and a safety layer vetoes unavailable cars and over-capacity departures for everyone.
4. **Put it in a lane.** Use one of the buttons on the card:
   - *Use*: opens New experiment with this contestant in lane A. Lane B keeps its current pick, or a default algorithm if that would be the same contestant.
   - *vs [peer]*: a **controlled pairing**. It puts this model against another with the same encoding and a shared 1.5 s timeout, so the setup check says *Controlled · decider*. It appears on System One models that have such a peer.
   - *vs [other version]*: puts two versions of the same policy in lanes A and B, for a version comparison.
   - *Leaderboard*: opens the rankings. It appears once the contestant has runs.
5. **Launch** from New experiment as usual (see [How to run a race](how-to-run-a-race.md)).

## Which one to use

| You want to… | Pick |
|---|---|
| A strong baseline | Nearest-Car ETA v1.3.0 (load-aware), or v1.2.0 (the plain rule) |
| A naive baseline anything smart should beat | Round robin v1.0.0 |
| Jev's best dispatching | Jev · API enc3 |
| To see a model decide differently from Nearest-Car | enc1 or enc2 (enc3 hands the model Nearest-Car's own estimate) |
| A fair model-vs-model comparison | Both models on the same encoding (*vs [peer]*) |
| A fine-tuned Laya | *Laya · fine-tuned* (one version per checkpoint), which appears when its server runs and the runner was started with `ARENA_LAYA_FT` |

For why encodings matter, see [`docs/model-setups.md`](../model-setups.md) §16 and §18.

## When a live model is missing or offline

- **None at all:** the page isn't served by the runner. Open http://127.0.0.1:8787/ after `cd runner && npm start`.
- **Offline:** the card's status says why. Examples: the key isn't set, laya-serve isn't running (start it with `runtime/laya/serve.sh`), or the checkpoint doesn't match the pin. The runner also prints one status line per backend when it starts.
- **Adding a new contestant** (an algorithm or a model) is a code change. See [How to add new benchmarks](how-to-add-new-benchmarks.md#3-add-a-contestant).
