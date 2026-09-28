# Confirmation run 1: results

**Ran:** 2026-09-28 08:55 UTC, after the pre-registration was committed ([preregistration.md](preregistration.md), commit `2844075`, 08:50 UTC). SPEC sha256 `c5c4849a…367234d`, unchanged.

**Summary:** 180 runs and 4,973 live calls, covering 5,151 Jev decisions. Jev cost **$0.104**. There were 0 fallbacks, 0 drifted decisions and 0 reruns, and it took 247 s. **All 180 run files pass the app's Audit verification** by replay (Jev answers are recorded, never re-asked). The full analysis, with every per-seed value, is in [analysis.json](analysis.json).

## Primary hypotheses: all four supported

Average wait, A − B in seconds, paired over seeds 2001–2030 (n = 30). A negative value means A waited less. Holm-adjusted across the four tests.

| ID | Comparison | Mean difference | 95% CI | 90% CI | Test | Holm p | Verdict | A better |
|---|---|---|---|---|---|---|---|---|
| H1-normal | Jev enc3 − Jev enc1 | **−3.22** | [−4.66, −1.77] | [−4.42, −2.01] | paired t | 2.7e-4 | **supported** | 25/30 |
| H1-morning-wave | Jev enc3 − Jev enc1 | **−3.97** | [−5.26, −2.69] | [−5.04, −2.90] | paired t | 2.7e-6 | **supported** | 27/30 |
| H2-normal | Jev enc3 − Nearest-Car v1.2.0 | −0.50 | [−1.45, +0.45] | [−1.29, +0.29] | TOST ±1.5 s | 0.037 | **supported** (equivalent) | 16/30 |
| H2-morning-wave | Jev enc3 − Nearest-Car v1.2.0 | −0.75 | [−1.45, −0.04] | [−1.33, −0.16] | TOST ±1.5 s | 0.037 | **supported** (equivalent) | 18/30 |

**Reading:**
1. **The arrival estimate helps Jev.** This is confirmed on fresh seeds. The effect is smaller than in the exploratory runs (−3.2 / −4.0 s here, against −5.5 / −4.7 s on seeds 1001–1010). That shrinkage is what you'd expect once a choice made while watching one set of seeds is re-tested on another.
2. **With the estimate, Jev is equivalent to Nearest-Car ETA v1.2.0 within ±1.5 s** in both scenarios. On Morning Wave the 95% interval only just excludes zero, on the side where Jev waits less. The pre-registered claim is equivalence, not superiority, so we don't claim Jev is better.

## Means (seconds, 30 seeds)

| Contestant | Normal | Morning Wave |
|---|---|---|
| Jev enc3 | 29.8 | 42.0 |
| Jev enc1 | 33.0 | 46.0 |
| Nearest-Car ETA v1.2.0 | 30.3 | 42.7 |
| Nearest-Car ETA v1.3.0 | 30.0 | 41.6 |
| Round robin | 31.9 | 41.9 |
| Zoned dispatch | 30.9 | 44.1 |

## Exploratory (pre-registered as exploratory; not claims)

| Scenario | Comparison | Mean | 95% CI | A better |
|---|---|---|---|---|
| Normal | Jev enc1 − round robin | +1.08 | [−0.65, +2.80] | 13/30 |
| Normal | Jev enc3 − round robin | **−2.14** | [−3.09, −1.19] | 23/30 |
| Normal | Jev enc3 − Nearest-Car v1.3.0 | −0.23 | [−0.95, +0.48] | 17/30 |
| Normal | Nearest-Car v1.3.0 − v1.2.0 | −0.26 | [−1.13, +0.61] | 16/30 |
| Morning Wave | Jev enc1 − round robin | **+4.02** | [+2.41, +5.62] | 4/30 |
| Morning Wave | Jev enc3 − round robin | +0.05 | [−1.22, +1.31] | 16/30 |
| Morning Wave | Jev enc3 − Nearest-Car v1.3.0 | +0.42 | [−0.44, +1.28] | 10/30 |
| Morning Wave | Nearest-Car v1.3.0 − v1.2.0 | **−1.17** | [−2.08, −0.25] | 23/30 |

**Not pre-registered (post hoc), Nearest-Car v1.2.0 − round robin:**
- Normal: −1.64 s [−2.75, −0.53], rule better on 23/30 seeds;
- Morning Wave: +0.79 s [−0.55, +2.13], rule better on 15/30.

**A surprise, reported as found:** on these fresh Morning Wave seeds, **round robin was not beaten**. It was level with Jev enc3 and with Nearest-Car v1.2.0, and 0.3 s from v1.3.0. On seeds 1001–1010 it had been about 2 s behind. In this scenario, the gap between "smart" and "taking turns" is smaller than the earlier runs suggested. Jev on raw numbers (enc1) was still clearly worse than round robin on Morning Wave (+4.0 s, round robin better on 26 of 30 seeds).

## What this does and does not change

- **The headline claims about Jev now rest on a confirmatory test,** not only on exploratory runs:
  - the arrival estimate helps;
  - with it, Jev is equivalent to the classic rule within 1.5 s.
- **Unchanged limits:**
  - one simulated building and two traffic patterns;
  - options not shuffled;
  - the arrival estimate is the rule's own formula;
  - Jev ran once per seed.
- **Laya results were not part of this run** and remain exploratory.
- **The phrase "anything smart should beat round robin" needs care.** On Morning Wave, with these seeds, the simple baseline held its own.
