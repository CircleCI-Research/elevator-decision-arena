# Elevator Decision Arena

**A reproducible, simulation-based benchmark of decision models and dispatch algorithms on one everyday decision: which elevator car answers a call.**

Every time someone presses a hall button, a building has to decide which car answers. Elevator Decision Arena (EDA) races two contestants on that decision, side by side, under identical conditions: the same building, passengers, seed and events. The contestants can be decision models (such as TypeSafe's **Jev** or Convai's **Laya**, both "System One" models that answer typed questions with calibrated probabilities) or classic dispatch algorithms. It measures who serves passengers best, and whether the comparison is fair.

> **Status: v1.** The building, its traffic and its physics are simulated. The decisions are real: real algorithms, and real model calls through a local runner. Results are rankings *within this simulation*, not claims about real buildings.

## Using it with a coding agent

Paste one of these into your agent (Claude Code, Codex, Cursor…) from the repository root.

**Setup prompt:** installs everything and starts the servers.

```text
Set up Elevator Decision Arena in this repository, following README.md.
1. Check that Node is 22.6 or newer. If I want local Laya, also check for Python 3.12 and uv
   (install uv with Homebrew if it's missing, but ask me first).
2. Keys: never ask me to paste an API key into this chat. Check whether ~/.config/elevator-arena/env
   exists and which variable names it has (TYPESAFE_API_KEY, LAYA_API_KEY) without printing values.
   If it's missing, show me the command to create it myself (mode 600), and generate
   LAYA_API_KEY into it with `openssl rand -hex 24` if I agree.
3. Local Laya (optional; ask me): in runtime/laya, create a Python 3.12 venv with uv and install
   "laya[serve]". Start it only with ./serve.sh, never by running laya-serve directly: it binds
   every interface without auth. Confirm http://127.0.0.1:8000/health reports the english
   checkpoint at commit 55cf4c4.
4. Start the runner (cd runner && npm start) and confirm GET http://127.0.0.1:8787/api/contestants
   lists the live models as available.
5. Run `cd runner && npm test`, then tell me to open http://127.0.0.1:8787/ (not the HTML file) and
   summarise which live models are available.
```

**Start prompt:** runs a first experiment and reads the result.

```text
Using Elevator Decision Arena (the runner at http://127.0.0.1:8787 must be running; if it isn't,
start it as README.md describes), run a first controlled comparison and explain it to me:
- Building 24 floors × 4 cars, scenario "Normal traffic", seeds 1001–1010, fixed decision time.
- Lane A: Jev · API encoding 3; lane B: Laya · local encoding 3 (or two algorithms if no live
  models are available). The setup check must say "Controlled".
- Launch it as a 10-seed batch from New experiment, wait for it to finish, then report the mean
  average wait and 95th-percentile wait per contestant, how many seeds each won, the API cost from
  the runner log, and any fallbacks or model drift.
Before any paid API calls, tell me roughly how many calls and how much they will cost, and wait for
my go-ahead. Don't change code or settings unless I ask.
```

## What it does

- **Races two contestants** in cutaway buildings with animated passengers, or as a stats board for large towers (up to 120 floors and 16 cars). Runs play on a timeline, or compute at max speed.
- **Fixes every experiment up front:** building, traffic scenario, seed, events, contestants and decision timing are chosen before launch and can't change mid-run. Runs are independent and can run in parallel.
- **Checks fairness:** the *setup check* compares the two lanes part by part (interface, encoding, model, limits, fallback…). It says whether a result is a **controlled** comparison (exactly one thing differs) or a comparison of whole setups.
- **Separates quality from speed:** *fixed* decision time compares decisions only; *measured* time lets real latency count.
- **Keeps everything auditable:** every run records its definition and every decision, including the exact request and response of each live model call. Replays re-derive the whole run from the record and verify it (hashes, fingerprints); live models are never re-asked.
- **Ranks and evaluates:** a Leaderboard per experiment family, with 95% intervals across seeds and a *Controlled only* filter, and an SLA lab (for example "95% of runs keep the average wait under 30 s").

## Quick start

### 1. Just the app, with algorithms only (no setup)

Open `app/index.html` in a browser, or serve the folder with any static server. You get the four built-in algorithms (Nearest-Car ETA v1.2.0 and v1.3.0, round robin, zoned dispatch), every page of the app, and no model calls.

### 2. With real models (local Laya and/or the Jev API)

