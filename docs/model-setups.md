# Model setups: local and API models, and how to tell if two setups are comparable

Status: **draft for review** · 2026-09-27 · builds on [contestants.md](contestants.md), [state-model.md](state-model.md) and [laya-adapter.md](laya-adapter.md)

## 1. Summary

The first demo pairs **local Laya** against **Jev through TypeSafe's API**. The two are close relatives: `laya-serve` implements the same `POST /v1/systemone` request and response format as Jev ("existing TypeSafe clients work by changing their base URL"). So both can receive the **byte-identical** request, and the only thing that differs is the model behind the endpoint.

That is the ideal case for a benchmark, but it won't always hold. The next pairing might use different wording, a CPU instead of a GPU, or an API model that silently moved to a new version. So this document defines:

1. **One System One adapter** with two transports, local and remote (§3).
2. **Setup facets:** the separate parts of a contestant's setup, each hashed on its own (§5).
3. **A setup check** that compares two lanes facet by facet and says whether a run is a *controlled* comparison (only the model differs) or a comparison of whole setups (§6).

## 2. What the Jev docs tell us

| Fact (docs.typesafe.ai) | Consequence for the arena |
|---|---|
| `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`, `model` required. Choice answers return `choice`, `probabilities` for every option, and `confidence`. | Same contract as `laya-serve`. The full distribution comes back, so decision panels work unchanged. |
| `jev-latest` is an alias that "moves when a new release ships, so the answers behind it can change without a change on your side". The response's `model` field reports the version that answered (`jev-1.13.0`). | Always send the **pinned version id**, and check the response's `model` on **every** decision. A mismatch is recorded as *model drift* (§7). This resolves contestants.md Q4. |
| Same weights for every account; no fine-tuning. Customisation is through `state`, `instructions` and `criteria` only. | For Jev, the encoding *is* the only lever. Laya can also be fine-tuned, which makes "fine-tuned Laya vs Jev" a natural later experiment. |
| Repeating the same moderation rubric 15 times kept Jev's plurality label **90.8%** of the time. Labels flip when probabilities are close. | Jev is **stochastic** in practice. It is never re-asked during replay, its responses are the only replay source, and results need replications. |
| Known weak spots: "not a calculator", doesn't count reliably, struggles with numeric comparison, reads literally, and loses accuracy with irrelevant state. "Keep the arithmetic in code." | Our `laya-encoding v1` sends raw numbers ("floor 3.2, 150 of 630 kg"), which plays to that weakness. A **semantic encoding** (§8) is worth racing as a separate version. |
| Price: $0.042 per million input tokens; output tokens are free. The response reports `usage.input_tokens`. | Cost per decision is **measured exactly** from `usage`. A ~400-token decision costs about $0.000017, so 1,000 decisions cost under 2 cents. |
| Rate limits: 1,200 requests per minute and 250,000 tokens per second, "adjusting dynamically". Errors: 401, 422, 429, 529. | An API contestant's speed is bounded by its rate limit, especially in Max speed with parallel runs. Throttling is recorded separately (§7). |
| JS SDK `@typesafe-ai/sdk` (Node 20+) retries 408, 429 and 5xx twice by default, with backoff. Default timeout 10 s. `dangerouslyAllowBrowser` would expose the key to page users. | Disable SDK retries and let the arena's own retry policy decide, so retries are visible. The key must **never** reach the browser (§4). |
| Context: 64k tokens per request; up to 255 options per Choice. | No size problem for Jev, unlike Laya (512–1,024 tokens). A request that fits Laya always fits Jev. |

## 3. One adapter, two transports

Both models speak the System One protocol, so the adapter is shared and only the transport differs:

```ts
interface SystemOneTransport {
  readonly kind: 'local' | 'remote';
  // Sends the request exactly as encoded; returns the raw response and timings.
  send(body: SystemOneRequest, signal: AbortSignal): Promise<{
    response: SystemOneResult;
    timing: { queuedMs: number; roundTripMs: number; attempts: number };
  }>;
  // Reports what the endpoint says it is serving (model id, runtime version).
  identify(): Promise<EndpointIdentity>;
}

const layaLocal = httpTransport({ baseURL: 'http://127.0.0.1:8000', apiKey: env.LAYA_API_KEY });
const jevRemote = httpTransport({ baseURL: 'https://api.typesafe.ai', apiKey: env.TYPESAFE_API_KEY });
```

