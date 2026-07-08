# Integrated Transit Expansion Benefit-Cost Model

## Overview

This document describes a toy welfare model for evaluating a transit line expansion in a medium-sized city. The model computes annual social benefits from six externality categories plus an agglomeration uplift, and compares them against the fully integrated cost of building and operating the system — annualized capital plus operating deficit (or minus operating surplus). The purpose is pedagogical: to illustrate the relative magnitudes of different benefit categories using the best available parameter estimates from the academic literature, and to demonstrate that benefits must be counted once against the combined capital and operating cost rather than used to separately justify each.

The model draws primarily on Parry and Small (2009), Börjesson et al. (2020), Gupta, Kontokosta, and Van Nieuwerburgh (2022), Hörcher and Tirachini (2021), and the UK WebTAG wider economic impacts methodology.

---

## Input Parameters

### Demand and Benefits

| Parameter | Symbol | Default | Range | Source/Rationale |
|---|---|---|---|---|
| Daily ridership (thousands) | R | 40 | 15–80 | Typical range for a new LRT line in a metro area of ~1M |
| Average time saved per trip (minutes) | Δt | 12 | 5–25 | Net door-to-door time savings vs. counterfactual mode |
| Value of time ($/hour) | VOT | 18 | 8–40 | US DOT recommends $18/hr for local personal travel. Commuters ~$25–30. Low-income riders ~$10–12 |
| Share of riders diverted from cars (%) | α | 30% | 10–60% | Varies enormously by city mode share and service context |
| Agglomeration uplift (%) | γ | 25% | 0–50% | Elizabeth Line: 24% (Centre for Cities). Stockholm T-bana: 48% (Börjesson et al.) |

### Capital

| Parameter | Symbol | Default | Range | Source/Rationale |
|---|---|---|---|---|
| Capital cost ($B) | K | 1.5 | 0.5–6.0 | International best practice ~$1–1.5B/10km LRT. US costs often $3–6B |

### Operations

| Parameter | Symbol | Default | Range | Source/Rationale |
|---|---|---|---|---|
| Daily train-hours | H_train | 150 | 50–400 | Total hours of train service operated per day across all routes/directions |
| Vehicles per train | V | 3 | 1–10 | Cars per consist. Determines total vehicle-hours |
| Operating cost per vehicle-hour ($) | c_op | 180 | 80–300 | US LRT median from National Transit Database ~$150–200. Some systems >$250 |
| Average fare ($) | f | 1.75 | 0.50–5.00 | Typical US transit fare. Parry-Small optimal is usually $1.50–2.00 |

### Fixed Assumptions

| Parameter | Value | Source |
|---|---|---|
| Average trip length | 8 miles | Typical LRT trip length |
| Operating days per year | 300 | Excludes major holidays, accounts for reduced weekend service |
| Discount rate | 4% | Standard for US transport appraisal |
| Asset life | 30 years | Conventional for rail infrastructure BCAs |
| Congestion externality (blended) | $0.20/auto-mile | Parry & Small 2009: 28¢ peak, 7¢ off-peak, 60/40 split, net of fuel tax |
| Accident externality | $0.03/auto-mile | Parry & Small 2009 |
| Emissions externality | $0.015/auto-mile | Parry & Small 2009: CO₂ + local pollutants |
| Mohring scale factor | 18% of consumer surplus | Square-root rule (Mohring 1972): optimal frequency ∝ √demand |
| Labor market factor | 5% of consumer surplus | Parry & Bento (2001): commute cost reduction offsets income tax wedge |

---

## Derived Quantities

### Service Supply

Daily vehicle-hours:

```
H_veh = H_train × V
```

Annual vehicle-hours:

```
VH_annual = H_veh × 300
```

### Annual Trips

```
T = R × 1000 × 300
```

### Annual Diverted Car Trips

```
T_car = T × α
```

---

## Benefit Components

All benefits are in annual dollars (nominal).

### 1. Consumer Surplus (CS)

The direct welfare gain from reduced travel time. This is the largest component in virtually all well-selected transit projects, consistent with Börjesson et al.'s finding that the primary benefit of urban rail is being ridden.

