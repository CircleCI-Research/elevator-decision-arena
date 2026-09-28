# Confirmation run 2: results

**Ran:** 2026-09-28, after the pre-registration was committed ([preregistration-2.md](preregistration-2.md), commit `b951c14`). SPEC2 sha256 `be311e91…23cb8f26`, unchanged.

**Summary:** 420 runs, with 21,124 live calls: 10,187 Jev decisions and about 10,900 local Laya decisions. Jev cost **$0.21**. There were 0 fallbacks, 0 drifted decisions and 0 reruns, and it took 512 s.
- **All 420 run files pass the app's Audit verification** by replay.
- **For the position analysis,** all 19,144 model requests were rebuilt from the replay with the runner's own encoder. Every one is identical to the recorded request, so the order each model saw is known exactly.
- **Files:** full analysis in [analysis-2.json](analysis-2.json); position analysis in [positions-2.json](positions-2.json).

## Primary hypotheses: all nine supported

Average wait, A − B in seconds, paired over seeds 3001–3030 (n = 30). A negative value means A waited less. Holm-adjusted across the nine tests. "Pilot" is the office imitation fine-tune `laya-ft@pilot-imitation-enc3-bd0835f`.

| ID | Comparison | Mean | 95% CI | Test | Holm p | Verdict | A better |
|---|---|---|---|---|---|---|---|
| H3-normal | base Laya enc1 − round robin | **+13.96** | [+10.46, +17.46] | t (expect > 0) | 3.8e-8 | **supported** | 1/30 |
| H3-morning-wave | base Laya enc1 − round robin | **+8.54** | [+7.22, +9.85] | t (expect > 0) | 7.1e-13 | **supported** | 0/30 |
| H4-normal | pilot − base Laya enc3 | **−10.55** | [−13.12, −7.97] | t (expect < 0) | 2.6e-8 | **supported** | 28/30 |
| H4-morning-wave | pilot − base Laya enc3 | **−4.42** | [−6.14, −2.70] | t (expect < 0) | 6.1e-5 | **supported** | 24/30 |
| H5-normal | pilot − Nearest-Car v1.3.0 (its teacher) | +0.03 | [−0.72, +0.79] | TOST ±1.5 | 8.9e-4 | **supported** (equivalent) | 15/30 |
| H5-morning-wave | pilot − Nearest-Car v1.3.0 | +0.13 | [−0.37, +0.64] | TOST ±1.5 | 1.6e-5 | **supported** (equivalent) | 6/30 |
| H6-12x3-down-peak | pilot − Nearest-Car v1.2.0, second building | +0.06 | [−1.00, +1.13] | TOST ±1.5 | 7.1e-3 | **supported** (equivalent) | 13/30 |
| H7-normal | Jev enc3s − Jev enc3 (shuffled − fixed order) | −0.66 | [−1.25, −0.06] | TOST ±1.5 | 7.1e-3 | **supported** (equivalent) | 20/30 |
| H7-morning-wave | Jev enc3s − Jev enc3 | −0.35 | [−1.10, +0.39] | TOST ±1.5 | 5.5e-3 | **supported** (equivalent) | 13/30 |

**Reading:**
1. **Zero-shot base Laya, in our raw-number format, waits longer than round robin.** It did worse on 29 of 30 seeds in Normal traffic and 30 of 30 in Morning Wave.
2. **Fine-tuning helps.** The imitation fine-tune beats base Laya with the same encoding by 10.6 s and 4.4 s.
3. **The fine-tune equals its teacher** within ±1.5 s. In the second building, which it never trained on, it equals Nearest-Car v1.2.0.
4. **For Jev with the arrival estimate, option order doesn't matter** within the margin. On Normal traffic the shuffled version was slightly *better* (−0.66 s), so the fixed order didn't flatter Jev.

## Means (seconds, 30 seeds)

| Contestant | Normal | Morning Wave | 12 × 3 down-peak |
|---|---|---|---|
| Base Laya enc1 | 45.8 | 51.4 | |
| Base Laya enc3 | 40.9 | 47.8 | |
| Pilot fine-tune | 30.4 | 43.4 | 47.4 |
| Pilot fine-tune, shuffled | 30.5 | 43.3 | |
| Jev enc1 / enc1s | 33.2 / 32.4 | 47.3 / 46.5 | |
| Jev enc3 / enc3s | 30.8 / 30.1 | 43.8 / 43.5 | |
| Nearest-Car v1.2.0 | 30.4 | 42.9 | 47.4 |
| Nearest-Car v1.3.0 | 30.3 | 43.3 | 47.4 |
| Round robin | 31.8 | 42.9 | 47.9 |
| Zoned dispatch | 31.3 | 45.4 | |

## Exploratory

