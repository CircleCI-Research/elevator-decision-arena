# Elevator Decision Arena: the app

Vanilla JS and SVG, with no build step. Open `index.html` directly for the algorithms only, or serve it through the arena runner (`runner/`) for live models.

## Direction chosen: "Transit Pictogram"

Three directions were considered:

1. **Transit Pictogram** (chosen). Warm paper, flat signage colors, pictogram passengers, in the spirit of wayfinding signage and Mini Metro.
2. **Night Blueprint.** Navy with cyan line art and neon. Dramatic, but it loses legibility when many events overlap.
3. **Arcade Tower.** Pixel art in the style of SimTower. Charming, but it clashes with precise probability bars and makes a benchmark feel less credible.

Dark mode reuses the chosen direction's tokens. It follows the system setting, and the theme button cycles auto → light → dark.

## Design choices

- **Color does one job per surface.** Passenger color always means destination floor. The floor badges on the left are the key, like metro line colors. Contestant accents (teal for A, graphite for B) mark ownership: signs, lanes, chips and decision panels. Red, amber and green are reserved for car state and severity.
- **A car's state is readable without text.** A red pulsing outline means overload. An amber outline with a flickering interior means a fault. Hazard stripes, a hatched shaft and a dashed outline mean offline. The small display over each shaft shows floor, direction and a colored state bar. Detailed readouts live in HTML **car cards** above each building, where text stays readable at any width: state, floor, load against capacity (all a policy is allowed to see about weight), and energy with live kW, shown green while regenerating. Hovering a card highlights its car.
- **Hall buttons show the shared call state.** A lit triangle means called. A ripple means someone pressed it, even if it was already lit. A `×n` badge counts repeat presses. A spinner in the contestant's color means the policy is still deciding. A numbered chip shows which car was assigned. The spinner only appears for the model, so decision latency is visible inside the building, not just in a number.
- **One decision component for every policy.** Each option is a row with an animated bar and a percentage. While the model deliberates, the distribution drifts from uniform to its answer. Then the sampled choice stamps in. The deterministic policy uses the same component and shows one 100% bar plus a rule trace, so the difference in certainty is visible at a glance. Options the engine forbids appear locked as `VETO` instead of being hidden.
- **Recent decisions as segmented bars.** Each past decision is one bar split by probability, with the chosen segment highlighted. A model's history looks fragmented and an algorithm's looks solid.
- **Calm when many things happen at once.** Anything persistent stays on the object (car outline, shaft hatch, button chip). Anything transient floats up and fades (`+1`, `×3`, `486 kg`). Anything that needs attention right now is pinned in **Active incidents**. The feed can be filtered to Decisions or Incidents.
- **The timeline tells the run's story.** Delivery ticks are colored by destination, incident icons sit on each contestant's lane, and dashed markers show scripted or injected events.
- **Decision cost is kept separate.** The scoreboard splits service metrics from decision cost, and the race card says a single seeded run is not a ranking.

## Experiments and runs

An experiment is defined once, in the **New experiment** dialog (sidebar, the Experiment card, or `N`), and becomes a **run**:

- **Defined up front and fixed for the run:** building (3–120 floors, 1–16 cars, or a preset), seed, scripted events (heavy group, car fault, demand spike), contestants, decision timing, and the starting run mode. The Experiment card shows the definition read-only. There are no live building controls or injections; they would change the conditions mid-experiment.
- **The one live control is the run mode**, Timeline or Max speed (`M`). It never changes simulated results. If a run switches modes, its wall-clock result is reported as "mixed modes", because it no longer measures one mode cleanly.
- **Parallel runs:** every run from this session is listed under **Arena** in the sidebar, with status (playing, max speed, paused, done) and progress. All runs keep simulating in the background; opening one rebuilds its timeline and feed from its own event log. Runs can be discarded. **Rerun** (`R`) starts a new run with the same definition.
- The URL (`#floors=60&cars=10`) only seeds the session's first run.

## Live models (local Laya, Jev API)