```
CS = T × (Δt / 60) × VOT
```

**Literature:** Börjesson et al. (2020) find consumer surplus dominates benefits for Stockholm's T-bana (BCR ~6). Parry and Small (2009) treat time savings as the primary user benefit. The value of time is the most consequential single parameter; the US DOT guidance of $18/hr represents a median — commute trips are typically valued at 50% of the wage rate, while leisure trips are lower.

**Limitation:** This uses a linear valuation. In reality, the marginal value of time savings may be nonlinear — small savings (<3 min) may not be perceived, while large savings (>20 min) may be superlinear. The model also assumes a uniform VOT across all riders, which overstates benefits for high-VOT riders relative to low-VOT riders or vice versa depending on the chosen value.

### 2. Congestion Relief

The external cost reduction from removing car trips from the road network. This is a second-best benefit — it exists because road congestion is not directly priced.

```
Congestion = T_car × 8 × 0.20
```

**Literature:** Parry and Small (2009) estimate net external congestion costs at 25–31¢/passenger-mile peak, 6–8¢ off-peak for Washington and LA, and much higher for London (119¢ peak). The 20¢ blended figure assumes a 60/40 peak/off-peak split and nets out the portion already internalized through fuel taxes (~8¢/gallon equivalent). In cities with congestion pricing (Stockholm, London, Singapore), this benefit is substantially reduced.

**Limitation:** The benefit depends on the cross-elasticity between transit and auto — not all new transit riders would otherwise have driven. The car diversion parameter (α) is a rough proxy. Empirical cross-elasticities vary from 0.1 to 0.4 depending on city and mode. The model also assumes the marginal congestion externality is constant, when in reality it's convex — removing cars from a severely congested road saves more per car removed than on a lightly congested road.

### 3. Mohring Effect

The positive externality from demand-induced frequency increases. When ridership rises, operators add service, reducing waiting times for all riders.

```
Mohring = CS × 0.18
```

**Literature:** Mohring (1972) showed that optimal frequency scales with √demand (the "square-root rule"), implying increasing returns to scale. Calibrated at 18% of consumer surplus for a medium-frequency system. This ratio would be higher for a new bus route with low initial frequency and lower (potentially negative per Coulombel and Monchambert 2023) for a line at crush capacity where additional riders impose crowding externalities.

**Limitation:** The 18% factor is a rough calibration, not derived from a specific demand function. A proper Mohring calculation requires knowing the frequency-demand relationship, the distribution of arrival times, and the crowding function. Van Reeven (2008) also argued that a profit-maximizing monopolist may already internalize this effect through revenue optimization, though this was contested by Basso and Jara-Díaz.

### 4. Accident Reduction

External accident costs avoided by removing car trips from the road.

```
Accident = T_car × 8 × 0.03
```

**Literature:** Parry and Small (2009) estimate external accident costs at approximately 3¢/auto-mile, representing the marginal increase in collision risk that each driver imposes on other road users beyond what is internalized through insurance premiums.

### 5. Emissions Reduction

CO₂ and local air pollution costs avoided by diverting car trips.

```
Emissions = T_car × 8 × 0.015
```

**Literature:** Parry and Small (2009) estimate combined CO₂ and local pollution externalities at approximately 1.5¢/auto-mile. This is deliberately conservative — some social cost of carbon estimates would yield higher values. The model does not net out emissions from electricity generation for electric rail, which would reduce this benefit somewhat depending on the grid mix.

### 6. Labor Market Effect

Reduced commuting costs partially offset the income tax wedge on labor supply, encouraging labor force participation at the margin.

```
Labor = CS × 0.05
```

**Literature:** Parry and Bento (2001) showed that commuting costs interact with pre-existing labor market distortions from income taxation. Transit subsidies that lower commuting costs encourage work, generating welfare gains in the labor market. Calibrated conservatively at 5% of consumer surplus. A Pittsburgh RCT of fare subsidies (2023) found small and insignificant employment effects, suggesting this channel may be weaker than theoretical models predict.

### 7. Agglomeration (Wider Economic Impacts)

Productivity gains from improved labor market access and effective density increases.

