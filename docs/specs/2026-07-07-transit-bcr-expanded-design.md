# Expanded Transit Benefit-Cost Widget — Design Spec

**Date:** 2026-07-07
**Status:** Approved design, pre-implementation
**Source model:** `docs/transit_benefit_cost_model.md` (the original toy welfare model and widget)

---

## 1. Purpose and scope

The original widget (see source doc) is a pedagogical benefit-cost model for a transit-line
expansion. It computes six externality benefits plus an agglomeration uplift and compares them
against integrated capital + operating cost. Its central weakness, called out in the source doc,
is that **fare and ridership are independent inputs**: raising the fare slider does not reduce
ridership, so the fare control is misleading and the double-counting logic the model is designed to
enforce is only half-closed.

This expansion makes the fare/service → demand loop **endogenous** and adds the three highest-priority
missing economic channels, while staying a single self-contained HTML artifact.

### In scope (the "demand + top economic gaps" tier)

1. **Endogenous demand** via a generalized-cost pivot (fare **and** service quality drive ridership).
2. **Crowding externality** (load factor suppresses demand and imposes a disamenity cost).
3. **Marginal cost of public funds (MCPF)** applied to the net public subsidy.
4. **Fare optimization** (welfare-, revenue-, and farebox-target fares, shown as markers with a snap-to control).
5. **Real-project presets** (full parameter vectors from actual systems).
6. **JSON import/export** of the full parameter set ("parameters from an outside model").

### Explicitly out of scope (deferred, in source-doc priority order)

Property-value capitalization, induced demand / land-use dynamics, construction-period disruption,
network effects, distributional weighting. These remain documented as "not modeled" and are candidates
for a later tier. Do not implement them.

### Non-negotiable regression anchor

At each preset's **reference point**, with MCPF λ = 1 and crowding multiplier φ = 1, the expanded model
**must reproduce the original widget's outputs**. For the US-LRT baseline preset that means
total annual benefits ≈ **$127M** and BCR ≈ **1.2**. This identity is the primary correctness test.

---

## 2. Architecture

- **Single self-contained file:** `transit-bcr.html` — inline CSS/JS, Chart.js 4.4.1 from CDN, no build step,
  opens by double-click, hostable anywhere.
- **Pure calculation engine** separated from all DOM code. The engine is a set of side-effect-free functions
  exposed on a `TBCR` namespace so they can be unit-tested and driven by the JSON import path:
  - `computeDemand(params) → { R, loadFactor, tWait, phi, tGen }`
  - `computeBenefits(params, demand) → { CS, congestion, mohring, accident, emissions, labor, agglomeration, crowdingDisamenity, total }`
  - `computeCosts(params, demand) → { annualizedCapital, opCost, fareRev, opNet, surplusOffset, netCost, mcpfDeadweight, netCostWithMCPF }`
  - `computeWelfare(params) → { benefits, costs, W, BCR, FRR }`  (composes the three above)
  - `optimizeFare(params, objective) → { fareStar, W, R, ... }`  (`objective ∈ {welfare, revenue, fareboxTarget}`)
- **UI layer** is a thin controller: read sliders → build `params` → call `computeWelfare` / `optimizeFare` →
  update cards, charts, and breakdown text. All rendering lives in one `render(state)` path.

---

## 3. The expanded model

All benefit/cost formulas from the source doc are retained unless overridden below. New and changed
pieces:

### 3.1 Endogenous demand (generalized-cost pivot)

Each preset defines a **reference equilibrium**: observed ridership `R0` at reference fare `f0`,
reference daily train-hours `H0`, and the reference generalized time `tGen0`. Current ridership pivots
off that reference with **decomposed constant elasticities**:

```
R      = R0 × (f / f0)^εf × (tGen / tGen0)^εt
tGen   = φ(load) · t_ivt + t_wait
t_wait = t_wait0 × (H0 / H_train)          # more train-hours → shorter waits (Mohring channel, endogenous)
t_ivt  = trip_length / avg_speed           # in-vehicle minutes; trip_length=8mi, avg_speed default 20 mph → 24 min
```

- `εf` — fare elasticity, **default −0.35**, range −0.10 … −0.60. Direct user slider (the headline fix).
- `εt` — generalized-time elasticity, **default −0.60**, range −0.30 … −1.00.
- `t_wait0` — reference wait, default 5 min (derived per preset from reference frequency where known).
- The pivot is an **identity at the reference point**: when `f=f0`, `H_train=H0`, `φ=1`, then `R=R0`.