Serve the page through the **arena runner** (`runner/`, `npm start`, then open http://127.0.0.1:8787/) and six **live contestants** join the registry: *Laya · local* and *Jev · API*, each in encoding 1 (raw numbers), 2 (semantic) and 3 (a derived arrival estimate per car). Opened any other way, the page has only the algorithms.

- **The runner holds the keys and talks to the models.** The page sends the observation and the legal options built by the engine, and gets back probabilities, the choice, timings, token cost and the exact request and response.
- **Timing:** while a live answer is out, the run holds (both lanes in timeline mode; just that world at max speed). The answer then lands after its **measured** round trip, in sim seconds. The simulation depends only on what was recorded, so runs replay exactly.
- **Failures and timeouts:** unreachable servers, HTTP errors and malformed answers go to the fallback (Nearest-Car ETA v1.3.0), like timeouts. They show in the event feed, the decision panel and Audit.
- **Audit:** every live decision shows the model that answered, round trip, server-side model time (Laya), queueing, attempts, tokens and cost, plus the request sent and the response received. Replay never re-asks a live model. A live run replays and verifies even without the runner.
- **Cost:** the scoreboard and Run history show API cost from each response's token usage. Local Laya shows "local · no charge".
- **Drift:** if Jev answers as a model other than the pinned `jev-1.13.0`, the decision is flagged and the run counts the drifted decisions.
- **Availability:** live contestants are checked every 30 s. An offline one is disabled in the lane pickers with the reason, and a rerun that needs it is refused rather than substituted.

## Decision timing and the setup check

**Decision timing** is part of the experiment and applies to both lanes:

- **Decision time:** *Measured* (a decision lands after the time it took, so speed counts) or *Fixed 0.25 s* (every decision, from any contestant, takes the same time, so only decision quality counts).
- **Timeout:** *each contestant's own* (for example Laya · local 400 ms, Jev · API 1.5 s), or *shared* 1.5 s or 0.5 s. A decision over the timeout is discarded and the contestant's **fallback** decides. The event feed, decision panel and Audit mark those decisions, and results count them ("Fallback decisions").
- Default timing (measured, own timeouts) adds nothing to the definition hash, so earlier runs keep their hashes. Anything else is part of the definition, and Leaderboard and SLA families are split by it.

The **setup check** (New experiment, below the timing controls) compares the two lanes facet by facet: interface, encoding, limits, fallback, model, tuning, location, compute, determinism and cost basis. Facets come from the registry, and limits and fallback are resolved under the chosen timing. It gives one of two verdicts:

- **Controlled:** exactly one thing is compared. Either only the decider differs (model or code, with its tuning, plus what comes with it, such as location), or the decider is the same and one harness facet differs, such as the encoding.
- **Setup comparison:** several parts differ, so the result compares whole setups, not models.

Each differing facet is tagged *being compared*, *comes with the decider*, *breaks control* or *no effect here* (for example, speed facets under fixed decision time). Notes explain timeouts, measured network time, external services, cost bases and replications, with one-click fixes (*Use a shared 1.5 s timeout*, *Use fixed decision time*). Run records store the verdict. It appears as a chip in Run history and on the Experiment card, as a full panel in the run's detail, as a line in Audit, and as the Leaderboard's **Controlled only** filter. See `docs/model-setups.md`.

## Contestants

**Contestants** in the sidebar (or `P`) is the registry of every policy that can take a lane. Experiments choose from it: New experiment has **Lane A** and **Lane B** pickers. Any pairing works (model vs algorithm, model vs model, algorithm vs algorithm, or two versions of the same policy), except a policy against itself.

- **Decision models:** the live ones only, *Laya · local* and *Jev · API* in encodings 1–3, which join when the page is served by the arena runner (see *Live models*). The scripted mock models used before the real ones were connected have been removed. Runs that used them keep their recorded names, and Audit replays them from the record.
- **Deterministic algorithms**: Nearest-Car ETA v1.2.0 and v1.3.0 (load-aware), Round robin, Zoned dispatch. Each is identified by its source and a **code hash computed from the function that actually runs** (plus its parameters). *Show code* displays that code.
- **One contract for everyone:** every contestant receives the same observation and returns the same action. The page shows both schemas and their hash (`contract v1`); individual passenger weights are never observed.
- **Track record** per contestant from finished runs (replications counted once): runs, cleared-first W–L–T, opponents and scenarios. *vs &lt;version&gt;* puts two versions of the same policy into the lanes.
- **Provenance in every run:** run records and run files store each contestant's kind-specific provenance, models and algorithms apart. Replay looks up the exact version. The original pair keeps identical logic and random draws, so earlier runs still replicate.
- **Leagues:** Leaderboard and SLA lab rank every contestant that appeared in a family, with a stable colour and badge from the registry (for example L1, NCE3, RR) rather than lane letters. Contestants with fewer than 5 runs are **provisional**: listed with their run count, never placed. A category ranks whoever has data in it once two contestants do. Resilience twins must share the same contestants. Run comparison matches contestants by identity, not lane.

## Scenarios

**Scenarios** in the sidebar (or `C`) is the catalog of traffic an experiment can run. Pick one in New experiment (**Traffic**), or use **Use** / **Batch** on a scenario card.

- **Catalog** (built-in, read-only): Morning Wave, Normal traffic, Rush hour, Evening down-peak, Uneven destinations, Heavy passengers, Duplicate button presses, Elevator overloads, Equipment failures, Sudden demand spike.
- **A scenario** defines:
  - how many passengers arrive (a base count plus a number per floor), over what window, and with what intensity (steady, peaked or burst);
  - the mix of up, down and between-floor trips, and a destination hotspot;
  - the heavy share, the chance of pressing an already-lit button, and group arrivals;
  - the parameters of the three scripted events. Event keys are fixed across scenarios (heavy group, car fault, demand spike), so fault pairs, resilience and the SLA lab's normal / failure split work with every scenario. *Equipment failures* makes the fault take down two cars in turn, never leaving the building without a car.
- **Cards** show what each scenario stresses, the traffic it generates for a chosen building (6 × 3 up to 60 × 10): arrivals over time stacked by direction, scripted-event markers, and destinations by floor. They also show the event descriptions and how often the scenario has been run.
- **Custom scenarios:** *Duplicate* opens an editor with a live preview. Saving creates a new, read-only, hashed version.
- **Reproducibility:** a run's definition hash covers its scenario version. Run files and history records of custom scenarios embed the scenario definition, so they replay, verify and rerun even after the scenario is deleted, or on another machine. Morning Wave keeps its original generator and hash key, so runs recorded before the catalog existed still replicate exactly.

## Run history

**Run history** in the sidebar (or `H`) lists every run as an audit record, from this session and earlier visits:

- **Definition:** building, passengers, seed, scripted events, decision timing, run modes used, simulator version and contestant versions. A **definition hash** covers everything that affects simulated results (run mode and inference time don't).
- **Results:** every metric for each contestant, plus wall-clock (max-speed runs only; "mixed" if the run changed modes), and the waiting-over-time curves of both contestants overlaid.
- **Replication:** a **result fingerprint** is computed from simulated outcomes only. Finished runs with the same definition hash are compared: **Replicated ×n** when they match, **Mismatch** when they don't. The simulation is deterministic for a seed, so a rerun of the same algorithms must match (live models are replicated, not repeated).
- **Status:** running (with progress), done, stopped (discarded before finishing) or interrupted (the page closed mid-run). Run numbers stay unique across visits.
- **Actions:** Open in Arena (runs still live in this session), Rerun same definition, Remove record, and Clear history (asks you to click twice).

**Compare two runs:** tick the checkbox on two records (the first one ticked is the **baseline**), then **Compare**:

- Summary cards for both runs, with winner, margin, and links to the Arena and Audit.
- A verdict: *same experiment, same results* (a replication), *same experiment, different results* (audit both), or *different experiments*.
- A **definition diff** highlighting changed fields. Fields that only affect wall-clock (run modes) are labelled as such.
- **Results per contestant** for both runs, with the change against the baseline in absolute and percentage terms, green when better and red when worse by each metric's direction. Wall-clock is compared only for runs computed purely at max speed.
- **Waiting over sim time** for each contestant, baseline solid and the other run dashed.
- **Swap** flips baseline and compared run.

Records live in this browser's `localStorage` (`eda-history-v1`, newest 200). If storage is blocked, the page says history lasts for this page only.

## Leaderboard

**Leaderboard** in the sidebar (or `L`) ranks contestants per **experiment family**: runs that share scenario, building, scripted events and simulator, with different seeds. Raw metrics are only comparable within a family, so families are never mixed. Reruns of an identical definition count once.

- **Benchmark batches:** in New experiment, **Repetitions** (5, 10 or 20 seeds, counting up from the base seed) launches a batch at max speed in the background. **Fault pairs** runs every seed with and without the car fault. The Leaderboard's *Run benchmark batch* opens the dialog preset for the current family. The sidebar shows each batch as one entry with progress.
- **Headline categories**, each ranked on its own and shown as **mean ± 95% confidence interval** (Student t) on a shared axis:
  - Speed: time to clear the wave.
  - Wait: average wait.
  - Fairness: longest wait.
  - Resilience: extra clear time with the fault, vs the same seed without it (needs fault pairs).
  - Safety: vetoes per 100 decisions.
  - Decision cost: average decision time.
- A category's leader is called **separable** only when the intervals don't overlap. Otherwise it says "ahead · not separable".
- **More metrics** (shown, not ranked): P95 wait, energy per passenger, empty travel per passenger, decision energy.
- **Overall** = average rank across the headline categories that have data for everyone, with equal weights and the formula printed on the page, alongside head-to-head W–L–T and how many leads are separable. It never replaces the categories.

## SLA lab

**SLA lab** in the sidebar (or `S`) checks whether each policy can keep an operational promise reliably, under **normal** conditions (car fault off) and **failure** conditions (car fault on).

- **An SLA** is a set of clauses (P95 wait, average wait, longest wait, time to clear the wave, energy per passenger, safety vetoes, average decision time), each with a threshold and the condition it applies to (normal, failure, or both). The same metric can have different thresholds per condition. The SLA also sets a **target** (met in at least 80–99% of runs) and a **minimum number of runs** per condition.
- **Versioned and immutable:** a saved SLA gets a version number and a hash, and is read-only. *Duplicate & edit* always creates a new version, so thresholds can't be moved after seeing results, and every version stays listed. A starter SLA, *Office tower · baseline*, is created on first use.
- **Evaluation:** a run meets the SLA only if every clause for its condition passes. For each contestant and condition the page shows runs met (k/n), the rate with a **95% Wilson interval**, and a verdict:
  - **Meets / Falls short**, observed, once the minimum runs are in;
  - **Demonstrated**, when the interval clears the target too. Until then it states roughly how many more clean runs would prove it.
- It also names the clause that **breaks first**.
- **Clause strip plots:** every run is a dot against the threshold line (hollow when it failed), per contestant and condition.
- *Run batch with fault pairs* opens New experiment preset to 10 seeds with fault pairs for the current family.

## Audit & replay

**Principle: record the inputs, re-derive everything else.** A run is fully determined by its definition plus the decisions its policies made, so a **run file** stores exactly that: definition, definition hash, contestants, every decision (request, options, probabilities, choice, latency, outcome), results, result fingerprint, and a hash of the decision log. Events, positions and metrics are not stored; they're regenerated. A 6 × 3 run file is about 30 KB.

**Audit & replay** in the sidebar (or `A`, or the button on a Run history record):

- **Verification** replays the run file from scratch with the recorded decisions fed back in. The policies are never asked again, since real models aren't repeatable. It checks four things:
  1. **Definition:** the hash is recomputed from the definition.
  2. **Decisions:** each recorded decision matches the request the replay produces at that moment. On the first mismatch it reports where it diverged, and the policy decides live from there.
  3. **Results:** the result fingerprint is recomputed and compared.
  4. **Integrity:** the decision-log hash matches the file header and, when this browser has its own record of the run, that record too. This catches edits to decisions that had no visible effect, which replay alone can't see.
- **Replay player:** the buildings (or stats boards) at any moment, with play, step to next decision, scrub, and speed (1×–64×). Replay is deterministic, so seeking backwards simply re-executes from zero.
- **Decision inspector:** every decision for each contestant, synced with the replay. Selecting one jumps there and shows its options and the **observation**: exactly what the policy was allowed to see (car floor, direction, mode, doors, total load and capacity, stops, assignments, speed). Individual passenger weights are not part of it.
- **Event log:** re-derived events up to the replay position; click one to jump there.
- **Download run file / Open run file…:** export a run as `.json`, or open one from disk to replay and verify it independently.

Run files of finished runs are kept in browser storage (newest 15). Runs still in progress are audited as a snapshot.

## Adapting to building size

All dimensions come from one function, `EDA.util.geometry(floors, cars)`, used by both the view and the simulated world:

- **Floors:** floor height shrinks from 78 to 26 units, then the building simply grows taller. Buttons, doors and labels shrink with it, down to half size.
- **Passenger detail follows floor height:** full pictograms at 56 units or more, smaller pictograms (with tags) from 40 to 56, and colored dots ("circle lights") below that.
- **Cars:** shaft spacing shrinks from 84 to 58 units, then the building grows wider. Car cards keep one row up to 4 cars, then wrap into balanced compact rows (6 → 3 + 3). Decision panels switch to dense rows beyond 4 options; beyond 6 the list scrolls under an **overview slider**, a mini distribution of every option with a draggable window marking the rows in view.
- **Destination colors:** up to 6 floors each floor has its own color. Taller buildings share 5 color bands above the lobby, and the number tag stays exact. The legend switches to band ranges automatically.
- **Page layout:** when a building exceeds 700 units in either direction, the arena switches to two wide columns: buildings side by side, shared cards in a row beneath, decision panels below. On phones everything stacks: A, A's decisions, B, B's decisions, then the shared cards.
- **Scenario:** passenger counts scale with floors, scripted destinations clamp to the top floor, car speed rises with building height, and single-car buildings skip the scripted fault.

### Stats-only runs (above 24 floors or 6 cars)

Beyond the Tower preset nothing is drawn. Each building becomes a **stats board**: big delivered count and progress, sim time and wall-clock time, tiles for waiting, wait times, energy and decisions, a waiting-over-time trend line, and a grid of car floors and states.

Stats runs have two **run modes**:

- **Timeline:** both buildings advance in lockstep on the clock (1×–16×), and stats appear as the timeline plays.
- **Max speed** (default): each building is computed as fast as the CPU allows, held back only by its own policy. A deterministic rule reaches the result almost instantly; a model must wait for every decision. Sim-time results are identical to Timeline mode. Only the **wall-clock time to result** differs, and it's reported on the boards, the race card and the scoreboard. Each timeline lane gets its own playhead, and low-level events are kept out of the feed. Max speed is available for every run, drawn or not.

Live models take real time: the world waits for each answer, so their wall-clock includes every real call. Algorithms answer at once.

Still to explore: folding idle floor ranges in very tall towers, grouping many cars into low-rise and high-rise banks, and a camera that follows the busiest floors.

## Known limitations and plans

| Area | Current state | Planned |
| --- | --- | --- |
| `js/sim/world.js` | A minimal stand-in world that just drives the animations. Motion, dispatch and door logic are simplified. | Domain-neutral engine: event queue, safety layer, observation schema, replay |
| `js/sim/registry.js` | Four deterministic algorithms (Nearest-Car ETA v1.2.0 and v1.3.0, round robin, zoned dispatch). Real code, deliberately simple. | Algorithm packages with signed code hashes, registered through manifests |
| `js/sim/scenario.js` | One hand-tuned wave with a scripted heavy group, a fault on Car 3 and a floor-3 spike. | Scenario catalog, configurable floors, cars and arrivals, seeds |
| Elevator energy | Simplified physics in `js/sim/world.js`, with coefficients in `CONFIG.energy`. The motor lifts the car-versus-counterweight imbalance (counterweight = car + 45% of capacity), so cost depends on direction, load and height. It adds friction, a fixed cost per start (short hops cost more per metre), door cycles and standby per car, and credits energy recovered by a regenerative drive. Floors are a uniform 3.5 m. | A documented method (e.g. ISO 25745), per-floor heights including basements, and energy attributed to the decision that caused each move |
| Run history | Summary records in browser storage: definition, results, downsampled trends. No event logs, prompts or schemas. | Immutable, exportable run records with full event logs, prompts, schemas and dependency hashes (Audit & replay) |
| Run files | JSON with definition, decisions, results and hashes; unsigned, and the last 15 kept in browser storage. | Signed, immutable run files with prompts, schemas and dependency hashes in a run store |
| Leaderboard | Families from browser-stored records; unpaired t-intervals; equal-weight overall rank; any registered contestants, with a *Controlled only* filter. | Paired per-scenario analysis over a curated scenario catalog, contestant versions from a registry, configurable weights |
| SLA lab | SLA versions in browser storage; per-run pass/fail with Wilson intervals over the recorded runs of one family. | SLAs in a shared registry, evaluated over the scenario catalog with paired and sequential testing |
| Scenarios | A parametric generator (counts, window, intensity shape, direction mix, hotspot, heavy share, groups, three scripted events) validated only by eye. | Generators calibrated against measured building traffic, in a shared, versioned catalog |
| Contestants | Twelve scripted policies in code; model "prompts", weights, locations and services are descriptive only, and no inference or network call runs. | A real registry: model endpoints or local weights, prompts and schemas under version control, algorithm packages with signed code hashes, and an adapter per contestant for the policy contract |
| Max-speed wall-clock | Real: simulation time plus real model calls; algorithms don't add artificial waiting. | Measured compute time per decision on the engine's hardware |
| Crowd dispatch | When more people wait at a landing than the assigned cars can carry, the policy is asked for a backup car ("CROWD"). Full cars skip hall calls (load bypass). | Real group-control strategies as contestant policies |
| Decision energy | An estimate per contestant (about 0.0003 Wh per local Laya decision, effectively zero for algorithms). Remote models show "remote · n/a" and are left out of energy rankings. | Measured device power per decision for local models, marked as measured or estimated |
| Scoreboard and race | Metrics are computed from the simulated world, with no confidence intervals on a single run. Wait is measured from arrival to first boarding. | Metric definitions, repeated runs, confidence intervals, rankings, SLA evaluation |
| Fallback | Runs on timeout, and on failure for live models, deciding instantly from the same observation. Benching after repeated failures is not implemented. | Fallback on timeout, failure or illegal choice, with benching after repeated failures |
| Setup facets | Declared by hand in the registry. | Computed from manifests, resolved runtime identity and endpoint checks |

The view layer (`js/ui/*`) only reads world state and never mutates it, so it can be pointed at the real engine's snapshot later.

## Controls

- `Space`: play or pause
- `→`: step 0.5 s
- `1`, `2`, `4`: speed
- `M`: switch run mode (Timeline / Max speed)
- `N`: new experiment
- `H`: toggle Run history
- `L`: toggle Leaderboard
- `S`: toggle SLA lab
- `C`: toggle Scenarios
- `P`: toggle Contestants
- `A`: toggle Audit & replay (there, `Space` plays the replay and `→` jumps to the next decision)
- `R`: rerun the current definition as a new run
- `T`: theme
- `[`: collapse or expand the sidebar (desktop)

On desktop, the button at the bottom of the sidebar (or `[`) collapses it to an icon rail with hover tooltips, and the choice is remembered. Below 1024 px the sidebar becomes a drawer behind the hamburger button. Esc, the scrim or choosing an item closes it.

The run auto-pauses when both buildings have cleared the wave.
