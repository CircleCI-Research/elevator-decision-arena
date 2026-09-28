# Laya adapter

Status: **draft for review** · 2026-09-27 · builds on [contestants.md](contestants.md) and [state-model.md](state-model.md) · the shared System One adapter for local and API models is in [model-setups.md](model-setups.md)

## 1. Summary

Laya ([`convaiinnovations/laya`](https://huggingface.co/convaiinnovations/laya), Apache 2.0) is a non-autoregressive decision model. It takes a **state** and **typed questions**, and scores every option of a question in one forward pass (about 33–40 ms on a T4 GPU, 190–460 ms on CPU). It never generates text, so there is nothing to parse.

That fits the arena's contract closely:

| Arena contract | Laya |
|---|---|
| The engine builds the legal `options` | A `choice` question whose `criteria` are defined per request ("new schemas need no retraining") |
| `distribution` over options | Softmax over the question's options |
| Observation from the state catalogue | `state` as JSON |
| No parsing, no invented actions | Laya can only pick one of the given keys |

The adapter is written in **TypeScript** and talks to a **local** Laya server over HTTP. Its job is to turn an observation into one Laya request, deterministically, and to turn the answer into an action. Everything it does is versioned as the contestant's **encoding** and **parameters**.

## 2. What the model card tells us (and what it changes)

| Fact from the model card | Consequence for the arena |
|---|---|
| Base checkpoints score near chance zero-shot (0.362 on typed decisions); fine-tuning raised it to 0.766. "A fast base to specialise, not a zero-shot decision engine." | Expect the base checkpoint to lose to Nearest-Car at first. The arena should **export decision datasets** for fine-tuning (§8), and fine-tuned checkpoints become new contestant versions. |
| Ships over-confident; one temperature per (question type, option count) cuts calibration error from 0.466 to 0.081. | Temperatures are a **parameter** of the version, fitted on arena data and hashed. Without them the decision panels would show false certainty. |
| Options share a fixed token budget (`head_max_len` 192 English, 256 multilingual); the state gets the rest (~320 or ~768 tokens). | The encoding must be **compact**, and its size must be checked against the largest allowed building (120 floors, 16 cars) at registration. Truncation is never silent (§4.4). |
| `noul` can follow its `false:`/`true:` labels instead of the state; the card recommends a two-option `choice` with neutral keys. | Use only `choice`, always with **neutral keys**. |
| `Router` picks a checkpoint by detecting the language. | Always **pin the checkpoint** explicitly. A run must never switch model because of routing. The returned `routing` is recorded and checked. |
| `action.act_probability` carries no usable signal; `confidence` does. | Ignore `act_probability`. Record `confidence`. |
| `laya-serve` binds `0.0.0.0` with no authentication unless `LAYA_API_KEY` is set. | Bind to `127.0.0.1` and always set a key (§6). |
| Determinism is not stated. There is a GPU fast path (TileLang) and CPU fallback. | Determinism is **measured** at registration, never assumed (§7). |

## 3. How a decision flows

```
engine ──observation──▶ encoder ──{state, questions}──▶ laya-serve ──answers──▶ decoder ──action──▶ engine
          (state v1)     (TS, pure)                    (Python, local)          (TS, pure)
```

1. The engine builds the observation (state catalogue, filtered by the visibility profile) and the legal options.
2. The **encoder** renders one request. It is a pure function: the same observation and parameters give byte-identical JSON.
3. The adapter sends it to the local server and measures the round trip.
4. The **decoder** maps the answer back to an option index and a distribution, applying the version's temperature.
5. The adapter returns `{choice, distribution}`, and records the rendered request, the raw response, the routing and the latency.

## 4. Encoding `laya-encoding v1`

### 4.1 One question per decision

| Request | Question | Options |
|---|---|---|
| `assign` | "Which car should answer this hall call?" | One per legal car |
| `overload` | "The car is over capacity. What should it do?" | The engine's recovery options |

Always `type: "choice"`, and always a single question per call (lowest latency, no interaction between questions).

### 4.2 State

The state is a compact JSON object built from catalogue variables, with units in the key names so the model never has to guess them. Only variables visible under the profile are included, in catalogue order, with the catalogue's precision.

```json
{
  "request": {"kind": "assign", "floor": 7, "dir": "up", "reason": "new", "t_s": 132.4},
  "building": {"floors": 24, "cars": 4},
  "history": {"window_s": 120, "calls_up_by_floor": {"0": 18, "7": 3}, "calls_down_by_floor": {"12": 2}}
}
```

Car details are **not** repeated in the state. They go into each option's description (4.3), so the model reads each car next to the option it scores.

### 4.3 Options

Keys are neutral letters (`A`, `B`, …), so a label like `car_0` can't bias the answer. Each description is a fixed template filled from the car's variables:

```json
"criteria": {
  "A": "floor 3.2, moving up, doors closed, 150 of 630 kg, 2 stops, 1 call, not coming",
  "B": "floor 12.0, idle, doors open, 0 of 630 kg, 0 stops, 0 calls, not coming",
  "C": "offline"
}
```

- Templates render only facts (state-model §3). No distances, ETAs or hints.
- **Option order:** a parameter, either `fixed` (car order) or `shuffled` with the run's seeded RNG, to neutralise position bias. Shuffling is recorded and reversed by the decoder.
- Advanced features add fields to the template (for example `serves floors 0–12`) only when they are enabled.

### 4.4 Size budget

The encoder counts tokens with the checkpoint's own tokenizer (shipped with the adapter, pinned to the same revision) before sending:

- If it doesn't fit, the encoder applies **declared** reductions in order: shorten history to its top floors, then drop history. It never drops car options.
- Every reduction is recorded on the decision (`truncated: history-top-8`), and the audit counts them.
- At registration, fixtures for the largest allowed building must fit **without** dropping cars. If they don't, the version needs a larger `head_max_len`/`max_len` or is rejected.

Rough budget: 16 options at about 20 tokens each is 320 tokens, above the default `head_max_len` of 256. Large buildings therefore need `head_max_len` 512 and `max_len` 1024 or more, which the card documents.

### 4.5 Decoding

- Read the probabilities for all option keys, apply the version's temperature, and map keys back to option indexes.
- **Decision rule** (parameter): `argmax` (default) or `sample` with the seeded RNG. `argmax` makes Laya deterministic if the runtime is.
- `laya-serve` uses Jev's response format, which includes `probabilities` for every option. **Confirmed in the spike** ([model-setups.md](model-setups.md) §13): no sidecar is needed. Identity comes from `GET /health` (checkpoint, commit SHA, device), not from the response's `model` field.

## 5. Identity: engine, encoding, parameters

Every Laya version records three layers, all hashed into its `configHash`:

| Layer | Fields |
|---|---|
| **Engine** | Checkpoint (`laya`, `laya-multilingual`, `laya-typed-decisions`, or a fine-tune), Hub repo and **commit SHA**, weights SHA-256, `laya` package version, device (`cuda` or `cpu`), fast path on or off |
| **Encoding** | `laya-encoding v1`, instructions text, option templates, key style, state fields used, reduction order |
| **Parameters** | `max_len`, `head_max_len`, temperatures per option count, decision rule, option order, `timeout_ms`, fallback |

Example manifest:

```yaml
contract: v1
state: ">=1.0 <2"
id: laya
name: Laya
version: 0.3.0
kind: model
adapter:
  type: local-model
  runtime: laya-serve
  package: laya==0.3.20
  checkpoint: convaiinnovations/laya
  revision: <hub commit sha>
  weights_sha256: <hash>
  device: cuda
encoding: laya-encoding@1
reads: [request.*, building.*, cars[].*, history.perFloor]
params:
  max_len: 1024
  head_max_len: 512
  temperature: { "2": 1.8, "4": 2.1, "8": 2.4, "16": 2.6 }
  decision: argmax
  option_order: shuffled
limits: { timeout_ms: 400 }
fallback: nearest-car-eta@1.3.0
```

Changing any of these makes a new version. "Laya with a different wording" is a different contestant, and the leaderboard can rank the two.

## 6. Runtime

**Server.** Laya runs in Python, so the adapter uses a local server:

- `laya-serve` with `LAYA_PRELOAD=1`, bound to `127.0.0.1`, with `LAYA_API_KEY` set. The key lives in the operator's environment, never in manifests or run files.
- If `laya-serve` can't pin a checkpoint and revision per request, or doesn't return the full distribution, we add a **thin sidecar** (`arena-laya`, about 50 lines of Python) that loads the pinned checkpoint with `laya.load(repo, subfolder, revision)` and returns every option's probability. Same request shape, same port conventions.
- On start the adapter calls the server once and checks that it reports the pinned checkpoint, revision and package version. If they don't match, it refuses to race.

**Concurrency.** Parallel runs share one server. The adapter queues requests per server, and the measured latency includes queueing, which is realistic but must be reported. Benchmarks that measure speed should run one Laya run at a time (a hint in New experiment).

**Decision time in the simulation.** Real latency varies by a few milliseconds from call to call, so two runs with identical choices could still differ. The experiment chooses how decision time enters the simulation, and both lanes use the same rule:

| Mode | Decision lands after | Use it for |
|---|---|---|
| `measured` (default) | The real round-trip time | Realistic comparisons, including speed |
| `fixed` | One fixed time (for example 0.25 s) for every decision, in both lanes, whoever makes it | Comparing decision quality only; reruns are exactly reproducible if the model is deterministic |

The mode is part of the definition hash. Measured latency is always recorded either way. (An earlier draft had a `nominal` mode using each version's own declared latency. That still lets speed differ between lanes, so it was replaced by `fixed`.)

## 7. Validation at registration

On top of the general suite (contestants.md §6.2):

- **Identity check:** the server reports exactly the pinned checkpoint, revision and package.
- **Budget check:** every fixture fits, including 120 floors × 16 cars with full history, without dropping options.
- **Determinism probe:** each fixture is asked 5 times. The result is reported as *deterministic*, or as *varies* with the rate of differing choices. A `varies` version still races, but runs of it are treated as stochastic replications.
- **Calibration report:** if temperatures are given, the expected calibration error on a held-out arena dataset is shown on the contestant card.
- **Latency profile:** p50 and p95 per option count, on the registered device. This also suggests `timeout_ms`.

## 8. Fine-tuning data (outside the arena)

Training stays a non-goal inside the arena, but the arena is the natural source of training data:

- **Export decisions** from any run as a dataset in Laya's format: the rendered `{state, questions}`, the choice made and the outcome that followed (wait and ride time of the passengers served by that choice).
- **Labels** come from a declared source, for example the best algorithm's choice in the same situation, or a hindsight label computed after the run. The export records the label source, the runs used and the scenarios, so a fine-tuned checkpoint's training data is traceable.
- **Guard against leakage:** exports record the scenario seeds they came from. A fine-tuned version that was trained on a seed is flagged when it races on that seed.

The fine-tuned checkpoint is then pushed to the Hub, and it becomes a new Laya version with its own revision.

## 9. Delivery

1. **Spike (1–2 days):** run `laya-serve` locally, and verify revision pinning, the full distribution in the response, determinism on CPU and GPU, and latency. Decide between `laya-serve` and the sidecar.
2. **Encoder and decoder** in TypeScript, with golden-file tests: fixture observation → exact request bytes.
3. **Adapter and validation** (identity, budget, determinism, latency), and the Laya version registered as `laya@0.3.0` against the base checkpoint.
4. **Arena integration:** the request and response viewer in Audit, measured and fixed decision time, fallback and benching.
5. **Dataset export** for fine-tuning.

## 10. Open questions

- **Q1. Default decision-time mode:** `measured` (realistic, not exactly rerunnable) or `fixed` (exactly rerunnable, ignores real speed)? Proposal: `measured`, with `fixed` available for quality-only studies. (Implemented this way in the prototype.)
- **Q2. Training labels:** best algorithm's choice (easy, but Laya learns to imitate the algorithm) or hindsight outcomes (harder, but can beat it)? Proposal: start with imitation of Nearest-Car ETA to get a working model, then move to hindsight labels.
- **Q3. Device for benchmarks:** GPU or CPU? Decision time differs by 5–10×, and on CPU (190–460 ms per decision) it would dominate the results. Proposal: record the device, and treat it as part of the contestant version so they never mix.
