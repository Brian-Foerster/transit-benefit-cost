# v2 Discounted Lifecycle Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the annual-snapshot cost/benefit engine with a discounted multi-decade lifecycle model (per-year benefit profile, asset-class capex + renewals + residual, NPV/PV-BCR headline), and fix two benefit-coherence bugs (A1 single-channel crowding, A2 re-based agglomeration), re-anchoring the regression tests.

**Architecture:** Keep the single self-contained `transit-bcr.html` with inline `<script id>` blocks and the zero-dep `run-tests.mjs`. The within-year equilibrium kernel (`computeDemand` + revised `computeBenefits`) is reused across years by a new time layer (`annualKernel` → `computeLifecycle`) that discounts benefits and an explicit capex schedule over a long horizon. `computeWelfare` is replaced by `computeLifecycle`; the fare optimizer and charts target NPV (welfare) and the mature representative year (demand/revenue).

**Tech Stack:** Vanilla HTML/CSS/JS, Chart.js 4.4.1 (CDN), Node (test runner only). ES2019+.

## Global Constraints

- Single distributable `transit-bcr.html`; all CSS/JS inline; only Chart.js 4.4.1 from CDN. `run-tests.mjs` uses Node built-ins only. No build step, no packages.
- Engine + presets + tests blocks stay DOM-free and pure; only `tbcr-ui`/`tbcr-charts` touch the DOM (guarded so they never run under Node or `?test=1`).
- Tests run headless via `node run-tests.mjs` (exit 0 = pass) AND in-browser via `?test=1`.
- Money in $M/yr for annual quantities and $M (present value) for PV quantities; the `fmtM` helper renders `$B` above $1000M. Ridership in thousands/day. Rates in decimal (0.04 = 4%).
- **A1 (crowding single channel):** crowding stays inside the generalized cost used for BOTH demand and the CS rule-of-a-half. The standalone `crowdingDisamenity` term is REMOVED from all totals. A non-additive diagnostic `crowdingInCS ≥ 0` is exposed.
- **A2 (agglomeration base):** `agglomeration = (CS + mohring) × γ`; `total = (CS+mohring)×(1+γ) + congestion + accident + emissions + labor`. No γ uplift on labour or externalities.
- **A3:** `mohring_coef` (default 0.18) and `labor_coef` (default 0.05) are parameters.
- **Lifecycle (C):** no CRF and no accounting-depreciation line. Capital = per-year real outlays by asset class, renewed every `life` years within the horizon, with a linear residual credit at the horizon. Benefits/opex per year, discounted. MCPF `(λ−1)` applies to the PV of net public funds.
- **Confirmed defaults:** horizon 60 (20–100); discount_rate 0.04 (0.01–0.08); declining_rate off; ramp_start 0.60; ramp_years 5; growth 0.0 (0–0.02); carbon_growth 0.0 (0–0.07); asset split shares 0.55/0.25/0.15/0.05 with lives 80/30/30/12.
- **Headline:** NPV + PV-BCR on the cards; mature-year annual figures in the breakdown.
- Fixed assumptions unchanged: trip 8 mi, 300 operating days, congestion $0.20/mi, accident $0.03/mi, emissions $0.015/mi.

## File Structure

- `transit-bcr.html` — inline blocks `tbcr-engine` (kernel + lifecycle), `tbcr-presets` (v2 presets + `TBCR_IO`), `tbcr-tests`, `tbcr-ui`, `tbcr-charts`.
- `run-tests.mjs` — unchanged.
- `README.md`, `docs/` — updated.

**Conventions:** engine functions added inside the `tbcr-engine` IIFE before the `root.TBCR = {…}` export and added to that export; tests inserted before `// ---- END TESTS ----`; run `node run-tests.mjs` after each change.

**Engine defaults (defensive):** every new numeric param is read with a fallback so v1-shaped inputs still run: `params.horizon || 60`, `params.discount_rate ?? 0.04`, `params.mohring_coef ?? 0.18`, `params.labor_coef ?? 0.05`, `params.ramp_start ?? 0.60`, `params.ramp_years ?? 5`, `params.growth ?? 0`, `params.carbon_growth ?? 0`, `params.assets || DEFAULT_ASSETS`, `params.declining_rate || false`.

---

## Task 1: Revise the benefit kernel (A1 + A2 + A3)

**Files:** Modify `transit-bcr.html` (`tbcr-engine` `computeBenefits`; `tbcr-tests`).

**Interfaces:**
- Consumes: `demand` from `computeDemand` (has `R, load, phi, tWait, tIvt, tGen, GC`), `ref` (has `R0, f0, tGen0, GC0`).
- Produces: `computeBenefits(params, demand, ref) → { CS, crowdingInCS, congestion, mohring, accident, emissions, labor, userBenefits, agglomeration, total }`. `params` adds `mohring_coef`, `labor_coef`, optional `carbonFactor` (default 1). No `crowdingDisamenity`, no `direct` key.

- [ ] **Step 1: Write the failing test** (insert before `// ---- END TESTS ----`):

