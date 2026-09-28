# How to compare runs

**Menu section:** Run history

Run history lists every run as an audit record: its definition, its results per contestant, how it was run, and whether reruns reproduced it. Its main job is **comparing two runs**, either to check a replication or to see what one change did.

## Steps

1. **Open Run history** (`H`). Filter by *All*, *Finished*, *Running* or *Incomplete* (stopped or interrupted runs).
2. **Scan the replication badges:**
   - **Replicated ×n:** n other finished runs have the same definition *and* the same results.
   - **Mismatch:** same definition, different results. That should never happen: audit both runs.
   - **Not rerun:** no other finished run with this definition yet.
3. **Open a run** to see its definition, contestants, results, and waiting over sim time. From there you can:
   - *Rerun same definition*;
   - *Open in Arena*, if it's from this session;
   - *Audit & replay*, if its run file is still stored;
   - *Remove* it.
4. **Pick two runs** with their checkboxes, then press *Compare*.
5. **Read the verdict at the top:**
   - *Same experiment, same results*: the two share the definition hash and the result fingerprint. One replicates the other.
   - *Same experiment, different results*: the definition matches but the fingerprints don't. Audit both run files to find where they diverge.
   - *Different experiments*: the differences below reflect both the change in definition and the contestants' behaviour.
6. **Read the details:**
   - **Definition side by side.** It says how many fields differ. Only the fields without a note can change simulated results.
   - **Results per contestant.**
   - **Waiting over time.**
   - **The setup check** for each run's pairing.

   Press *Swap* to change which run is the baseline.

## Common uses

| Question | Compare |
|---|---|
| Does this result reproduce? | A run and its rerun (`R` in the Arena, or *Rerun same definition*) |
| What did one change do? | Two runs whose definitions differ in one field, such as the seed, one event, or the decision timing |
| How does a contestant do on the same seed in two lanes? | Runs with the same seed and scenario, different pairings |

## Good to know

- **History lives in this browser:** up to 200 records. *Clear history* removes them all, and doesn't touch downloaded run files.
- **Records summarise; run files prove.** Full run files are kept for the newest 15 runs only. Download the ones you need (see [How to verify a run](how-to-verify-a-run.md)).
- **Wall-clock differences are expected.** Run mode and real decision time change how long a run took to compute, never its simulated results (except under *measured* timing, where latency is part of the experiment).