**Rationale for decomposed (not single blended-GC) elasticity:** lets the user set the fare elasticity
directly to the source doc's −0.3…−0.4 guidance, and matches standard transit-demand practice
(separate fare vs. time elasticities). The Mohring and crowding channels become endogenous through
`t_wait` and `φ(load)` inside `tGen`.

**Rationale for reduced-form `t_wait ∝ 1/H_train`:** avoids deriving headway from route geometry
(length/speed/route-count), so the original service inputs (`H_train`, `V`, `c_op`) are unchanged.
It captures the sign and rough magnitude of the frequency→wait relationship for pedagogy.

### 3.2 Consumer surplus (revised)

There are **two distinct baselines** and CS must respect both:

- **No-project counterfactual** (do-nothing / counterfactual mode): the source of the headline
  `Δt = 12 min` time savings and the ~$90M baseline surplus. The original model measures CS against this.
- **Reference fare/service equilibrium** (`f0`, `H0`): the pivot point for how demand responds to fare and
  service *changes within the project*.

CS is the **baseline surplus at the reference equilibrium plus a rule-of-a-half adjustment** for any
deviation of generalized cost from the reference:

```
CS0 = T0 × (Δt / 60) × VOT                              # baseline surplus vs. no-project counterfactual (original formula, at R0)
GC  = f + (VOT/60) × tGen                               # current generalized cost per trip ($)
CS  = CS0 − ½ × (R0 + R) × (GC − GC0) × operating_days  # riders in trips/day; add when GC<GC0, subtract when GC>GC0
```

- At the reference point `GC = GC0` ⇒ `CS = CS0` ⇒ **the anchor holds** (baseline preset → original ~$90M CS,
  ~$127M total benefits, BCR ≈ 1.2).
- Raising fare or degrading service (`GC > GC0`) loses surplus via the rule-of-a-half trapezoid; improving
  service (`GC < GC0`) adds surplus. CS therefore responds correctly to both fare and service changes while
  preserving the original counterfactual-based magnitude.

### 3.3 Crowding externality (new)

```
capacity_peak = frequency_peak × V × seats_per_vehicle
load          = peak_hour_riders / capacity_peak
peak_hour_riders = R × 1000 × peak_hour_share × peak_direction_share
φ(load) = 1                             for load ≤ load_comfort (default 0.80)
        = 1 + k × (load − load_comfort) for load > load_comfort, capped at φ_crush (default 1.8)
```

- New params: `seats_per_vehicle` (default 150), `peak_hour_share` (default 0.17), `peak_direction_share`
  (default 0.60), `load_comfort` (0.80), `φ_crush` (1.8), crush slope `k` derived to hit `φ_crush` at
  load = 1.5 (crush). (Wardman/Whelan multipliers; Hörcher 2023.)
- Crowding enters **twice**: (a) as `φ(load)` inflating `t_ivt` in `tGen` (demand suppression), and
  (b) as a **crowding disamenity cost** counted in the benefit ledger as a negative segment:
  `crowdingDisamenity = − (VOT/60) × (φ−1) × t_ivt × T`.

### 3.4 Marginal cost of public funds (new)

```
subsidy            = max(netCost, 0)                 # public money required, if any
mcpfDeadweight     = (λ − 1) × subsidy               # shown as its own cost segment
netCostWithMCPF    = netCost + mcpfDeadweight
BCR                = B / netCostWithMCPF
```

- `λ` — shadow price of public funds, **default 1.30**, range 1.00 … 1.50. λ = 1 disables it (anchor case).

### 3.5 Fare optimization (new)

A 1-D golden-section search over the fare range returns three fares, each with `R`, `W`, `BCR`, `FRR`:

- **Welfare-maximizing** `f*`: maximizes `W = B(f) − netCostWithMCPF(f)`.
- **Revenue-maximizing**: maximizes `fareRev(f) = R(f) × f`.
- **Farebox-target**: smallest fare achieving a user-set FRR target (default 40%); null if unreachable.

Because `R`, `B`, and `netCost` all depend on `f`, each objective evaluation calls `computeWelfare`.
This closes the double-counting loop: the widget can show the fare the model itself would pick and how
far the current fare sits from it.

---

## 4. UI and interaction

Retains the current layout — summary cards, slider groups, stacked benefit/cost bars, breakdown text,
assumptions box — and adds:

### 4.1 Controls

- **New "Behavioral & second-best" slider group:** `εf`, `εt`, MCPF `λ`, `seats_per_vehicle`,
  `peak_hour_share`, `avg_speed`, `φ_crush`.
- **Preset dropdown** and **Import JSON / Export JSON** buttons in a top control bar.
- **Optimize control:** a segmented button (Welfare / Revenue / Farebox) that **shows markers** on the
  charts by default (slider stays where the user left it), plus a one-click **"Snap fare to optimal"**
  that moves the fare slider to the selected objective's fare. (Show-markers is the default behavior;
  snap is explicit.)