- The **encoder and decoder** are the ones from laya-adapter.md §4, now named `system-one-encoding`. Local Laya and API Jev can use the same encoding version, so their requests differ only in the `model` field.
- The transport is a plain `fetch` wrapper, not the SDK, so there are no hidden retries and nothing extra added to the request. Using the SDK is fine later if we keep `maxRetries: 0`.
- This also settles the open point in laya-adapter.md §6: `laya-serve` returns the full `probabilities`, so no sidecar is needed, *provided* the spike confirms it can pin the checkpoint (it ignores the `model` field and routes by language).

## 4. Where keys and calls live

The app runs in the browser. API keys can't. The engine phase adds a small **local runner**:

```
browser (UI) ──WebSocket──▶ arena runner (Node, TypeScript, 127.0.0.1)
                                ├──▶ laya-serve       127.0.0.1:8000   LAYA_API_KEY
                                └──▶ api.typesafe.ai  (HTTPS)          TYPESAFE_API_KEY
```

- The runner owns the engine, the adapters and the keys. The browser only renders and sends commands.
- Keys come from the runner's environment (`TYPESAFE_API_KEY`, `LAYA_API_KEY`). They never appear in manifests, run files, logs or the UI. Manifests name the variable instead (`auth: env:TYPESAFE_API_KEY`).
- Before a run starts, the runner lists which contestants call **external services**, and New experiment says so ("Jev: sends the building state to api.typesafe.ai"). The state is synthetic simulation data, but it still leaves the machine.

## 5. Setup facets

A contestant's setup is split into **facets**. Each is hashed separately, so two setups can be compared piece by piece instead of as one opaque hash.

| Facet | What it captures | Affects | Local Laya | API Jev |
|---|---|---|---|---|
| **Interface** | Protocol and question type | Whether requests can be identical at all | System One · `choice` | System One · `choice` |
| **Encoding** | Encoding version, instructions, option templates, state fields, key style, option order | Decision quality | `system-one-encoding@1` | `system-one-encoding@1` |
| **Model** | Model identity, and the version actually reported per decision | Decision quality | `laya` @ Hub commit SHA | `jev-1.13.0` (pinned, checked) |
| **Tuning** | Fine-tuning, calibration temperatures, decision rule (argmax or sample) | Quality, calibration | base · no temperature · argmax | none possible · argmax |
| **Location** | Local or remote, host, network path | Speed, availability, privacy | local · 127.0.0.1 | remote · api.typesafe.ai |
| **Compute** | Device and runtime, where known | Speed, energy | `laya 0.3.20` · CUDA T4 | not disclosed |
| **Limits** | Timeout, retries, rate limit, max input size | Failures, fallback share | 400 ms · 0 retries · no rate limit · 1,024 tokens | 1,500 ms · 0 retries · 1,200 req/min · 64k tokens |
| **Fallback** | Fallback contestant and benching threshold | Results under failure | nearest-car-eta@1.3.0 | nearest-car-eta@1.3.0 |
| **Determinism** | Measured at registration (laya-adapter §7) | Replications needed | *measured* | stochastic (~91% repeat agreement) |
| **Cost basis** | What is measured per decision | Cost metrics | energy (Wh, device power) | money (tokens × price) |

The experiment adds two run-level facets that always apply to both lanes and are part of the definition hash: the **visibility profile** (state-model.md) and the **decision-time mode** (laya-adapter.md §6).

## 6. The setup check

When two lanes are chosen in New experiment, the setup check compares them facet by facet and gives the pairing one of three verdicts:

