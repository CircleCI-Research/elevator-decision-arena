# How-to guides

Short, task-first guides to Elevator Decision Arena (EDA). Each one says what you get, then the steps. For the design reasoning behind the app, see the other documents in [`docs/`](..). For the reference description of every page, see [`app/README.md`](../../app/README.md).

Start the app with the runner (`cd runner && npm start`, then open http://127.0.0.1:8787/) whenever you want live models (local Laya, the Jev API). Without the runner, the page still works with the algorithms alone.

## Cross-cutting

| Guide | Use it when you want to… |
|---|---|
| [How to add new benchmarks](how-to-add-new-benchmarks.md) | set up a new, repeatable comparison, including new contestants to race in it |
| [How to generate new scenarios](how-to-generate-new-scenarios.md) | create new traffic, in the app or as a built-in scenario in code |
| [How batching works](how-batching-works.md) | understand what a batch launches, how it runs, and where its results go |

## One per menu section

| Menu section | Guide | Main activity |
|---|---|---|
| **Arena** | [How to run a race](how-to-run-a-race.md) | define an experiment and watch two contestants dispatch the same traffic |
| **Scenarios** | [How to generate new scenarios](how-to-generate-new-scenarios.md) | browse, preview and create traffic definitions (shared with the cross-cutting guide above) |
| **Contestants** | [How to pick contestants](how-to-pick-contestants.md) | inspect a contestant's identity and put it in a lane, or pair it for a controlled comparison |
| **Leaderboard** | [How to rank contestants](how-to-rank-contestants.md) | read rankings with confidence intervals across seeds |
| **SLA lab** | [How to test an SLA](how-to-test-an-sla.md) | check whether each contestant keeps an operational promise, under normal and failure conditions |
| **Run history** | [How to compare runs](how-to-compare-runs.md) | compare two runs and check that reruns reproduce |
| **Audit & replay** | [How to verify a run](how-to-verify-a-run.md) | verify a run file and replay every decision |

## Things every guide assumes

- **The building and traffic are simulated; the decisions are real.** Results rank contestants within this simulation, not in real buildings.
- **An experiment is fixed once it starts.** Only the run mode (timeline or max speed) can change while it runs.
- **Browser storage holds your records.** Run history keeps up to 200 runs, and full run files are kept for the newest 15 runs only. Download the run files you need to keep (see [How to verify a run](how-to-verify-a-run.md)).
- **Keyboard:** `N` new experiment, `R` rerun, `Space` play or pause, `→` step, `M` run mode, `H` history, `A` audit, `L` leaderboard, `S` SLA lab, `C` scenarios, `P` contestants.
