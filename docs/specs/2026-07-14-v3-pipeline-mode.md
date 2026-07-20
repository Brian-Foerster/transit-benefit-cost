# v3 Engine: Pipeline Mode — pricing exogenous per-draw quantity streams

**Date:** 2026-07-14
**Status:** Proposed design, pre-implementation
**Companion to:** `oc-transit-forecast/specs/06-bca-integration.md` (THE CONTRACT — §2
allocation rule, §3 export schema 08-A3.2, §4 dilemmas D1–D10, §6 E1–E6, §7 W1). This
spec translates spec 06 §6 into current-engine-native function signatures and adds the
node wrapper (§7 W1).
**Adds to, does not supersede:** the v2 discounted-lifecycle engine
(`2026-07-09-v2-discounted-lifecycle-engine.md`). Endogenous mode (the widget's
`computeDemand` → `computeBenefits` → `lifecycleCore` path) is untouched; pipeline mode
is a second entry point beside it. 160 tests stay green.

---

## 1. Goal and role

Add a **pipeline mode** in which the engine performs **no demand logic** and instead
prices per-draw quantity streams produced by the stage-2 pivot-logit ridership model
(oc-transit-forecast), aggregating them over the discounted lifecycle. This realizes the
allocation rule (spec 06 §2): **quantities from the ridership model; prices, time-profile,
and public finance from the BCA.**

In pipeline mode the following endogenous machinery is bypassed (never called):
`computeDemand`, the elasticity pivot (`eps_f`/`eps_t`), the market-saturation ceiling
(`ridership_cap`), the income-derived VOT (`votOf`), `mc_pax`, the fare optimizer, and the
Mohring markup — the last kept as a **coefficient hook** defaulting to 0 so D2's row is a
parameter change, not a code fork (spec 06 §2). §8 states each bypass explicitly. The
engine consumes the exported, exogenous per-draw masses and monetizes them; the widget's
endogenous mode remains for standalone exploration only.

Non-role: no reliability/comfort/amenity benefit line (D1 — retired for pipeline use; see
§12 for the two spec-06 rows this engine cannot yet compute — `reliability_restored` and
`roh`). This is the welfare BCA, not the federal template.

---

## 2. Binding interfaces (no re-hardcoding)

The wrapper (§7) reads three inputs and **re-derives nothing that another artifact already
owns**:

1. **The §3 export** `outputs/bca_export_<corridor>.json.gz` (spec 06 §3): per-draw
   quantity arrays, 19 stage-2 priors + `anchor`, optional `abc_weights` (kernel-labeled),
   top-level `routes_removed`, `base_service` (= `rev_hours_weekday` only, `{}` when
   nothing folds), `eq_days`. Verified against the real harbor export: the per-weekday
   arrays are `(40000,)`, `cm_seg` / `cm_seg_fullod` are `(3, 40000)`, and 5 `abc_weights`
   arrays ship (`543_launch_s500` central, `…_s350`, `…_s800`, `543_launch14_s500`,
   `543_matured_s500`).
2. **`oc-transit-forecast/outputs/assumptions.json`** (schema **08-A3.2**) — the cross-repo
   registry. **Binding rule (staged — the landed 08-A3.2 artifact does not yet carry the
   values).** The values the wrapper needs are `eq_days` `(300, 330)`, the ABC kernel
   **labels with a central designation**, the `(lo, hi, shape)` bands for the five priors it
   re-prices with (`vot_behav` tri(10,22), `pcar0` U(.05,.25), `pcar1` U(.35,.65), `pcar2`
   U(.55,.85), `pcarv` U(0,.30)), and `default_fare` $2.00. The committed **08-A3.2**
   appendix is an inventory only: its `priors` entries carry `{id, basis, tornado_pct,
   extras_pct}` with **no `(lo,hi,shape)` band**, `eq_days`/`default_fare` appear as rowless
   dispositions **with no value field**, and the central kernel label `543_launch_s500`
   appears **nowhere** in the file. So the single-source rule is landed in two stages:
   - **Target state (rider — schema bump 08-A3.3, §10):** `check_assumptions.py --appendix`
     emits a machine **values** section carrying the `eq_days` value, the kernel-label list
     with an explicit **central** flag, `(lo,hi,shape)` for the five re-priced priors, and
     `default_fare`. The wrapper reads all of these from `assumptions.json`, never
     re-hardcodes them, and **G-E5's grep gate activates at 08-A3.3**.
   - **Interim (until 08-A3.3 lands):** the wrapper reads `eq_days` `(300,330)` and the ABC
     kernel labels from **the §3 export** (which already ships both — `eq_days` and the
     label-keyed `abc_weights`); the **central-kernel** designation, which the export does
     not mark, is declared in the corridor **cost profile**; and the five prior `(lo,hi)`
     endpoints are read from the **cost profile** with a **stated TODO to migrate to
     08-A3.3** — because the export's `params` arrays are the per-draw **sampled values**
     (empirical percentiles), not the `(lo,hi,shape)` band endpoints the `pcar_lo/hi` and
     `vot_behav_lo/hi` re-pricing rows require. No value is hardcoded in wrapper source in
     either stage; the interim just sources from the export + cost profile rather than the
     registry. (Rows the wrapper cannot re-price from exported arrays — nonwork tilt, design
     variants — are additional export design points, not wrapper knobs; spec 06 §3.)
3. **A corridor cost profile** `config/<corridor>.cost.json` — spec-04 LOW and US-TYPICAL
   capex by asset class, `build_years`, GoA4 O&M benchmark bands, the E5 car-km design
   inputs (route_km, per-period headway/hours, cars_per_train), `base_boardings`, and the
   `avg_fare` band. The **only** BCA-owned prices live here and in the engine RANGES (§4).

---

## 3. E1 — pipeline core (`lifecycleCorePipeline`)

```
lifecycleCorePipeline(params, quantities) →
  { npv, bcrPV, pvBenefits, pvNetCost, subsidyPV, pvCapex, pvOM,
    pvBaseOMAvoided, pvFareRev, residual, loadFlag, byYear }
```

