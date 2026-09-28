# How to generate new scenarios

**Menu section:** Scenarios

A scenario is the traffic an experiment runs: how many passengers arrive, over what window, where they go, how heavy they are, and the three scripted events (heavy group, demand spike, car fault). Every scenario is **versioned and hashed**, so a run always points at exactly the traffic it used.

There are two ways to make one. **In the app** is quick, needs no code, and stays in your browser. **In code** adds a built-in to the catalog for everyone.

## In the app

1. **Open Scenarios** (`C`). Each card shows the traffic the scenario generates for the building picked at the top (6 × 3 up to 60 × 10): passenger count, direction shares, heavy share, an arrivals-over-time chart with event markers, destinations by floor, its version and hash, and how often it has run.
2. **Start from the closest scenario.** Press *Duplicate* on its card, or *New scenario* to start from Normal traffic. The editor opens above the catalog.
3. **Name and describe it.** *Stresses* is a comma-separated list of what it tests, such as `down-peak, queues`. It shows as tags on the card.
4. **Shape the arrivals:**

   | Field | What it does |
   |---|---|
   | Intensity | *Steady* (even over the window), *Peaked* (bell-shaped around the middle), or *Burst* (70% crammed into one stretch) |
   | Window | Seconds over which people arrive. It scales with building height (×√(floors ÷ 24)) so towers aren't swamped |
   | Passengers | `base + perFloor × floors`, capped at 90 for drawn buildings (700 for stats-only ones) |
   | Groups of | People arriving together from the same floor |

5. **Set directions and destinations.** Choose the *Up from lobby*, *Down to lobby* and *Between floors* shares (normalised if they don't add to 100%). Optionally add a *Hotspot floor* (low, middle or top) that takes a share of trips, like a cafeteria.
6. **Set the passengers.** *Heavy share* sets the share of heavy passengers (110–140 kg, with carts), who fill cars by weight. *Press a lit button anyway* sets how many people press a button that's already lit, which tests shared hall state.
7. **Set the scripted events.** Ticked events are on by default in New experiment, and can still be switched per experiment.
   - **Heavy group:** when it arrives (as a % of the window), how many people, and how many of them are heavy.
   - **Demand spike:** when, how many people, and from which floor.
   - **Car fault:** one car, or two in turn; when each fails; and the repair time. A fault that would leave no car in service is dropped.
8. **Watch the preview** as you edit. It uses the building selected at the top, and shows the hash the version will get.
9. **Press *Save version*.** Saved versions are **read-only**. Editing means *Duplicate* again, and a new version with the same name gets the next number (v2, v3…). *Remove* deletes a custom scenario from the catalog. Runs that used it keep a copy in their run files.
10. **Use it.** Press *Use* to open New experiment with it selected, or *Batch* to open New experiment prefilled for 10 seeds with fault pairs.

**Where custom scenarios live:** in this browser's storage. They're **not shared** with other browsers or people. Every run file embeds the full scenario definition, though, so anyone can open that run file in Audit and replay it exactly. To make a scenario available to everyone, add it in code.

## In code (a built-in scenario)

Built-ins are defined in `CATALOG` in [`app/js/sim/scenario.js`](../../app/js/sim/scenario.js).

1. **Add an entry with `spec({...})`.** Any field you leave out takes its default: steady profile, 80 s window, `10 + 3 × floors` passengers, shares 40/35/25, no hotspot, 3% heavy, 55% press anyway, no groups, all events off.

   ```js
   spec({
     id: 'lunch-return',            // unique, and never changed later
     name: 'Lunch return',
     stresses: ['up-peak', 'hotspot'],
     description: 'Back from lunch: most people ride up from the lobby, many to one busy floor.',
     profile: 'peak',
     window: 60,
     perFloor: 4,
     shares: { up: 0.8, down: 0.1, inter: 0.1 },
     hotspot: 'middle',
     hotspotShare: 0.4,
     events: { heavy: { on: true, size: 4, heavy: 2 } },
   }),
   ```

2. **Keep the `id` stable forever.** The traffic generator's random stream is seeded from the run's seed *and* the scenario id. Renaming the id changes every passenger.
3. **Don't edit an existing built-in's traffic.** Its hash, and therefore its key, would change, so new runs would form a separate family on the Leaderboard under the same name. Add a new entry instead. If you must change one, bump its `version` so the change is visible. Old run files still replay, because they embed the definition they used.
4. **Keep the event keys** (`heavy`, `spike`, `fault`). Fault pairs, the Resilience category and the SLA lab's normal/failure split rely on them.
5. **Check it:** reload the app, open Scenarios, and look at its card at a few building sizes. Then run a short batch (5 seeds, max speed) with two algorithms to make sure it separates them the way you intended.
6. **Update the catalog list** in [`app/README.md`](../../app/README.md), under *Scenarios*.

*Morning Wave* is special: it keeps its original hand-tuned generator (`legacy: true`), so runs from before the catalog existed still replicate. Don't copy that pattern for new scenarios.

## Tips

- **Scenarios test different things.** Rush hour stresses queues, Heavy passengers stresses weight limits, and Equipment failures stresses reassignment. Name what yours stresses, so its Leaderboard results can be read correctly.
- **Previews use a fixed seed.** Real runs vary with the seed. The chart shows the shape, not the exact passengers.
- **For a new building type** (for example a hotel's evening pattern), a new scenario plus a building size is usually enough. It doesn't need new code.