| Verdict | Rule | What the result can claim |
|---|---|---|
| **Controlled** | Everything that affects quality is equal (interface, encoding, tuning rule, limits, fallback) and only **model** differs. Location and compute may differ. | "Model A decides better than model B under this encoding." Speed and cost differences are reported separately. |
| **Setup comparison** | One or more quality facets besides the model also differ, for example a different encoding. | "Setup A beats setup B." The panel lists every difference, so nobody reads it as a model result. |
| **Not comparable** | The interface can't produce equivalent decisions, or a lane can't run under the chosen profile. | Blocked, with the reason. |

Example: the demo, with both lanes on `system-one-encoding@1`:

```
Setup check · Laya (local) vs Jev (API)                        CONTROLLED
  Same      interface · encoding e41c09 · decision rule · fallback
  Differs   model       laya@3f2a91c        jev-1.13.0
            location    local               api.typesafe.ai
            compute     CUDA T4             not disclosed
            cost basis  energy              money
            limits      timeout 400 ms      timeout 1,500 ms   ⚠ affects fallback share
  Note      decision time "measured": Jev's network round trip counts against it.
            Choose "fixed" decision time to compare decision quality only.
```

The check is used in four places:

- **New experiment**, as the panel above, before launch.
- **Run records**, which store the verdict and the facet diff, and show a *Controlled* or *Setup comparison* label in Run history and Audit.
- **Leaderboard**, with a filter: *controlled comparisons only*. A "which model decides better" ranking then uses only runs where the encoding was held constant.
- **SLA lab**, which reports which facets a pass or fail depended on. An API contestant that fails a latency clause only because of network time is shown with that reason.

Rule for limits: different timeouts make a pairing a *setup comparison* by default, because timeouts decide how often the fallback takes over. For local vs API, the experiment can instead set **one timeout for both lanes**, which keeps it controlled.

## 7. Fairness rules for local vs API

- **Decision time.** `measured` includes Jev's network round trip and any queueing. That is realistic for a building connected to a cloud service, but it is not the model's own speed. The arena records `queuedMs`, `roundTripMs` and `attempts` per decision. Jev doesn't report server-side time, so network and inference can't be separated. A per-run **network baseline** (a few `GET /v1/models` calls before the run) is recorded to give a rough sense of the network share.
- **Rate limits.** 429 and 529 responses are handled by the arena's retry policy (1 retry with backoff by default). Each retry is recorded. If the answer still misses the timeout, the fallback decides. Throttled time is reported as its own figure, so a slow run caused by rate limits isn't mistaken for a slow model.
- **Model drift.** If the response's `model` differs from the pinned version, the decision is used but flagged, and the run is marked *drifted*. It won't count toward the leaderboard or SLA pools until someone confirms it. Pinning a version id makes this rare, but it is still checked.
- **Stochastic replay.** Every Jev request and response is stored in the run file. Replay feeds them back, and verification can't re-ask Jev. Two runs with the same definition are replications, not duplicates, as for any stochastic model.
- **Cost.** Energy (local) and money (API) are different units. The comparison shows both, and never converts one into the other.
- **Outages.** If the API is unreachable at launch, the run doesn't start. If it fails mid-run, the normal failure and benching rules apply (contestants.md §7), and the run shows how many decisions the fallback made.

## 8. The demo: local Laya vs API Jev

Three experiment sets, each on a basic-case scenario (Normal traffic and Morning Wave, 24 floors × 4 cars), with 5 replications each for the leaderboard:

| Set | Setup | Answers |
|---|---|---|
| **1. Decision quality** | Same encoding, decision time `fixed`, same timeout | Which model chooses better cars, independent of speed. *Controlled.* |
| **2. Realistic** | Same encoding, decision time `measured` | How the building actually performs with a local GPU model vs a cloud API, including network time. *Controlled*, with the speed difference shown. |
| **3. Encoding study** | Each model with `system-one-encoding@1` (raw numbers) and `@2` (semantic) | Whether the "keep arithmetic in code" advice matters here. Four setups; *controlled* per encoding and *setup comparisons* across them. |

`system-one-encoding@2` (semantic) describes each car relative to the call, computed in the encoding:

```json
"criteria": {
  "A": "4 floors below the call, moving towards it, about a quarter full, 2 stops on the way",
  "B": "at the call floor, idle, empty, doors open",
  "C": "out of service"
}
```

