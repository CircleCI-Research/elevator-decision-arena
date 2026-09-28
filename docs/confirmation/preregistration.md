# Confirmation run 1: pre-registration

**Written:** 2026-09-28, before any confirmation seed was run. The commit that adds this file also adds the tool, so its timestamp proves the plan came first.

**Why:** the headline results so far are exploratory. The encodings were chosen while we watched results on evaluation seeds 1001–1010. An external review (September 2026) recommended freezing everything and testing the headline claims on seeds nobody has seen. This run does that.

## What is frozen

Everything below is fixed in `SPEC` in [`runner/tools/confirm.ts`](../../runner/tools/confirm.ts).

**SPEC sha256:** `c5c4849a0b22bda702e8a9d81944720c4dfdf9e6c6588a91b926b1cec367234d`. Check it with `node --experimental-strip-types tools/confirm.ts --spec-hash`.

| | |
|---|---|
| Simulator | eda-sim 0.2, the app at this commit |
| Building | 24 floors × 4 cars |
| Scenarios | Normal traffic, and Morning Wave with its default events |
| Seeds | **2001–2030**. None of them has ever been run: they're not the training seeds (1–60), the validation seeds (501–520) or the evaluation seeds (1001–1010) |
| Decision time | fixed 0.25 s for every contestant |
| Contestants | Jev · API enc1 and enc3 (`jev-1.13.0`, pinned); Nearest-Car ETA v1.2.0 and v1.3.0; round robin; zoned dispatch |
| Encodings | unchanged from the reported runs (`runner/src/encoding.ts` at this commit). Options stay in car order, **not shuffled**, as in the reported runs: this run confirms what was reported, and doesn't fix it |
| Metric | average wait (arrival to boarding) per run |
| Jev | each seed runs once |

**Pairings:** each is one run per scenario and seed.
- Jev enc3 vs Jev enc1
- Nearest-Car v1.2.0 vs round robin
- Nearest-Car v1.3.0 vs zoned

Each lane is an independent world on the same seed, so every contestant can be paired with every other one by seed.

## Primary hypotheses

There are four, tested at a family-wise α = 0.05 with Holm's correction. Differences are A − B in seconds, paired by seed, so a negative value means A waited less.

| ID | Claim | Test | Supported if |
|---|---|---|---|
| H1-normal | Jev enc3 waits less than Jev enc1 (Normal traffic) | two-sided paired t-test | Holm-adjusted p < 0.05 **and** the mean difference < 0 |
| H1-morning-wave | the same, Morning Wave | two-sided paired t-test | the same |
| H2-normal | Jev enc3 is **equivalent** to Nearest-Car ETA v1.2.0 within ±1.5 s (Normal) | TOST, two one-sided paired t-tests; the p-value is the larger of the two | Holm-adjusted p < 0.05 |
| H2-morning-wave | the same, Morning Wave | TOST | the same |

**Why the ±1.5 s margin:** it's about 4% of the average wait. It's also smaller than the gap between Nearest-Car and round robin in both scenarios in the earlier runs (2.8 s and 1.9 s), so "equivalent" can't include round-robin-level dispatching. We chose the margin before running, from the pilot's variance: with 30 seeds, the expected 90% interval half-width is about 0.6–0.7 s.

## Exploratory (reported, not tested for claims)

Paired differences with 95% intervals, per scenario:
- Jev enc1 − round robin;
- Jev enc3 − round robin;
- Jev enc3 − Nearest-Car v1.3.0;
- Nearest-Car v1.3.0 − v1.2.0.

Also reported: p95 wait, per-seed wins, Jev decisions, fallbacks, drift and cost.

## Rules

- **All 30 seeds run, then the analysis runs once.** No partial results are inspected. There's no early stopping and no extra seeds.
- **Rerun rule:** a run where more than 5% of a live lane's decisions failed or fell back is rerun once, and both runs are reported. The analysis uses the first run.
- **No exclusions otherwise.**
- **Everything is reported, whatever it shows.** If a hypothesis isn't supported, the articles say so and are corrected.
- **Evidence:**
  - every run is saved as a full run file, which the app's Audit verifies by replay (Jev answers are recorded, never re-asked);
  - the analysis is saved as `analysis.json`.

## Budget

About 5,400 Jev calls (2 scenarios × 30 seeds × 2 Jev lanes × about 45 decisions), roughly $0.11.

## Checks done before this commit (not part of the confirmation)

- The statistics code matches reference values: t distribution, quantiles, Holm.
- A plumbing run on throwaway seeds 9001–9002: 12 runs, 346 Jev calls, $0.007, 0 fallbacks, 0 drift. All 12 run files pass the app's Audit verification.
- The headless harness reproduces all 80 algorithm results that the app recorded in demo sets 1 and 3 exactly.
