# State model: what a contestant can see

Status: **draft for review** · 2026-09-27 · companion to [contestants.md](contestants.md)

## 1. Why this needs its own model

Every decision a contestant makes depends on what it is told. Today the prototype's observation is a handful of fields written inline in `mock-world.js` (`observe()`) and described informally in `SCHEMAS`. That was enough for a mock, but it breaks down as soon as the arena grows:

- **Buildings will differ:** priority floors, cars with different capacities or speeds, cars that only serve some floors, destination panels in the lobby.
- **The information rules may change:** the spec says models may know only each car's total load and capacity. Some future experiment may want to test what happens when a policy also knows each passenger's weight, so it can move most of the weight straight to its floors.
- **Contestants read the state differently:** an algorithm reads typed fields; Laya reads a `state` object plus question criteria rendered from it. If a field's meaning, unit or rounding changes silently, results stop being comparable.

So the state must be a **catalogue of well-defined variables**, not a loose object. Each variable has one definition, one meaning, a unit and a version, and every run records exactly which variables were visible.

## 2. Three separate things

| | What it is | Who defines it | Recorded as |
|---|---|---|---|
| **World state** | Everything the simulator knows: every passenger, their weight, destination, arrival time, future arrivals. | The engine | Re-derived from the seed; never shown to contestants |
| **State catalogue** | The list of variables that *could* be shown, each fully specified (§3). | This document, versioned (`state v1`, `v1.1`, `v2`…) | Catalogue version and hash |
| **Visibility profile** | Which catalogue variables a given experiment actually shows. | The experiment, before launch | Profile id and hash, part of the definition hash |

The **observation** a contestant receives is the world state projected through the catalogue and filtered by the profile. Both lanes of a run always get the same profile, so a comparison stays fair even when the rules differ between experiments.

This turns the spec's rule into data instead of code: the default profile, `aggregate-load`, is exactly today's rule. A profile such as `passenger-weights` is a different experiment, clearly labelled, and it never ranks against `aggregate-load` runs (§6).

## 3. How a variable is defined

Every variable in the catalogue has the same fields:

| Field | Meaning | Example |
|---|---|---|
| `path` | Stable name in the observation | `cars[].capacityKg` |
| `scope` | What it belongs to: `run`, `building`, `floor`, `car`, `call`, `passenger`, `request` | `car` |
| `type` | `int`, `number`, `bool`, `enum`, `list` | `int` |
| `unit` | SI or domain units, never implicit | `kg` |
| `range` | Allowed values, used for validation and fixtures | `100–5000` |
| `precision` | How it is rounded before it is shown | `1 kg` |
| `meaning` | One precise sentence, including edge cases | "Rated load. The safety layer refuses departures above it." |
| `changes` | `static` (fixed for the run) or `dynamic` (changes every step) | `static` |
| `requires` | The building feature that makes it exist, if any | `—` |
| `visibility` | `always`, or the profiles that show it | `always` |
| `since` | The catalogue version that introduced it | `state v1` |

Rules that follow from this:

- **Precision is part of the definition.** `loadKg` rounded to 1 kg vs 10 kg is a different variable. This matters for determinism and for Laya, which reads rendered numbers.
- **Absent and unknown are different.** A variable whose feature is off is *absent*. A variable that exists but has no value (a car with no planned stops) has an explicit empty value. Nothing is ever silently `null`.
- **Only facts, no advice** (decided). The observation carries raw facts: positions, loads, calls and recent history. The engine never provides derived values such as ETAs or suggested cars. Contestants and their encodings compute those themselves, so a clever feature can't be smuggled in as part of the "neutral" state, and all contestants start from the same information.
- **No hidden identity.** Passengers, when visible at all, appear only as anonymous entries (`weightKg`, `destFloor`, `waitingSince`), never with ids that would let a policy recognise the same person across runs.

## 4. Building features

Anything that makes buildings differ is a named **feature** in the experiment definition. Variables that depend on a feature exist only when it is on, and the catalogue says which feature each one needs.