`quantities` — per-draw scalars the wrapper collapses from the export (pcar-weighting and
the ws/κ blend are wrapper-side re-pricings per spec 06 §3 division of labor):

| field | source | units |
|---|---|---|
| `umInfraMin`, `umMarginMin` | `um_infra`, `um_margin`, ws/κ-blended | ASC-incl. equiv-IVT min/weekday |
| `um0InfraMin`, `um0MarginMin` | `um0_infra`, `um0_margin`, blended | no-ASC counterfactual min/weekday (D1) |
| `fareBurdenDay` | `fare_burden` | $/weekday, **0 at flat-fare designs** (D3) |
| `fareReceiptsInfraDay`, `fareReceiptsMarginDay` | `fare_receipts` (infra/margin split) | $/weekday, **0 at flat-fare designs** (D3, D5); **REQUIRED for any Δfare≠0 design** |
| `carMilesDay` | Σ_seg `pcar`ₛ·`cm_seg`ₛ + `pcarv`·`cm_visitor`, blended | diverted car-mi/weekday, pre-ramp |
| `carMilesFullOdDay` | `cm_seg_fullod` variant | transfer-full-OD row (spec 06 D7) |
| `fareRevDay` | `avg_fare`·(`total` − `base_boardings`) | incremental system revenue $/weekday (D3) |
| `R0` | per-draw **new-line** boardings (`newline`) | load diagnostic only (D4) |

> **Extension, noted:** spec 06 E1 lists `{umInfraMin, umMarginMin, fareBurdenDay,
> carMilesComponents, fareRevDay, baseOpexAvoidedYr, R0}`. Three changes, all faithful:
> (a) `um0*` is added because D1's no-ASC counterfactual is the γ base (below) and the
> `no-ASC CS` row; (b) `carMilesComponents` is realized as the wrapper-collapsed scalar
> `carMilesDay` (+ `carMilesFullOdDay`), keeping the pcar/κ tornado rows as pure wrapper
> re-pricings per §3; (c) `fareReceipts*` is added as the fiscal counterpart to
> `fareBurdenDay` — the receipts side of a fare-policy Δ, without which the D3 money-metric
> transfer does not round-trip (see the money-metric note below and §12.6). It is a **pending
> export-schema addition** (rider, §10) and is **0 at every current flat-fare design**;
> until the `fare_receipts` stream ships, the interim guard applies (below).
> `baseOpexAvoidedYr` and the GoA4 car-km move to `params` (they are design-point constants,
> not per-draw).