```
Direct_benefits = CS + Congestion + Mohring + Accident + Emissions + Labor
Agglomeration = Direct_benefits × γ
```

**Literature:** Applied as a percentage uplift on direct benefits, following UK WebTAG methodology. The Centre for Cities estimated the Elizabeth Line's agglomeration benefit at 24% of direct user benefits. Börjesson et al. found 48% for Stockholm's T-bana. The agglomeration elasticity literature (Donovan et al. 2024 meta-analysis: 0.015–0.039 for doubling density) underpins these estimates, though the translation from aggregate elasticity to project-level uplift requires strong assumptions.

**Limitation:** Agglomeration estimates are subject to sorting bias — roughly half the raw urban wage premium reflects who lives in cities rather than what cities do to people (Combes, Duranton, Gobillon 2008). The uplift percentage is calibrated from two specific projects and may not generalize. It will be smaller for additions to already-dense transit networks and larger for first metro lines in monocentric cities.

### Total Annual Benefits

```
B = Direct_benefits + Agglomeration
  = Direct_benefits × (1 + γ)
```

---

## Cost Components

### Annualized Capital Cost

Capital cost is annualized over 30 years at a 4% discount rate using a standard capital recovery factor (annuity formula):

```
CRF = [r × (1+r)^n] / [(1+r)^n − 1]

where r = 0.04, n = 30

CRF ≈ 0.05783

Annualized_capital = K × 10^9 × CRF
```

(Converted to millions for comparison with benefit figures.)

### Operating Cost and Revenue

Annual gross operating cost:

```
OpCost = c_op × H_train × V × 300
```

Annual fare revenue:

```
FareRev = T × f = R × 1000 × 300 × f
```

Operating net position:

```
OpNet = FareRev − OpCost
```

- If OpNet < 0: the system runs an **operating deficit** of |OpNet|.
- If OpNet > 0: the system runs an **operating surplus** of OpNet.

### Farebox Recovery Ratio

```
FRR = FareRev / OpCost × 100%
```

Typical US transit systems run 20–40% farebox recovery. Parry and Small's optimal subsidy implies farebox recovery of roughly 10–55% depending on mode, city, and time of day. Systems above 100% are operationally profitable (Hong Kong MTR, some Japanese private railways).

### Net Annual Cost (Integrated)

The critical integration step: operating surplus, if any, offsets annualized capital cost. This prevents double counting by treating the system as a single fiscal entity.

```
If OpNet ≥ 0 (operating surplus):
    Surplus_offset = min(OpNet, Annualized_capital)
    Net_cost = Annualized_capital − Surplus_offset

If OpNet < 0 (operating deficit):
    Net_cost = Annualized_capital + |OpNet|
```

**Rationale:** When fare revenue exceeds operating cost, the surplus is real money that can service capital debt. Treating it as an offset to annualized capital is equivalent to saying the system's operating cash flow partially amortizes the construction bonds. Conversely, when the system runs a deficit, both the capital amortization and the deficit must be funded — the combined figure represents the total annual public subsidy required.

---

## Benefit-Cost Ratio

```
BCR = B / Net_cost
```

Interpretation:

| BCR | Assessment |
|---|---|
| < 1.0 | Project fails — total costs exceed total benefits |
| 1.0–1.5 | Marginal — passes but vulnerable to cost overruns, ridership shortfalls, or parameter uncertainty |
| 1.5–2.5 | Robust — sufficient margin for moderate risk |
| > 2.5 | Strong — likely a high-value project unless parameters are significantly overstated |

---

## The Double Counting Problem

This model is designed to avoid a specific error common in transit advocacy and institutional practice: using the same pool of rider benefits to separately justify capital investment and operating subsidies.

**The mechanism:** Consumer surplus is generated at a specific ridership level that *assumes* a subsidized fare. If the fare were raised to full operating cost recovery, ridership would fall, consumer surplus would shrink, and the capital BCA would weaken. The capital case implicitly depends on the operating subsidy being in place, while the operating subsidy is separately justified by pointing to the consumer surplus that only exists because the capital investment was made.

