# Confirmation run 2: pre-registration

**Written:** 2026-09-28, before any seed of this run was used. The commit that adds this file also adds the shuffled encodings and the updated tool, so its timestamp proves the plan came first.

**Why:** confirmation run 1 ([results](results.md)) confirmed the two Jev claims. Two things were still open:
- **The Laya claims**, zero-shot and fine-tuned, are still exploratory.
- **Option order:** in every run so far the cars were listed in the same order (car 1 = option A), and one fine-tune collapsed onto option A.

This run tests both.

## New since run 1

- **Shuffled encodings** (`enc1s`, `enc3s`, and `…-shuffled` for fine-tunes; `runner/src/encoding.ts`):
  - they list the legal cars in an order that looks random but is fixed by the request, so the same request always gets the same order;
  - the descriptions carry no car numbers, so only the order changes, and answers are mapped back to the right car;
  - each shuffled contestant differs from its twin in the encoding facet alone.
- **Position analysis of run 1** (free: it only uses recorded decisions, done before this plan). Over 2,271 enc3 decisions, Jev's choices were spread across positions A–D like the rule's (A: 29.8% against the rule's 27.8%). When the rule's car wasn't A, Jev picked A 6.0% of the time and the last option 5.1%. **With enc1 (raw numbers), Jev picked A 36.4% of the time, against the rule's 25.7%.** That's either position bias or a genuine preference for car 1, and only shuffling can tell them apart.

## What is frozen

Everything is fixed in `SPEC2` in [`runner/tools/confirm.ts`](../../runner/tools/confirm.ts).

**SPEC2 sha256:** `be311e91df0150fb482c8b3863470a43bf7b696aa3a530927f4d53b623cb8f26`. Check it with `node --experimental-strip-types tools/confirm.ts --spec 2 --spec-hash`.

| | |
|---|---|
| Simulator | eda-sim 0.2, the app at this commit |
| Conditions | office 24 × 4 Normal traffic; office 24 × 4 Morning Wave (default events); second building 12 × 3 Evening down-peak |
| Seeds | **3001–3030**, never used for anything, including run 1 (2001–2030) |
| Decision time | fixed 0.25 s |
| Laya | base English checkpoint at commit 55cf4c4 (`laya-local@enc1`, `@enc3`), and the office imitation fine-tune `laya-ft@pilot-imitation-enc3-bd0835f`, pinned by its weights hash, plus its shuffled twin |
| Jev | `jev-1.13.0`: `enc1`, `enc1s`, `enc3`, `enc3s` |
| Algorithms | Nearest-Car ETA v1.2.0 and v1.3.0, round robin, zoned |
| Metric | average wait per run |

**Office pairings** (one run each, per condition and seed):
- base Laya enc1 vs round robin
- pilot vs base Laya enc3
- Nearest-Car v1.3.0 vs v1.2.0
- Jev enc3 vs enc3s
- Jev enc1 vs enc1s
- pilot, shuffled, vs zoned

**Second building:**
- pilot vs Nearest-Car v1.2.0
- Nearest-Car v1.3.0 vs round robin

## Primary hypotheses

There are nine, with family-wise α = 0.05 and Holm correction. Paired over 30 seeds; the difference is A − B, and a negative value means A waited less.

| ID | Claim | Test |
|---|---|---|
| H3-normal / H3-morning-wave | zero-shot base Laya on raw numbers (enc1) waits **longer** than round robin | two-sided paired t; supported if Holm p < 0.05 and the mean is > 0 |
| H4-normal / H4-morning-wave | the imitation fine-tune waits **less** than base Laya with the same encoding (enc3) | two-sided paired t; supported if Holm p < 0.05 and the mean is < 0 |
| H5-normal / H5-morning-wave | the fine-tune is **equivalent** to its teacher, Nearest-Car v1.3.0, within ±1.5 s | TOST |
| H6-12x3-down-peak | in the second building, which it never trained on, the office fine-tune is **equivalent** to Nearest-Car v1.2.0 within ±1.5 s | TOST |
| H7-normal / H7-morning-wave | **option order doesn't matter** for Jev with the arrival estimate: enc3s is equivalent to enc3 within ±1.5 s | TOST |

The margin stays ±1.5 s, as in run 1, for the same reasons.

## Exploratory (reported, not claims)

- **Shuffled vs fixed order:**
  - Jev enc1s − enc1, which tests whether its extra picks of A were position bias;
  - pilot-shuffled − pilot, which tests whether the fine-tune leans on position. It was trained on fixed order.
- **Laya against the baselines:**
  - pilot − round robin;
  - base Laya enc3 − round robin;
  - in the second building, pilot − Nearest-Car v1.3.0.
- **Repeats of run 1 comparisons on new seeds:**
  - Jev enc3 − Nearest-Car v1.2.0;
  - Nearest-Car v1.2.0 − round robin, in all three conditions.
- **Per-position choice rates** for every live lane, against the position of the lowest-ETA car.

## Rules

- **Run once:** all seeds run, then the analysis runs once. No partial results are inspected, and there are no extra seeds.
- **Rerun rule:** a run where more than 5% of a live lane's decisions failed or fell back is rerun once, and both runs are reported.
- **No exclusions.**
- **Report everything,** whatever it shows. If a hypothesis fails, the articles are corrected.
- **Evidence:** every run is saved as a full run file, verified by the app's Audit.

## Budget

- **Jev:** 4 lanes × 2 office conditions × 30 seeds × about 45 decisions, about 10,800 calls, roughly $0.22.
- **Laya:** about 11,800 local calls, at no cost; roughly 10 minutes.

## Checks done before this commit

- **Runner tests pass**, including a new one: the shuffled encoding is deterministic, a permutation of the legal cars, and decodes back to the right car.
- **The shuffle spreads the first legal car evenly across positions:** about 33% each with 3 options, 22–33% with 4. The order changes on 90% of requests.
- **Run 1's SPEC hash is unchanged** after the tool was extended. A run-1 plumbing check on throwaway seeds 9001–9002 reproduced its deterministic results exactly.
- **Run 2 plumbing check** on throwaway seeds 9101–9102: 28 runs, 1,379 live calls, 0 fallbacks, 0 drift. All 28 run files pass the app's Audit verification.
