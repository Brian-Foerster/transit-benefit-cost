# Transit Benefit-Cost Model (Expanded)

Single-file interactive widget for evaluating a transit-line expansion. Extends the original toy
welfare model (`docs/transit_benefit_cost_model.md`) by making ridership **endogenous** to fare and
service and adding crowding, marginal cost of public funds, and fare optimization.

## Run it

Open `transit-bcr.html` in any modern browser (double-click). No build step. Chart.js loads from CDN.

## Run the tests

- Headless: `node run-tests.mjs` (exit 0 = all pass).
- In-browser: open `transit-bcr.html?test=1` — assertions render at the top of the page.

## What it models

- **Endogenous demand:** ridership pivots off each preset's reference equilibrium via decomposed
  fare (εf) and generalized-time (εt) elasticities. More service shortens waits and raises ridership;
  crush loads suppress it.
- **Crowding:** peak load factor drives a crowding multiplier that both suppresses demand and imposes
  a disamenity cost.
- **MCPF:** the net public subsidy is scaled by a shadow price λ (deadweight loss shown separately).
- **Fare optimization:** welfare-, revenue-, and farebox-target fares, shown as options with snap-to.

## Presets

US LRT baseline, Elizabeth Line, Stockholm T-bana, high-cost US project, low-cost international.
See the `tbcr-presets` block in `transit-bcr.html` for parameter vectors and citations.

## JSON import/export

Export copies/downloads a `{version, params, referencePoint}` object. Import parses it, clamps values
to valid ranges, and warns on out-of-range or unknown fields. This is how you feed parameters from an
outside ridership model.

## Anchor

At each preset's reference point with λ=1 and φ=1 (comfort threshold lifted), endogenous ridership
equals the reference ridership, and the US-LRT baseline reproduces the original model's **formulas**:
~$75.2M benefits, ~$90M net cost, ~0.84 BCR. (The source doc's prose headline of $127M/1.2 is
inconsistent with its own equations; we reproduce the equations.) In normal use (default
`load_comfort=0.8`) benefits sit modestly below the anchor value because of the crowding disamenity —
intended behavior, not a discrepancy.

## Not modeled

Property-value capitalization, induced demand / land-use dynamics, construction disruption, network
effects, distributional weighting. See the spec in `docs/specs/` for the deferred-features rationale.
