# How batching works

A **batch** is one experiment definition repeated over several seeds, and optionally run with and without the car fault. It's how EDA turns single races into rankings with confidence intervals.

## Launching one

Batches are launched from **New experiment**: set *Repetitions* to more than one seed, or tick *Fault pairs*. Four other buttons open the same form, prefilled for a batch:

| From | Button | Prefills |
|---|---|---|
| Leaderboard | *Run benchmark batch* | 10 seeds, plus the building and events of the family you're viewing |
| SLA lab | *Run batch with fault pairs* | 10 seeds with fault pairs, plus the building and events of the family you're viewing |
| Scenarios | *Batch* on a scenario card | 10 seeds with fault pairs, plus that scenario and its default events |
| New experiment | *Seeds* 5, 10 or 20, and *Fault pairs* | whatever you set |

**Always check the scenario and the decision time before launching.** The Leaderboard and SLA lab buttons copy only the building and events. The scenario, contestants and timing come from the run you were viewing. For the new runs to join an existing family, the scenario, building, events and decision timing must all match it. The contestants can differ: that's how a new contestant joins a ranking.

The launch button says how many runs will start, for example *Launch batch (20 runs)*.

## What it launches

- **Seeds:** consecutive, starting from the *Seed* field. Seed 1001 with 10 repetitions runs seeds 1001–1010.
- **Fault pairs:** each seed runs twice, once with the car fault and once without. 10 seeds with fault pairs make 20 runs. The pairs feed the Leaderboard's *Resilience* category (extra time to clear with the fault, on the same seed) and the SLA lab's normal and failure conditions.
- **Everything else is identical** across the runs: building, scenario, other events, contestants and decision timing.

## How it runs

- **Max speed, in the background.** Batches always compute at max speed. The *Start in* choice is disabled. Every run of the batch advances at once in this browser tab, sharing the frame budget. Results are identical to timeline playback.
- **One sidebar entry.** The batch appears as *Batch N* with a progress count. You land on the Leaderboard for its family, which shows *Batch N is running* until runs finish. A toast says when it's done.
- **Discarding:** the × on the batch entry stops and discards its unfinished runs. Finished runs stay recorded.

## Batches with live models

- **Every run pauses while its model's answer is out.** Many runs share the runner, and each backend limits how many calls it has in flight: Jev 4, local Laya 1, each local fine-tune 1. The rest queue.
- **Queueing never counts as decision time.** The runner reports queue time separately, and in *measured* mode only the call's own latency lands in the simulation. A busy batch doesn't make a model look slower.
- **Speed:** a Laya batch is roughly serial, at 35–50 ms per decision. Budget about runs × 45 decisions × 40 ms, plus the simulation itself. Jev's calls are slower (about 200 ms each), but 4 run in parallel.
- **Cost:** estimate before a paid batch: runs × about 45 decisions per lane × the price per decision. The runner prints each call as it happens.

## Where the results go

- **Every finished run is recorded** in Run history, and feeds the Leaderboard and the SLA lab, grouped by *experiment family*. A family is the same scenario, building, scripted events, decision timing and simulator, with the seeds varying.
- **Reruns of an identical definition count once.** A seed you ran twice doesn't inflate *n*.
- **The batch itself isn't saved.** Reloading the page forgets the batch grouping. Finished runs stay in history. Unfinished ones are marked *Interrupted*; relaunch them.
- **Full run files are kept for the newest 15 runs only.** A 20-run batch keeps run files for its last 15. Download any you'll need for Audit (see [How to verify a run](how-to-verify-a-run.md)).

## Choosing the size

| Seeds | Good for |
|---|---|
| 5 | The minimum before a contestant stops being *provisional* on the Leaderboard |
| 10 | Most comparisons; what the published results use (seeds 1001–1010) |
| 20 | Close contests, where 10 seeds leave the intervals overlapping |

Seeds 1001–1010 are the evaluation seeds of the published results. The dataset exporter refuses to train on them. Keep using them for evaluation, and never for fine-tuning data.
