# Contestants: adding algorithms and models

Status: **design document** · 2026-09-27, updated for v1 on 2026-09-28

## 1. Purpose

Elevator Decision Arena compares elevator dispatch policies under identical conditions. A **contestant** is any policy that can take a lane in an experiment: a deterministic algorithm, Laya, or another decision model. This document defines how contestants are **defined, registered, validated, run, recorded and replayed**, so that:

- adding a new algorithm or model never requires changes to the engine, the UI or the analysis pages;
- every result can be traced to the exact contestant version that produced it;
- someone who did not create a run can replay and verify it.

### Goals

- One contract for every contestant: the same observation in, the same kind of action out.
- Support for three kinds of runtime: in-process algorithms, local models and remote services.
- Immutable, versioned registrations with full provenance, kept separately for models and algorithms.
- Automatic checks before a contestant can race: contract conformance, determinism where promised, and a smoke run.
- Safe racing: timeouts, fallbacks and illegal actions are handled by the engine and recorded.

### Non-goals (for now)

- Training or fine-tuning models inside the arena.
- More than two contestants per run. The arena shows two buildings side by side. Leagues across many contestants come from many runs, as they do today.
- Hosting third-party models on behalf of others.

## 2. What v1 already establishes

The v1 app (`app/js/sim/registry.js`, originally with eight mock contestants, now four algorithms plus live models from the runner) has a working registry, and the rest of the app already consumes it generically:

- Lane A and Lane B pickers in New experiment; any pairing except a policy against itself.
- Kind-specific provenance stored in every run record and run file (prompt and config hashes for models, source and code hash for algorithms).
- Replay feeds recorded decisions back in and never re-asks the policy. Verification checks the definition hash, per-decision request matching, the result fingerprint and a decision-log hash.
- Leaderboard and SLA lab treat contestants as a league (registry colours, provisional status below 5 runs).

The engine phase keeps these behaviours and replaces the mocks with real adapters. Three shortcuts from the early app must **not** carry over into the engine (see §4.3):

1. In-process algorithms build their own list of options. In the engine, **the engine** offers the legal options.
2. In-process algorithms report their own latency. In the engine, **the engine** measures it.
3. The early mock "models" were scripted softmaxes (since removed). Real models run through adapters.

## 3. Concepts

| Term | Meaning |
|---|---|
| **Contestant** | A named policy family, for example `laya` or `nearest-car-eta`. |
| **Version** | An immutable registration of a contestant, for example `laya@0.2.0`. Runs always reference a version. |
| **Kind** | `algorithm` (deterministic) or `model` (may be stochastic). Recorded differently; raced identically. |
| **Adapter** | The code that connects a contestant's runtime to the contract (in-process, local model, remote service). |
| **Manifest** | The file that declares a version: identity, adapter, entry point, prompt, limits, fallback. |
| **Contract** | The versioned observation and action schemas every contestant implements. |
| **Registry** | The store of all registered versions and their validation results. |

## 4. The contract

Every contestant implements one call, per decision:

```
decide(observation, context) → action
```

The contract is versioned (`contract v1`, …) and hashed. The hash is recorded with every run, so a contract change is always visible in the results.

### 4.1 Observation (what a contestant may see)

Per decision the engine sends:

- `t`: sim time in seconds; `n`: decisions this contestant has made so far in the run;
- `building`: floors, number of cars, car speed;
- `request`: `assign` (a hall call: floor, direction, reason `new | reassign | retry | crowd`) or `overload` (which car);
- `cars[]`: for each car its index, fractional floor, direction, mode (`normal | overload | malfunction | out`), door phase, **total load and capacity**, planned stops, assigned calls, and whether it is already coming for this call;
- `options[]`: the **legal actions** for this request, prepared by the engine (see §4.3).

It never contains individual passenger weights, passenger identities, future arrivals, or the other contestant's state. This follows the spec: models "may know only the elevator's total current weight and maximum capacity".

Every variable in the observation is defined, versioned and filtered by the experiment's visibility profile in the **state model**: see [state-model.md](state-model.md). This section only summarises catalogue `state v1`.

### 4.2 Action (what a contestant returns)