This stays within the facts-only rule: the **engine** still sends only facts, and the relative wording is computed by the contestant's encoding, which is part of its identity (state-model.md §3).

Nearest-Car ETA joins every set as the reference algorithm, because Laya's base checkpoint is expected to be near chance (laya-adapter.md §2).

**Budget:** a 24 × 4 Morning Wave run has a few hundred decisions per lane. The whole demo is 40 Jev runs (10 in set 1, 10 in set 2, 20 in set 3), roughly 12,000 decisions × ~400 tokens, which is about 5 million tokens, or **about $0.20**. That is well within the rate limits if the runs are spread over a few minutes.

## 9. Delivery

1. **Spike:** call Jev with the key from the environment and a fixture request, and call `laya-serve` with the same bytes. Confirm the response shapes and `probabilities`, and measure latency and repeat agreement on 20 fixtures. Confirm how `laya-serve` pins its checkpoint.
2. **Runner and transports:** the Node runner, WebSocket to the UI, the two transports, and key handling.
3. **Setup facets and check:** facet hashing in the registry, the setup-check panel in New experiment, verdicts in run records, and the leaderboard filter.
4. **Demo sets 1–3**, then a write-up of the results.

The facets and the setup check can be built into the **app first**, with mock Laya and Jev contestants, so the UI can be reviewed before any real call is made.

## 10. Decisions

| # | Question | Decision |
|---|---|---|
| Q1 | Send the synthetic building state to api.typesafe.ai while the project is private? | Yes. |
| Q2 | Local Node runner for the engine and keys? | Yes. |
| Q3 | One shared timeout for the demo? | Yes: 1.5 s shared, for sets 1 and 2. |
| Q4 | Encoding study (set 3) in the first demo? | Yes. |

## 11. Status in the app

The setup check is built into the app (`app/js/setup.js`, `app/js/ui/setup-view.js`), first with mock contestants (since removed):

- **Laya · local** and **Jev · API** in encodings 1 and 2, with facets as in §5 and scripted quality and latency. There are no calls and no keys.
- **Decision timing:** `measured` or `fixed`, and each contestant's own timeout or a shared one. Timeouts hand the decision to the fallback, and the handover is recorded, replayed and verified.
- **Verdicts**, following the rule in §6, refined to "exactly one thing differs": either the decider (model or code, with its tuning and what comes with it), or one harness facet such as the encoding. So *Laya · local enc1 vs enc2* is controlled and compares the encoding.
- **Where verdicts show:** the New experiment panel with one-click fixes, chips in Run history and on the Experiment card, a line in Audit, and a *Controlled only* filter on the Leaderboard.
- **Not yet in the app:** a *not comparable* verdict (no registered pairing needs it yet), a network baseline, token-cost metrics and model-drift checks. Those need the real transports.

## 12. Spike results: Jev (2026-09-27)

These were real calls to `api.typesafe.ai`, with the key loaded from `~/.config/elevator-arena/env` (never printed or stored in the repo). The fixture and script are in [`docs/spike/`](spike/): a 24-floor, 4-car hall call with four options, one of them out of service.

| Check | Result |
|---|---|
| Authentication, `GET /v1/models` | 200 in 0.40 s. Lists the aliases `jev-latest` and `jev-preview` only, as documented. |
| Pinned model | Requests with `"model": "jev-1.13.0"` are accepted, and every response reported `jev-1.13.0`. The drift check can compare this field. |
| Response shape | `choice`, `confidence` and **`probabilities` for every option**, plus `usage.input_tokens`. It matches the adapter design. |
| Size and cost | 513 input tokens (encoding 1) and 470 (encoding 2), about $0.00002 per decision. |
| Latency, 10 sequential calls each | p50 ~190 ms, range 173–339 ms, from this machine. The mock is now calibrated to this. |
| Same bytes, same answer? | **The top choice was stable** (A in 10/10, both encodings). **The probabilities were not**: 10 distinct distributions out of 10 for byte-identical requests, with P(A) between 0.79 and 0.86 (encoding 1) and between 0.62 and 0.78 (encoding 2). |
| Encoding effect (one fixture) | Encoding 2 made Jev *less* certain: P(A) around 0.72 against around 0.84, with more weight on the idle empty car 5 floors above. One fixture proves nothing. This is what demo set 3 is for. |