| Condition | Comparison | Mean | 95% CI | A better |
|---|---|---|---|---|
| Normal | Jev enc1s − enc1 | −0.73 | [−2.17, +0.71] | 16/30 |
| Morning Wave | Jev enc1s − enc1 | −0.85 | [−2.24, +0.54] | 16/30 |
| Normal | pilot shuffled − pilot | +0.08 | [−0.56, +0.71] | 14/30 |
| Morning Wave | pilot shuffled − pilot | −0.07 | [−0.61, +0.47] | 6/30 |
| Normal | pilot − round robin | **−1.43** | [−2.67, −0.20] | 21/30 |
| Morning Wave | pilot − round robin | +0.54 | [−0.94, +2.01] | 15/30 |
| Normal | Jev enc3 − Nearest-Car v1.2.0 | +0.39 | [−0.19, +0.97] | 12/30 |
| Morning Wave | Jev enc3 − Nearest-Car v1.2.0 | +0.95 | [−0.06, +1.96] | 14/30 |
| Normal | base Laya enc3 − round robin | **+9.11** | [+6.47, +11.76] | 1/30 |
| Morning Wave | base Laya enc3 − round robin | **+4.96** | [+3.08, +6.84] | 6/30 |
| 12 × 3 down-peak | pilot − Nearest-Car v1.3.0 | −0.02 | [−0.92, +0.88] | 14/30 |
| Normal | Nearest-Car v1.2.0 − round robin | **−1.41** | [−2.58, −0.24] | 21/30 |
| Morning Wave | Nearest-Car v1.2.0 − round robin | +0.03 | [−1.46, +1.51] | 16/30 |
| 12 × 3 down-peak | Nearest-Car v1.2.0 − round robin | −0.56 | [−2.34, +1.23] | 17/30 |

## Option order: what the models actually picked

The position is the order each model *saw*. In a shuffled lane, position A is a random car, so any lean towards A is a lean towards the position itself.

| Lane (Normal traffic) | Picks A | Rule's car at A | Agrees with the rule | Rule's car not A: picks A | Rule's car not last: picks last |
|---|---|---|---|---|---|
| Jev enc1 (fixed) | 33.3% | 21.0% | 48.7% | 24.1% | 14.2% |
| Jev enc1s (shuffled) | 32.7% | 26.9% | 51.7% | 21.8% | 15.6% |
| Jev enc3 (fixed) | 27.6% | 26.3% | 85.3% | 6.7% | 5.2% |
| Jev enc3s (shuffled) | 30.2% | 27.6% | 85.4% | 6.4% | 3.4% |
| Pilot (fixed) | 26.0% | 28.7% | 84.8% | 4.1% | 5.2% |
| Pilot, shuffled | 24.8% | 27.0% | 85.7% | 3.6% | 5.5% |
| Base Laya enc1 (fixed) | 35.6% | 12.0% | 18.7% | 34.5% | 16.7% |

Morning Wave shows the same pattern. See [positions-2.json](positions-2.json).

- **Jev on raw numbers leans towards the first option.** It does so even when the order is shuffled: it picks A about 6 points more often than the rule's car sits there, and when it disagrees with the rule it picks A more often than the last option (21.8% against 15.6%). With the fixed order the excess was about 12 points, so part of it was a genuine preference for car 1 and part was position. **The lean made no measurable difference to waiting** (enc1s − enc1: −0.7 s and −0.9 s, not separable).
- **With the arrival estimate, Jev's lean is small** (a few points) and doesn't change the outcome (H7).
- **The imitation fine-tune shows no lean,** and shuffling doesn't change its results. It learned the facts, not the position. (The small per-building fine-tune that collapsed onto A, F018, did learn position.)
- **Base Laya on raw numbers picks A far more often than the rule would** (35.6% against 12.0%). It wasn't run with shuffled options, so we can't say how much of that is position.

## A claim that did not replicate

The exploratory run on seeds 1001–1010 said that in the second building the office fine-tune was **1.6 s better than Nearest-Car v1.3.0** (8 of 10 seeds). **On fresh seeds it was level:** −0.02 s [−0.92, +0.88]. The fine-tune and both rule versions all scored 47.4 s. The equivalence claim (H6) holds; the "better than v1.3.0" claim doesn't.

## Round robin, again

On Morning Wave, round robin was level with the rule (+0.03 s) and with the fine-tune, as in run 1. On Normal traffic the rule beat it by 1.4 s. In this simulator, the morning rush is kinder to turn-taking than the first ten seeds suggested.

## What this changes

- **Now confirmed on fresh seeds:** the Laya claims (zero-shot base worse than round robin; fine-tune better than base; fine-tune equal to its teacher; fine-tune holds its level in a second building), and **option order doesn't matter** for Jev's arrival-estimate result.
- **Corrected:** "the fine-tune beat Nearest-Car v1.3.0 in the second building".
- **Still exploratory:**
  - the hindsight-label fine-tune;
  - the collapsed per-building fine-tune;
  - measured-latency results;
  - Jev vs Laya head-to-head, which was never a pre-registered contrast, though every run points the same way.
