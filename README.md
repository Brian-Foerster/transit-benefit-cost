# Transit Benefit-Cost Model (Expanded)

Single-file interactive widget for evaluating a transit-line expansion. Extends the original toy
welfare model (`docs/transit_benefit_cost_model.md`) by making ridership **endogenous** to fare and
service, adding crowding and marginal cost of public funds, and — in v2 — replacing the single-year
annualized-cost framing with a full **discounted-lifecycle NPV / PV-BCR** model.

## Run it

Open `transit-bcr.html` in any modern browser (double-click). No build step. Chart.js loads from CDN.

## Run the tests

- Headless: `node run-tests.mjs` (exit 0 = all pass).
- In-browser: open `transit-bcr.html?test=1` — assertions render at the top of the page.

## What it models

- **Endogenous demand:** ridership pivots off each preset's reference equilibrium via decomposed
  fare (εf) and generalized-time (εt) elasticities. More service shortens waits and raises ridership;
  crush loads suppress it.
- **Crowding:** peak load factor drives a crowding multiplier baked into the generalized travel time
  used to compute consumer surplus — it suppresses demand and shows up as a diagnostic ("crowding
  embedded in CS"), not as a separate disamenity line (see [`#glossary`](transit-bcr.html) for detail).
- **MCPF:** the public subsidy's present value is scaled by a shadow price λ (deadweight loss shown
  separately).
- **Marginal cost per passenger (`mc_pax`, default $0.75/trip):** a real per-rider operating cost
  (energy/wear + the boarding/dwell-delay externality each boarding imposes on others). It deliberately
  excludes in-vehicle crowding, which is already counted as a rider disamenity in consumer surplus.
  Without it the marginal passenger costs nothing, so a BCR/NPV optimizer drives fares to the floor;
  with it, the optimal fare is interior.
- **Fare + service optimization:** one "Maximize BCR" control jointly picks the fare and daily
  train-hours that maximize the PV benefit-cost ratio, then snaps both sliders.
- **Discounted lifecycle:** every benefit and cost stream is computed year-by-year over a multi-decade
  horizon, with ridership ramping in from opening and capital assets renewed and residualized on their
  own schedules, then discounted to present value (see below).

## JSON import/export

Export copies/downloads a `{version, params, referencePoint}` object (schema v2 includes the asset
lifecycle block; v1 payloads are migrated automatically). Import parses it, clamps values to valid
ranges, and warns on out-of-range or unknown fields. This is how you feed parameters from an outside
ridership model.

## The lifecycle model (v2)

The widget no longer scores a project on one annualized "typical year." It runs a per-year kernel over
the whole project horizon and discounts every stream to a present value:

- **Horizon:** years of costs and benefits included in the PV sum. Default **60** (heavy-rail scale).
- **Discount rate:** annual rate used to convert future dollars to present value. Default **4%**
  (a Green Book–style declining-rate schedule is also available). Higher rates shrink distant-year
  benefits and renewals faster than near-term ones and lower the BCR.
- **Ridership ramp:** ridership does not open at its full modeled level — it starts at a fraction of
  the mature level and rises linearly to 100% over a ramp period. Default **60% → 100% over 5 years**.
- **Asset lifecycle:** capital is split into asset classes (civil works, track/systems, rolling stock,
  fare/IT), each capitalized at build and re-capitalized on its own renewal schedule inside the
  horizon. Default split: **civil 55% (80-yr life), track/systems 25% (30-yr), rolling stock 15%
  (30-yr), fare/IT 5% (12-yr)**. Any remaining useful life at the end of the horizon is credited back
  as a residual value that reduces PV capital cost.

**NPV = PV benefits − PV net cost** (PV net cost = PV capital+renewals net of residual, plus PV
operating subsidy, plus PV MCPF deadweight). **PV-BCR = PV benefits ÷ PV net cost.** There is
deliberately no separate depreciation line: discounting itself supplies the economic depreciation on
capital, comparing dollars spent today against benefits realized in future years purely through the
discount factor.

Two other v2 re-basings affect the benefit math (see `#glossary` in the widget for the full
per-line explanation):

- **A1 — crowding is single-channel:** crowding cost lives entirely inside consumer surplus via the
  generalized-time multiplier; there is no separate `crowdingDisamenity` benefit line to double-count
  against it.
- **A2 — agglomeration is re-based to user benefits only:** the productivity-uplift percentage now
  marks up consumer surplus + Mohring effect only, not the externality lines (congestion, accident,
  emissions) or the labor-market term. Those accrue to third parties or the tax base directly and
  aren't re-priced by agglomeration economies the way commuters' own time savings are.

## Anchor vs. as-shipped output

**Anchor (a correctness check, not the default view):** with the second-best corrections switched
off — `λ=1` and `φ=1` (comfort threshold lifted) — endogenous ridership equals the reference
ridership and the US-LRT baseline reproduces the original model's mature-year **formulas** exactly:
**~$72.9M mature-year benefits**. The v1 anchor (~$75.2M annualized-model benefits, BCR ~0.84) has
been **retired** — it does not carry over to v2 because A1/A2 re-base the benefit kernel (agglomeration
no longer marks up labor/externalities) and the cost side is now a discounted lifecycle rather than a
single annualized year, so the two are not directly comparable. The v2 anchor is derived fresh from
the built engine (see the "anchor" tests in `tbcr-tests`), not carried forward from v1.

**As shipped (what the cards actually show):** the presets ship with the corrections **on** (`λ=1.30`
MCPF, `load_comfort=0.80` crowding, full 60-year discounted lifecycle), so the numbers on screen
reflect both the second-best corrections and the time value of money — this is the point of the
model, not a discrepancy. For the US-LRT preset at its defaults the widget shows **NPV ≈ −$1.01B,
PV-BCR ≈ 0.62** (including a $0.75/trip marginal cost per passenger — see below).

## Presets

Each preset is internally consistent — ridership, service supply (train-hours, vehicles, seats),
capital, and fares all scaled to the same real project, so capital and ridership move together. The
on-screen info box explains what makes each one distinct. As-shipped lifecycle results (60-yr horizon,
4% discount, MCPF + crowding on):

| Preset | Riders/day | Capital | $ / daily rider | NPV | PV-BCR | Character |
|---|---|---|---|---|---|---|
| US LRT baseline | 40k | $1.5B | $38k | −$1.01B | 0.62 | marginal, subsidy-heavy (the anchor preset) |
| Elizabeth Line | 600k | $24B | $40k | +$25.1B | 1.64 | costly but justified by scale + agglomeration |
| Stockholm T-bana | 130k | $3B | $23k | +$4.9B | 2.10 | efficient flagship winner |
| High-cost US | 75k | $6B | $80k | −$7.4B | 0.29 | cost-disease cautionary tale |
| Low-cost intl | 70k | $1.2B | $17k | +$0.24B | 1.10 | cheap and efficient |

`us_lrt` is held fixed as the regression anchor; the other four were recalibrated to realistic,
internally-consistent scales.

## Not modeled

Property-value capitalization, induced demand / land-use dynamics, construction disruption, network
effects, distributional weighting. **Deferred (Part B of the v2 spec):** health benefits (active
travel to/from stations), reliability/schedule-adherence value, and parking-cost savings are not yet
in the model. See the spec in `docs/specs/` for the deferred-features rationale.
