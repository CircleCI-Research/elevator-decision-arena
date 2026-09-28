# How to rank contestants

**Menu section:** Leaderboard

The Leaderboard ranks contestants **within one experiment family**: runs that share the scenario, building, scripted events, decision timing and simulator, with seeds varying. Within a family the raw numbers compare. Across families they don't, so the page never mixes them.

## Steps

1. **Get runs in.** Rankings need several seeds. Press *Run benchmark batch*: it opens New experiment with 10 seeds and the current family's building and events. Check the scenario and decision time match too, then launch (see [How batching works](how-batching-works.md)).
2. **Open Leaderboard** (`L`) and **pick the family** from the selector. A batch opens its own family automatically, and shows *Batch N is running* until its runs finish.
3. **Choose which runs count:**
   - *All runs*: every finished run in the family.
   - *Controlled only*: only runs where exactly one thing differed between the lanes. Use this to rank models against each other. A note says how many setup-comparison runs were hidden.
4. **Read the overall standing.**
   - **Runs:** unique runs the contestant took part in. Reruns of an identical definition count once. Fewer than 5 runs marks the contestant **provisional**.
   - **Avg rank:** the average rank across the headline categories, with equal weights. Lower is better. It also shows leads, and how many of those leads are *separable*.
   - **Head to head:** waves cleared first–second–tied.
5. **Read the categories.** Each card shows the mean ± 95% confidence interval across seeds, and marks the leader and whether the lead is **separable**. Separable means the intervals don't overlap.

   | Category | Metric | In the overall standing |
   |---|---|---|
   | Speed | Time to clear the whole wave | yes |
   | Wait | Average wait, arrival to boarding | yes |
   | Fairness | Longest wait (the worst-served passenger) | yes |
   | Resilience | Extra time to clear with the car fault, against the same seed without it (needs fault pairs) | yes |
   | Safety | Decisions vetoed by the safety layer, per 100 | yes |
   | Decision cost | Average time to produce a decision | yes |
   | P95 wait, Energy, Utilization, Decision energy | shown for context | no |

   Lower is better in every category.

## Reading it correctly

- **"Not separable" doesn't mean "equal".** It means 10 seeds couldn't tell the two apart. Run 20 seeds if the question matters.
- **The intervals are per contestant, not paired by seed.** Two contestants on the same seeds can differ more reliably than overlapping intervals suggest. For a paired, seed-by-seed comparison, compare their runs seed by seed (see [How to compare runs](how-to-compare-runs.md)), or do it offline from the run files.
- **Resilience needs fault pairs.** Without them, that card says so and the category doesn't count.
- **Fixed vs measured timing are different families.** A contestant ranked under fixed 0.25 s decisions (quality only) isn't ranked against measured-latency runs.
- **Older-simulator runs** (recorded before a simulator fix) form their own family, labelled *older simulator*, and never mix with current ones.