Requirements: **Node 22.6+** (the runner is TypeScript run directly by Node, with no dependencies). For local Laya, also Python 3.12 and [uv](https://github.com/astral-sh/uv).

**Keys** go in one private file, never in the repo:

```sh
mkdir -p ~/.config/elevator-arena
(umask 077; cat > ~/.config/elevator-arena/env) <<'KEYS'
TYPESAFE_API_KEY=…   # for Jev (api.typesafe.ai)
LAYA_API_KEY=…       # any random string; protects your local Laya server
KEYS
```

**Local Laya** (optional; skip it if you only want Jev):

```sh
cd runtime/laya
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python "laya[serve]"
./serve.sh                      # 127.0.0.1:8000, key required, checkpoint pinned
```

Always start it with `serve.sh`: `laya-serve` run directly binds every network interface with no authentication.

**The arena runner**, which serves the app and makes the model calls:

```sh
cd runner && npm start          # then open http://127.0.0.1:8787/
```

Open the app **from the runner's address**. Opened any other way, it has only the algorithms. The live models appear in New experiment under *Live models · arena runner*: **Laya · local** and **Jev · API**, each in three encodings (raw numbers, semantic, derived arrival estimate). The runner prints one line per real call (contestant, time, choice, tokens, cost), never keys.

### 3. Run an experiment

1. **New experiment** (`N`): pick a building, scenario, seed and events.
2. Pick the two lanes, and read the **setup check**: aim for *Controlled*, and use its one-click fixes (shared timeout, fixed decision time).
3. Choose **Seeds: 10** for a batch. It runs at max speed and feeds the Leaderboard.
4. Read the results in **Leaderboard** (turn on *Controlled only*), **Run history** (compare two runs) and **Audit & replay** (every decision, with the exact model request and response).

Step-by-step guides for every menu section, batching, new scenarios and new benchmarks are in [docs/HOW-TO/](docs/HOW-TO/README.md).

## Repository

| Path | What |
|---|---|
| `app/` | The app: vanilla JS, SVG, no build step. `js/sim/` holds the simulator (`world.js`), traffic scenarios (`scenario.js`) and the contestant registry (`registry.js`). See [app/README.md](app/README.md) for every page and control. |
| `runner/` | Local server (TypeScript, Node): serves the app, holds the keys, encodes decisions and calls the models. Loopback and same-origin only. `tools/export-dataset.ts` exports fine-tuning data from the simulator. See [runner/README.md](runner/README.md). |
| `runtime/laya/` | Local Laya: `serve.sh` (safe `laya-serve`), `train_mps.py` (fine-tuning on Apple silicon), `serve_local.py` (serve a fine-tuned checkpoint privately). Virtualenv, data and checkpoints are git-ignored. |
| `docs/` | Design documents (below), [`HOW-TO/`](docs/HOW-TO/README.md) guides, and `spike/`, the first real calls to both models. |

## Design documents

- [docs/contestants.md](docs/contestants.md): how algorithms and models are defined, registered, validated, raced and replayed; the decision contract.
- [docs/state-model.md](docs/state-model.md): what a contestant can see. A versioned catalogue of state variables, visibility profiles, and basic vs advanced cases.
- [docs/laya-adapter.md](docs/laya-adapter.md): running Laya locally, encodings, identity, calibration, and fine-tuning data.
- [docs/model-setups.md](docs/model-setups.md): local and API models, setup facets and the setup check. It also records the spikes and demo results so far (§12–18).

## Results so far (simulated building, eda-sim 0.2)

24 floors × 4 cars, the same 10 seeds for every contestant, fixed decision time, mean average wait (Normal traffic / Morning Wave). Differences were tested seed by seed (paired, 95% intervals, not adjusted for multiple comparisons) from the exported run records. These results are **exploratory**: the encodings were chosen while watching these same seeds, and options were always listed in the same order.

| Contestant | Average wait |
|---|---|
| Nearest-Car ETA v1.2.0 (classic heuristic) | **30.6 s / 43.0 s** |
| Nearest-Car ETA v1.3.0 (load-aware) | 31.0 s / 42.9 s |
| Jev, given a per-car arrival estimate (encoding 3) | 31.1 s / 43.6 s |
| Round robin | 33.4 s / 44.9 s |
| Jev on raw numbers (encoding 1) | 36.5 s / 48.3 s |
| Base Laya, zero-shot, arrival estimate (encoding 3) | 40.3 s / 50.7 s |
| Base Laya, zero-shot, raw numbers (encoding 1) | 52.2 s / 51.3 s |

In short: handing Jev an arrival estimate (the heuristic's own formula, computed in the encoding) brought it within a second of the heuristic, too close for ten seeds to call. Base Laya, used zero-shot in our format, needs fine-tuning. Scope: rankings inside this simulated building, for the setups tested. Details and caveats are in [docs/model-setups.md](docs/model-setups.md) §15–18.

## Tests

```sh
cd runner && npm test           # encoder golden files and decoder checks
```

The simulator's determinism, replay verification, leaderboard and SLA statistics are checked with headless Node scripts during development. Folding them into `npm test` is on the list.

## Principles

- **Experiments are fixed up front.** Only the run mode (timeline or max speed) can change while a run plays.
- **Record inputs, re-derive everything else.** A run file is the definition plus every decision, and a replay must reproduce the rest exactly.
- **Never re-ask a model to verify it.** Stochastic models (Jev) can't be re-asked meaningfully, so their recorded answers are the evidence.
- **Keys never reach the browser,** and local model servers bind to `127.0.0.1` only.
- **Every number names its versions:** simulator, model, encoding, and seeds.

## License

[Apache License 2.0](LICENSE).