```json
{
  "choice": 1,
  "distribution": [0.18, 0.71, 0.11],
  "rationale": "optional, short, stored but never scored"
}
```

- `choice` is an index into `options`.
- `distribution` is optional. Deterministic contestants may omit it, and the engine then records a one-hot distribution. Models should return it so the decision panels and audit can show their uncertainty.
- Anything else is ignored. A malformed action is treated as a failure (§7).

### 4.3 Changes from the early app

- **The engine builds `options`.** The contestant picks among them and cannot invent actions. The safety layer still re-checks every choice at commit time, because the world can change while a model is thinking (a car may fail). A vetoed choice is recorded and the request is retried, as v1 already does.
- **The engine measures latency** from request to answer, per decision. Contestants no longer report it. Sim-time semantics stay as in v1: the decision lands `latency` seconds after it was requested.
- **Energy per decision** is measured by the adapter where possible (device power for local models) and otherwise estimated, with the source (`measured | estimated`) recorded.

## 5. Adapters

| Adapter | Typical contestants | How it runs | Determinism | Identity recorded |
|---|---|---|---|---|
| **In-process** | Rule-based algorithms | JS/TS module, or WASM for other languages, loaded into a sandbox | Required | Content hash of the bundle, plus parameters |
| **Local model** | Laya, other local LMs | A local runtime (model server or binary) called by the adapter | Not required | Weights hash, runtime and version, prompt template hash, sampling settings, schema hashes |
| **Remote service** | Models behind an API | HTTP call to a declared endpoint | Not required | Endpoint, declared version, and the full request and response of every decision |

All three expose the same `decide` call to the engine. The adapter owns everything runtime-specific:

- **In-process:** calls the exported `decide` function directly.
- **Local model:** renders the prompt template with the observation, calls the runtime with the declared sampling settings, parses the response against the action schema, and extracts the distribution if one is available (logits or scores over the options).
- **Remote service:** same as a local model, but over HTTP, with authentication supplied by the operator and never stored in manifests or run files.

### 5.1 Sandbox rules for algorithms

To keep algorithms deterministic and replays exact:

