# v2 Engine: Discounted Multi-Decade Lifecycle Model — Design Spec

**Date:** 2026-07-09
**Status:** Proposed design, pre-implementation
**Supersedes:** the annual-snapshot cost/benefit engine in `transit-bcr.html`
**Source:** the "Proposed Changes to transit-benefit-cost" design note (Parts A, C, D; Part B deferred)

---

## 1. Goal and scope

Replace the steady-state annual-snapshot engine with an explicit **discounted multi-decade cash flow**,
and fix two coherence bugs in the benefit terms. Concretely, this round delivers:

- **A1** — crowding routed through a single channel (kept inside generalized cost; standalone
  `crowdingDisamenity` term dropped). A diagnostic "crowding embedded in CS" readout is retained.
- **A2** — agglomeration re-based onto **user benefits only** (CS + Mohring), removing the spurious
  `(1+γ)` uplift on labour and on the environmental/accident externalities.
- **A3** — Mohring (0.18) and labour (0.05) coefficients exposed as parameters with cited ranges.
- **C1** — document that no accounting-depreciation line exists or should be added (the discounting
  handles economic depreciation).
- **C2/C3/C4** — capital disaggregated by asset class and life; renewals (life-cycled reinvestment)
  and residual value; benefits and costs modelled as a year-by-year discounted profile over a long
  horizon.
- **C5** — discount rate a first-class parameter with a BCR/NPV-vs-rate sensitivity, plus an optional
  declining-rate schedule for distant years.
- **Re-anchor** — the regression anchor is re-derived for the corrected model; the source-faithful
  formula is dropped (the documented discrepancy note already preserves the original).

**Explicitly out of scope this round** (deferred to a later phase): Part B new benefit terms (health
/ physical activity, reliability, parking). The engine will be structured so these slot in later as
per-year benefit contributions.

---

## 2. Architecture change

Today `computeWelfare(params, ref)` returns a single representative year. v2 introduces a **time
layer** around a reusable **annual kernel**:

- `annualWelfare(params, ref, year, ctx) → { demand, benefits, opCost, fareRev, ... }` — the existing
  within-year equilibrium (endogenous demand pivot + benefits), evaluated for a given year using
  year-indexed inputs (ridership ramp, escalated carbon value). This is essentially today's
  `computeDemand`/`computeBenefits` with A1/A2 applied and a year-scaled reference ridership.
- `capexSchedule(params) → number[]` — real capital + renewals outlay per year, by asset class,
  plus a residual-value **credit** in the final year.
- `computeLifecycle(params, ref) → { npv, bcrPV, pvBenefits, pvNetCost, byYear[], matureYear, ... }`
  — discounts the annual kernel across the horizon and combines with the capex schedule.

The within-year kernel keeps everything the current model does well (endogenous demand, rule-of-a-half,
crowding feedback, Mohring markup, MCPF on the subsidy). The time layer is new.

---

## 3. Revised benefit kernel (A1, A2)

Per year `t`, with year-scaled reference ridership `R0(t)` (see §5.1):

```
tGen  = φ(load)·tIvt + tWait                 # crowded generalized time (unchanged)
GC    = f + (VOT/60)·tGen                     # crowding stays INSIDE generalized cost (A1)
GC0   = f0 + (VOT/60)·tGen0                   # reference GC at CURRENT VOT (existing fix, retained)
R     = R0(t) · (f/f0)^εf · (tGen/tGen0)^εt   # endogenous demand (unchanged)

CS0   = R0(t)·1000·D·(dt/60)·VOT
CS    = ( CS0 − 0.5·(R0(t)+R)·1000·D·(GC − GC0) ) / 1e6     # crowding welfare cost captured HERE, once

# A1: standalone crowdingDisamenity REMOVED. Diagnostic only (not added to any total):
crowdingInCS = ( CS_atφ1 − CS ) where CS_atφ1 recomputes CS with φ forced to 1   # ≥ 0, shown as a readout

congestion, accident = (diverted trips)·miles·(per-mile externality)             # unchanged
emissions            = (diverted trips)·miles·emissionRate·carbonFactor(t)       # escalates (see §5.2)
mohring = CS·mohringCoef        labor = CS·laborCoef                              # coefs now parameters (A3)

# A2: agglomeration marks up USER BENEFITS ONLY (CS + Mohring), not externalities or labour
userBenefits  = CS + mohring
agglomeration = userBenefits · γ
totalBenefits = userBenefits + agglomeration + congestion + accident + emissions + labor
              = userBenefits·(1+γ) + congestion + accident + emissions + labor
```

Notes:
- **A1 rationale:** demand responds to crowded `GC` (via `εt`) and CS is integrated over the same
  crowded `GC` — one consistent price space, crowding counted once relative to the reference. The
  standalone absolute term is removed to stop the off-reference double credit
  (verified: adding service currently books ~$12M of relief twice on us_lrt).