| Feature | What changes in the building | Variables it adds |
|---|---|---|
| *(none, base)* | Uniform cars, all floors served | the base catalogue (§5) |
| `heterogeneous-cars` | Each car has its own capacity and speed | `cars[].capacityKg` and `cars[].speed` vary per car (they already exist per car, so no schema change is needed, only different values) |
| `priority-floors` | Some floors have a priority level (hospital, VIP, executive). Priority belongs to the floor, not to a call or a passenger (decided). | `floors[].priority`, `request.priority` (copied from the call's floor) |
| `served-floors` | Cars serve only some floors (zones, express cars) | `cars[].serves` |
| `destination-dispatch` | Passengers enter their destination at the hall panel | `request.destFloor`, `calls[].destFloor` |

### 4.1 Basic and advanced cases

The **basic case** is what every experiment gets by default and what the headline rankings are built on: uniform cars, all floors served, no priorities, the `aggregate-load` profile with default history. Everything else is an **advanced case**:

- `priority-floors`, `heterogeneous-cars`, `served-floors` and `destination-dispatch` are off by default. They sit in a collapsed *Advanced* section of New experiment, and a run that uses any of them carries an *Advanced* label everywhere it appears.
- Their variables are absent from basic observations, so a basic contestant never has to handle them, and fixtures for them run only when a contestant declares it supports the feature.
- Their metrics and SLA clauses appear only for runs that use the feature. Priority-wait metrics, for example, don't show up on the basic leaderboard, and the SLA lab offers priority clauses only when an SLA targets priority experiments.
- Advanced runs form their own leaderboard families, like the research profile, and never change basic rankings.

The **visibility profile** is separate from features. `priority-floors` changes the building. `passenger-weights` changes what the contestant is told about the same building.

| Profile | Shows | Notes |
|---|---|---|
| `aggregate-load` (default) | Base catalogue plus the feature variables | Exactly the spec's rule. |
| `passenger-weights` | Adds `cars[].riders[]` (`weightKg`, `destFloor`) and `calls[].waiting[]` (`weightKg`), if the building has destination panels | A labelled **research condition** (decided). Its runs form their own leaderboard families and SLA pools, marked "with passenger weights". `aggregate-load` stays the default and the headline ranking. |

## 5. Catalogue `state v1` (what the prototype already sends)

| Path | Type · unit · precision | Meaning |
|---|---|---|
| `t` | number · s · 0.1 s | Simulation time when the decision was requested. |
| `n` | int | Decisions this contestant has made so far in the run. |
| `building.floors` | int · 3–120 | Number of floors, lowest first. Floor 0 is the lobby. |
| `building.cars` | int · 1–16 | Number of cars. |
| `request.kind` | enum `assign`, `overload` | What is being decided. |
| `request.floor` | int | Floor of the hall call (`assign`). |
| `request.dir` | enum `up`, `down` | Direction of the hall call (`assign`). |
| `request.reason` | enum `new`, `reassign`, `retry`, `crowd` | Why the call is being (re)assigned. |
| `request.car` | int | Car that is overloaded (`overload`). |
| `cars[].idx` | int | Car index, stable for the run. |
| `cars[].floor` | number · floors · 0.01 | Position; fractional while moving. |
| `cars[].dir` | enum `-1`, `0`, `1` | Travel direction; 0 when idle. |
| `cars[].speed` | number · floors/s | Maximum speed (`vmax` in the prototype, today the same for all cars). |
| `cars[].mode` | enum `normal`, `overload`, `malfunction`, `out` | Operating mode. |
| `cars[].doorPhase` | enum `closed`, `opening`, `open`, `closing` | Door state. |
| `cars[].loadKg` | int · kg · 1 kg | Total load now. Never broken down per passenger in this profile. |
| `cars[].capacityKg` | int · kg | Rated load (today the same for all cars). |
| `cars[].stops` | int | Planned stops. |
| `cars[].assigned` | int | Hall calls assigned and not yet served. |
| `cars[].coming` | bool | Already assigned to this very call. |

Two small changes from the prototype: `vmax` and `capacityKg` move to **per-car** fields (so `heterogeneous-cars` needs no schema change), and `floors` moves under `building`.

### 5.1 Planned for `state v1.1`: priority and history

| Path | Type · unit · precision | Meaning |
|---|---|---|
| `floors[].priority` | int · 0–2 | Floor priority: 0 normal, 1 high, 2 critical. Only with `priority-floors`. |
| `request.priority` | int · 0–2 | Priority of the call's floor. Only with `priority-floors`. |
| `history.window` | number · s | How far back the history reaches. Fixed for the run. |
| `history.calls[]` | list | Hall calls made within the window, oldest first: `{ t, floor, dir }`. At most `history.max` entries; older ones drop off. |
| `history.served[]` | list | Calls served within the window: `{ t, floor, dir, car, waitS }`. |
| `history.perFloor[]` | list | For each floor, calls up and down within the window: `{ floor, up, down }`. |

Decided: contestants **do** see recent history. Rules:

- History contains only events a real controller could have seen: hall calls and served calls. It never contains passenger arrivals behind the scenes, passenger counts or anything from the future.
- The window (`history.window`, default 120 s) and the size limit (`history.max`, default 50 calls) are part of the visibility profile. They are chosen before launch and included in the definition hash, and both lanes get the same values.
- The **engine** keeps the history, not the contestant. This keeps the sandbox rule of contestants.md §5.1: algorithms keep no hidden state between decisions. Anything a policy may remember must be in the observation, so replays stay exact.
- `history.perFloor[]` is a count of events, not a derived prediction, so it stays within the facts-only rule.

## 6. Versioning and compatibility

The catalogue follows semantic versioning, like the contract:

- **Minor** (`v1` → `v1.1`): new variables, new features, new profiles. Every existing observation is still valid.
- **Major** (`v1` → `v2`): anything that changes the meaning, unit, precision or name of an existing variable, or removes one.

Consequences:

- The **definition hash** of every run includes the catalogue version, the enabled features and the visibility profile. Change any of them and it is a different experiment.
- **Leaderboard families** add the profile and the catalogue major version to the family key. Results from different information rules never rank together. A minor version bump doesn't split families, because the old variables mean the same thing.
- **Contestants declare what they read.** A manifest lists the variables it uses (`reads: [cars[].floor, cars[].loadKg, …]`) and the catalogue range it supports (`state: ">=1.0 <2"`). New experiment only offers contestants that can run under the chosen profile and features, and warns when a contestant ignores a variable the experiment is about. Example: running a priority-floors experiment with an algorithm that doesn't read `request.priority`.
- **Replay** re-derives observations from the seed, so a run file only needs the catalogue version and profile, not the observations themselves. Model decisions additionally store the rendered `state` they were given (contestants.md §8).

## 7. One definition, many uses

The catalogue lives in one place as TypeScript types plus metadata:

```ts
export const cars_capacityKg = defineVar({
  path: 'cars[].capacityKg', scope: 'car', type: 'int', unit: 'kg',
  range: [100, 5000], precision: 1, changes: 'static',
  meaning: 'Rated load. The safety layer refuses departures above it.',
  visibility: 'always', since: '1.0',
});
```

Everything else is generated from it:

| Consumer | Uses it for |
|---|---|
| Engine | Building the observation and applying the profile |
| TypeScript algorithms | Typed `Observation` interface |
| JSON Schema | Validating observations, fixtures and manifests |
| Validation suite | Fixture generation from `range`, and conformance checks |
| Laya encoding | Field names, units and meanings rendered into `state` and option `criteria` |
| Contestants page | The shared-contract panel, generated rather than hand-written as today |
| Audit | Showing exactly which variables a decision was made on |

## 8. Worked examples

**Priority floors** (advanced). Open *Advanced*, turn on `priority-floors` and set each floor's level before launch. Floors get `floors[].priority` (0 normal, 1 high, 2 critical), and hall calls carry `request.priority`, copied from their floor. Metrics gain *mean and p95 wait by priority level*, and SLA clauses can target them, for example "critical floors: p95 wait ≤ 30 s". None of this appears for basic runs. A contestant that doesn't declare `request.priority` is marked "priority-blind" in New experiment, which is a legitimate baseline.

**Different car capacity per building.** Nothing new in the schema: `cars[].capacityKg` is already per car. A building preset simply sets different values, and the definition hash captures them. Mixed capacities inside one building use `heterogeneous-cars`.

**Passenger weights.** Use the `passenger-weights` profile. Each car shows `riders[]` with `weightKg` and `destFloor`, so a contestant can see that 400 of its 600 kg is going to floor 12 and go there first. Results form their own research family, *"with passenger weights"*, and can be compared with the same seeds under `aggregate-load` to measure how much that information is worth.

## 9. Decisions

| # | Question | Decision |
|---|---|---|
| Q1 | Is per-passenger weight allowed? | Yes, as the labelled research profile `passenger-weights`. `aggregate-load` stays the default and the headline ranking. |
| Q2 | Priority per floor, call or passenger? | Per floor. Calls inherit their floor's priority. |
| Q3 | Should the engine provide derived values such as ETA? | No. Facts only. |
| Q4 | Should contestants see recent history? | Yes. The engine keeps a bounded window (§5.1) whose size is set by the profile. |
| Q5 | Default history window? | 120 s and at most 50 calls. Both can be changed per profile before launch. |
| Q6 | Priority metrics and SLAs? | Mean and p95 wait by priority level, with SLA clauses such as "critical floors: p95 wait ≤ 30 s". Priority is an **advanced case** (§4.1). |