- no network, file system or clock access;
- randomness only through the seeded `context.rng` the engine provides;
- no state kept between decisions except through what the observation carries (`n`, the cars' state). Hidden internal state would make a decision depend on history the replay can't see.

WASM gives language freedom inside the same sandbox. A separate process (for example Python) is possible, but only if it satisfies the same rules and the determinism check.

## 6. Manifest and registration

A version is declared by a manifest. Example for a model:

```yaml
contract: v1
id: laya
name: Laya
version: 0.2.0
kind: model
description: Dispatch model under test.
adapter:
  type: local-model
  runtime: <runtime name and version>
  model: <path or model identifier>
  weights_sha256: <hash>
  sampling: { temperature: 0.4, top_p: 0.9, seed_from_context: true }
prompt:
  template: prompts/laya-dispatch.md
  output: action-v1          # parsed and validated against the action schema
limits:
  timeout_ms: 2500
  max_decisions_per_second: 20
fallback: nearest-car-eta@1.2.0
energy: { measure: device-power }
```

And for an algorithm:

```yaml
contract: v1
id: nearest-car-eta
name: Nearest-Car ETA
version: 1.3.0
kind: algorithm
adapter:
  type: in-process
  entry: algorithms/nearest-car-eta/index.js   # exports decide(observation, context)
params: { stop_cost: 3, load_cost: 6 }
limits: { timeout_ms: 50 }
```

### 6.1 Registration flow

1. **Submit** a manifest: from the Contestants page (*Register contestant*) or by adding it to `contestants/` in the repo (see open question Q3).
2. **Resolve and hash:** fetch the bundle or prompt, compute content hashes, and record the runtime and weights identity.
3. **Validate** (§6.2). A version that fails is stored as `rejected` with its report, and cannot be selected.
4. **Publish:** the version becomes `available` and appears in the Lane pickers. It is immutable from this point. Any change, including a prompt edit, a parameter change or new weights, is a new version.
5. **Deprecate** (optional): hidden from pickers for new experiments, but kept forever for replay and audit.

### 6.2 Validation suite

Run automatically at registration and shown on the contestant's card:

- **Contract conformance:** a fixed set of fixture observations covering every request kind, faults, overloads, crowd reassignments, and one- and many-car buildings. Every answer must parse, choose a legal option, and arrive within `timeout_ms`.
- **Determinism** (algorithms only): each fixture is asked twice, and any difference fails. The source is scanned for sandbox violations.
- **Stability** (models): repeated asks are allowed to differ, but the rates of malformed answers and timeouts must stay under a threshold.
- **Smoke run:** one short run of the Normal traffic scenario against the reference algorithm, which must finish, replay-verify and produce no safety violations beyond vetoes.
- **Fallback check:** the declared fallback exists, is an algorithm, and is itself `available`.

## 7. Racing: failures and safety

| Situation | Engine behaviour | Recorded as |
|---|---|---|
| Answer later than `timeout_ms` | The fallback decides this request | `timeout` + the fallback's decision |
| Crash, transport error, unparsable answer | The fallback decides | `failure` with the reason |
| Choice vetoed at commit (the world changed) | Request retried | `vetoed` (already in v1) |
| Illegal choice (not in `options`) | Rejected, the fallback decides | `violation`, and counted against the contestant in Safety |
| Repeated failures | After N consecutive failures the contestant is benched and the fallback finishes the run | `benched` at time t |

Fallback decisions are clearly marked everywhere: decision panels, the event feed, audit and metrics. A run where the fallback did much of the work cannot be mistaken for the contestant's own result. The Leaderboard should report each contestant's fallback share next to its ranking.

## 8. Provenance, replay and audit

Every run record and run file stores, per lane, the version reference plus kind-specific provenance, keeping models and algorithms apart as the spec requires:

- **Models:** adapter type, runtime and version, model identifier, weights hash, prompt template hash, rendered prompt for each decision (in the run file), sampling settings, and schema hashes.
- **Algorithms:** bundle hash, entry point, parameters and runtime.
- **Both:** contract version and hash, fallback reference, and the measured latency and energy per decision.

Replay works as it does in v1:

- recorded decisions are fed back in, and models are **never** re-asked;
- algorithms can additionally be **re-executed** from their bundle as an independent check. A difference means the bundle or the engine isn't deterministic, and is flagged in Audit.

The v1 run file already stores the raw request and response of live-model decisions; it still needs a small extension: store the rendered prompt and raw response for model decisions, and each decision's measured latency and energy source.

## 9. UI changes

- **Contestants page:** a *Register contestant* action (manifest upload or form), validation status and report per version, a deprecate action, and a fallback-share figure in each contestant's track record.
- **New experiment:** only `available` versions appear in the Lane pickers; deprecated versions are hidden unless a rerun needs them.
- **Decision panels:** show `fallback` and `timeout` decisions distinctly, and show the model's rationale if one was returned.
- **Audit:** per-decision prompt and response viewer for models, and a re-execution check for algorithms.

## 10. Phased delivery

1. **Contract v1 and the in-process adapter.** Port the v1 algorithms to manifests and bundles, move option building and latency measurement into the engine, and add the validation suite.
2. **Laya through its adapter:** see [laya-adapter.md](laya-adapter.md). Add the request and response log, measured latency, fallback handling and benching.
3. **Registration UI** and the deprecation flow.
4. **Local-model adapter generalised**, for other local models.
5. **Remote-service adapter**, if needed.

## 11. Open questions

- **Q1. How is Laya run?** *Answered:* a local model, [`convaiinnovations/laya`](https://huggingface.co/convaiinnovations/laya) on Hugging Face, served locally by `laya-serve` (`POST /v1/systemone`). It answers typed questions (`choice`, `score`, `noul`) with options defined per request, which suits engine-built options. The adapter design will follow the state model ([state-model.md](state-model.md)).
- **Q2. Which languages must algorithms support?** *Answered:* TypeScript.
- **Q3. Where do manifests live?** *Answered:* both. The repo is the source of truth, and the UI registers local experiments.
- **Q4. What counts as the same version for a remote model** whose provider may change it silently? *Answered* in [model-setups.md](model-setups.md): pin the provider's version id, check the reported model on every decision, and treat recorded responses as the only replay source.
- **Q5. Benching threshold:** how many consecutive failures before the fallback takes over for the rest of the run?