- **A1 UX:** the breakdown's explicit "Crowding" line is replaced by the non-additive `crowdingInCS`
  diagnostic ("crowding is currently costing riders ≈ $X of surplus vs an uncrowded baseline"), so the
  effect stays visible without being summed into benefits.
- **A2 rationale:** WEI is a markup on transport user benefits, not on pollution/accident savings or the
  labour-tax-interaction term. Base = CS + Mohring (Mohring is a user-time benefit). This also removes
  the labour `(1+γ)` double-uplift in one change.
- **A3:** `mohringCoef` (default 0.18, range 0.05–0.30) and `laborCoef` (default 0.05, range 0.0–0.15)
  become sliders. Doc note: the Mohring markup stands in for the endogenous-frequency response the model
  does not simulate (headway is an exogenous slider); set it to 0 if frequency is ever made
  demand-responsive.

---

## 4. Lifecycle cost model (C1, C2, C3)

The single 30-year CRF is **removed**. Capital is disaggregated into asset classes, each with its own
life, and modelled as explicit real outlays in the years they occur, discounted in §6.

### 4.1 Asset classes (default shares of total capital `K`, and lives)

| Class | Default share | Life (yr) | Notes |
|---|---|---|---|
| Civil works (tunnels, viaducts, stations) | 55% | 80 | long-life, drives residual value |
| Track & systems (signalling, power, OCS) | 25% | 30 | |
| Rolling stock | 15% | 30 | mid-life refurb approximated by full renewal at life |
| Fare / IT equipment | 5% | 12 | short-life, renewed several times |

Shares and lives are parameters (advanced group), defaulting as above; presets may override to reflect
project mix (e.g., an all-elevated line is more civil-heavy).

### 4.2 Renewals + residual (C3), replacing the CRF (C1)

For each class with cost `C_class` (= `K · share`) and life `L`:

- **Investments** at years `t = 0, L, 2L, …` for every `t ≤ T` (initial build + life-cycled renewals).
- **Residual value** at horizon `T`: the last investment made at year `t_last` still has
  `(L − (T − t_last)) / L` of its life remaining; credit `C_class · max(0, that fraction)` at `T`
  (linear economic depreciation of the final tranche only).

This yields the full real capex profile per year and one residual credit at `T`. No separate
depreciation or CRF line exists — the discounting in §6 supplies both return-of- and return-on-capital.

### 4.3 Operating cost / revenue per year

`opCost(t)` from `c_op · H_train · V · D` (service is exogenous → constant unless the user ramps it);
`fareRev(t) = R(t)·1000·D·f` grows as ridership ramps. `opNet(t) = fareRev(t) − opCost(t)`.

---

## 5. Time profile (C4)

### 5.1 Ridership ramp

`R0(t) = R0 · ramp(t) · (1+g)^t`, where:
- `ramp(t)` linearly rises from `rampStart` (default 0.60) at `t=0` to 1.0 at `t = rampYears`
  (default 5), then holds at 1.0.
- `g` = long-run real ridership growth (default 0%/yr, range 0–2%), for population/land-use build-up.

Each year the annual kernel runs with reference ridership `R0(t)`; the endogenous pivot (fare/service
response) applies on top. **Consequence, intended:** with service held fixed while ridership grows,
peak load rises over time, so crowding worsens in later years — captured automatically through φ.

### 5.2 Carbon escalation

`carbonFactor(t) = (1 + carbonGrowth)^t`, applied to the **emissions** term only. **Default
`carbonGrowth = 0` (off)**; range 0–7% so users can enable a rising social cost of carbon.

### 5.3 Horizon

`horizon T` default **60 years** (heavy-rail appraisal); slider 20–100.

---

## 6. Discounting and headline metrics (C4, C5)

```
disc(t) = Π_{s=1..t} 1/(1+rate(s))                          # supports a time-varying rate
PV_benefits = Σ_t totalBenefits(t) · disc(t)
PV_opNetSubsidy = Σ_t max(opCost(t) − fareRev(t), 0) · disc(t)     # operating subsidy years
PV_capex   = Σ_t capex(t) · disc(t) − residual · disc(T)
subsidyPV  = PV_capex + PV_opNetSubsidy − (operating surplus offsets)   # net public funds, PV
PV_netCost = subsidyPV + (λ−1)·subsidyPV        # MCPF on the PV of net public funds
NPV        = PV_benefits − PV_netCost
BCR        = PV_benefits / PV_netCost
```

- **MCPF** applies to the present value of net public funds required (deadweight `(λ−1)·subsidyPV`),
  consistent with today's treatment but on discounted subsidy.