**Central profile in bold** (spec 06 presentation principle): **λ=1.0, γ=0, SCC=$50,
mohring_coef=0, labor_coef=0, rebound=0.4** (recentered from 0, FB batch 2026-07-19:
external review 2026-07-17 + Duranton & Turner induced-refill evidence — freed road
capacity is partially re-consumed, so the congestion slice of the avoided-car-mile
credit is haircut at central; rows at 0 and 0.8; materiality: the car-mile externality
slice is ~4% of user benefits)**, carbon_growth=0, traction_gco2_per_km = grid rate
(corridor cost profile — D8's debit is ON at central; the clean-grid zero is the row),
VOT=$22.50/hr, discount 4% flat, eq_days=300, ramp_start=0.8, ramp_years=5, growth=0,
build_years=5, peak_hour_share=0.17**, plus the corridor's LOW **and** US-TYPICAL capital
(both shown). Explicit `mohring_coef:0, labor_coef:0` are **written into the profile object,
not left to defaults** (E2 — `parseState`'s `V2_DEFAULTS` would otherwise backfill 0.18/0.05).

Per calendar year `t`, with opening at `B = build_years` and opening-relative
`τ = max(t − B, 0)` (years `t < B` carry construction capex only):

```
g_t   = (1 + growth)^τ                                                  # whole-market growth (all streams); τ = opening-relative build-up
adopt = min(1, ramp_start + (1 − ramp_start)·min(τ / ramp_years, 1))    # D6 margin adoption ratio
cf    = (1 + carbon_growth)^t                                           # carbonFactor(t) — CALENDAR-time (TBCR def); SCC is a price path, escalating during construction too, so ^t NOT ^τ

# Margin-only ramp (D6): um_infra / fare_burden / receipts-infra get growth only; margin streams get adopt·g_t
umDay    = umInfraMin·g_t + umMarginMin·adopt·g_t                       # ASC-inclusive minutes/weekday
um0Day   = um0InfraMin·g_t + um0MarginMin·adopt·g_t                     # no-ASC minutes/weekday (γ AND labor base)
cmDay    = carMilesDay·adopt·g_t                                        # car-miles ∝ ΔS  → margin-ramped
frDay    = fareRevDay·adopt·g_t                                         # incremental revenue ∝ ΔS
frcptDay = fareReceiptsInfraDay·g_t + fareReceiptsMarginDay·adopt·g_t   # fare-Δ receipts; infra (∝S0) growth-only, margin (∝ΔS) ramped — mirrors fare_burden's S0 / ½ΔS split (D3); 0 at flat fare

timeUSD  = umDay·(VOT/60)·(1 + mohring_coef)                            # CS + Mohring hook (D2); mohring=0 central
agglom   = gamma · um0Day·(VOT/60)                                      # γ on the NO-ASC time base (see note)
laborUSD = labor_coef · um0Day·(VOT/60)                                 # D9 — on the NO-ASC time base too (symmetry with γ; §12); labor ABSENT at central (0)
extUSD   = cmDay·( c_cong·(1 − rebound) + c_acc + c_emis_local          # avoided-car externalities; rebound on congestion only (D8)
                   + (gco2_per_mi / 1e6)·SCC·cf )                       # avoided-car carbon: grams→tonnes /1e6 EXPLICIT & separate

# metro's own traction carbon — benefit-side NEGATIVE externality (D8 symmetry, fund(t) stays fiscal); annual (car_km_yr already carries eq_days), NOT ridership-ramped (line runs its full timetable from opening):
tractionUSDyr = (traction_gco2_per_km / 1e6)·car_km_yr·SCC·cf           # $/yr; same SCC·cf as the avoided-car line

benefit(t) = ( (timeUSD + agglom + laborUSD − fareBurdenDay·g_t + extUSD)·eq_days − tractionUSDyr ) / 1e6 · 1[t ≥ B]   # $M
             # per-weekday streams ×eq_days (→$/yr); tractionUSDyr already $/yr; then one dollars→$M /1e6; explicit 1[t ≥ B] — years t < B carry construction capex only
```

- **grams→tonnes vs dollars→$M** are two distinct `/1e6` (spec 06 E1 blocking fix): the
  inner `gco2_per_mi/1e6` (and, identically, `traction_gco2_per_km/1e6`) converts g→t before
  `×SCC` ($/t); the outer `/1e6` converts $/yr→$M. They must never be folded.
- **γ base (reconciliation, spec 06 presentation principle over the literal E1).** The E1
  shorthand writes `(1+γ)·(umInfra+…)`. The binding intent is that γ marks up the **no-ASC
  time-based** stream only — "marking up a comfort premium with a factor calibrated on time
  savings would add phantom benefit." So the engine applies γ to `um0Day`, not `umDay`. At
  γ=0 central the two readings coincide; the difference surfaces only in the γ tornado rows.
  **"γ on ASC-inclusive CS"** is a separate labeled row (spec 06 §7).
- **Money stays money-metric (D3/A4), and the transfer must round-trip.** `fareBurdenDay`
  (the rider welfare loss `P·(S0+½ΔS)·Δfare`) enters the benefit line at **weight 1** (never
  multiplied by VOT, γ, mohring, or labor). Its fiscal counterpart — government receipts
  `fare_receipts = P·S1·Δfare` — nets in `fund(t)` and is therefore scaled at λ per D5. At
  λ=1 the two cancel **up to the Harberger deadweight triangle** `½·P·ΔS·Δfare` (the correct
  welfare residual of a fare change), **not** to zero and **not** to "only the MCPF on the
  changed subsidy" as an earlier draft asserted — that claim was false as specified, because
  the receipts side was absent. **The cancellation is real only when the `fare_receipts`
  stream is present** (pending export addition, rider §10). Every current design is flat-fare
  (`fareBurdenDay ≡ fareReceipts ≡ 0`), so the A4 carve-out (§8) holds only *vacuously*
  today. **Interim hard guard:** `lifecycleCorePipeline` **errors and marks the output
  invalid** if `fareBurdenDay ≠ 0` while no `fare_receipts` stream is supplied — a fare-sweep
  design point priced with a half-built ledger (rider loss booked, no fiscal credit) would be
  biased against every fare increase by ~the full transfer, not the triangle. See §12.6.

Net public funds and headline (mirrors v2 §6 on discounted streams):

```
# fund(t) is STRICTLY FISCAL (no social carbon here — traction is on the benefit side). All terms $M.
# capex(t): spec-04, already $M. goaOM, baseOMAvoided, fare rev & receipts: natural $/yr → one /1e6.
fund(t)     = capex(t) + ( goaOM(t) − baseOMAvoided(t) − (frDay + frcptDay)·eq_days ) / 1e6   # $M; O&M/avoided/rev/receipts only for t ≥ B (else 0)
pvBenefits  = Σ_t benefit(t)·disc(t)
pvFund      = Σ_t fund(t)·disc(t) − residual·disc(T)                          # residual credit at horizon ($M)
subsidyPV   = max(pvFund, 0)                                                  # PV-level floor — deliberate v2 divergence (note)
pvNetCost   = subsidyPV·λ                                                     # = subsidyPV + (λ−1)·subsidyPV (D5: net public funding scaled at λ; benefits never scaled)
npv         = pvBenefits − pvNetCost
bcrPV       = pvBenefits / pvNetCost                                          # ∞/NA when subsidyPV = 0 (floor binds) — never a divide-by-zero (note)
```

- **Units — every `fund(t)` term is $M.** `capex(t)` is spec-04 dollars-millions;
  `goaOM(t)` (§7), `baseOMAvoided(t)` (§6), and `(frDay + frcptDay)·eq_days` are natural
  dollars-per-year (`$/rev-hr·hr`, `$/car-km·km`, `$/weekday·weekday`) and carry the
  **explicit `/1e6`** shown above. `om_fixed_yr` is `$/yr` and `om_var_per_car_km` is
  `$/car-km` in the cost profile and RANGES (§4); `avoidable_rate` is `$/rev-hr`. This is the
  same "never fold the `/1e6`s" discipline the benefit line enforces, applied to the fiscal
  side the E1 blocking fix left implicit.
- **`subsidyPV` floors at the PV level** (`max(pvFund, 0)`) — a **deliberate divergence from
  v2 §6**, which floored year-by-year (`Σ_t max(opCost − fareRev, 0)·disc` with surplus
  offsets). The PV-level floor suits a public sponsor with intertemporal fungibility and
  never binds for these capex-heavy corridors; the divergence is named here, not silent. When
  it does bind (`subsidyPV = 0`), `pvNetCost = 0` and **`bcrPV` is reported as ∞/NA** (positive
  benefits over zero net public cost), never as a divide-by-zero.

`disc(t)` reuses v2 `discountSeries` (flat 4% central; declining-schedule toggle available
as a row). `loadFlag` (D4): a **year-indexed** peak-load diagnostic,
`loadFlag = max_τ ( R0·g_t·peak_hour_share·pk_dir / seatCap )`, flagged where it exceeds
`load_comfort`. **`peak_hour_share` is the BCA-owned peak-HOUR share** (RANGES [0.08,0.30],
central 0.17, D4's 17%×0.60 convention) — **NOT** the export's `pkshare`, which is the
stage-2 time-of-day **period** share (prior U(0.45,0.60)); against an hourly seat capacity
`pkshare` overstates load ~3× and would fire the flag spuriously on every corridor (D4's
"revisit if any corridor's flag fires" would trip on a phantom). `R0` is the per-draw
**new-line** boardings scaled by `g_t`, so the binding year is the last (growth) year. No CS
haircut in v1 (the haircut is a wrapper tornado variant).

---

## 4. E2 — parameters + boundary hygiene

- **RANGES extension.** `parseState` strips unknown keys — a pipeline param absent from
  RANGES silently vanishes. RANGES entries are `[lo,hi]` pairs, so **every** new knob needs
  explicit bounds (the implementer must not have to invent them). Add:
  `eq_days [200,366]`, `c_cong [0.05,0.25]` ($/mi, congestion),
  `c_acc [0.01,0.05]` ($/mi, accident),
  `c_emis_local [0.007,0.010]` ($/mi; local-pollutant only **0.7–1.0 ¢/mi**, D8 re-spec),
  `gco2_per_mi [200,400]` (g CO₂/mi, car-fleet intensity; central ~350 ICE, lo end an
  EV-heavy fleet — see the `gco2_lo/hi` rows §10),
  `scc [0,300]`, `carbon_growth [0,0.07]` (present), `rebound [0,0.8]`,
  `traction_gco2_per_km [0,60]` (g/car-km; **central = the corridor grid rate from the cost
  profile**, D8; the `traction_0` row is the clean-grid zero),
  `build_years [3,10]`, `avoidable_rate [50,200]` ($/rev-hr, marginal→fully-allocated),
  `om_var_per_car_km [2,12]` ($/car-km, GoA4 benchmark band),
  `om_fixed_yr [0, 1e9]` ($/yr, corridor-scaled wide clamp; the operative lo/hi come from the
  §7 SkyTrain/Copenhagen/NTD benchmark band in the cost profile),
  `peak_hour_share [0.08,0.30]` (central 0.17, D4 load diagnostic — the BCA-owned peak-HOUR
  share, distinct from the export's period `pkshare`),
  `VOT [8,40]` (present — social VOT central 22.50 sits mid-band). `ramp_start [0.2,1.0]`
  already spans D6's U(0.6,1.0) support including the no-ramp end (=1.0). **`nonwork_factor`
  is NOT added** — it cannot act engine-side (the engine receives ws/κ-blended scalars, so
  the work/nonwork split is already collapsed); `nonwork_07` is a **wrapper** re-blend (§3
  note, §10), not an engine knob, so G-E7 points at the wrapper for it.
- **`mohring_coef` floor → 0.** RANGES currently clamps `mohring_coef:[0.05,0.30]`, which
  would silently reinstate a 5% markup over D2's zero central. Lower the floor to
  `[0,0.30]`. Likewise `labor_coef` floor → 0 if RANGES clamps it above 0.
- **`V2_DEFAULTS` backfill — explicit zeros, not defaults.** `parseState`'s `V2_DEFAULTS`
  backfill injects `mohring_coef:0.18, labor_coef:0.05, mc_pax:0.75` into any params object
  **missing** those keys — the same silent-reinstatement hazard the floor fix targets, via
  the other door. So the pipeline central profile **carries explicit `mohring_coef:0,
  labor_coef:0`** (and `mc_pax` is never read in pipeline mode, §8), and the wrapper
  **asserts them post-parse** whether or not it routes through `parseState`. A **G-E3
  invariant** locks it: the central profile's effective `mohring_coef` and `labor_coef` are 0
  after any parse path.
- **`life ≥ 5` guard on the wrapper input path.** `capexSchedule` infinite-loops on
  `life ≤ 0`. `parseState` already clamps `assets[i].life` to `[5,120]`; the wrapper's
  cost-profile parser must apply the **same** guard whether or not it routes through
  `parseState` (it reads a cost JSON directly).

---

## 5. E3 — construction period

`build_years` (default **5**, judgment; rows at 4/7). Capital classes (v2 §4.1 shares/lives)
are spread over construction years `0 … B−1` (even real outlay per class by default; the
profile may weight it), and **opening** — ramp, benefits, GoA4 O&M, avoided base O&M,
incremental revenue — begins at year `B`. Renewals and the residual are measured from each
class's **in-service date** (year `B` for the initial build), so the residual fraction at
horizon `T` is `(life − (T − t_last_in_service)) / life`. `capexSchedulePipeline` returns
the shifted `capex[]` and `residual`; the v2 `capexSchedule` (opening at t=0) is retained
for endogenous mode.

---

## 6. E4 — avoided base O&M + incremental revenue

- **Avoided base O&M** (per scenario, spec 06 E4): `baseOMAvoidedYr = Σ_{route ∈
  routes_removed[scenario]} rev_hours_weekday[route] · eq_days · avoidable_rate` — units
  `$/yr` (`$/rev-hr · hr/weekday · weekday/yr`), carried into `fund(t)` under its explicit
  `/1e6` (§3). `routes_removed` and `rev_hours_weekday` come from the export (top-level and
  `base_service`). `avoidable_rate` ($/rev-hr) is a **knob spanning marginal → fully
  allocated**; the NTD fully-allocated rate overstates what folding two routes sheds, so the
  central sits below it and there is a **row at the marginal end**. When
  `routes_removed[scenario]` is empty (streetcar — no single route to fold), `base_service`
  is `{}` and `baseOMAvoidedYr = 0`.
  - **`eq_days` reused as the service-hour annualizer — a judgment, not an identity.**
    `eq_days` is the `anchor_from_apc` RIDERSHIP weekday→annual convention (300/330); weekend
    *service-hour* ratios differ from weekend *ridership* ratios, so this reuse is a named
    shortcut (and it mechanically couples avoided-O&M to the `eq_days_330` row — benefits and
    avoided cost move together by construction). Within the 300–330 band the error is small
    for typical OCTA weekend service; the alternative is to annualize from GTFS actual annual
    rev-hours per route (the config already sources `rev_hours_weekday` from published service
    data). Logged, not silent.
- **Incremental system fare revenue** (D3): `fareRevDay = avg_fare · (total −
  base_boardings)` per draw — **net-new** system boardings only, never gross new-line
  boardings × fare (riders diverted from 43/543 already paid the flat fare; gross would
  overstate ~3.5× and inflate the λ column). `base_boardings` comes from the corridor cost
  profile; `avg_fare` is the transfer-discount band. Revenue offsets subsidy **at λ** (§3,
  D5), and is margin-ramped (`adopt·g_t`).

---

## 7. E5 — GoA4 operating cost

`goaOM(t) = om_fixed_yr + om_var_per_car_km · car_km_yr` for `t ≥ B`, with (spec 06 E5):

```
car_km_yr = eq_days · Σ_periods 2 · route_km · (60 / headway_p) · hours_p · cars_per_train
```

sharing `route_km` / `headway` / `consist` **inputs** with spec 04 §3.1 (which sizes the
FLEET; it does not itself produce car-km — the feasibility-audit citation correction).
`om_fixed_yr` ($/yr) and `om_var_per_car_km` ($/car-km) are **wide** benchmark priors
anchored to SkyTrain / Copenhagen Metro / NTD GoA4 systems, with lo/hi rows; `goaOM(t)` is
`$/yr`, entering `fund(t)` under its explicit `/1e6` (§3).

The E5 module **computes `car_km_yr`**, but **`goaOM(t)` stays strictly fiscal** — the
**traction-carbon debit is booked on the benefit side** (§3), not here. Spec 06 E5's
"traction-carbon debit per D8" names *this module* (which owns `car_km_yr`), not the λ base:
routing `traction_gco2_per_km · car_km_yr · SCC` through `goaOM → fund → subsidyPV·λ` would
(a) mark a social carbon cost up by λ (D5 pins λ to the **net public funding requirement** —
carbon is not a fiscal flow), (b) sit the debit in the BCR denominator while its mirror
(avoided-car CO₂) sits in the numerator, and (c) carry no `carbonFactor` escalation while the
avoided-car line does. So `tractionUSDyr = (traction_gco2_per_km/1e6)·car_km_yr·SCC·cf` is a
**negative externality on the benefit line**, same `SCC·cf` as the avoided-car term.
**Central = the grid rate** (cost profile); the **`traction_0` row is the clean-grid zero**.
Per D8 the debit is **ON at central** and the clean-grid zero is the sensitivity — crediting
avoided-car CO₂ while ignoring the line's own traction carbon would be asymmetric, and D8's
asymmetry cuts on placement as well as on presence.

---

## 8. Reconciliation with the current engine's endogenous features

Pipeline mode does **no demand logic**, so each demand-coupled feature added since the v2
spec must be explicitly bypassed or shown consistent. Resolved decisions:

- **Income-derived VOT (`votOf`) — bypassed; social VOT used.** In pipeline mode VOT is the
  **wrapper-supplied social monetization prior** (tri $15/$30, central **$22.50**;
  the federal all-purpose $21.80 is a mid-band reference, not an authority), converting
  exported **minutes → dollars**. The income path (`vot_fraction·rider_income/2080`) is
  behavioral and stays in endogenous mode only. This honors D3's deliberate two-VOT split:
  behavioral `vot_behav` (stage 2, governs fare response, already in the exported utility)
  vs. social `VOT` (BCA monetization). The owner's income slider is **not** declared the
  pipeline VOT source.
- **`mc_pax` (marginal cost/passenger) — bypassed.** Pipeline operating cost is the E5 GoA4
  module (fixed + var·car-km, disaggregated from first principles), not the endogenous-mode
  `mc_pax·R` reduced form. `mc_pax` stays in `annualKernel`.
- **Market-saturation ceiling (`ridership_cap`) — bypassed.** The cap brakes the
  constant-elasticity pivot as fare→0; pipeline has no pivot. Saturation is already inside
  stage 2's logit, baked into the exported per-draw masses.
- **A4 fare-transfer-excluded-from-markup — preserved natively, but round-trips only with
  the receipts side.** A4's principle (the fare part of a generalized-cost move is a transfer,
  marked up by nothing, netted against revenue) is exactly D3's money-metric carve-out:
  `fareBurdenDay` is the money side at weight 1, and the markups (mohring, γ, labor) touch
  only the minute streams. But a transfer nets only if **both** legs are booked — the rider
  loss on the benefit side AND the government receipts in `fund(t)` (`fare_receipts`, §3).
  Today every design is flat-fare (`fareBurdenDay ≡ fareReceipts ≡ 0`, identical to A4's
  `f = f0` case), so A4 holds only **vacuously**; the moment a Δfare≠0 design point exists the
  `fare_receipts` stream (rider §10) is REQUIRED and the interim guard (§3) fires until it
  ships. A4 is thus preserved *by construction*, not merely by the current absence of a fare
  sweep.

---

## 9. E6 — tests

- **160 existing tests stay green** (endogenous mode untouched — pipeline mode is additive).
  Spec 06 E6 cited 131; that was the count at spec-06 authoring, before the income-VOT /
  line-length / mc_pax / saturation / A4 test additions. The current tree is 160
  (`node run-tests.mjs`).
- **Configured pipeline-mode anchor (0.5%).** The comparator `lifecycleCore` and
  `lifecycleCorePipeline` agree within 0.5% only when the endogenous path is neutralized to
  the closed-form pipeline shape. A bare `mohring=0, labor=0, γ=0, λ=1` is **not enough**
  (~20% apart by construction); configure `lifecycleCore` with the **full** list:
  - `mohring_coef=0, labor_coef=0` **written explicitly** (not left to `V2_DEFAULTS`, which
    backfills 0.18/0.05 — E2), and asserted post-parse (G-E3);
  - `gamma=0, lambda=1`, reliability absent (already; §1);
  - **`mc_pax=0`** (or `ramp_start=1` to freeze all years) — else endogenous `opCost` is
    year-varying with ramped R while pipeline `goaOM` is constant (~$10M PV divergence
    against a 0.5%-of-|NPV| ≈ $5M budget);
  - **`load_comfort` forced high so `phi=1`** (no crowding non-affinity — the pipeline's
    scalar×`adopt·g_t` shape cannot reproduce a mid-ramp `phi>1`; the existing anchor test
    already forces `load_comfort:10`);
  - **`build_years=0`** so `lifecycleCore` opens at `t=0` — the anchor passes params
    **directly, bypassing `parseState`** (whose floor is `build_years [3,10]`), or the floor
    is lowered for the test;
  - **`umInfraMin=0` (all-margin assignment)** — endogenous `rampFactor` scales *all* streams
    while the pipeline ramps margin only, so the constructed quantities go entirely to margin;
  - **`base_boardings=0`** — endogenous `fareRev` is gross, so incremental revenue matches
    only with a zero base;
  - **`om_fixed_yr` set to the service `opCost`**; externality rates set to the comparator's
    CONST (`c_cong=0.20, c_acc=0.03, c_emis_local=0.015, SCC=0`);
  - **`VOT = votOf(us_lrt)`** — any consistent VOT cancels between the minutes-construction
    and the monetization.

  Construct `quantities` from **us_lrt's** demand-side streams: mature-year CS as
  equivalent-IVT minutes `CS·1e6/(VOT/60)/eq_days`, and diverted car-miles **per weekday** as
  `alpha·R·D·trip_length / eq_days` (dividing by `eq_days`: the raw `alpha·R·D·trip_length` is
  ANNUAL and `carMilesDay` is per-weekday, so feeding it raw would ×`eq_days` double-count —
  symmetric with the CS mapping's own `/eq_days`). Then `lifecycleCorePipeline` must reproduce
  NPV/BCR within **0.5%**.
- **Structural invariants re-asserted:** BCR strictly decreasing in discount rate; residual
  increasing in asset life; **margin-only ramp ⇒ early-year benefits ≥ the all-ramped
  variant** (the composition property D6 fixes); `fareBurdenDay` at weight 1 (unmarked); **γ
  and labor act on `um0`, mohring on `um`**; and (G-E3) the central profile's effective
  `mohring_coef`/`labor_coef` are 0 after any parse path.
- **Determinism.** `outputs/bca_<corridor>.json` is emitted with sorted keys and an explicit
  `\n`, byte-stable across runs at fixed seed. **No run id, date, or wall-clock value is
  embedded**, and **any set-derived list** (omitted-column reasons, scenario keys) is
  **sorted before writing** — mirroring spec 07 G6 in full, not just its mtime clause. Per
  spec 07 G6 (gzip stamps wall-clock mtime), **any** `.gz` artifact this engine/wrapper writes
  sets `mtime = 0`; Node's `zlib` already emits `MTIME=0` by default, so for the Node wrapper
  the gz clause is a **regression assertion**, not new work (the primary wrapper output is
  plain JSON — this bites only a gz companion).

---

## 10. W1 — the node wrapper (`bca-pipeline.mjs`)

Node ≥ 22. Reads the three §2 inputs, loops the 40k draws through
`lifecycleCorePipeline` at the central profile, then produces the tornado by **re-pricing
cached per-draw component PVs**. Because every stream is a scalar-per-draw × a deterministic
year-shape, **all** rows — including the nominally "structural" ones (build_years, ramp,
discount) — reduce to one PV-factor recompute plus an O(40k) multiply-add; true draw-loop
rebuilds are never needed. Pure re-pricings / re-weightings: λ, SCC, VOT, γ, pcar, κ,
**nonwork** (wrapper re-blend, below), eq_days, carbon, rebound, avg_fare, O&M,
avoidable_rate, and **ABC-weight** (swaps the per-draw weight vector applied to cached
component PVs — the cheapest rows, not re-loops). Budget: **~12 s-scale** at 40k — basis
restated: the pipeline kernel is 61 years of closed-form scalar arithmetic, estimated
**~2–10 µs/call, to be confirmed at implementation** (the earlier figure cited a
`lifecycleCore` measurement dominated by `computeDemand`'s 30-iteration fixed point, which
pipeline mode never runs; ~12s survives because the kernel is ~10–50× cheaper and the cache
turns structural rows into re-pricings).

**Emits `outputs/bca_<corridor>.json`** with:

- **Central-profile headline:** fold and retain **reported separately (no blend of any
  kind** — different cost structures; spec 06 §1) × **uncapped | ABC** columns × **LOW |
  US-TYPICAL** cost bands: NPV & PV-BCR P10/P50/P90 and P(NPV>0). The ABC column weights
  draws by the **central-kernel `abc_weights` vector**, selected by the resolved central
  designation of §2 (interim: declared in the cost profile; target: the 08-A3.3 `central`
  flag) — **not a hardcoded label string**. The R1 launch-equivalent central
  (`543_launch_s500`) is the current value but is *resolved*, not literalized in wrapper
  source (G-E5). **ESS is reported per weighted statistic.** Where a corridor lacks
  `abc_weights` (streetcar pre-launch), the ABC columns are **omitted with the reason
  printed** — uncapped-only.
- **The full cross** `{scenario × uncapped|ABC × λ × band}` (JSON only).
- **`tornado_row_ids` — the machine-readable row-id list.** Shape pinned as a **flat array
  of id strings** plus a **separate `blocked` map `{id: reason}`** for rows
  specified-but-not-yet-computable (`reliability_restored`, `roh` — §12); the two never mix
  into one list, so `check_assumptions.py` check-2 parses a stable shape. This is the artifact
  check-2 (wrapper scan) enumerates once `outputs/bca_*.json` exists — flipping the
  `spec-pending:06§E4` dispositions (`eq_days`, `bca_config`) from a check-1 warning to a
  check-2 fail (spec 08 §5 **check 2** is the landed anchor language). **check-3 (no-orphans)
  scope:** the wrapper artifact is scanned for coverage of **oc-claimed ids only**
  (`eq_days_330`, `bca_config`'s rows, `abc_s350`/`abc_s800`, and the `pcar_*` /
  `vot_behav_*` / `kappa_1` rows); the ~40 **engine-owned** ids (`vot_*`, `gamma_*`,
  `lambda_13`, `scc_*`, `rebound_*`, `disc_*`, `build_years_*`, `om_*`, `avoidable_marginal`,
  `ext_*`, `traction_0`, `growth_1`, `ramp_*`, `no_asc_cs`, `mohring_009`, `labor_05`,
  `transfer_fullod`, `crowding_haircut`, `avg_fare_*`, `gco2_*`, `nonwork_07`) are **exempt
  from check-3** and covered by G-E7 on the TBCR side — they live in this repo's RANGES, not
  the oc registry. Every knob this spec introduces appears in `tornado_row_ids` in the same
  commit (spec 06 G5).

**oc-side riders — one landing block (rides W1's commit unless marked landed):**

1. **Export `fare_receipts` stream (+ `um_roh_*` option).** Add
   `fare_receipts = P·S1·Δfare_chosen` with an **infra/margin split** to the §3 export — the
   fiscal counterpart to `fare_burden`, REQUIRED for any Δfare≠0 design (interim guard until
   it ships, §3). Same rider: an optional **`um_roh_*` accumulator pair**
   (`Σ ½·P·(S0+S1)·dv`, rng-free, parallel to `um0_*`) to un-block the `roh` row.
2. **`assumptions.json` schema bump 08-A3.3 — machine values section.**
   `check_assumptions.py --appendix` emits `eq_days` value, the kernel-label list with an
   explicit **central** flag, `(lo,hi,shape)` for the five wrapper-re-priced priors, and
   `default_fare`. **G-E5's grep gate activates at this landing** (§2).
3. **Spec 06 count/coverage sync.** §3 `17 → 19` PRIORS keys and E6/G2 `131 → 160` tests —
   **already landed** (oc `master`, commit `8f7f5eb`, 2026-07-14; listed for traceability, no
   longer pending). **Still pending:** spec 06 §7 also **lacks a gCO₂/mi row** despite E2
   listing it (a latent spec 06 G5 gap this spec inherits) — queue the §7 row alongside the
   `gco2_lo/hi` rows added on the TBCR side (below).
4. **Spec 08 check-3 scoping amendment + §9 Q7.** Amend spec 08 §5 check-3 to scope the
   `bca_*.json` scan to oc-claimed ids (engine-owned ids exempt, enumerated above — option
   (b), not ~40 orphan registry entries), and **add Q7 to spec 08 §9** recording the
   wrapper-scan flip (spec 08 §9 currently ends at Q6, so the rider *creates* Q7 rather than
   citing a dangling pointer).
5. **Wrapper-artifact scan.** Turn on check-2 enumeration of `outputs/bca_*.json` once it
   exists.
6. **Width per-corridor coverage.** The per-corridor tornado width / coverage check.

**Complete tornado row list** (spec 06 §7, with stable ids) — the flat `tornado_row_ids`:

| id | row | id | row |
|---|---|---|---|
| `vot_lo`/`vot_hi` | VOT $15/$30 | `traction_0` | traction-carbon clean-grid zero (central = grid) |
| `nonwork_07` | non-work 0.7×VOT (**wrapper re-blend**) | `rebound_0`/`rebound_hi` | rebound 0 / 0.8 (central 0.4, FB batch 2026-07-19; ids were `rebound_05`/`rebound_08` when central was 0) |
| `vot_behav_lo`/`_hi` | behavioral VOT (via export) | `ext_cong_lo`/`_hi` | congestion rate |
| `vot_wedge` | minute streams re-priced at the exported per-draw behavioral VOT (FB batch 2026-07-19; money streams stay money-metric, D3/A4) | | |
| `gamma_015`/`gamma_025` | γ 0.15/0.25 (no-ASC base) | `ext_acc_lo`/`_hi` | accident rate |
| `gamma_asc` | γ on ASC-inclusive CS | `ext_local_lo`/`_hi` | local-pollutant rate |
| `lambda_13` | λ = 1.3 | `pcar_lo`/`pcar_hi` | pcar set lo/hi |
| `scc_0`/`scc_190` | SCC $0/$190 | `transfer_fullod` | transfer full-O-D car-miles |
| `carbon_growth_2` | carbon growth 2%/yr | `kappa_1` | κ → 1 |
| `gco2_lo`/`gco2_hi` | car-fleet gCO₂/mi lo/hi | `mohring_009` | Mohring 0.09 |
| `no_asc_cs` | CS = no-ASC counterfactual | `disc_2`/`disc_3`/`disc_7` | discount 2/3/7% |
| `labor_05` | labor +5% of time CS (on `um0`, §12) | `ramp_start_1`/`ramp_start_lo` | no-ramp / ramp lo |
| `disc_declining` | declining-rate schedule | `growth_1` | growth 1%/yr |
| `ramp_years_lo`/`_hi` | ramp years | `avoidable_marginal` | avoidable-cost marginal end |
| `build_years_4`/`_7` | build years | `avg_fare_lo`/`_hi` | avg fare / incremental boarding |
| `om_lo`/`om_hi` | GoA4 O&M prior | `crowding_haircut` | CS haircut when load > comfort |
| `abc_s350`/`abc_s800` | ABC σ (`543_launch_s350`/`_s800`) | `eq_days_330` | eq_days = 330 |

**Blocked rows** — carried in `tornado_row_ids.blocked` `{id: reason}`, **not** the flat list
(specified in spec 06 §7 but not yet computable; see §12):

| id | reason |
|---|---|
| `reliability_restored` | no reliability term in the engine to restore; un-blocks if a Part-B reliability line lands |
| `roh` | rule-of-half needs a `um_roh_*` stage-2 accumulator absent from the §3 export; un-blocked by rider 1 |

Cautions printed in the tornado (spec 06 D3/D9): the `vot_*` and `vot_behav_*` rows must not
be read jointly at opposite extremes; `labor_05` must not be read jointly with the γ rows.
Per spec 05 §4.3, the Flyvbjerg optimism-bias annotation prints beside the headline table.

---

## 11. Validation gates

- **G-E1 (regression):** 160 tests green; endogenous headline for every preset unchanged
  (pipeline mode adds functions, touches no existing path).
- **G-E2 (anchor):** configured pipeline-mode anchor within 0.5% of the configured
  `lifecycleCore` (§9).
- **G-E3 (invariants):** the §9 structural invariants hold, **including** the post-parse
  assertion that the central profile's effective `mohring_coef`/`labor_coef` are 0 after any
  parse path (E2 — guards the `V2_DEFAULTS` 0.18/0.05 backfill).
- **G-E4 (round-trip):** wrapper ABC-weighted P50 matches the export's own weighted P50
  (spec 06 B4 gate) to 4 significant figures; the seed+1 companion export drives a
  seed-drift check ≤ 2% on ABC-weighted BCR P50 (spec 06 G4).
- **G-E5 (interface) — staged (§2).** No `eq_days`, kernel label, or re-priced prior band is
  literalized in wrapper source. **At 08-A3.3** all resolve from `assumptions.json` and the
  **grep gate is enforced in CI**. **Until 08-A3.3**, `eq_days` and kernel labels resolve
  from the §3 export and the prior `(lo,hi)` bands + central-kernel designation from the cost
  profile (with the migration TODO); the grep gate then only asserts no value is hardcoded in
  wrapper source, since the registry does not yet carry the values.
- **G-E6 (determinism):** `bca_<corridor>.json` byte-stable at fixed seed; no run
  id/date/wall-clock embedded; set-derived lists sorted before writing; any gz companion
  carries `mtime=0` (Node `zlib` default — a regression assertion).
- **G-E7 (coverage):** every knob in §4 (engine RANGES) appears in `tornado_row_ids` (§10) in
  the commit that introduces it (spec 06 G5); wrapper-side rows that are NOT §4 knobs
  (`nonwork_07`, the pcar/κ re-blends) are covered by their own re-pricing rows. Once landed,
  check-2 scans `bca_*.json` for **oc-claimed** ids only; engine-owned ids are G-E7's
  responsibility and **exempt from check-3** (§10).

---

## 12. Resolved questions and known issues

1. **Pipeline VOT is social, not income-derived** (§8) — deliberate; the two VOTs (D3) are
   both exposed and must not be read jointly at opposite extremes.
2. **γ marks up the no-ASC time base**, not the ASC-inclusive CS (§3) — the literal E1
   `(1+γ)` shorthand is disambiguated by the presentation principle; `gamma_asc` is a
   separate row. Immaterial at γ=0 central.
3. **`carMilesComponents` collapses wrapper-side** to `carMilesDay` + `carMilesFullOdDay`
   (§3) — keeps pcar/κ tornado rows as pure re-pricings per spec 06 §3.
4. **`um0*` added to `quantities`** beyond spec 06 E1's list — required by D1 (no-ASC γ base
   and `no_asc_cs` row).
5. **`eq_days` central = 300** (the anchor_from_apc primary, listed first / conservative);
   `eq_days_330` is the single high row. The export's `(300,330)` pair remains the swept
   band, so the `eq_days_330` row is the band's **far edge**, not a one-sided judgment.
6. **`fareBurdenDay` is growth-scaled but not adoption-ramped — and its receipts counterpart
   was missing entirely** (§3). At every current flat-fare design
   `fareBurdenDay ≡ fareReceipts ≡ 0`, so both are immaterial today. The earlier draft named
   only the ramp asymmetry (burden `g_t`-only vs revenue `adopt·g_t`); the real defect was
   the **absent `fare_receipts` stream** — without it the D3 transfer does not round-trip and
   the "at λ=1 they cancel" claim was **false as specified**. Resolution: the `fare_receipts`
   export stream (infra/margin split, rider §10) restores the round-trip (cancel **up to the
   Harberger triangle**), and an **interim hard guard** errors on `fareBurdenDay ≠ 0` until it
   ships. Revisit the burden's own ramp split when a fare-sweep design point is built.
7. **mc_pax / ridership_cap / income-VOT bypassed; A4 preserved natively** (§8) — A4 holds
   vacuously today (flat fare) and *by construction* once `fare_receipts` lands.
8. **γ (and labor) mark up `um0` WITHOUT the Mohring share.** The γ base is `um0`, not
   `um0·(1 + mohring_coef)` — a silent departure from v2 A2's CS+Mohring agglomeration base.
   Immaterial: mohring and γ rows never co-move one-at-a-time and both are 0 at central.
   Logged, not hidden.
9. **Labor is bound to the no-ASC time base `um0`, for symmetry with γ** (§3). D9's row is
   "labor +5% of *time-based* CS," and the same reasoning that rebases γ off the ASC-inclusive
   stream ("marking up a comfort premium with a factor calibrated on time savings adds
   phantom benefit") applies to a coefficient calibrated on commuting time. Mohring stays on
   `um` because the E1 literal puts it there and it is 0 at central. Bites only in `labor_05`.

**Cannot be translated faithfully — TWO flagged blocked rows.** Spec 06 §7 lists two rows
this engine cannot yet compute; both are carried in `tornado_row_ids.blocked` `{id: reason}`
(§10), recorded here, not hidden:

- **`reliability_restored`** (D1: "reliability line restored at TBCR default + no-ASC CS,"
  bounding the *under*count direction). The current engine has **no reliability term to
  restore**: v2 §1 explicitly deferred all Part-B benefit lines (reliability / health /
  parking), and neither v2 nor the current engine implemented one — the older Part-B
  "reliability" item D1 refers to never existed in this codebase. Would slot in as a
  per-margin-rider reliability $ at a TBCR-default rate, added to the `no_asc_cs` stream, if
  Part-B lands (status `blocked-no-term`).
- **`roh`** (D10: rule-of-half vs exact logsum). The §3 export carries only the exact-logsum
  accumulators (`um_infra = Σ P·S0·dv`, `um_margin = total − infra`); reconstructing
  `ROH = Σ ½·P·(S0+S1)·dv` needs a dedicated stage-2 accumulator (`um_roh_*`, rng-free,
  parallel to `um0_*`) that is **not exported**, and it is not a wrapper re-pricing of any
  shipped quantity (status `blocked-no-data`). Un-blocked by rider 1 (§10).

So **two** spec 06 §7 rows — not one — are specified-but-blocked (correcting an earlier
"only reliability is blocked" claim); every **other** row and formula in spec 06 §6 (E1–E6)
translates directly to the signatures above.