### 4.2 Charts

- **Existing benefit stacked bar:** gains a **crowding-disamenity** segment (negative).
- **Existing cost stacked bar:** gains an **MCPF deadweight** segment.
- **New demand curve chart:** ridership vs. fare, with vertical markers at current fare, welfare-optimal,
  and revenue-max fares.
- **New welfare-vs-fare chart:** `W(f)` across the fare range with the optimum marked.
- Shared x-axis scaling for the two stacked bars is retained (115% of the larger of benefits / gross cost).

### 4.3 Readouts

Load factor, farebox recovery ratio, and **implied elasticities at the current point** are shown as small
readouts so the pedagogy stays visible. Breakdown text is regenerated to **narrate the endogenous
linkages** (e.g., "raising fare from $1.75 to $2.50 cut ridership 15% via εf=−0.35, shrinking CS by …").

---

## 5. Presets and JSON I/O

### 5.1 Presets

A `PRESETS` JS object. Each entry = full parameter vector + `referencePoint {R0, f0, H0, tGen0, tWait0}`
+ a one-line citation string. Ship five:

1. **US LRT baseline** — the source doc's current defaults (benefits ≈ $127M, BCR ≈ 1.2). Anchor preset.
2. **Elizabeth Line (London)** — γ = 24%, congestion-priced city (congestion externality reduced).
3. **Stockholm T-bana** — γ = 48%, high BCR (~6) reference case.
4. **High-cost US project** — K = $3–6B teaching case that pushes BCR < 1.
5. **Low-cost international** — international best-practice capital cost, strong BCR.

Selecting a preset repopulates **every** slider and the reference point, then re-renders.

### 5.2 JSON schema

```jsonc
{
  "version": 1,
  "params": { /* every slider key: value, flat */ },
  "referencePoint": { "R0": 40, "f0": 1.75, "H0": 150, "tGen0": 29.0, "tWait0": 5.0 }
}
```

- **Export** serializes current state (params + referencePoint) and offers download + copy-to-clipboard.
- **Import** parses, validates against known keys, **clamps values to their slider ranges**, and shows a
  **non-blocking warning** listing any out-of-range or unknown fields (import still applies the valid ones).
- Round-trip (export → import → export) is **idempotent**.
- This is the path for feeding parameters from an outside model (e.g., an `oc-transit-forecast` ridership
  estimate shaped into this schema).

---

## 6. Testing

- **Regression anchor (primary):** for each preset, at its reference point with λ = 1 and φ = 1, assert
  endogenous `R == R0` (pivot identity) and that the US-LRT baseline yields benefits ≈ $127M, BCR ≈ 1.2
  (tolerance ±1%).
- **Engine unit checks** (pure functions, no DOM):
  - demand strictly decreasing in fare; strictly increasing in `H_train`.
  - CS integral ≥ 0 for any fare below the reference fare; = 0 at reference.
  - `optimizeFare` returns a fare within range and `W(f*) ≥ W(f0)`.
  - `φ(load)` monotonic non-decreasing in load, `φ(load ≤ load_comfort) == 1`, capped at `φ_crush`.
  - MCPF: `BCR` strictly decreasing in λ for a subsidized system; unchanged for a surplus system.
  - JSON round-trip idempotent; import clamps out-of-range and reports unknown keys.
- **Harness:** an inline test block runnable via `?test=1` (renders pass/fail to the page) or a sibling
  `transit-bcr.tests.html` that imports the same engine functions. No build step or test framework required —
  plain `console.assert`-style checks with a visible summary.

---

## 7. File layout (new repo `C:\Users\aersl\transit-benefit-cost`)

```
transit-benefit-cost/
├── transit-bcr.html              # the widget (engine + UI, self-contained)
├── transit-bcr.tests.html        # regression + unit checks
├── docs/
│   ├── transit_benefit_cost_model.md          # original source model (reference)
│   └── specs/
│       └── 2026-07-07-transit-bcr-expanded-design.md   # this spec
└── README.md                     # what it is, how to open, JSON schema, preset citations
```

Git is **not** initialized at this stage (per user's choice); files are created only.

---

## 8. Open items deliberately left to implementation

- Exact `k` / `φ_crush` calibration constants for the crowding curve (pick published Wardman/Whelan values).
- Precise `tGen0` / `tWait0` reference values per non-baseline preset (derive from each project's published
  frequency where available; otherwise reuse baseline wait and document the assumption).
- Chart color assignments for the two new segments and two new charts.

None of these change the architecture; they are parameter/calibration choices resolved during build.