- **Operating surplus** in a year offsets that year's public funding need (as today), floored so net
  public funds can't go negative within the capital-bearing years.

### 6.1 Discount rate (C5)

- `rate` default **4%**, slider 1–8%, first-class.
- Optional **declining schedule** (toggle, UK Green Book shape): `rate` for years 1–30, `rate−0.5%`
  for 31–75, `rate−1.0%` beyond. Off by default.
- The UI always shows a small **BCR-vs-discount-rate** sensitivity strip (e.g. BCR at 2/3/4/6%), since
  the rate does most of the work on durable assets.

---

## 7. Re-anchor

The corrected model no longer reproduces the source doc's `total = direct×(1+γ)` formula, so the old
$75.24M / BCR 0.836 anchor is retired (the source-faithful computation is dropped; the documented
discrepancy note in the earlier spec preserves the original). New anchors, both re-derived numerically
during implementation and pinned with tolerance:

1. **Mature-year annual identity:** at us_lrt reference params, ramp = 1, φ forced to 1 (comfort
   lifted), λ = 1 — the mature representative-year benefits equal a documented value `B*_annual`
   (computed in Task 1 of the plan; expected in the ~$60–65M range after A2 re-basing).
2. **Lifecycle NPV anchor:** at us_lrt with all v2 defaults (horizon 60, rate 4%, default ramp and
   asset split), `NPV` and `BCR` equal documented values within ±1%.
3. **Structural invariants** (unit tests): PV_benefits > 0; BCR strictly decreasing in discount rate;
   longer asset life raises residual and lowers PV_capex; renewals raise PV_capex; ramp < 1 lowers
   early-year benefits; crowding single-channel — total benefits invariant to removing the (now-absent)
   standalone term, monotonic in load.

---

## 8. UI changes

- **Headline cards** become: **NPV** (over horizon), **BCR (PV)**, and **discount rate** context; the
  mature-year annual benefit/cost remain available in the breakdown.
- **New "Time & finance" slider group:** horizon, discount rate, declining-rate toggle, ramp-start,
  ramp-years, long-run growth, carbon growth. **New "Asset lifecycle" advanced group:** the four
  asset-class shares and lives (collapsible; most users won't touch it).
- **A3 sliders:** Mohring coefficient, labour coefficient.
- **New chart: discounted cash-flow profile** — benefits, opex, capex/renewals, and cumulative NPV by
  year, with the residual credit visible at the horizon. The existing benefit/cost stacked bars show
  the **mature representative year**; the demand/welfare-vs-fare curves are unchanged (mature year).
- **BCR-vs-discount-rate** sensitivity strip near the headline.
- Breakdown text and the glossary updated for the re-based agglomeration, the single-channel crowding
  diagnostic, and the lifecycle cost lines (capital by class, renewals, residual credit, MCPF on PV).

---

## 9. JSON schema

`params` gains: `horizon`, `discount_rate`, `declining_rate` (bool), `ramp_start`, `ramp_years`,
`growth`, `carbon_growth`, `mohring_coef`, `labor_coef`, and an `assets` block (per-class share + life).
`version` bumps to 2. `parseState` clamps new numeric fields to ranges and **migrates v1 payloads**
(missing fields fall back to v2 defaults; the old single-`K` capital maps onto the default asset split).

---

## 10. Testing strategy

- The pure kernel and lifecycle functions stay DOM-free and Node-testable (existing harness).
- Port/keep the existing 67 tests where still meaningful; retire the source-faithful anchor asserts;
  add the §7 anchors and invariants; add A1/A2 regression tests (agglomeration base excludes
  externalities/labour; crowding not double-counted off-reference).
- Keep the headless UI smoke test; extend it for the new cards/sliders and the cash-flow chart hook.

---

## 11. Migration / backward-compat

- v1 exported scenarios import via the `parseState` v1→v2 migration (single K → default asset split;
  new time/finance params → defaults).
- The widget remains a single self-contained `transit-bcr.html`; `run-tests.mjs` unchanged in spirit.

---

## 12. Resolved defaults (confirmed 2026-07-09)

1. **Horizon:** 60 years (slider 20–100). ✓
2. **Asset split:** 55/25/15/5 shares, lives 80/30/30/12 (parameters; presets may override). ✓
3. **Ridership ramp:** 60%→100% over 5 years; **long-run growth 0%/yr by default** (slider 0–2%). ✓
4. **Carbon escalation:** **off by default** (`carbonGrowth = 0`; slider 0–7%). ✓
5. **Headline metric:** NPV + PV-based BCR on the cards; mature-representative-year annual figures live
   in the breakdown. ✓

All other behaviour follows the resolved decisions: A1 (crowding single-channel, drop standalone,
keep diagnostic), A2 (agglomeration on CS+Mohring only), just re-anchor.
