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

## Anchor vs. as-shipped output

**Anchor (a correctness check, not the default view):** with the second-best corrections switched
off — `λ=1` and `φ=1` (comfort threshold lifted) — endogenous ridership equals the reference
ridership and the US-LRT baseline reproduces the original model's **formulas** exactly: **~$75.2M
benefits, ~$90M net cost, BCR ~0.84**. (The source doc's prose headline of $127M / BCR 1.2 is
internally inconsistent with its own equations; we reproduce the equations. See the spec's anchor
note.)

**As shipped (what the cards actually show):** the presets ship with the corrections **on**
(`λ=1.30` MCPF, `load_comfort=0.80` crowding), so the numbers on screen are lower than the anchor —
this is the point of the second-best additions, not a discrepancy. For the US-LRT preset at its
defaults the widget shows **B ≈ $39.7M, net cost ≈ $117.1M, BCR ≈ 0.34**: the crowding disamenity
removes ~$28M of benefit (peak load ≈1.09 → φ≈1.33) and the MCPF shadow price adds ~$27M of
deadweight to the subsidy. That is roughly half the anchor benefit and a third higher cost — a large,
deliberate movement, not a modest one. Turn MCPF to 1.0 and lift the comfort threshold and you return
to the anchor.

## Presets

Each preset is internally consistent — ridership, service supply (train-hours, vehicles, seats),
capital, and fares all scaled to the same real project, so capital and ridership move together. The
on-screen info box explains what makes each one distinct. As-shipped BCRs (with MCPF + crowding on):

| Preset | Riders/day | Capital | $ / daily rider | BCR | Character |
|---|---|---|---|---|---|
| US LRT baseline | 40k | $1.5B | $38k | 0.34 | marginal, subsidy-heavy (the anchor preset) |
| Elizabeth Line | 600k | $24B | $40k | 1.51 | costly but justified by scale + agglomeration |
| Stockholm T-bana | 130k | $3B | $23k | 2.49 | efficient flagship winner |
| High-cost US | 75k | $6B | $80k | 0.23 | cost-disease cautionary tale |
| Low-cost intl | 70k | $1.2B | $17k | 1.24 | cheap and efficient |

`us_lrt` is held fixed as the regression anchor; the other four were recalibrated to realistic,
internally-consistent scales.

## Not modeled

Property-value capitalization, induced demand / land-use dynamics, construction disruption, network
effects, distributional weighting. See the spec in `docs/specs/` for the deferred-features rationale.