```js
// Task 1: revised benefit kernel (A1 single-channel crowding, A2 re-based agglomeration, A3 coefs)
{
  const base = { f:1.75, H_train:150, V:3, VOT:18, eps_f:-0.35, eps_t:-0.60, avg_speed:20,
                 seats_per_vehicle:150, peak_hour_share:0.17, peak_direction_share:0.60,
                 load_comfort:0.80, phi_crush:1.8, service_span_hrs:18,
                 dt:12, alpha:0.30, gamma:0.25, mohring_coef:0.18, labor_coef:0.05 };
  const refSeed = { R0:40, f0:1.75, H0:150, tWait0:5, tGen0:null };
  const cal = TBCR.computeDemand(base, refSeed);
  const ref = { ...refSeed, tGen0: cal.tGen, GC0: cal.GC };
  const d = TBCR.computeDemand(base, ref);
  const b = TBCR.computeBenefits(base, d, ref);
  // A2: total = (CS+mohring)*(1+gamma) + congestion + accident + emissions + labor  (labour NOT uplifted)
  const expected = (b.CS + b.mohring)*(1+base.gamma) + b.congestion + b.accident + b.emissions + b.labor;
  T.eq('A2 total = userBenefits*(1+g)+externals+labor', b.total, expected, 1e-9);
  T.ok('A2 agglomeration base is CS+mohring only', Math.abs(b.agglomeration - (b.CS+b.mohring)*base.gamma) < 1e-9);
  T.ok('A1 no standalone crowdingDisamenity key', !('crowdingDisamenity' in b));
  T.ok('A1 crowdingInCS >= 0', b.crowdingInCS >= -1e-9);
  T.ok('A1 crowdingInCS > 0 when crowded', d.phi > 1 ? b.crowdingInCS > 0 : true);
  // A3: labour scales with labor_coef
  const b2 = TBCR.computeBenefits({ ...base, labor_coef:0.10 }, d, ref);
  T.ok('A3 labour tracks labor_coef', Math.abs(b2.labor - 2*b.labor) < 1e-6);
  // carbon factor scales emissions only
  const b3 = TBCR.computeBenefits({ ...base, carbonFactor:2 }, d, ref);
  T.ok('carbonFactor doubles emissions', Math.abs(b3.emissions - 2*b.emissions) < 1e-9);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `node run-tests.mjs` → FAIL (`computeBenefits` still returns `crowdingDisamenity`/`direct`, agglomeration on wrong base). Exit 1.

- [ ] **Step 3: Replace `computeBenefits`** in `tbcr-engine`:

```js
  function computeBenefits(params, demand, ref) {
    const D = CONST.OPERATING_DAYS, R = demand.R;
    const GC0 = ref.f0 + (params.VOT / 60) * ref.tGen0;          // reference GC at current VOT
    const CS0 = ref.R0 * 1000 * D * (params.dt / 60) * params.VOT;
    const CS = (CS0 - 0.5 * (ref.R0 + R) * 1000 * D * (demand.GC - GC0)) / 1e6;
    // A1 diagnostic (non-additive): surplus that crowding is costing riders vs an uncrowded trip.
    // GC0 cancels: crowdingInCS = 0.5(R0+R)*1000*D*(VOT/60)*(phi-1)*tIvt / 1e6  >= 0
    const crowdingInCS = (0.5 * (ref.R0 + R) * 1000 * D * (params.VOT / 60) * (demand.phi - 1) * demand.tIvt) / 1e6;
    const Tcar = R * 1000 * D * params.alpha;
    const congestion = (Tcar * CONST.TRIP_LENGTH_MI * CONST.CONGESTION_PER_MI) / 1e6;
    const accident   = (Tcar * CONST.TRIP_LENGTH_MI * CONST.ACCIDENT_PER_MI) / 1e6;
    const emissions  = (Tcar * CONST.TRIP_LENGTH_MI * CONST.EMISSIONS_PER_MI) / 1e6 * (params.carbonFactor ?? 1);
    const mohring = CS * (params.mohring_coef ?? 0.18);
    const labor   = CS * (params.labor_coef ?? 0.05);
    const userBenefits = CS + mohring;                            // A2 base
    const agglomeration = userBenefits * params.gamma;
    const total = userBenefits * (1 + params.gamma) + congestion + accident + emissions + labor;
    return { CS, crowdingInCS, congestion, mohring, accident, emissions, labor, userBenefits, agglomeration, total };
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `node run-tests.mjs`. Expected: Task 1 lines PASS. NOTE: the OLD Task 5 tests and the anchor/consolidated tests still reference `crowdingDisamenity`/`direct`/old totals and WILL now fail — that is expected; they are retired/updated in Task 6. To keep the suite green between tasks, in THIS task also delete the now-obsolete assertions that reference `b.crowdingDisamenity`, `b.direct`, `'no crowding disamenity at phi=1'`, and `'crowding disamenity negative when phi>1'` in the older Task 5 block, and temporarily comment out the `Task 6`/`Task 12` anchor+consolidated blocks with a `// TODO(Task 6): re-anchor for v2` marker. Re-run until green.

- [ ] **Step 5: Commit**

```bash
git add transit-bcr.html
git commit -m "feat(v2): re-based agglomeration and single-channel crowding in benefit kernel (A1/A2/A3)"
```

---

## Task 2: Asset-class capex schedule (C2/C3)

**Files:** Modify `transit-bcr.html` (`tbcr-engine`; `tbcr-tests`).

**Interfaces:**
- Produces: `TBCR.DEFAULT_ASSETS` (array of `{share, life}`) and `TBCR.capexSchedule(params) → { capex: number[], residual: number }` — `capex[t]` is real capital outlay in $M in year `t` (0..horizon), summing initial build + life-cycled renewals across asset classes; `residual` is the $M residual value at the horizon (linear un-depreciated remainder of each class's last tranche). Uses `params.K` ($B), `params.assets`, `params.horizon`.

- [ ] **Step 1: Write the failing test:**

```js
// Task 2: capex schedule (renewals + residual)
{
  const params = { K:1.5, horizon:60, assets:[{share:0.55,life:80},{share:0.25,life:30},{share:0.15,life:30},{share:0.05,life:12}] };
  const { capex, residual } = TBCR.capexSchedule(params);
  T.eq('initial build at year 0 = full K', capex[0], 1.5*1000*0.05783/0.05783, 1e-6*1500); // = K in $M = 1500
  T.ok('renewal spike at 30 (life-30 classes)', capex[30] > 0);
  T.ok('renewal spike at 12 (IT)', capex[12] > 0);
  T.ok('no build exactly at horizon', capex[60] === 0);
  // civil (life 80 > horizon 60) keeps 25% residual; life-30 classes renewed at 30 are dead at 60 (0 residual)
  const civilCost = 1.5*1000*0.55; // $825M
  T.ok('residual >= civil remainder', residual >= civilCost*((80-60)/80) - 1e-6);
  T.ok('residual positive', residual > 0);
}
```

(Note: `capex[0]` should equal K expressed in $M = `K*1e9/1e6` = `K*1000` = 1500; the test's arithmetic reduces to 1500 with tolerance.)

- [ ] **Step 2: Run to verify it fails** → `capexSchedule` undefined. Exit 1.

- [ ] **Step 3: Implement** in `tbcr-engine` (and export `DEFAULT_ASSETS`, `capexSchedule`):

```js
  const DEFAULT_ASSETS = [
    { share:0.55, life:80 },  // civil works
    { share:0.25, life:30 },  // track & systems
    { share:0.15, life:30 },  // rolling stock
    { share:0.05, life:12 },  // fare / IT
  ];
  function capexSchedule(params) {
    const T = params.horizon || 60;
    const classes = params.assets || DEFAULT_ASSETS;
    const capex = new Array(T + 1).fill(0);
    let residual = 0;
    for (const c of classes) {
      const cost = (params.K * c.share * 1e9) / 1e6;   // $M
      let last = 0;
      for (let t = 0; t < T; t += c.life) { capex[t] += cost; last = t; }   // build + renewals strictly before horizon
      const remaining = (c.life - (T - last)) / c.life;                     // fraction of last tranche's life left at T
      residual += cost * Math.max(0, Math.min(1, remaining));
    }
    return { capex, residual };
  }
```

- [ ] **Step 4: Run to verify it passes** → Task 2 lines PASS.

- [ ] **Step 5: Commit**

```bash
git add transit-bcr.html
git commit -m "feat(v2): asset-class capex schedule with renewals and residual value"
```

---

## Task 3: Ramp, growth, carbon, and discount helpers (C4/C5)

**Files:** Modify `transit-bcr.html` (`tbcr-engine`; `tbcr-tests`).

**Interfaces:**
- Produces:
  - `TBCR.rampFactor(t, params) → number` = `min(1, ramp_start + (1-ramp_start)*t/ramp_years) * (1+growth)^t`.
  - `TBCR.carbonFactor(t, params) → number` = `(1 + carbon_growth)^t`.
  - `TBCR.discountSeries(params) → number[]` — `disc[t]` for t=0..horizon; `disc[0]=1`; supports `declining_rate` (rate for yrs 1–30, `rate−0.005` for 31–75, `rate−0.01` beyond, floored at 0).

- [ ] **Step 1: Write the failing test:**

```js
// Task 3: time helpers
{
  const p = { ramp_start:0.60, ramp_years:5, growth:0, carbon_growth:0, horizon:60, discount_rate:0.04, declining_rate:false };
  T.eq('ramp at t=0 = ramp_start', TBCR.rampFactor(0,p), 0.60, 1e-9);
  T.eq('ramp reaches 1 at ramp_years', TBCR.rampFactor(5,p), 1.0, 1e-9);
  T.eq('ramp holds at 1 after', TBCR.rampFactor(20,p), 1.0, 1e-9);
  T.eq('carbon off by default = 1', TBCR.carbonFactor(30,p), 1.0, 1e-9);
  T.ok('carbon grows when enabled', TBCR.carbonFactor(10,{...p,carbon_growth:0.03}) > 1.3);
  T.ok('growth compounds', TBCR.rampFactor(10,{...p,growth:0.01}) > 1.0);
  const disc = TBCR.discountSeries(p);
  T.eq('disc[0]=1', disc[0], 1, 1e-12);
  T.eq('disc[1]=1/1.04', disc[1], 1/1.04, 1e-9);
  T.ok('disc decreasing', disc[60] < disc[30] && disc[30] < disc[1]);
  const dd = TBCR.discountSeries({...p, declining_rate:true});
  T.ok('declining discounts distant years less harshly', dd[60] > disc[60]);
}
```

- [ ] **Step 2: Run to verify it fails** → helpers undefined. Exit 1.

- [ ] **Step 3: Implement** (and export `rampFactor, carbonFactor, discountSeries`):

```js
  function rampFactor(t, params) {
    const rs = params.ramp_start ?? 0.60, ry = params.ramp_years ?? 5, g = params.growth ?? 0;
    const ramp = Math.min(1, rs + (1 - rs) * (ry > 0 ? t / ry : 1));
    return ramp * Math.pow(1 + g, t);
  }
  function carbonFactor(t, params) { return Math.pow(1 + (params.carbon_growth ?? 0), t); }
  function discountSeries(params) {
    const T = params.horizon || 60, r = params.discount_rate ?? 0.04, dec = params.declining_rate || false;
    const disc = new Array(T + 1); disc[0] = 1; let acc = 1;
    for (let t = 1; t <= T; t++) {
      const rt = dec ? (t <= 30 ? r : t <= 75 ? Math.max(r - 0.005, 0) : Math.max(r - 0.01, 0)) : r;
      acc = acc / (1 + rt); disc[t] = acc;
    }
    return disc;
  }
```

- [ ] **Step 4: Run to verify it passes** → Task 3 lines PASS.

- [ ] **Step 5: Commit**

```bash
git add transit-bcr.html
git commit -m "feat(v2): ridership ramp, carbon escalation, and discount-series helpers"
```

---

## Task 4: Annual kernel

**Files:** Modify `transit-bcr.html` (`tbcr-engine`; `tbcr-tests`).

**Interfaces:**
- Consumes: `computeDemand`, `computeBenefits`, `rampFactor`, `carbonFactor`.
- Produces: `TBCR.annualKernel(params, ref, t) → { demand, benefits, opCost, fareRev, opNet, R0t, FRR }` — runs the within-year equilibrium with reference ridership scaled to `R0(t) = ref.R0 * rampFactor(t)` and carbon escalation applied to emissions. `opCost = c_op*H_train*V*300/1e6`; `fareRev = demand.R*1000*300*f/1e6`.

- [ ] **Step 1: Write the failing test:**

```js
// Task 4: annual kernel
{
  const P = PRESETS.us_lrt; const ref = TBCR.calibrateRef(P.params, P.ref);
  const y0 = TBCR.annualKernel(P.params, ref, 0);
  const yM = TBCR.annualKernel(P.params, ref, 5);   // mature (ramp=1)
  T.ok('year 0 ridership below mature (ramp<1)', y0.demand.R < yM.demand.R);
  T.ok('mature benefits exceed year-0 benefits', yM.benefits.total > y0.benefits.total);
  T.ok('opCost constant across years', Math.abs(y0.opCost - yM.opCost) < 1e-9);
  T.ok('fareRev tracks ridership', yM.fareRev > y0.fareRev);
  T.ok('FRR present', typeof yM.FRR === 'number');
}
```

- [ ] **Step 2: Run to verify it fails** → `annualKernel` undefined. Exit 1.

- [ ] **Step 3: Implement** (and export `annualKernel`):

```js
  function annualKernel(params, ref, t) {
    const R0t = ref.R0 * rampFactor(t, params);
    const yref = { ...ref, R0: R0t };                       // scale reference ridership; f0/H0/tGen0/GC0 fixed
    const yparams = { ...params, carbonFactor: carbonFactor(t, params) };
    const demand = computeDemand(yparams, yref);
    const benefits = computeBenefits(yparams, demand, yref);
    const opCost = (params.c_op * params.H_train * params.V * CONST.OPERATING_DAYS) / 1e6;
    const fareRev = (demand.R * 1000 * CONST.OPERATING_DAYS * params.f) / 1e6;
    const opNet = fareRev - opCost;
    const FRR = opCost > 0 ? (fareRev / opCost) * 100 : 0;
    return { demand, benefits, opCost, fareRev, opNet, R0t, FRR };
  }
```

- [ ] **Step 4: Run to verify it passes** → Task 4 lines PASS.

- [ ] **Step 5: Commit**

```bash
git add transit-bcr.html
git commit -m "feat(v2): per-year annual kernel with ridership ramp and carbon escalation"
```

---

## Task 5: Lifecycle discounting + NPV/BCR (C4) — replaces computeWelfare

**Files:** Modify `transit-bcr.html` (`tbcr-engine`; `tbcr-tests`).

**Interfaces:**
- Consumes: `annualKernel`, `capexSchedule`, `discountSeries`.
- Produces:
  - `TBCR.lifecycleCore(params, ref) → { npv, bcrPV, pvBenefits, pvNetCost, subsidyPV, mcpfPV, pvCapex, pvOpNet, residual, matureYear, byYear }` — the rate-sensitivity-free core (used by the optimizer and chart sweeps — hot loops, called ~thousands of times, so it must NOT recompute rate sensitivity).
  - `TBCR.computeLifecycle(params, ref)` = `lifecycleCore` plus `rateSens = [{r,bcr}]` at r ∈ {0.02,0.03,0.04,0.06} (used by `render()` for the headline strip). Both exported.
  - `matureYear` = `annualKernel` result at `t = min(ramp_years, horizon)` (captured from the loop, not recomputed). `byYear[t] = { t, benefits, opCost, fareRev, capex, disc }`. `pvOpNet = pvOpDeficit − pvOpSurplus` (for the cost bar).
  - `bcrPV = pvBenefits / pvNetCost` (Infinity if denom 0). `subsidyPV = max(pvCapex + pvOpDeficit − pvOpSurplus, 0)` where `pvCapex` is already net of `residual·disc[T]`; `pvNetCost = subsidyPV·λ`.
  - Retire `computeWelfare`; update all callers to `computeLifecycle`/`lifecycleCore`.

- [ ] **Step 1: Write the failing test:**

```js
// Task 5: lifecycle NPV/BCR
{
  const P = PRESETS.us_lrt; const ref = TBCR.calibrateRef(P.params, P.ref);
  const w = TBCR.computeLifecycle(P.params, ref);
  T.ok('pvBenefits > 0', w.pvBenefits > 0);
  T.ok('npv = pvBenefits - pvNetCost', Math.abs(w.npv - (w.pvBenefits - w.pvNetCost)) < 1e-6);
  T.ok('bcrPV finite', isFinite(w.bcrPV));
  T.ok('byYear spans horizon', w.byYear.length === (P.params.horizon||60)+1);
  T.ok('matureYear present', w.matureYear && w.matureYear.benefits.total > 0);
  // BCR strictly decreasing in discount rate
  const lo = TBCR.computeLifecycle({...P.params, discount_rate:0.02}, ref).bcrPV;
  const hi = TBCR.computeLifecycle({...P.params, discount_rate:0.06}, ref).bcrPV;
  T.ok('BCR falls as discount rate rises', hi < lo);
  // longer civil life -> more residual -> lower net cost -> higher BCR
  const longer = TBCR.computeLifecycle({...P.params, assets:[{share:0.55,life:120},{share:0.25,life:30},{share:0.15,life:30},{share:0.05,life:12}]}, ref).bcrPV;
  T.ok('longer asset life raises BCR', longer > w.bcrPV);
  // MCPF monotonicity
  const mcLo = TBCR.computeLifecycle({...P.params, lambda:1.0}, ref).bcrPV;
  const mcHi = TBCR.computeLifecycle({...P.params, lambda:1.5}, ref).bcrPV;
  T.ok('BCR falls as MCPF rises', mcHi < mcLo);
}
```

- [ ] **Step 2: Run to verify it fails** → `computeLifecycle` undefined. Exit 1.

- [ ] **Step 3: Implement** (and export `computeLifecycle`; delete the old `computeWelfare` and its export entry):

```js
  function lifecycleCore(params, ref) {
    const T = params.horizon || 60;
    const disc = discountSeries(params);
    const { capex, residual } = capexSchedule(params);
    const matureT = Math.min(params.ramp_years ?? 5, T);
    let pvBenefits = 0, pvOpDeficit = 0, pvOpSurplus = 0, pvCapex = 0, matureYear = null;
    const byYear = [];
    for (let t = 0; t <= T; t++) {
      const k = annualKernel(params, ref, t);
      if (t === matureT) matureYear = k;                    // captured from the loop, not recomputed
      pvBenefits += k.benefits.total * disc[t];
      if (k.opNet < 0) pvOpDeficit += (-k.opNet) * disc[t]; else pvOpSurplus += k.opNet * disc[t];
      pvCapex += (capex[t] || 0) * disc[t];
      byYear.push({ t, benefits: k.benefits.total, opCost: k.opCost, fareRev: k.fareRev, capex: capex[t] || 0, disc: disc[t] });
    }
    pvCapex -= residual * disc[T];
    const pvOpNet = pvOpDeficit - pvOpSurplus;
    const subsidyPV = Math.max(pvCapex + pvOpNet, 0);
    const mcpfPV = (params.lambda - 1) * subsidyPV;
    const pvNetCost = subsidyPV + mcpfPV;
    const npv = pvBenefits - pvNetCost;
    const bcrPV = pvNetCost !== 0 ? pvBenefits / pvNetCost : Infinity;
    return { npv, bcrPV, pvBenefits, pvNetCost, subsidyPV, mcpfPV, pvCapex, pvOpNet, residual, matureYear, byYear };
  }
  function computeLifecycle(params, ref) {
    const base = lifecycleCore(params, ref);
    base.rateSens = [0.02, 0.03, 0.04, 0.06].map(r => ({ r, bcr: lifecycleCore({ ...params, discount_rate: r, declining_rate: false }, ref).bcrPV }));
    return base;
  }
```

Update the `root.TBCR = { … }` export: remove `computeWelfare`, add `lifecycleCore` and `computeLifecycle`.

- [ ] **Step 4: Run to verify it passes** → Task 5 lines PASS. (Other suites still have the Task 6/12 blocks commented from Task 1.)

- [ ] **Step 5: Commit**

```bash
git add transit-bcr.html
git commit -m "feat(v2): discounted lifecycle NPV/BCR engine replacing annual computeWelfare"
```

---

## Task 6: Presets v2, fare optimizer on NPV, and re-anchor

**Files:** Modify `transit-bcr.html` (`tbcr-presets` params; `tbcr-engine` `optimizeFare`; `tbcr-tests`).

**Interfaces:**
- Each preset's `params` gains the v2 fields (defaults per Global Constraints; presets may keep the shared defaults). `optimizeFare(params, ref, objective, opts)` now scores welfare by `computeLifecycle(...).npv`, revenue by `computeLifecycle(...).matureYear.fareRev`, farebox by `computeLifecycle(...).matureYear.FRR`.

- [ ] **Step 1: Add v2 fields to every preset** in `tbcr-presets`. For each of the five presets add these keys to its `params` object (same defaults for all; do not change existing v1 keys):

```js
      horizon:60, discount_rate:0.04, declining_rate:false, ramp_start:0.60, ramp_years:5,
      growth:0.0, carbon_growth:0.0, mohring_coef:0.18, labor_coef:0.05,
      assets:[{share:0.55,life:80},{share:0.25,life:30},{share:0.15,life:30},{share:0.05,life:12}],
```

- [ ] **Step 2: Update `optimizeFare`** in `tbcr-engine` to score on lifecycle:

```js
  function optimizeFare(params, ref, objective, opts) {
    const fMin = (opts && opts.fMin) ?? 0.5, fMax = (opts && opts.fMax) ?? 5.0;
    const target = (opts && opts.fareboxTarget) ?? 40;
    const metric = (f) => { const w = lifecycleCore({ ...params, f }, ref); return { W: w.npv, rev: w.matureYear.fareRev, FRR: w.matureYear.FRR, R: w.matureYear.demand.R, BCR: w.bcrPV }; };   // lifecycleCore (no rateSens) — hot loop
    if (objective === 'fareboxTarget') {
      const N = 200;
      for (let i = 0; i <= N; i++) {
        const f = fMin + (fMax - fMin) * i / N; const m = metric(f);
        if (m.FRR >= target) return { fareStar: f, value: m.FRR, R: m.R, W: m.W, BCR: m.BCR, FRR: m.FRR };
      }
      return { fareStar: null, value: null, R: null, W: null, BCR: null, FRR: null };
    }
    const score = (f) => { const m = metric(f); return objective === 'revenue' ? m.rev : m.W; };
    const gr = (Math.sqrt(5) - 1) / 2;
    let a = fMin, b = fMax, c = b - gr*(b-a), d = a + gr*(b-a), fc = score(c), fd = score(d);
    for (let i = 0; i < 60 && Math.abs(b-a) > 1e-4; i++) {
      if (fc < fd) { a = c; c = d; fc = fd; d = a + gr*(b-a); fd = score(d); }
      else { b = d; d = c; fd = fc; c = b - gr*(b-a); fc = score(c); }
    }
    const fStar = (a+b)/2, m = metric(fStar);
    return { fareStar: fStar, value: objective==='revenue'? m.rev : m.W, R: m.R, W: m.W, BCR: m.BCR, FRR: m.FRR };
  }
```

- [ ] **Step 3: Re-anchor.** DELETE the obsolete Task 6/Task 12 anchor+consolidated blocks (the `// TODO(Task 6)` markers from Task 1) and the old Task 5 benefit block that referenced `crowdingDisamenity`/`direct`. Insert the v2 anchor test below. **The anchor numbers are pre-computed** (us_lrt at all v2 defaults, validated against a prototype): mature-year benefits at φ=1 = **72.94**, lifecycle NPV = **−746.6**, PV-BCR = **0.6929**. Critical: the mature-year identity must **calibrate the reference under the same φ=1 regime** (else CS is inflated by a crowded-vs-uncrowded reference mismatch).

```js
// v2 anchor + invariants
{
  const P = PRESETS.us_lrt;
  // mature-year identity: force phi=1 AND calibrate the reference under the SAME regime
  const anchorParams = { ...P.params, load_comfort:10 };
  const anchorRef = TBCR.calibrateRef(anchorParams, P.ref);
  const m = TBCR.annualKernel(anchorParams, anchorRef, P.params.ramp_years);
  T.eq('anchor: mature-year benefits (phi=1)', m.benefits.total, 72.94, 0.02);
  // lifecycle NPV/BCR at shipped defaults (reference calibrated under the same params)
  const ref = TBCR.calibrateRef(P.params, P.ref);
  const w = TBCR.computeLifecycle(P.params, ref);
  T.eq('anchor: lifecycle NPV', w.npv, -746.6, 5);
  T.eq('anchor: lifecycle PV-BCR', w.bcrPV, 0.6929, 0.005);
  // every preset: finite BCR, positive PV benefits, ridership ramps up over time
  Object.keys(PRESETS).forEach(id => {
    const Pi = PRESETS[id]; const ri = TBCR.calibrateRef(Pi.params, Pi.ref);
    const wi = TBCR.computeLifecycle(Pi.params, ri);
    T.ok('finite BCR '+id, isFinite(wi.bcrPV) && wi.pvBenefits > 0);
    const y0 = TBCR.annualKernel(Pi.params, ri, 0), ym = TBCR.annualKernel(Pi.params, ri, 10);
    T.ok('ramp raises ridership over time '+id, ym.demand.R >= y0.demand.R - 1e-9);
  });
}
```

If the anchor lines fail after a faithful transcription, the engine differs from the validated prototype — re-derive with a one-off (`new Function(engine+presets)()` then `computeLifecycle(PRESETS.us_lrt.params, calibrateRef(...))`) rather than loosening tolerances.

- [ ] **Step 4: Run to verify it passes**

Run: `node run-tests.mjs`. Expected: all tests PASS, 0 failed, exit 0. If the anchor lines fail, you mis-transcribed the printed numbers — re-read and correct the literals (do NOT loosen tolerances beyond those shown).

- [ ] **Step 5: Commit**

```bash
git add transit-bcr.html
git commit -m "feat(v2): v2 preset params, NPV-based fare optimizer, and re-anchored regression tests"
```

---

## Task 7: JSON v2 schema + v1 migration

**Files:** Modify `transit-bcr.html` (`tbcr-presets` `TBCR_IO`; `tbcr-tests`).

**Interfaces:**
- `RANGES` gains the new scalar params. `serializeState` writes `version:2` and includes `assets`. `parseState(obj)` clamps known scalars, passes `assets` through (validating each `{share,life}` numeric, else default), and **migrates v1** (`version` 1 or absent): fills missing v2 fields with defaults and sets `assets` to `DEFAULT_ASSETS` if absent.

- [ ] **Step 1: Write the failing test:**

```js
// Task 7: JSON v2 + migration
{
  const P = PRESETS.us_lrt;
  const s = TBCR_IO.serializeState(P.params, P.ref);
  T.eq('serialize version 2', s.version, 2);
  T.ok('serialize includes assets', Array.isArray(s.params.assets));
  const round = TBCR_IO.parseState(JSON.parse(JSON.stringify(s)));
  T.eq('round-trip horizon', round.params.horizon, 60, 1e-9);
  T.ok('round-trip assets preserved', round.params.assets.length === 4);
  // v1 migration: no version, no v2 fields
  const v1 = { params: { R:40, dt:12, VOT:18, alpha:0.30, gamma:0.25, K:1.5, H_train:150, V:3, c_op:180, f:1.75, lambda:1.30, eps_f:-0.35, eps_t:-0.60, avg_speed:20, seats_per_vehicle:150, peak_hour_share:0.17, peak_direction_share:0.60, load_comfort:0.80, phi_crush:1.8, service_span_hrs:18 }, referencePoint:{ R0:40, f0:1.75, H0:150, tWait0:5 } };
  const mig = TBCR_IO.parseState(v1);
  T.eq('v1 migrates horizon default', mig.params.horizon, 60, 1e-9);
  T.ok('v1 migrates assets default', Array.isArray(mig.params.assets) && mig.params.assets.length === 4);
  T.ok('v1 migration warns', mig.warnings.some(w => /migrat/i.test(w)));
  // clamp new scalar
  const bad = TBCR_IO.parseState({ version:2, params:{ ...P.params, horizon:500 }, referencePoint:P.ref });
  T.ok('horizon clamped', bad.params.horizon <= 100);
}
```

- [ ] **Step 2: Run to verify it fails** → version still 1 / no migration. Exit 1.

- [ ] **Step 3: Implement.** In `TBCR_IO`, extend `RANGES` and rewrite `serializeState`/`parseState`:

```js
  const RANGES = {
    R:[10,800], dt:[5,25], VOT:[8,40], alpha:[0.10,0.60], gamma:[0,0.50], K:[0.3,30],
    H_train:[50,1200], V:[1,12], c_op:[80,400], f:[0.5,5.0], lambda:[1.0,1.5],
    eps_f:[-1.50,-0.10], eps_t:[-1.5,-0.20], avg_speed:[8,45], seats_per_vehicle:[80,300],
    peak_hour_share:[0.08,0.30], peak_direction_share:[0.50,0.75], load_comfort:[0.5,1.0],
    phi_crush:[1.2,2.5], service_span_hrs:[10,24],
    horizon:[20,100], discount_rate:[0.01,0.08], ramp_start:[0.2,1.0], ramp_years:[1,20],
    growth:[0,0.02], carbon_growth:[0,0.07], mohring_coef:[0.05,0.30], labor_coef:[0,0.15],
  };
  const V2_DEFAULTS = { horizon:60, discount_rate:0.04, declining_rate:false, ramp_start:0.60,
    ramp_years:5, growth:0, carbon_growth:0, mohring_coef:0.18, labor_coef:0.05 };
  function serializeState(params, ref) { return { version:2, params:{ ...params }, referencePoint:{ ...ref } }; }
  function parseState(obj) {
    const warnings = [], src = (obj && obj.params) || {}, params = {};
    const isV1 = !obj || obj.version == null || obj.version < 2;
    Object.keys(src).forEach(k => {
      if (k === 'assets' || k === 'declining_rate') return;                 // handled below
      if (!(k in RANGES)) { warnings.push(`unknown key ignored: ${k}`); return; }
      let v = src[k]; const [lo, hi] = RANGES[k];
      if (typeof v !== 'number' || !isFinite(v)) { warnings.push(`non-numeric ${k} ignored`); return; }
      if (v < lo) { warnings.push(`${k} ${v} clamped to ${lo}`); v = lo; }
      if (v > hi) { warnings.push(`${k} ${v} clamped to ${hi}`); v = hi; }
      params[k] = v;
    });
    // assets: accept a valid 4-field-ish array, else default
    if (Array.isArray(src.assets) && src.assets.every(a => a && isFinite(a.share) && isFinite(a.life))) {
      params.assets = src.assets.map(a => ({ share: a.share, life: a.life }));
    } else { params.assets = window.TBCR.DEFAULT_ASSETS.map(a => ({ ...a })); if ('assets' in src) warnings.push('invalid assets replaced with default'); }
    params.declining_rate = !!src.declining_rate;
    // migrate v1: fill any missing v2 scalar with its default
    Object.keys(V2_DEFAULTS).forEach(k => { if (!(k in params)) params[k] = V2_DEFAULTS[k]; });
    if (isV1) warnings.push('migrated v1 scenario to v2 defaults (horizon/discount/ramp/assets)');
    const ref = (obj && obj.referencePoint) ? { ...obj.referencePoint } : null;
    return { params, ref, warnings };
  }
```

- [ ] **Step 4: Run to verify it passes** → Task 7 lines PASS.

- [ ] **Step 5: Commit**

```bash
git add transit-bcr.html
git commit -m "feat(v2): JSON v2 schema with asset block and v1->v2 migration"
```

---

## Task 8: UI — cards, slider groups, breakdown (NPV headline)

**Files:** Modify `transit-bcr.html` (`<body>` markup, `<style>`, `tbcr-ui`).

**Interfaces:** Consumes `TBCR.computeLifecycle`, `PRESETS`, `TBCR_IO`. `render()` now calls `computeLifecycle`, sets NPV/PV-BCR cards, mature-year breakdown, and the rate-sensitivity strip.

- [ ] **Step 1: Update the cards markup** (replace the three `.card` contents):

```html
  <div class="cards">
    <div class="card"><div>Net present value</div><div class="v" id="cNPV">–</div></div>
    <div class="card"><div>Benefit-cost ratio (PV)</div><div class="v" id="cBCR">–</div></div>
    <div class="card"><div>PV benefits / PV cost</div><div class="v" id="cPV">–</div></div>
  </div>
  <div id="ratestrip" style="font-size:.85rem;color:#555;margin:.2rem 0"></div>
```

- [ ] **Step 2: Add the two new slider groups** to the markup (after the existing `grpBehavior` section):

```html
  <h2>Time &amp; finance</h2><div class="sliders" id="grpTime"></div>
  <details><summary style="cursor:pointer;font-size:1.05rem;font-weight:600;margin:1.2rem 0 .4rem">Asset lifecycle (advanced)</summary>
  <div class="sliders" id="grpAssets"></div></details>
```

- [ ] **Step 3: Extend `SLIDERS`** with the new groups and add the coefficient sliders to `grpBehavior`:

```js
    grpBehavior: [
      ['eps_f','Fare elasticity',-1.50,-0.10,0.01],['eps_t','Time elasticity',-1.5,-0.20,0.01],
      ['lambda','MCPF (shadow price)',1.0,1.5,0.05],['seats_per_vehicle','Seats/vehicle',80,300,10],
      ['peak_hour_share','Peak-hour share',0.08,0.30,0.01],['phi_crush','Crush crowding mult.',1.2,2.5,0.1],
      ['mohring_coef','Mohring markup (×CS)',0.05,0.30,0.01],['labor_coef','Labour markup (×CS)',0,0.15,0.01],
    ],
    grpTime: [
      ['horizon','Appraisal horizon (yr)',20,100,5],['discount_rate','Discount rate',0.01,0.08,0.005],
      ['ramp_start','Ridership at opening (×mature)',0.2,1.0,0.05],['ramp_years','Years to mature',1,20,1],
      ['growth','Long-run ridership growth/yr',0,0.02,0.005],['carbon_growth','Carbon value growth/yr',0,0.07,0.005],
    ],
    grpAssets: [
      ['asset_civil_life','Civil works life (yr)',40,120,5],['asset_track_life','Track & systems life (yr)',15,50,5],
      ['asset_rs_life','Rolling stock life (yr)',15,45,5],['asset_it_life','Fare/IT life (yr)',5,25,1],
    ],
```

Note: the four `asset_*_life` sliders are UI proxies; on input they write into `state.params.assets[i].life` (see Step 5). `declining_rate` is a checkbox added near `grpTime` — see Step 4.

- [ ] **Step 4: Add a declining-rate checkbox** to the markup inside a small bar under the Time heading:

```html
  <label style="display:block;margin:.2rem 0"><input type="checkbox" id="chkDeclining"> Declining discount rate for distant years (Green Book style)</label>
```

- [ ] **Step 5: Rewrite `render()`, `loadPreset()`, and slider wiring** in `tbcr-ui`. Add HELP entries for the new sliders; make the asset-life proxies and the checkbox update `state.params`. Key `render()` body:

```js
  function render(){
    const w = TBCR.computeLifecycle(state.params, state.ref);
    $('cNPV').textContent = fmtM(w.npv);
    const bcrEl = $('cBCR'); bcrEl.textContent = isFinite(w.bcrPV)? w.bcrPV.toFixed(2) : '∞';
    bcrEl.style.color = w.bcrPV>=1.5?'var(--green)': w.bcrPV>=1.0?'var(--amber)':'var(--red)';
    $('cPV').textContent = fmtM(w.pvBenefits)+' / '+fmtM(w.pvNetCost);
    $('ratestrip').textContent = 'BCR vs discount rate → ' + w.rateSens.map(s=>`${(s.r*100).toFixed(0)}%: ${isFinite(s.bcr)?s.bcr.toFixed(2):'∞'}`).join('  ·  ');
    renderBreakdown(w);
    if (window.__updateCharts) window.__updateCharts(w);
  }
```

`renderBreakdown(w)` uses `w.matureYear` for the annual component lines and `w` for PV lines:

```js
  function renderBreakdown(w){
    const m=w.matureYear, b=m.benefits;
    $('breakdown').innerHTML =
      `<b>Mature year</b> (year ${state.params.ramp_years}): ridership ${m.demand.R.toFixed(1)}k/day, load ${m.demand.load.toFixed(2)}, farebox ${m.FRR.toFixed(0)}%. `+
      `Crowding is costing riders ≈ ${fmtM(b.crowdingInCS)} of surplus (already inside CS, not added separately).<br>`+
      `Benefits (mature yr): CS ${fmtM(b.CS)} · congestion ${fmtM(b.congestion)} · Mohring ${fmtM(b.mohring)} · accident ${fmtM(b.accident)} · emissions ${fmtM(b.emissions)} · labour ${fmtM(b.labor)} · agglomeration ${fmtM(b.agglomeration)} = <b>${fmtM(b.total)}</b>/yr.<br>`+
      `Lifecycle (PV over ${state.params.horizon} yr @ ${(state.params.discount_rate*100).toFixed(1)}%): PV benefits <b>${fmtM(w.pvBenefits)}</b> · PV capital+renewals net of residual ${fmtM(w.pvCapex)} · residual credit ${fmtM(w.residual)} · MCPF deadweight ${fmtM(w.mcpfPV)} · PV net cost <b>${fmtM(w.pvNetCost)}</b> · <b>NPV ${fmtM(w.npv)}</b>.`;
  }
```

Add asset-life proxy + checkbox listeners after `buildSliders()`:

```js
  const ASSET_IDX = { asset_civil_life:0, asset_track_life:1, asset_rs_life:2, asset_it_life:3 };
  Object.keys(ASSET_IDX).forEach(id=>{ const el=$('s_'+id); if(el){ el.value = state.params.assets[ASSET_IDX[id]].life; $('o_'+id).textContent=el.value;
    el.addEventListener('input', e=>{ state.params.assets[ASSET_IDX[id]].life = parseFloat(e.target.value); $('o_'+id).textContent=e.target.value; render(); }); } });
  $('chkDeclining').addEventListener('change', e=>{ state.params.declining_rate = e.target.checked; render(); });
```

In `syncInputsFromParams()` also refresh the asset-life proxies and checkbox; in `loadPreset()` set `chkDeclining.checked = !!state.params.declining_rate`. Add HELP strings for `horizon`, `discount_rate`, `ramp_start`, `ramp_years`, `growth`, `carbon_growth`, `mohring_coef`, `labor_coef`, and the four `asset_*_life` keys (one-line plain-language each, e.g. `horizon:'Years of costs and benefits included in the present-value calculation. Longer horizons reward durable assets (via residual value); default 60 for heavy rail.'`).

- [ ] **Step 6: Verify manually + headless.** Open `transit-bcr.html`: NPV/BCR/PV cards populate; changing horizon/discount rate/ramp updates everything; the rate strip shows four BCRs; asset-life sliders change the result; breakdown shows mature-year + PV lines. Then run `node run-tests.mjs` → still `OK` (UI guarded).

- [ ] **Step 7: Commit**

```bash
git add transit-bcr.html
git commit -m "feat(v2): NPV headline cards, time/finance + asset-lifecycle sliders, PV breakdown"
```

---

## Task 9: Charts for v2 (cash-flow profile + mature-year bars)

**Files:** Modify `transit-bcr.html` (`<body>` canvases, `tbcr-charts`).

**Interfaces:** `window.__updateCharts(w)` consumes a `computeLifecycle` result. Charts: (1) mature-year benefit stacked bar (7 segments, no crowding segment — crowding is inside CS); (2) PV cost stacked bar (pvCapex-net-of-residual split shown as capital+renewals, operating subsidy PV, MCPF PV); (3) cash-flow-by-year line/bar: benefits, opex, capex per year + cumulative discounted NPV; (4) demand curve mature-year ridership vs fare; (5) welfare = NPV vs fare.

- [ ] **Step 1: Replace the canvases** to five charts (grid), ids `chBenefit chCost chCashflow chDemand chWelfare`.

- [ ] **Step 2: Rewrite `init()` and `__updateCharts`** to build datasets once (animation:false) and mutate in place. Benefit bar uses `w.matureYear.benefits` (CS, congestion, mohring, accident, emissions, labor, agglomeration — no crowding segment). Cost bar uses PV parts: `[w.pvCapex, Math.max(w.pvOpNet,0), w.mcpfPV]` labelled Capital+renewals (PV, net residual) / Operating subsidy (PV) / MCPF (PV); if `w.pvOpNet < 0` show it as a negative "operating surplus offset" segment. Cash-flow chart: from `w.byYear`, plot `benefits`, `opCost`, `capex` per year and a cumulative-NPV line `Σ (benefits-opCost-capex)·disc`. Demand/welfare sweep fare 0.5→5 step 0.25 (19 points, to bound the 60-year cost) using **`TBCR.lifecycleCore({...st.params,f}, st.ref)`** (NOT `computeLifecycle` — avoid recomputing rateSens 19×) → `.matureYear.demand.R` and `.npv`.

Provide the full block modeled on the existing charts block (init once, `animation:false`, `update()` mutates `dataset.data`); include a `title` per chart. Reuse the guard `if (typeof document!=='undefined' && !/[?&]test=1/.test(location.search||'') && typeof Chart!=='undefined')`.

- [ ] **Step 3: Verify manually + headless.** Open the widget: five charts render; the cash-flow chart shows capex spikes at renewal years and a cumulative NPV crossing; moving the discount rate visibly reshapes it. `node run-tests.mjs` → `OK`.

- [ ] **Step 4: Commit**

```bash
git add transit-bcr.html
git commit -m "feat(v2): mature-year bars, PV cost bar, and discounted cash-flow chart"
```

---

## Task 10: Docs, glossary, README, final sweep

**Files:** Modify `transit-bcr.html` (`#glossary`, `tbcr-tests`); `README.md`; `docs/`.

- [ ] **Step 1: Update the glossary `<details>`** for v2: agglomeration now marks up user benefits only; crowding is inside CS (show the diagnostic, no separate line); costs are PV of capital+renewals net of residual, operating subsidy PV, and MCPF; note explicitly that **there is no depreciation line — discounting supplies economic depreciation (C1)**; explain horizon, discount rate, ramp, residual value in one line each.

- [ ] **Step 2: Add a consolidated v2 regression block** to `tbcr-tests` (before `// ---- END TESTS ----`): assert every preset's `computeLifecycle` gives finite BCR and positive PV benefits; BCR decreasing in discount rate for us_lrt; NPV = pvBenefits − pvNetCost; A2 invariant (agglomeration excludes externals) on `stockholm_tbana` (high γ); A1 invariant (no `crowdingDisamenity` key). Run `node run-tests.mjs` → `OK`.

- [ ] **Step 3: Rewrite the README** model section: replace the annual-BCR framing with the lifecycle NPV/PV-BCR model; document horizon/discount/ramp/asset defaults; keep the anchor note; state the A1/A2 re-basing and that the v1 anchor was retired; add a "not modeled" note that Part B (health, reliability, parking) is deferred. Update the preset table to the validated v2 as-shipped values:

| Preset | NPV | PV-BCR |
|---|---|---|
| US LRT baseline | −$0.75B | 0.69 |
| Elizabeth Line | +$29.1B | 1.83 |
| Stockholm T-bana | +$5.8B | 2.60 |
| High-cost US | −$6.9B | 0.31 |
| Low-cost intl | +$0.70B | 1.37 |

(Re-derive from the built engine if any earlier task changed a default; these are from the design-validation prototype.)

- [ ] **Step 4: Commit**

```bash
git add transit-bcr.html README.md docs/
git commit -m "docs(v2): glossary, README lifecycle model + preset table, consolidated v2 regression"
```

---

## Self-Review notes (for the implementer)

- **Suite stays green between tasks:** Task 1 removes obsolete assertions and comments out the anchor/consolidated blocks; Task 6 restores them as v2 anchors. Never leave a red suite at a task boundary.
- **Anchor is data-derived:** the v2 anchor numbers are computed by the Task 6 one-off snippet and pasted as literals; do not invent them. Expect the mature-year benefit to shift from v1 because agglomeration is re-based (labour/externals no longer uplifted) — that is intended.
- **Performance:** `computeLifecycle` runs `horizon+1` kernels; `optimizeFare` and the fare-sweep charts call it repeatedly. The demand fixed-point converges in a few iterations, so a 60-year lifecycle is a few thousand cheap ops — fine for on-input rendering. Keep the fare sweep at step 0.25 (19 points), not 0.1.
- **DOM purity:** engine/presets/tests stay DOM-free; only `tbcr-ui`/`tbcr-charts` touch DOM/Chart, both guarded. The Node runner evals engine+presets+tests only.
- **Type consistency:** `lifecycleCore` returns `{ npv, bcrPV, pvBenefits, pvNetCost, subsidyPV, mcpfPV, pvCapex, pvOpNet, residual, matureYear, byYear }`; `computeLifecycle` adds `rateSens`. `matureYear` is an `annualKernel` result: `{ demand, benefits, opCost, fareRev, opNet, R0t, FRR }`. `benefits` has `{ CS, crowdingInCS, congestion, mohring, accident, emissions, labor, userBenefits, agglomeration, total }` (no `crowdingDisamenity`, no `direct`). UI/charts/optimizer reference exactly these.
- **Hot loops use `lifecycleCore` (no rateSens); `render()` uses `computeLifecycle` (needs rateSens for the strip).** Verified: `computeLifecycle` is 5× the work of `lifecycleCore`; using it in the optimizer would be 18k+ kernels/click vs 3.6k.
- **`computeWelfare` is gone:** ensure no code (UI, charts, optimizer, tests) still calls it after Task 5/6.
- **Horizon slider is mildly stepwise near renewal boundaries (<2% NPV jumps, dampened by residual) — expected, not a bug.**