**The solution:** This model computes benefits once and subtracts the full cost of building and running the system. If B > Net_cost, both the capital investment and the operating subsidy are jointly justified. They draw on a single pool of social benefits, and that pool can only be spent once.

**Institutional relevance:** In the US, the FTA's Capital Investment Grants program evaluates capital projects without accounting for operating subsidies, while transit agencies separately argue for operating funding from state or local sources. Neither analysis checks whether the combined expenditure is justified by a single coherent welfare calculation. This model performs that check.

---

## Sensitivity and Key Findings

At default parameters (40k daily riders, 12 min saved, $18/hr VOT, 30% car diversion, $1.5B capital, 25% agglomeration, 150 train-hrs/day, 3 vehicles/train, $180/veh-hr, $1.75 fare):

- **Total annual benefits:** ~$127M
- **Net annual cost:** ~$107M (annualized capital ~$87M + operating deficit ~$20M)
- **BCR:** ~1.2

### Critical sensitivities:

1. **Capital cost** is the dominant swing factor. At $3B (common for US projects), BCR falls below 1. At $1B (international best practice), BCR rises above 2. This is Levy's central point: cost control matters more than funding mechanism.

2. **Value of time** is the most consequential benefit-side parameter. Reducing VOT from $18 to $10 (appropriate for a low-income ridership base) roughly halves consumer surplus and pushes the default project below a BCR of 1. This raises equity concerns: CBAs systematically favor projects serving high-income riders.

3. **Car diversion** determines whether congestion relief is large or small. At 15% (a transit-dependent ridership), congestion benefits shrink to a minor component. At 50% (a system drawing heavily from auto commuters), congestion relief becomes the second-largest benefit.

4. **Agglomeration** can tip marginal projects. At 0% (standard US appraisal), the default project is marginal. At 25% (UK practice), it passes with a thin margin. At 50% (Stockholm-caliber), it's robust. Whether to include agglomeration depends on how much you trust the elasticity estimates (0.015–0.039 per Donovan et al. 2024, after publication bias correction).

5. **Operating cost per vehicle-hour** is the main operating-side sensitivity. At $250/veh-hr (high-cost US operator), the operating deficit doubles and the BCR drops significantly. This is why Parry and Small caveat that their subsidy findings assume a cost-efficient operator.

6. **The operating surplus regime** (fare > ~$3.50 at default parameters) reduces net cost substantially but would in reality reduce ridership, meaning the benefits side would also shrink. The model does not dynamically link fare to demand — users should manually reduce ridership when raising fares, applying a fare elasticity of approximately -0.3 to -0.4.

---

## What the Model Does Not Include

- **Demand elasticity:** Fare and ridership are independent inputs. A full model would link them through a demand curve, making fare optimization endogenous (the Parry-Small approach).
- **Crowding externality:** Hörcher (2023) shows that crowding reduces optimal subsidies by 4–29%. The model's Mohring factor does not account for diseconomies at high load factors.
- **Marginal cost of public funds:** Subsidies funded by distortionary taxes carry a deadweight loss (shadow cost ~1.1–1.5× per dollar raised). The model treats public funds as costless.
- **Property value capitalization:** Gupta et al. (2022) show 8% price increases near the SAS. This is a capitalization of future consumer surplus, not an independent benefit — including both would double count.
- **Induced demand and land use change:** Over decades, transit reshapes development patterns, generating additional ridership. The model uses a static ridership estimate.
- **Construction period disruption:** Negative externalities during construction (traffic disruption, business losses) are omitted.
- **Network effects:** A new line may increase ridership on connecting lines. Omitted.
- **Distributional weighting:** All riders' time is valued equally. Tirachini and Proost (2021) argue for inequality-averse welfare functions.

---

## Implementation Notes

### Widget Architecture

The interactive widget is implemented as a single HTML page with inline JavaScript and Chart.js (v4.4.1, loaded from CDN). No build step or framework is required.

**Structure:**

1. **Summary cards** (3): Total benefits, net cost, BCR. BCR is color-coded: green (≥1.5), amber (1.0–1.5), red (<1.0).

