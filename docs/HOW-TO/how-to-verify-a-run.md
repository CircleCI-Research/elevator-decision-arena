# How to verify a run

**Menu section:** Audit & replay

A **run file** records a run's definition and every decision, including, for live models, the exact request sent and the response received. Audit re-derives everything else by replaying the simulation, and checks it against the record. **A live model is never re-asked.** Its recorded answers are the evidence.

## Steps

1. **Open Audit & replay** (`A`). It opens on the run you were viewing, or on the latest finished run.
2. **Pick the run file:**
   - from the selector (runs from this session and the ones stored in this browser); or
   - with *Open run file…*, for a file you downloaded or were sent. Anyone can verify a run this way, on any machine, without keys or models.
3. **Read the verification** (it replays in milliseconds):

   | Check | Passes when |
   |---|---|
   | **Definition** | The definition hash recomputed from the file matches the recorded one |
   | **Decisions** | Every decision the replay asked for matches a recorded request, in order |
   | **Fingerprint** | The replayed results match the recorded results fingerprint |
   | **Integrity** | The decision log hash matches, and agrees with this browser's own record of the run, if there is one |

   The verdict is **Verified** or **Verification failed**. Two other outcomes are possible:
   - **Older simulator:** the run was recorded before a simulator change, so the replay can't confirm it. That isn't a failure.
   - **Former name:** runs recorded under the simulator's former name (`mock-world 0.2`) verify as the same simulator, `eda-sim 0.2`.

   The setup check for the run's pairing is shown below.
4. **Replay it.** Play, step decision by decision (`→`), and set the speed (1× to 64×). The buildings, the decision list and the event log move in sync.
5. **Inspect a decision.** Pick a lane tab, then a decision:
   - the **options** it had, including vetoed ones and why;
   - its choice and probabilities, or its rule trace;
   - the **observation**: everything the policy was allowed to see. Only total load per car is visible, never individual passenger weights;
   - for a live model, the **live call**: the model and version that answered, latency, runner queueing, tokens and cost, and the **request sent** and **response received**;
   - fallbacks: if the contestant was over its timeout, what it chose and what the fallback decided instead.
6. **Download the run file** to keep it, or to send it to someone. It includes the full scenario definition, so custom scenarios replay too.

## When a check fails

- **Decisions diverge:** the replay marks the first decision that doesn't match, and what the record says instead. Everything after it is unverified.
  - This usually means the file was edited, or it comes from a different version of the app or a contestant.
  - The contestant's recorded provenance (code hash, pinned model, encoding) shows which one.
- **Fingerprint differs, decisions match:** the simulation itself behaved differently. Check the simulator version.
- **Definition hash differs:** the definition in the file was changed after it was recorded.

## Keep what you need

- **Only the newest 15 run files stay in browser storage.** A browser record in Run history outlives its run file.
- **Download a run file** for every run behind a number you publish, or a result you want to defend later. The file is plain JSON, named like `eda-run-12-24x4-seed1001.json`.
