# How to add new benchmarks

A **benchmark** in EDA is a fixed, repeatable comparison that answers one question: a building, one or more scenarios, the decision timing, a set of evaluation seeds, and the contestants raced on it. The published results are one such benchmark: 24 × 4, Normal traffic and Morning Wave, fixed 0.25 s decisions, seeds 1001–1010.

Adding a benchmark means deciding those parts up front, adding any contestant or scenario it needs, running it as batches, and writing down its definition, so anyone can rerun it and get the same numbers.

## 1. Write the question first

One sentence, such as *"Does a fine-tuned Laya beat Nearest-Car ETA on evening down-peak in a 12 × 3 building?"* It decides everything below. Change one thing per comparison: the setup check will tell you if you changed more.

## 2. Fix the definition

| Part | Decide | Guidance |
|---|---|---|
| Building | floors × cars | One size per question. Results don't compare across sizes |
| Scenarios | which traffic | Use a catalog scenario, or add one (see [How to generate new scenarios](how-to-generate-new-scenarios.md)). Each scenario is its own family |
| Scripted events | heavy group, spike, fault | Keep them fixed. Use fault pairs if resilience or SLAs matter |
| Decision time | fixed or measured | **Fixed 0.25 s** to compare decision quality; **measured** to include latency. Report which |
| Timeout | own or shared | Shared, when the lanes' own timeouts differ and that isn't the question |
| Seeds | a range | 10 consecutive seeds by default. **Never train on them** (see step 6) |
| Contestants | who races | Include at least one strong baseline (Nearest-Car ETA) and one naive baseline (round robin) |

## 3. Add a contestant

Skip this step if every contestant already exists (see [How to pick contestants](how-to-pick-contestants.md)).

**An algorithm.** Algorithms live in [`app/js/sim/registry.js`](../../app/js/sim/registry.js).

1. **Write a decision function** `(req, obs, params)` that builds the options with `assignOptions(obs, params)` and returns `pick(req, options, choice, trace)`. Use the existing `nearestEta`, `roundRobin` and `zoned` as templates. It only sees the shared contract: no passenger weights, no future.
2. **Register it** in `LIST` with `algorithm({ id, name, family, version, identity, description, salt, params, decisionWh }, yourFunction)`. `salt` must be unique: it seeds the lane's random stream together with the run's seed. Once it has been used in runs, don't change it.
3. **Give a changed rule a new version.** Don't edit an existing entry: its code hash is part of every run's provenance, and the old version should stay raceable.

**A decision model** that speaks the System One API (`POST /v1/systemone`). Models are defined in [`runner/src/backends.ts`](../../runner/src/backends.ts).

1. **Add a backend** to `BACKENDS`. It needs:
   - the endpoint URL and the name of its key variable in `~/.config/elevator-arena/env`;
   - a **pinned** model id (never an alias like `latest`);
   - `maxInFlight` and a price per million input tokens (0 for local);
   - an `identity()` check the runner calls at start-up. A hosted API can confirm the pinned model is listed. A local server should report its checkpoint (commit or weights hash).
2. **Add contestants for it** in `liveContestants()`, usually one per encoding (enc1–enc3). Give each:
   - a `timeoutS`;
   - a `decisionWh` estimate;
   - the setup facets: interface, encoding, model, tuning, location, compute, determinism and cost. The setup check compares them.
3. **Restart the runner.** It prints one line per backend: `ok` with the identity it found, or why it's down. The contestant then appears in the lane pickers and on the Contestants page.
4. **Never paste a key into chat or the repository.** Keys go only in the env file.

**A local Laya fine-tune** doesn't need code. Serve the checkpoint with `runtime/laya/serve_local.py` on its own port, and start the runner with `ARENA_LAYA_FT=<port>[,<port>…]`. It joins as *Laya · fine-tuned*, pinned by its weights hash.

## 4. Check fairness before spending

Open New experiment with your definition and each pairing, and read the **setup check**. For a model-vs-model question you want *Controlled · decider*, which in practice means the same encoding and the same timing. If it says *Setup comparison*, either fix it (the panel offers one-click fixes), or state in the write-up that it compares whole setups.

## 5. Run it

- **One batch per scenario and pairing.** Set the seed field to the first evaluation seed, choose 10 seeds (with fault pairs if you need resilience), and launch (see [How batching works](how-batching-works.md)).
- **Race each new contestant against the same baselines, on the same seeds.** New runs join the existing family as long as the scenario, building, events and timing match.
- **Paid APIs:** estimate first. That's runs × about 45 decisions per lane × the price per decision. Watch the runner log while it runs.

## 6. Keep training and evaluation apart

If you fine-tune on arena data, export training decisions from **other seeds** with [`runner/tools/export-dataset.ts`](../../runner/tools/export-dataset.ts) (imitation labels) or [`runner/tools/hindsight.ts`](../../runner/tools/hindsight.ts) (outcome labels). Both refuse the evaluation seeds 1001–1010. If your benchmark uses different evaluation seeds, keep them out of training the same way.

## 7. Read and record it

1. **Leaderboard:** pick the family, turn on *Controlled only* for model comparisons, and read each category's mean ± 95% interval and separability (see [How to rank contestants](how-to-rank-contestants.md)).
2. **SLA lab:** if the question is operational ("can it keep p95 wait under 60 s, even with a fault?"), evaluate it there (see [How to test an SLA](how-to-test-an-sla.md)).
3. **Download the run files** for the runs behind any number you publish (see [How to verify a run](how-to-verify-a-run.md)).
4. **Write the definition down** next to the results, in the style of [`docs/model-setups.md`](../model-setups.md) §15–20:
   - building, scenarios, events, timing, seeds;
   - contestants, with their versions, pins and encodings;
   - the simulator version (`eda-sim 0.2`);
   - the number of runs and model calls, and the cost.

   Anyone can then rerun it and check your numbers.

## Checklist

- [ ] One question, one thing changed per comparison
- [ ] Building, scenarios, events, timing and seeds written down before running
- [ ] Strong and naive baselines included
- [ ] Setup check read for every pairing
- [ ] Evaluation seeds never used for training
- [ ] 10+ seeds per condition
- [ ] Run files downloaded, and the definition recorded with the results