2. **Slider groups** (3 sections, 10 sliders total): Each slider has a label, an HTML range input, and a numeric output span. All sliders call a single `calc()` function on input events.

3. **Benefit bar chart** (horizontal stacked bar, Chart.js): Seven benefit categories stacked in a single bar. Colors are fixed per category.

4. **Cost bar chart** (horizontal stacked bar, Chart.js): Two bars — "Gross capital cost" shows annualized capital plus any operating deficit; "Net cost after offset" shows the same minus any operating surplus offset. Three datasets: annualized capital, operating deficit, operating surplus offset.

5. **Breakdown text** (dynamically generated HTML): Detailed accounting of all components with dollar values and percentages.

6. **Assumptions box** (static HTML): Documents parameter sources.

**Calculation flow (`calc()`):**

```
read all 10 slider values
compute derived quantities (daily vehicle-hours, annual trips, diverted trips)
compute 6 direct benefit components
compute agglomeration as uplift on direct sum
compute annualized capital via CRF
compute gross operating cost, fare revenue, operating net
determine surplus vs. deficit regime
compute net cost with surplus offset
compute BCR
update charts and text
```

**Chart scaling:** Both charts share a common x-axis maximum set to 115% of whichever is larger (total benefits or gross capital + deficit), ensuring visual comparability.

**Dependencies:** Chart.js 4.4.1 (CDN). No other libraries. Compatible with any modern browser.

### Porting to Other Environments

The model is simple enough to implement in any language or spreadsheet. The core is ~30 lines of arithmetic. The key implementation decisions:

- The CRF formula must use the same discount rate and asset life consistently.
- The surplus offset logic (min of operating surplus and annualized capital) prevents the net cost from going negative — a system cannot "more than pay for itself" in this framework because we are not modeling reinvestment of excess surplus.
- Chart visualization is optional; the model's value is in the arithmetic and parameter calibration.

---

## References

- Ahlfeldt, G., Redding, S., Sturm, D., & Wolf, N. (2015). The Economics of Density: Evidence from the Berlin Wall. *Econometrica*, 83(6), 2127–2189.
- Börjesson, M., Isacsson, G., Eriksson, M., & Sundberger, J. (2020). Wider economic impacts of the Stockholm Metro. Centre for Transport Studies, KTH.
- Combes, P.-P., Duranton, G., & Gobillon, L. (2008). Spatial wage disparities: Sorting matters! *Journal of Urban Economics*, 63(2), 723–742.
- Coulombel, N. & Monchambert, G. (2023). Congestion in public transport: The Mohring effect revisited. *Journal of Public Economics*, 228.
- Donovan, S. et al. (2024). Agglomeration economies: A meta-analysis. *Journal of Economic Literature*.
- Dye, R. & Merriman, D. (2000). The Effects of Tax Increment Financing on Economic Development. *Journal of Urban Economics*, 47(2), 306–328.
- Gupta, A., Kontokosta, C., & Van Nieuwerburgh, S. (2022). Take the Q Train: Value Capture of Public Infrastructure Projects. *Journal of Urban Economics*, 129.
- Hörcher, D. & Tirachini, A. (2021). A review of public transport economics. *Economics of Transportation*, 25.
- Merriman, D. (2018). Improving Tax Increment Financing (TIF) for Economic Development. Lincoln Institute of Land Policy.
- Mohring, H. (1972). Optimization and Scale Economies in Urban Bus Transportation. *American Economic Review*, 62(4), 591–604.
- Parry, I. & Bento, A. (2001). Revenue Recycling and the Welfare Effects of Road Pricing. *Scandinavian Journal of Economics*, 103(4), 645–671.
- Parry, I. & Small, K. (2009). Should Urban Transit Subsidies Be Reduced? *American Economic Review*, 99(3), 700–724.
- Rosenthal, S. & Strange, W. (2004). Evidence on the Nature and Sources of Agglomeration Economies. *Handbook of Regional and Urban Economics*, 4, 2119–2171.
- Tirachini, A. & Proost, S. (2021). Transport taxes and subsidies in developing countries: The effect of income inequality aversion. *Economics of Transportation*, 25.
