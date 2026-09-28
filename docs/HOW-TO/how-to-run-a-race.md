# How to run a race

**Menu section:** Arena

A race puts two contestants (lanes A and B) in two identical copies of the same simulated building. They get the same passengers, seed and scripted events, so the only thing that differs is who dispatches the cars.

## Steps

1. **Open New experiment.** Use *New experiment* in the sidebar, or press `N`. The form starts from the run you're viewing, so a variation is one change away.
2. **Building.** Set *Floors* and *Cars*, or pick a preset (Low-rise 6 × 3 up to Megatall 120 × 16). Above 24 floors or 6 cars nothing is drawn: the run shows a stats board instead.
3. **Scenario.** Pick the traffic from *Traffic*: the catalog, or your custom scenarios (see [How to generate new scenarios](how-to-generate-new-scenarios.md)). Its description appears below the picker.
4. **Seed.** Keep the number shown, type one, or press *Random*. The same seed always produces the same passengers, weights and events.
5. **Scripted events.** Turn the heavy group, car fault and demand spike on or off. The text next to each says when it happens in this building. A single-car building skips the fault, because there's no car to fail over to.
6. **Contestants.** Choose lanes A and B. Live models appear only when the page is served by the runner, and are greyed out while offline. The note below warns you if both lanes are the same, and says when a lane makes real (paid) model calls.
7. **Decision time.**
   - *Fixed 0.25 s · quality only*: every decision takes the same time, whoever makes it. Use this to compare decision quality.
   - *Measured · realistic*: each decision lands after the time it actually took, so a slow model pays for its latency.
   - *Timeout*: each contestant's own, or a shared 1.5 s or 0.5 s limit. When a contestant runs out of time, its fallback decides.
8. **Read the setup check.** The panel under the lanes compares the two setups part by part. *Controlled* means exactly one thing differs, so the race answers a clean question. *Setup comparison* means several things differ. The panel offers one-click fixes (fixed decision time, a shared timeout) where they help.
9. **Repetitions.** Keep *1 · single run* for a race you want to watch. More seeds launch a batch instead (see [How batching works](how-batching-works.md)).
10. **Start in** *Timeline* (watch it) or *Max speed* (compute as fast as possible; the results are identical). Press *Launch run*.

## While it runs

- **Controls:** `Space` plays or pauses, `→` steps, the 1× to 16× buttons set playback speed, and `M` switches between timeline and max speed. Nothing else about the experiment can change.
- **What to watch:**
  - the **scenario timeline**, which marks deliveries and scripted events;
  - **First to clear the wave** and the **scoreboard**: wait times, energy and decision cost;
  - each lane's **decision panel**: the options it had, the probabilities or rule trace behind its choice, and recent decisions.
- **Live models:** the run pauses while a model's answer is out, then the answer lands after its measured time (or the fixed time). The decision panel shows latency, any queueing in the runner, and fallbacks.
- **Rerun** (`R`) starts a fresh run with exactly the same definition. That's how you check a result reproduces.

## Afterwards

Every run you launch is recorded. The session's automatic demo run isn't. Find the run in **Run history**, verify and replay it in **Audit & replay**, and repeat it over seeds to rank it on the **Leaderboard**.

## Tips

- **One seed is an anecdote.** Use a race to understand behaviour, and a batch to draw conclusions.
- **To compare two models, give both lanes the same encoding** (for example Jev enc3 vs Laya enc3). Then the setup check says *Controlled · decider*.
- **Paid API:** a 24-floor, 4-car run makes roughly 40–50 decisions per lane. At Jev's price that's a fraction of a cent. The runner prints every call, with tokens and cost.