Consequences:

- **Jev is stochastic even on identical requests.** It is never re-asked in replay, and its recorded responses are the replay source, as designed.
- **Argmax decisions** will often repeat, but close calls can flip. Replications stay necessary.
- **Latency is lower than the third-party figure** (236–276 ms p50) we had assumed.

## 13. Spike results: local Laya (2026-09-27)

`laya[serve]` 0.3.21 runs in a Python 3.12 virtualenv (`runtime/laya/.venv`, git-ignored) and is started with [`runtime/laya/serve.sh`](../runtime/laya/serve.sh): loopback only, key required, checkpoint pinned, Apple GPU. The requests were the same fixture bytes Jev received, with only `model` changed to `"english"`.

| Check | Result |
|---|---|
| Access | `127.0.0.1:8000` only. Returns 401 without a key or with a wrong key. |
| Pinning | `LAYA_REVISION=reviewed` pins each checkpoint to the reviewed commit shipped with the package: `convaiinnovations/laya@55cf4c4…`. The request's `model` field can name a checkpoint (`"english"`); a Jev name falls back to auto-routing. |
| Identity | The response's `model` is just `"laya-rl-agent"`. **Identity must come from `GET /health`**, which reports the loaded checkpoints, their commit SHAs and the device. |
| Response shape | Same as Jev: `choice`, `confidence` and `probabilities` for every option, plus `routing`. **No sidecar is needed.** |
| Timing | Round trip p50 35–38 ms on the M4 Pro GPU (MPS). The first call took 1.8 s to warm up. `X-Inference-Time-Ms` reports model time separately (p50 34–37 ms), so network time can be told apart. |
| Same bytes, same answer? | **Yes.** 10 identical distributions out of 10, for both encodings. |
| Quality (one fixture) | Encoding 1: it chose **C, the almost-full car** (610 of 630 kg), with P = 0.63. Encoding 2: it chose A, but with an almost flat distribution (confidence 0.02). Jev chose A in every call. This fits the model card: the base checkpoint is near chance zero-shot, and fine-tuning is where its accuracy comes from. |
| Calibration warning | At startup: the checkpoint ships invalid temperatures for choices with 11 or more options, so confidence is uncalibrated there (buildings with 11 or more cars). |
| Token count | 166 and 148 tokens (Laya's own tokenizer), against Jev's billed 513 and 470. The two counts aren't comparable. |

**A gotcha:** `laya-serve --help` has no help. It starts a server bound to `0.0.0.0:8000` with no authentication, even with `LAYA_HOST` unset. That happened once during this spike and was stopped within minutes. `serve.sh` exists so the server is only ever started locked down.

**Mocks calibrated:** Laya · local now uses the measured latency (34–40 ms), takes the top option (it is deterministic), and has its decision noise raised so it performs near chance, just below round robin over 10 seeds. Jev · API uses its measured 173–339 ms.

**Reproduce:** start `runtime/laya/serve.sh` in one terminal. Then run `set -a; . ~/.config/elevator-arena/env; set +a; node docs/spike/repeat.mjs laya` (or `jev`).

**Spike conclusions for the adapter:**

1. **One System One transport serves both.** Laya's identity check is `GET /health`; Jev's is the response's `model` field on every decision.
2. **Determinism facet:** Laya · local is deterministic (so replay can re-ask it as a check); Jev is not.
3. **Decision time:** local Laya (~36 ms) against Jev over the network (~190 ms) is a real speed difference. Demo set 1 (fixed decision time) is what isolates decision quality.
4. **Before demo set 1, fine-tuning is the obvious next lever for Laya.** Its base checkpoint makes poor dispatch choices on the fixture.

## 14. Live connection (2026-09-27)

The runner (`runner/`) and the app now race **real** Laya and Jev:

- **Runner:** Node and TypeScript, with no dependencies, on `127.0.0.1:8787`. It serves the app, holds the keys, and implements §3 (one System One transport, encodings 1 and 2), §5 (facets per live contestant) and §7 (timeouts, one 429/529 retry, queueing reported separately, drift check on Jev's `model`, identity via Laya's `/health`).
- **Engine:** still in the browser app. §4 put the engine in the runner. For now the runner is a decision proxy, and the browser world holds while a live answer is out, then lands it after its measured time. Results depend only on the record, so replay verification works unchanged. Moving the engine into the runner remains the plan for the engine phase.
- **First real race** (6 × 3, Morning Wave, seed 24301, shared 1.5 s timeout, *Controlled · decider*): Jev cleared the wave in 1:51.9 and local Laya in 2:03.1. Average wait was 21.8 s against 24.8 s, and decision time 207 ms against 50 ms. There were 49 real decisions, no fallbacks, and $0.0004 of API cost. Replay verified 26/26 and 23/23 decisions. One seed is not a ranking.
- **Not yet:** benching after repeated failures, a network baseline per run, a per-run cost cap, and batches sized with cost in mind.

## 15. Demo set 1: decision quality (2026-09-27)

Fixed 0.25 s decision time; 24 × 4; Normal traffic and Morning Wave; seeds 1001–1010. Laya · local vs Jev · API (encoding 1, *Controlled · decider*), and Nearest-Car ETA v1.3.0 vs Round robin as references. 40 runs, 861 Jev calls ($0.018), 0 fallbacks, 0 drifted decisions.

Paired by seed, on average wait:

- **Nearest-Car ETA was best on both scenarios.**
- **Jev** was separably worse than Nearest-Car ETA (+5.6 s Normal, +4.5 s Morning Wave) and **not separable from round robin**.
- **Base Laya** was separably worse than Jev (+16.7 s, +3.9 s) and **worse than round robin** (+19.9 s, +6.6 s).

Zero-shot and from raw numbers, neither model beats a simple heuristic yet. Next: demo set 3 (encodings), an encoding with derived facts such as ETA computed by the contestant, and fine-tuned Laya with hindsight labels.

## 16. Demo set 3: encodings (2026-09-27)

The same design as set 1 (fixed 0.25 s, 24 × 4, Normal traffic and Morning Wave, seeds 1001–1010), with **encoding 2** (semantic) and a new **encoding 3**. Encoding 3 has the contestant compute a per-car arrival estimate, as Nearest-Car ETA v1.2.0 does, and state it alongside load. Laya vs Jev per encoding (*Controlled · decider*), plus Nearest-Car ETA v1.2.0 and zoned dispatch as extra references. 1,768 Jev calls ($0.035), 0 fallbacks, 0 drift.

Paired by seed, on average wait:

- **Jev with encoding 3 matched Nearest-Car ETA:** +0.6 s and +0.9 s against v1.2.0, not separable. It was separably better than Jev with encoding 1 (−5.2 s, −3.8 s) and than round robin on Normal traffic (−2.1 s).
- **Encoding 2** didn't reliably change either model.
- **Base Laya with encoding 3** improved on Normal traffic (−12.8 s against encoding 1) but stayed separably worse than round robin (+7.1 s, +5.6 s) and than Jev with encoding 3 (+9.2 s, +6.8 s).

Framing, doing the arithmetic in the encoding, closes Jev's gap to the heuristic but doesn't exceed it. Beating the heuristic will need information it ignores (call history, patterns specific to the building) or, for Laya, fine-tuning.

## 17. Simulator fix: mock-world 0.2 (2026-09-27)

Watching a run showed a passenger stepping out of the same overloaded car again and again. There were two bugs in the simulated world:

1. **Re-boarding:** a passenger who stepped out to clear an overload was barred from that car only until its doors closed, so they got back in at its next stop and overloaded it again. Now they remember the car, and board it again only when it has room for them. That counts the weight of people still walking in, which wasn't counted before.
2. **Who steps out:** the passenger asked to leave was whoever reached their spot inside last, not whoever got in last. A slow passenger with a cart was repeatedly the one sent out. Now it's by boarding order.

Across 240 runs (4 scenarios × 2 sizes × 30 seeds), passengers stepping out of the same car more than once dropped from 20 to 0. Step-offs dropped from 1,890 to 1,783. All 480 runs of a wider check (every scenario, 3 policies, 4 sizes) still finish.

The simulator version is now `mock-world 0.2`. Runs from 0.1 form their own Leaderboard and SLA families, labelled as the older simulator, and Audit reports them as "Older simulator" rather than failing them. **Demo sets 1 and 3 (§15–16) were recorded with 0.1 and need re-running under 0.2** before their numbers are used.

## 18. Demo sets 1 and 3 re-run on mock-world 0.2 (2026-09-27)

The same design, 100 runs, 2,607 Jev calls ($0.053), 0 errors, fallbacks or drift. Every mean moved by at most about 1 s, and the conclusions of §15–16 hold:

- **Nearest-Car ETA:** best (30.6 / 42.9 s average wait, Normal / Morning Wave).
- **Jev with encoding 3:** matches it (31.1 / 43.6 s; +0.4 / +0.7 s against v1.2.0, not separable).
- **Jev on raw numbers:** worse than Nearest-Car (+5.5 / +5.4 s), and now also separably worse than round robin on Morning Wave (+3.4 s).
- **Base Laya:** worse than round robin in every encoding (for example +18.8 / +6.3 s with raw numbers, +6.9 / +5.7 s with the arrival estimate).

These supersede the 0.1 tables in §15–16.

## 19. Pilot fine-tune rematch (2026-09-28)

A local imitation fine-tune of Laya (teacher: Nearest-Car ETA v1.3.0; encoding 3; 4,382 examples from seeds 1–60; validation seeds 501–520; about 24 min on an Apple M4 Pro, fp32), served privately by `runtime/laya/serve_local.py` and pinned by its weights hash. It raced base Laya on the demo-set design (mock-world 0.2, 24 × 4, seeds 1001–1010, fixed 0.25 s; *Controlled · decider*):

- **Against base Laya:** average wait **30.9 / 43.4 s** against 40.3 / 50.7 s, **−9.4 / −7.3 s, better on 10/10 seeds in both scenarios**.
- **Against the rest:** indistinguishable from Nearest-Car ETA (v1.2.0 30.6 / 43.0; v1.3.0 31.0 / 42.9) and from Jev with encoding 3 (31.1 / 43.6). Separably better than round robin on Normal traffic (−2.5 s).
- **Accuracy against the teacher:** 0.249 → 0.928 on 1,601 held-out decisions.

As expected, imitation reaches its teacher and doesn't pass it. Next: hindsight labels, and a second building profile.

## 20. Accuracy, measured latency, hindsight labels and a second building (2026-09-28)

- **Jev's accuracy:** on the pilot's 1,601 held-out decisions (encoding 3), Jev agrees with Nearest-Car ETA v1.3.0 on **90.3%** (base Laya 24.9%, pilot fine-tune 92.8%). $0.033.
- **Demo set 2, measured decision time:** Jev encoding 3 (~0.20 s per decision, counted) vs Nearest-Car (instant): 31.1 / 43.4 s against 30.7 / 42.4 s, **not separable**. $0.018.
- **Hindsight labels** (`runner/tools/hindsight.ts`: fork each decision per option, continue with Nearest-Car for 90 s, score by total waiting):
  - **The rollout acting on them online** reaches 25.2 / 36.9 s, but it's an **oracle**: the forks replay the real future arrivals.
  - **Laya fine-tuned on them** reaches **31.5 / 42.7 s**, tying the pilot, Nearest-Car and Jev. It captured none of the oracle's gap: the labels depend on arrivals the state doesn't show.
- **Second building** (12 × 3, evening down-peak):
  - **The office imitation fine-tune transfers:** 47.7 s, tied with Jev and Nearest-Car v1.2.0, and separably better than v1.3.0 (−1.6 s).
  - **A per-building hindsight fine-tune** (2,109 samples) **collapsed**: a near-uniform output with a positional lean, "always car A" on 200/200 held-out decisions, 84.8 s average wait.
  - **Lessons:** shuffle option order, check prediction distributions rather than accuracy, keep the best epoch, validate by racing.
