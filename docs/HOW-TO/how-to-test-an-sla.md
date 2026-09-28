# How to test an SLA

**Menu section:** SLA lab

An SLA is an operational promise, such as *"p95 wait under 60 s, and nobody waits more than 2 minutes even when a car fails"*. The SLA lab checks whether each contestant keeps it **reliably**, under **normal** conditions (car fault off) and **failure** conditions (car fault on), and says how sure that verdict is.

## Steps

1. **Pick or write the SLA.** Open SLA lab (`S`) and choose an SLA version. The default is *Office tower · baseline*: p95 wait ≤ 60 s; longest wait ≤ 90 s (normal) and ≤ 120 s (failure); clear the wave in ≤ 150 s (normal) and ≤ 180 s (failure); decisions ≤ 1,000 ms; no safety vetoes.
   - To make your own, press *New SLA*, or *Duplicate & edit* on an existing one.
   - **Add clauses.** Each clause is a metric, a maximum, and when it applies: both conditions, normal only, or failure only. The metrics are P95 wait, Average wait, Longest wait, Time to clear the wave, Energy per passenger, Safety vetoes per run, and Avg decision time.
   - **Set the target** (the share of runs that must meet it: 80, 90, 95 or 99%) and the **minimum runs** per condition before a verdict is given.
   - Press *Save version*. **Saved SLAs are read-only.** Editing creates a new version, so thresholds can't move after you've seen the results.
2. **Get runs under both conditions.** Press *Run batch with fault pairs*. It opens New experiment with 10 seeds and fault pairs: every seed with and without the car fault. Check the scenario, contestants and decision time, then launch (see [How batching works](how-batching-works.md)).
3. **Pick the experiment family** the batch ran in.
4. **Read the verdict,** one cell per contestant and condition:

   | Verdict | Meaning |
   |---|---|
   | **Meets**, *Demonstrated at 95% confidence* | Observed compliance is above the target, and the 95% Wilson interval clears it too |
   | **Meets**, *Observed; not yet demonstrated* | Above the target, but too few runs to be sure. The cell says how many more clean runs would demonstrate it |
   | **Falls short**, *Observed; not yet conclusive* | Below the target, but not yet certain |
   | **Fails**, *Demonstrated at 95% confidence* | Below the target, with confidence |
   | **Not enough runs** | Fewer than the minimum runs for that condition |

   A run meets the SLA only if **every** clause that applies to its condition passes. The cell also names the clause that **breaks first**.
5. **Look at the clauses.** Each clause has a strip plot with one dot per run, the threshold as a line, and hollow dots for runs that failed. It shows whether the misses are near-misses or far off.

## Tips

- **Write the SLA before running.** The point of read-only versions is that the threshold was chosen before the result was known.
- **Use fault pairs.** Without failure-condition runs, the failure half of the SLA has no evidence.
- **The decision-time clause uses the measured time**, under both fixed and measured timing. Runs recorded before real times were kept can't be judged on it, so they're left out of any SLA that has that clause, and the cell says how many. Rerun the batch, or use an SLA without that clause, to evaluate them.
- **The numbers come from the simulated building.** The decisions are real, but thresholds tuned here are a starting point for a real building, not a guarantee.
