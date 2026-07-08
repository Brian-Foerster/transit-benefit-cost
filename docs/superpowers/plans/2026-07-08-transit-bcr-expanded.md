# Expanded Transit Benefit-Cost Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single self-contained `transit-bcr.html` benefit-cost widget that makes transit ridership endogenous to fare and service, adds crowding / MCPF / fare-optimization economics, ships real-project presets, and supports JSON import/export — reproducing the original toy model's numbers at each preset's reference point.

**Architecture:** ONE distributable file, `transit-bcr.html`, containing four inline `<script>` blocks by `id`: `tbcr-engine` (pure math, no DOM), `tbcr-presets` (data + JSON I/O, no DOM), `tbcr-tests` (assertions), and `tbcr-ui` (DOM controller + Chart.js, browser-only). The pure engine is developed and tested first. A zero-dependency `run-tests.mjs` extracts the three DOM-free blocks and runs them under Node so tests are headless during TDD; the same tests render in-browser when the URL has `?test=1`.

**Tech Stack:** Vanilla HTML/CSS/JS, Chart.js 4.4.1 (CDN), Node (test runner only — no packages, no build step). ES2019+.

## Global Constraints

- **Single distributable widget file:** `transit-bcr.html` — all CSS/JS inline. No external deps except Chart.js 4.4.1 from CDN. Opens by double-click. `run-tests.mjs` and the docs are dev tooling, NOT part of the distributable artifact.
- No build step, no framework, no bundler, no npm packages. `run-tests.mjs` uses only Node built-ins.
- The engine (`TBCR.*`) and presets/IO (`PRESETS`, `TBCR_IO`) blocks MUST be DOM-free and pure: no `document`, no `window`-mutation beyond the single namespace assignment, deterministic for given input. Only the `tbcr-ui` block may touch the DOM or Chart.js.
- Tests must run headlessly via `node run-tests.mjs` (exit 0 = all pass, exit 1 = any fail) AND in-browser via `transit-bcr.html?test=1`.
- **Regression anchor (non-negotiable):** at each preset's reference point with MCPF `λ = 1` and crowding `φ = 1`, endogenous `R === R0`; the US-LRT baseline preset (with `φ = 1` forced via `load_comfort` override, per the spec's anchor definition) yields total benefits ≈ $127M and BCR ≈ 1.2 (tolerance ±1%).
- Fixed assumptions from the source model: trip length 8 mi, operating days/year 300, discount rate 4%, asset life 30 yr, congestion $0.20/auto-mi, accident $0.03/auto-mi, emissions $0.015/auto-mi.
- Elasticity defaults: `εf = −0.35`, `εt = −0.60`. MCPF `λ` default 1.30. Crowding: `seats_per_vehicle` 150, `peak_hour_share` 0.17, `peak_direction_share` 0.60, `load_comfort` 0.80, `φ_crush` 1.8 (reached at load 1.5). `avg_speed` 20 mph, `service_span_hrs` 18.
- Money reported in $millions/year. Ridership `R` in thousands of daily riders.

## File Structure

- `transit-bcr.html` — the widget. Inline blocks: `tbcr-engine`, `tbcr-presets`, `tbcr-tests`, `tbcr-ui`, plus `<style>` and DOM. One responsibility per block; engine/presets/tests are DOM-free.
- `run-tests.mjs` — Node test runner. Extracts the three DOM-free `<script>` blocks by id and executes them with `window=globalThis` and a `document` stub; exits non-zero on failure.
- `README.md` — what it is, how to open, how to run tests, JSON schema, preset citations.
- `docs/transit_benefit_cost_model.md` — original source model (already committed).
- `docs/specs/2026-07-07-transit-bcr-expanded-design.md` — the spec (already committed).

**Block-editing conventions (all engine/test tasks rely on these):**
- Engine functions are added inside the `tbcr-engine` IIFE, before the `root.TBCR = {…}` export line, and their names added to that export object.
- Presets/IO live in the `tbcr-presets` block (`window.PRESETS`, `window.TBCR_IO`).
- Test assertions are inserted immediately before the `// ---- END TESTS ----` marker in the `tbcr-tests` block.
- After every engine/test change, run `node run-tests.mjs` from the repo root.

---

## Task 1: Single-file skeleton, test harness, Node runner

**Files:**
- Create: `transit-bcr.html` (skeleton: head, body, `#out`, `tbcr-engine`, `tbcr-tests`)
- Create: `run-tests.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: global `TBCR` with `TBCR.CONST`; a `tbcr-tests` harness exposing `T.ok(name, cond)` and `T.eq(name, actual, expected, tol)` that renders to `#out` in the browser (when `?test=1`) and to `console` under Node, setting `globalThis.__TESTS_PASSED` / `__TESTS_FAILED`; `run-tests.mjs` exit code reflects failures.

- [ ] **Step 1: Write the failing test harness + skeleton**

Create `transit-bcr.html`:

```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Transit Benefit-Cost Model (Expanded)</title>
<style>
  :root { --green:#178a3a; --amber:#c98a00; --red:#c02626; }
  body{font:15px/1.5 system-ui,Segoe UI,Arial,sans-serif;max-width:1100px;margin:1rem auto;padding:0 1rem;color:#1a1a1a}
  #out{font:13px/1.45 monospace;white-space:pre-wrap;margin:1rem 0}
  #out .pass{color:var(--green)} #out .fail{color:var(--red);font-weight:700}
</style></head>
<body>
<div id="out"></div>

<script id="tbcr-engine">
(function (root) {
  const CONST = {
    TRIP_LENGTH_MI: 8, OPERATING_DAYS: 300, DISCOUNT_RATE: 0.04, ASSET_LIFE_YEARS: 30,
    CONGESTION_PER_MI: 0.20, ACCIDENT_PER_MI: 0.03, EMISSIONS_PER_MI: 0.015,
    MOHRING_FACTOR: 0.18, LABOR_FACTOR: 0.05,
  };
  root.TBCR = { CONST };
})(window);
</script>

<script id="tbcr-tests">
(function () {
  const RUN = (typeof location === 'undefined') || /[?&]test=1/.test(location.search);
  if (!RUN) return;
  const out = (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('out') : null;
  let passed = 0, failed = 0;
  function emit(ok, msg) {
    if (ok) passed++; else failed++;
    const text = (ok ? 'PASS ' : 'FAIL ') + msg;
    if (out) { const d = document.createElement('div'); d.className = ok ? 'pass' : 'fail'; d.textContent = text; out.appendChild(d); }
    else { console.log(text); }
  }
  const T = {
    ok(name, cond) { emit(!!cond, name); },
    eq(name, a, e, tol = 1e-9) { const ok = Math.abs(a - e) <= tol * (Math.abs(e) || 1) + tol; emit(ok, ok ? name : `${name}: got ${a}, want ${e}`); },
  };
  // ---- TESTS ----
  T.ok('engine loaded', typeof TBCR === 'object');
  T.eq('operating days const', TBCR.CONST.OPERATING_DAYS, 300);
  // ---- END TESTS ----
  globalThis.__TESTS_PASSED = passed; globalThis.__TESTS_FAILED = failed;
  const summary = `${passed} passed, ${failed} failed`;
  if (out) { const d = document.createElement('div'); d.className = failed ? 'fail' : 'pass'; d.textContent = summary; out.appendChild(d); }
  else { console.log(summary); }
})();
</script>
</body></html>
```

Create `run-tests.mjs`:

```js
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('./transit-bcr.html', import.meta.url), 'utf8');
function block(id) {
  const m = html.match(new RegExp('<script id="' + id + '"[^>]*>([\\s\\S]*?)<\\/script>'));
  if (!m) throw new Error('missing script block: ' + id);
  return m[1];
}
globalThis.window = globalThis;
globalThis.document = { getElementById: () => null, createElement: () => ({ style: {}, appendChild() {}, textContent: '', className: '' }) };
let presets = '';
try { presets = block('tbcr-presets'); } catch { /* added in Task 6 */ }
const code = block('tbcr-engine') + '\n' + presets + '\n' + block('tbcr-tests');
new Function(code)();
if (globalThis.__TESTS_FAILED > 0) { console.error('FAILED: ' + globalThis.__TESTS_FAILED); process.exit(1); }
console.log('OK (' + (globalThis.__TESTS_PASSED || 0) + ' passed)');
```

- [ ] **Step 2: Run to verify harness works**

Run: `node run-tests.mjs`
Expected: prints `PASS engine loaded`, `PASS operating days const`, `2 passed, 0 failed`, `OK (2 passed)`, exit 0.

- [ ] **Step 3: Confirm the failing-path works (sanity)**

Temporarily change the assert to `T.eq('operating days const', TBCR.CONST.OPERATING_DAYS, 999);`, run `node run-tests.mjs`, confirm it prints a `FAIL` line and exits 1, then revert to `300`.

- [ ] **Step 4: Verify in-browser mode**

Open `transit-bcr.html?test=1` in a browser. Expected: `#out` shows the two PASS lines and the summary. Opening without `?test=1` shows an empty page (no widget yet — added in Task 9).

- [ ] **Step 5: Commit**

```bash
git add transit-bcr.html run-tests.mjs
git commit -m "feat: single-file skeleton, dual-mode test harness, node runner"
```

---

## Task 2: Capital recovery + operating cost/revenue

**Files:**
- Modify: `transit-bcr.html` (`tbcr-engine` block, `tbcr-tests` block)

**Interfaces:**
- Consumes: `TBCR.CONST`.
- Produces:
  - `TBCR.crf(rate, years) → number`
  - `TBCR.computeCosts(params, demand) → { annualizedCapital, opCost, fareRev, opNet, surplusOffset, netCost, mcpfDeadweight, netCostWithMCPF, FRR }` — money $M/yr. `demand` is `{ R }` (thousands daily). `params` keys: `K` ($B), `H_train`, `V`, `c_op` ($), `f` ($), `lambda`.

- [ ] **Step 1: Write the failing test**

Insert before `// ---- END TESTS ----`:

```js
// Task 2: CRF and costs
T.eq('crf 4%/30yr', TBCR.crf(0.04, 30), 0.05783, 5e-4);
{
  const p = { K:1.5, H_train:150, V:3, c_op:180, f:1.75, lambda:1 };
  const c = TBCR.computeCosts(p, { R:40 });
  T.eq('annualized capital ~86.7M', c.annualizedCapital, 86.7, 0.02);
  T.eq('op cost 24.3M', c.opCost, 24.3, 0.02);        // 180*150*3*300 = 24.30M
  T.eq('fare rev 21.0M', c.fareRev, 21.0, 0.02);       // 40000*300*1.75 = 21.00M
  T.ok('operating deficit', c.opNet < 0);
  T.eq('net cost ~90.0M', c.netCost, 86.7+3.3, 0.03);  // capital + |opNet| (24.3-21.0=3.3)
  T.eq('mcpf off at lambda=1', c.mcpfDeadweight, 0, 1e-9);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node run-tests.mjs`
Expected: `FAIL crf 4%/30yr` (TBCR.crf undefined → throws or fails), exit 1.

- [ ] **Step 3: Write minimal implementation**

In `tbcr-engine`, add before `root.TBCR = …` and include in the export:

```js
  const MILLION = 1e6;
  function crf(rate, years) { const g = Math.pow(1 + rate, years); return (rate * g) / (g - 1); }
  function computeCosts(params, demand) {
    const { K, H_train, V, c_op, f, lambda } = params;
    const R = demand.R;
    const annualizedCapital = (K * 1e9 * crf(CONST.DISCOUNT_RATE, CONST.ASSET_LIFE_YEARS)) / MILLION;
    const opCost = (c_op * H_train * V * CONST.OPERATING_DAYS) / MILLION;
    const fareRev = (R * 1000 * CONST.OPERATING_DAYS * f) / MILLION;
    const opNet = fareRev - opCost;
    let surplusOffset = 0, netCost;
    if (opNet >= 0) { surplusOffset = Math.min(opNet, annualizedCapital); netCost = annualizedCapital - surplusOffset; }
    else { netCost = annualizedCapital + Math.abs(opNet); }
    const subsidy = Math.max(netCost, 0);
    const mcpfDeadweight = (lambda - 1) * subsidy;
    const netCostWithMCPF = netCost + mcpfDeadweight;
    const FRR = opCost > 0 ? (fareRev / opCost) * 100 : 0;
    return { annualizedCapital, opCost, fareRev, opNet, surplusOffset, netCost, mcpfDeadweight, netCostWithMCPF, FRR };
  }
```

Export line becomes: `root.TBCR = { CONST, crf, computeCosts };`

- [ ] **Step 4: Run test to verify it passes**

Run: `node run-tests.mjs`
Expected: all Task 2 lines PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add transit-bcr.html
git commit -m "feat: capital recovery factor and integrated cost calc"
```

---

## Task 3: Crowding model

**Files:**
- Modify: `transit-bcr.html` (`tbcr-engine`, `tbcr-tests`)

**Interfaces:**
- Consumes: `TBCR.CONST`.
- Produces:
  - `TBCR.loadFactor(params, R) → number` — peak load factor. `params` keys: `H_train`, `V`, `seats_per_vehicle`, `peak_hour_share`, `peak_direction_share`, `service_span_hrs` (default 18). Frequency_peak (trains/hr) = `H_train / service_span_hrs`.
  - `TBCR.phi(load, params) → number` — crowding multiplier ≥ 1. `params` keys: `load_comfort`, `phi_crush`. `φ=1` up to comfort, linear to `phi_crush` at load 1.5, capped.

- [ ] **Step 1: Write the failing test**

```js
// Task 3: crowding
{
  const p = { load_comfort:0.8, phi_crush:1.8 };
  T.eq('phi below comfort = 1', TBCR.phi(0.5, p), 1, 1e-9);
  T.eq('phi at comfort = 1', TBCR.phi(0.8, p), 1, 1e-9);
  T.eq('phi at crush(1.5) = phi_crush', TBCR.phi(1.5, p), 1.8, 1e-9);
  T.ok('phi monotonic', TBCR.phi(1.0,p) < TBCR.phi(1.2,p));
  T.ok('phi capped at crush', TBCR.phi(3.0,p) <= 1.8 + 1e-9);
  const pl = { H_train:150, V:3, seats_per_vehicle:150, peak_hour_share:0.17, peak_direction_share:0.60, service_span_hrs:18 };
  const lf = TBCR.loadFactor(pl, 40);
  T.ok('load factor positive', lf > 0);
  T.ok('load factor rises with ridership', TBCR.loadFactor(pl, 80) > lf);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node run-tests.mjs` → `FAIL phi below comfort = 1`, exit 1.

- [ ] **Step 3: Write minimal implementation**

Add to `tbcr-engine` (and export):

```js
  function phi(load, params) {
    const comfort = params.load_comfort, crush = params.phi_crush;
    if (load <= comfort) return 1;
    const slope = (crush - 1) / (1.5 - comfort);   // reach crush multiplier at load = 1.5
    return Math.min(1 + slope * (load - comfort), crush);
  }
  function loadFactor(params, R) {
    const span = params.service_span_hrs || 18;
    const freqPeak = params.H_train / span;                                   // trains/hr
    const capacityPeak = freqPeak * params.V * params.seats_per_vehicle;       // seats/hr
    const peakHourRiders = R * 1000 * params.peak_hour_share * params.peak_direction_share;
    return capacityPeak > 0 ? peakHourRiders / capacityPeak : 0;
  }
```

Add `phi, loadFactor` to the export object.

- [ ] **Step 4: Run test to verify it passes**

Run: `node run-tests.mjs` → all Task 3 lines PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add transit-bcr.html
git commit -m "feat: crowding multiplier and peak load factor"
```

---

## Task 4: Endogenous demand (generalized-cost pivot)

**Files:**
- Modify: `transit-bcr.html` (`tbcr-engine`, `tbcr-tests`)

**Interfaces:**
- Consumes: `TBCR.phi`, `TBCR.loadFactor`, `TBCR.CONST`.
- Produces:
  - `TBCR.computeDemand(params, ref) → { R, load, phi, tWait, tIvt, tGen, GC }`. `ref` is `{ R0, f0, H0, tWait0, tGen0 }`; when `tGen0 == null` the demand ratio self-references (ratio = 1) so the reference-calibration call is an identity. `params` keys: `f`, `H_train`, `VOT`, `eps_f`, `eps_t`, `avg_speed`, plus crowding keys. Iterates to a fixed point (φ depends on R which depends on φ), ≤ 30 iterations, damping 0.5.
  - `tIvt = TRIP_LENGTH_MI / avg_speed * 60`, `tWait = tWait0 * (H0 / H_train)`, `tGen = φ(load)·tIvt + tWait`, `GC = f + (VOT/60)·tGen`, `R = R0 · (f/f0)^eps_f · (tGen/tGen0)^eps_t`.

- [ ] **Step 1: Write the failing test**

```js
// Task 4: endogenous demand
{
  const base = { f:1.75, H_train:150, VOT:18, eps_f:-0.35, eps_t:-0.60, avg_speed:20,
                 seats_per_vehicle:150, peak_hour_share:0.17, peak_direction_share:0.60,
                 load_comfort:0.80, phi_crush:1.8, service_span_hrs:18 };
  const refCal = { R0:40, f0:1.75, H0:150, tWait0:5, tGen0:null };
  const cal = TBCR.computeDemand(base, refCal);
  const ref = { ...refCal, tGen0: cal.tGen };
  const atRef = TBCR.computeDemand(base, ref);
  T.eq('pivot identity: R==R0 at reference', atRef.R, 40, 1e-6);
  T.ok('higher fare lowers ridership', TBCR.computeDemand({...base, f:3.5}, ref).R < 40);
  T.ok('more train-hours raises ridership', TBCR.computeDemand({...base, H_train:300}, ref).R > 40);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node run-tests.mjs` → `FAIL pivot identity: R==R0 at reference`, exit 1.

- [ ] **Step 3: Write minimal implementation**

Add to `tbcr-engine` (and export):

```js
  function computeDemand(params, ref) {
    const tIvt = (CONST.TRIP_LENGTH_MI / params.avg_speed) * 60;
    const tWait = ref.tWait0 * (ref.H0 / params.H_train);
    let R = ref.R0, load = 0, ph = 1, tGen = tIvt + tWait;
    for (let i = 0; i < 30; i++) {
      load = loadFactor(params, R);
      ph = phi(load, params);
      tGen = ph * tIvt + tWait;
      const tGen0 = (ref.tGen0 == null) ? tGen : ref.tGen0;
      const Rnew = ref.R0 * Math.pow(params.f / ref.f0, params.eps_f) * Math.pow(tGen / tGen0, params.eps_t);
      const Rnext = 0.5 * R + 0.5 * Rnew;
      if (Math.abs(Rnext - R) < 1e-7) { R = Rnext; break; }
      R = Rnext;
    }
    load = loadFactor(params, R); ph = phi(load, params);
    tGen = ph * tIvt + tWait;
    const GC = params.f + (params.VOT / 60) * tGen;
    return { R, load, phi: ph, tWait, tIvt, tGen, GC };
  }
```

Add `computeDemand` to the export.

- [ ] **Step 4: Run test to verify it passes**

Run: `node run-tests.mjs` → all Task 4 lines PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add transit-bcr.html
git commit -m "feat: endogenous generalized-cost demand pivot with crowding fixed point"
```

---

## Task 5: Benefit components (revised CS + crowding disamenity)

**Files:**
- Modify: `transit-bcr.html` (`tbcr-engine`, `tbcr-tests`)

**Interfaces:**
- Consumes: `TBCR.CONST`.
- Produces:
  - `TBCR.computeBenefits(params, demand, ref) → { CS, congestion, mohring, accident, emissions, labor, crowdingDisamenity, direct, agglomeration, total }` — money $M/yr. `params` keys: `VOT`, `dt`, `alpha`, `gamma`. `ref` keys: `R0`, `GC0`. `demand` from Task 4.
  - `CS0 = R0*1000*OPERATING_DAYS*(dt/60)*VOT`; `CS = (CS0 − 0.5*(R0+R)*1000*OPERATING_DAYS*(GC − GC0))/1e6`.
  - `Tcar = R*1000*OPERATING_DAYS*alpha`; `congestion = Tcar*8*0.20/1e6`; `accident = Tcar*8*0.03/1e6`; `emissions = Tcar*8*0.015/1e6`.
  - `mohring = CS*MOHRING_FACTOR`; `labor = CS*LABOR_FACTOR`.
  - `crowdingDisamenity = −((VOT/60)*(phi−1)*tIvt*(R*1000*OPERATING_DAYS))/1e6` (≤ 0).
  - `direct = CS+congestion+mohring+accident+emissions+labor+crowdingDisamenity`; `agglomeration = direct*gamma`; `total = direct*(1+gamma)`.

- [ ] **Step 1: Write the failing test**

```js
// Task 5: benefits
{
  // load_comfort:10 forces phi=1 to isolate CS/agglomeration math from crowding.
  const base = { f:1.75, H_train:150, VOT:18, eps_f:-0.35, eps_t:-0.60, avg_speed:20,
                 seats_per_vehicle:150, peak_hour_share:0.17, peak_direction_share:0.60,
                 load_comfort:10, phi_crush:1.8, service_span_hrs:18,
                 dt:12, alpha:0.30, gamma:0.25 };
  const refCal = { R0:40, f0:1.75, H0:150, tWait0:5, tGen0:null };
  const cal = TBCR.computeDemand(base, refCal);
  const ref = { ...refCal, tGen0: cal.tGen, GC0: cal.GC };
  const d = TBCR.computeDemand(base, ref);
  const b = TBCR.computeBenefits(base, d, ref);
  // CS0 = 40k*300days*(12/60)h*$18 = $43.2M (matches original model)
  T.eq('CS baseline 43.2M', b.CS, 40*1000*300*(12/60)*18/1e6, 1e-6);
  T.eq('no crowding disamenity at phi=1', b.crowdingDisamenity, 0, 1e-9);
  T.ok('total > direct (agglomeration adds)', b.total > b.direct);
  T.eq('total = direct*(1+gamma)', b.total, b.direct*1.25, 1e-9);
  // crowding disamenity turns negative once load exceeds comfort
  const crowded = { ...base, load_comfort:0.80 };
  const refC = { ...refCal, tGen0: cal.tGen, GC0: cal.GC };
  const dC = TBCR.computeDemand(crowded, refC);
  const bC = TBCR.computeBenefits(crowded, dC, refC);
  T.ok('crowding disamenity negative when phi>1', dC.phi > 1 && bC.crowdingDisamenity < 0);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node run-tests.mjs` → `FAIL CS baseline 43.2M`, exit 1.

- [ ] **Step 3: Write minimal implementation**

Add to `tbcr-engine` (and export):

```js
  function computeBenefits(params, demand, ref) {
    const D = CONST.OPERATING_DAYS, R = demand.R;
    const CS0 = ref.R0 * 1000 * D * (params.dt / 60) * params.VOT;
    const CS = (CS0 - 0.5 * (ref.R0 + R) * 1000 * D * (demand.GC - ref.GC0)) / 1e6;
    const Tcar = R * 1000 * D * params.alpha;
    const congestion = (Tcar * CONST.TRIP_LENGTH_MI * CONST.CONGESTION_PER_MI) / 1e6;
    const accident   = (Tcar * CONST.TRIP_LENGTH_MI * CONST.ACCIDENT_PER_MI) / 1e6;
    const emissions  = (Tcar * CONST.TRIP_LENGTH_MI * CONST.EMISSIONS_PER_MI) / 1e6;
    const mohring = CS * CONST.MOHRING_FACTOR;
    const labor   = CS * CONST.LABOR_FACTOR;
    const crowdingDisamenity = -((params.VOT / 60) * (demand.phi - 1) * demand.tIvt * (R * 1000 * D)) / 1e6;
    const direct = CS + congestion + mohring + accident + emissions + labor + crowdingDisamenity;
    const agglomeration = direct * params.gamma;
    const total = direct * (1 + params.gamma);
    return { CS, congestion, mohring, accident, emissions, labor, crowdingDisamenity, direct, agglomeration, total };
  }
```

Add `computeBenefits` to the export.

- [ ] **Step 4: Run test to verify it passes**

Run: `node run-tests.mjs` → all Task 5 lines PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add transit-bcr.html
git commit -m "feat: benefit components with two-baseline consumer surplus and crowding disamenity"
```

---

## Task 6: Welfare compose + presets + regression anchor

**Files:**
- Modify: `transit-bcr.html` (create `tbcr-presets` block; extend `tbcr-engine`, `tbcr-tests`)

**Interfaces:**
- Consumes: all engine functions.
- Produces:
  - `TBCR.calibrateRef(params, refSeed) → ref` — runs `computeDemand` once with `tGen0:null` to fill `tGen0` and `GC0`.
  - `TBCR.computeWelfare(params, ref) → { demand, benefits, costs, B, netCostWithMCPF, W, BCR, FRR }`. `B = benefits.total`; `W = B − costs.netCostWithMCPF`; `BCR = B / costs.netCostWithMCPF` (Infinity if denom 0).
  - `window.PRESETS` — object keyed by id; each `{ label, citation, params, ref }` where `params` is the full flat param object and `ref` is `{ R0, f0, H0, tWait0 }`.

- [ ] **Step 1: Create the presets block**

Add a new `<script id="tbcr-presets">` block AFTER `tbcr-engine` and BEFORE `tbcr-tests` (so the Node runner and browser load order is engine → presets → tests):

```html
<script id="tbcr-presets">
window.PRESETS = {
  us_lrt: {
    label: 'US LRT baseline',
    citation: 'Source-doc defaults; US NTD medians. Benefits ~$127M, BCR ~1.2.',
    params: { R:40, dt:12, VOT:18, alpha:0.30, gamma:0.25, K:1.5,
      H_train:150, V:3, c_op:180, f:1.75, lambda:1.30,
      eps_f:-0.35, eps_t:-0.60, avg_speed:20, seats_per_vehicle:150,
      peak_hour_share:0.17, peak_direction_share:0.60, load_comfort:0.80,
      phi_crush:1.8, service_span_hrs:18 },
    ref: { R0:40, f0:1.75, H0:150, tWait0:5 },
  },
  elizabeth_line: {
    label: 'Elizabeth Line (London)',
    citation: 'Centre for Cities agglomeration 24%; congestion-priced city (lower congestion externality).',
    params: { R:60, dt:15, VOT:25, alpha:0.20, gamma:0.24, K:5.5,
      H_train:280, V:9, c_op:220, f:3.00, lambda:1.30,
      eps_f:-0.30, eps_t:-0.55, avg_speed:33, seats_per_vehicle:200,
      peak_hour_share:0.18, peak_direction_share:0.62, load_comfort:0.80,
      phi_crush:1.8, service_span_hrs:19 },
    ref: { R0:60, f0:3.00, H0:280, tWait0:3 },
  },
  stockholm_tbana: {
    label: 'Stockholm T-bana',
    citation: 'Borjesson et al. 2020: agglomeration ~48%, BCR ~6.',
    params: { R:50, dt:14, VOT:22, alpha:0.35, gamma:0.48, K:1.2,
      H_train:200, V:6, c_op:150, f:3.50, lambda:1.30,
      eps_f:-0.30, eps_t:-0.60, avg_speed:22, seats_per_vehicle:150,
      peak_hour_share:0.17, peak_direction_share:0.60, load_comfort:0.80,
      phi_crush:1.8, service_span_hrs:18 },
    ref: { R0:50, f0:3.50, H0:200, tWait0:4 },
  },
  high_cost_us: {
    label: 'High-cost US project',
    citation: 'US megaproject capital $4.5B; teaching case (BCR < 1).',
    params: { R:40, dt:12, VOT:18, alpha:0.30, gamma:0.10, K:4.5,
      H_train:150, V:3, c_op:250, f:1.75, lambda:1.30,
      eps_f:-0.35, eps_t:-0.60, avg_speed:20, seats_per_vehicle:150,
      peak_hour_share:0.17, peak_direction_share:0.60, load_comfort:0.80,
      phi_crush:1.8, service_span_hrs:18 },
    ref: { R0:40, f0:1.75, H0:150, tWait0:5 },
  },
  low_cost_intl: {
    label: 'Low-cost international',
    citation: 'International best-practice LRT capital ~$1.0B/10km.',
    params: { R:45, dt:12, VOT:16, alpha:0.30, gamma:0.25, K:1.0,
      H_train:160, V:3, c_op:120, f:1.50, lambda:1.30,
      eps_f:-0.35, eps_t:-0.60, avg_speed:20, seats_per_vehicle:150,
      peak_hour_share:0.17, peak_direction_share:0.60, load_comfort:0.80,
      phi_crush:1.8, service_span_hrs:18 },
    ref: { R0:45, f0:1.50, H0:160, tWait0:5 },
  },
};
</script>
```

- [ ] **Step 2: Write the failing test**

```js
// Task 6: welfare + anchor
{
  const P = PRESETS.us_lrt;
  // Anchor per spec: lambda=1 AND phi=1. Force phi=1 via load_comfort override,
  // calibrating the reference under the same regime so GC0 matches (clean pivot identity).
  const anchorParams = { ...P.params, lambda:1, load_comfort:10 };
  const ref = TBCR.calibrateRef(anchorParams, P.ref);
  const w = TBCR.computeWelfare(anchorParams, ref);
  T.eq('anchor: R == R0', w.demand.R, 40, 1e-6);
  T.eq('anchor: phi == 1', w.demand.phi, 1, 1e-9);
  T.eq('anchor: no crowding disamenity', w.benefits.crowdingDisamenity, 0, 1e-9);
  T.eq('anchor: total benefits ~127M', w.B, 127, 0.01*127);
  T.eq('anchor: BCR ~1.2', w.BCR, 1.2, 0.06);
  // MCPF monotonicity on the subsidized baseline
  const refN = TBCR.calibrateRef(P.params, P.ref);
  const wLo = TBCR.computeWelfare({ ...P.params, lambda:1.0 }, refN);
  const wHi = TBCR.computeWelfare({ ...P.params, lambda:1.5 }, refN);
  T.ok('BCR falls as lambda rises (subsidized)', wHi.BCR < wLo.BCR);
}
// Task 6b: every preset satisfies the pivot identity (phi=1 forced)
Object.keys(PRESETS).forEach(id => {
  const P = PRESETS[id];
  const ap = { ...P.params, lambda:1, load_comfort:10 };
  const ref = TBCR.calibrateRef(ap, P.ref);
  const w = TBCR.computeWelfare(ap, ref);
  T.eq('pivot identity '+id, w.demand.R, P.ref.R0, 1e-5);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node run-tests.mjs` → `FAIL anchor: R == R0` (calibrateRef/computeWelfare undefined), exit 1.

- [ ] **Step 4: Write minimal implementation**

Add to `tbcr-engine` (and export `calibrateRef, computeWelfare`):

```js
  function calibrateRef(params, refSeed) {
    const d0 = computeDemand(params, { ...refSeed, tGen0: null });
    return { ...refSeed, tGen0: d0.tGen, GC0: d0.GC };
  }
  function computeWelfare(params, ref) {
    const demand = computeDemand(params, ref);
    const benefits = computeBenefits(params, demand, ref);
    const costs = computeCosts(params, demand);
    const B = benefits.total;
    const W = B - costs.netCostWithMCPF;
    const BCR = costs.netCostWithMCPF !== 0 ? B / costs.netCostWithMCPF : Infinity;
    return { demand, benefits, costs, B, netCostWithMCPF: costs.netCostWithMCPF, W, BCR, FRR: costs.FRR };
  }
```

Also update `run-tests.mjs` is NOT needed — it already tries to load `tbcr-presets` and now finds it.

- [ ] **Step 5: Run test to verify it passes**

Run: `node run-tests.mjs` → all Task 6/6b lines PASS, exit 0.
If `anchor: total benefits ~127M` misses, DO NOT loosen the tolerance. Inspect `w.benefits.CS` and each component in the failing output and reconcile against the source doc ($127M total: CS 43.2 + congestion + mohring + accident + emissions + labor, then ×1.25 agglomeration). The anchor is defined with `φ=1` (forced here), so crowding disamenity must be exactly 0.

- [ ] **Step 6: Commit**

```bash
git add transit-bcr.html
git commit -m "feat: welfare compose, reference calibration, five real-project presets, regression anchor"
```

---

## Task 7: Fare optimization

**Files:**
- Modify: `transit-bcr.html` (`tbcr-engine`, `tbcr-tests`)

**Interfaces:**
- Consumes: `TBCR.computeWelfare`.
- Produces:
  - `TBCR.optimizeFare(params, ref, objective, opts) → { fareStar, value, R, W, BCR, FRR }`. `objective ∈ {'welfare','revenue','fareboxTarget'}`. `opts = { fMin=0.5, fMax=5.0, fareboxTarget=40 }`. Golden-section for welfare/revenue; grid-scan for smallest fare meeting FRR ≥ target (`fareStar:null` if unreachable).

- [ ] **Step 1: Write the failing test**

```js
// Task 7: fare optimization
{
  const P = PRESETS.us_lrt;
  const ref = TBCR.calibrateRef(P.params, P.ref);
  const wOpt = TBCR.optimizeFare(P.params, ref, 'welfare', {});
  T.ok('welfare-opt fare in range', wOpt.fareStar >= 0.5 && wOpt.fareStar <= 5.0);
  const wAt = TBCR.computeWelfare({ ...P.params, f: wOpt.fareStar }, ref);
  const wRef = TBCR.computeWelfare(P.params, ref);
  T.ok('W(f*) >= W(f0)', wAt.W >= wRef.W - 1e-6);
  const rOpt = TBCR.optimizeFare(P.params, ref, 'revenue', {});
  T.ok('revenue-opt fare in range', rOpt.fareStar >= 0.5 && rOpt.fareStar <= 5.0);
  const fb = TBCR.optimizeFare(P.params, ref, 'fareboxTarget', { fareboxTarget:40 });
  T.ok('farebox target null or in-range', fb.fareStar === null || (fb.fareStar>=0.5 && fb.fareStar<=5.0));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node run-tests.mjs` → `FAIL welfare-opt fare in range`, exit 1.

- [ ] **Step 3: Write minimal implementation**

Add to `tbcr-engine` (and export):

```js
  function optimizeFare(params, ref, objective, opts) {
    const fMin = (opts && opts.fMin) ?? 0.5, fMax = (opts && opts.fMax) ?? 5.0;
    const target = (opts && opts.fareboxTarget) ?? 40;
    if (objective === 'fareboxTarget') {
      const N = 200;
      for (let i = 0; i <= N; i++) {
        const f = fMin + (fMax - fMin) * i / N;
        const w = computeWelfare({ ...params, f }, ref);
        if (w.FRR >= target) return { fareStar: f, value: w.FRR, R: w.demand.R, W: w.W, BCR: w.BCR, FRR: w.FRR };
      }
      return { fareStar: null, value: null, R: null, W: null, BCR: null, FRR: null };
    }
    const score = (f) => { const w = computeWelfare({ ...params, f }, ref); return objective === 'revenue' ? w.costs.fareRev : w.W; };
    const gr = (Math.sqrt(5) - 1) / 2;
    let a = fMin, b = fMax, c = b - gr * (b - a), d = a + gr * (b - a), fc = score(c), fd = score(d);
    for (let i = 0; i < 60 && Math.abs(b - a) > 1e-4; i++) {
      if (fc < fd) { a = c; c = d; fc = fd; d = a + gr * (b - a); fd = score(d); }
      else { b = d; d = c; fd = fc; c = b - gr * (b - a); fc = score(c); }
    }
    const fStar = (a + b) / 2, w = computeWelfare({ ...params, f: fStar }, ref);
    return { fareStar: fStar, value: objective === 'revenue' ? w.costs.fareRev : w.W, R: w.demand.R, W: w.W, BCR: w.BCR, FRR: w.FRR };
  }
```

Add `optimizeFare` to the export.

- [ ] **Step 4: Run test to verify it passes**

Run: `node run-tests.mjs` → all Task 7 lines PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add transit-bcr.html
git commit -m "feat: welfare/revenue/farebox fare optimization"
```

---

## Task 8: JSON serialize/parse with clamping

**Files:**
- Modify: `transit-bcr.html` (`tbcr-presets`, `tbcr-tests`)

**Interfaces:**
- Consumes: `window.PRESETS`.
- Produces (on `window.TBCR_IO`, defined in `tbcr-presets`):
  - `RANGES` — map of each param key to `[min, max]`.
  - `serializeState(params, ref) → { version:1, params, referencePoint: ref }`.
  - `parseState(obj) → { params, ref, warnings: string[] }` — keeps only known keys, clamps to `RANGES`, warns on out-of-range (clamped) and unknown (ignored) keys.

- [ ] **Step 1: Write the failing test**

```js
// Task 8: JSON IO
{
  const P = PRESETS.us_lrt;
  const s = TBCR_IO.serializeState(P.params, P.ref);
  T.eq('serialize version', s.version, 1);
  const round = TBCR_IO.parseState(JSON.parse(JSON.stringify(s)));
  T.eq('round-trip fare preserved', round.params.f, P.params.f, 1e-9);
  T.ok('no warnings on clean input', round.warnings.length === 0);
  const bad = TBCR_IO.parseState({ version:1, params:{ ...P.params, f:99, bogus:5 }, referencePoint:P.ref });
  T.ok('out-of-range fare clamped', bad.params.f <= 5.0);
  T.ok('warns on clamp', bad.warnings.some(w => w.includes('f ')));
  T.ok('warns on unknown key', bad.warnings.some(w => w.includes('bogus')));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node run-tests.mjs` → `FAIL serialize version`, exit 1.

- [ ] **Step 3: Write minimal implementation**

Append to the `tbcr-presets` block:

```js
window.TBCR_IO = (function () {
  const RANGES = {
    R:[15,80], dt:[5,25], VOT:[8,40], alpha:[0.10,0.60], gamma:[0,0.50], K:[0.5,6.0],
    H_train:[50,400], V:[1,10], c_op:[80,300], f:[0.5,5.0], lambda:[1.0,1.5],
    eps_f:[-0.60,-0.10], eps_t:[-1.0,-0.30], avg_speed:[8,45], seats_per_vehicle:[80,250],
    peak_hour_share:[0.08,0.30], peak_direction_share:[0.50,0.75], load_comfort:[0.5,1.0],
    phi_crush:[1.2,2.5], service_span_hrs:[10,24],
  };
  function serializeState(params, ref) { return { version:1, params:{ ...params }, referencePoint:{ ...ref } }; }
  function parseState(obj) {
    const warnings = [], src = (obj && obj.params) || {}, params = {};
    Object.keys(src).forEach(k => {
      if (!(k in RANGES)) { warnings.push(`unknown key ignored: ${k}`); return; }
      let v = src[k]; const [lo, hi] = RANGES[k];
      if (typeof v !== 'number' || !isFinite(v)) { warnings.push(`non-numeric ${k} ignored`); return; }
      if (v < lo) { warnings.push(`${k} ${v} clamped to ${lo}`); v = lo; }
      if (v > hi) { warnings.push(`${k} ${v} clamped to ${hi}`); v = hi; }
      params[k] = v;
    });
    const ref = (obj && obj.referencePoint) ? { ...obj.referencePoint } : null;
    return { params, ref, warnings };
  }
  return { RANGES, serializeState, parseState };
})();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node run-tests.mjs` → all Task 8 lines PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add transit-bcr.html
git commit -m "feat: JSON serialize/parse with range clamping and warnings"
```

---

## Task 9: Widget UI shell — controls, cards, breakdown

**Files:**
- Modify: `transit-bcr.html` (add DOM markup in `<body>` and a new `tbcr-ui` block; add `<style>` rules)

**Interfaces:**
- Consumes: `TBCR.*`, `PRESETS`, `TBCR_IO`.
- Produces: interactive page (no charts yet). Module-scoped `state = { params, ref, lastOpt, selectedOpt }`; `render()` reads the engine and updates DOM; `buildSliders()`, `syncInputsFromParams()`, `loadPreset(id)`. The `tbcr-ui` block must be guarded so it does NOT execute under Node/test-only: wrap its body in `if (typeof document !== 'undefined' && !/[?&]test=1/.test(location.search || '')) { … }` so `?test=1` shows only the test output and Node never runs UI code. Expose `window.__WIDGET = { render, loadPreset }` for manual debugging.

- [ ] **Step 1: Add DOM + styles + UI block**

Add to `<style>`:

```css
  h1{font-size:1.4rem} h2{font-size:1.05rem;margin:1.2rem 0 .4rem}
  .bar{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin:.5rem 0}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;margin:.5rem 0}
  .card{border:1px solid #ddd;border-radius:8px;padding:.75rem}
  .card .v{font-size:1.5rem;font-weight:700}
  .sliders{display:grid;grid-template-columns:repeat(2,1fr);gap:.4rem 1.5rem}
  .row{display:grid;grid-template-columns:1fr 140px 70px;align-items:center;gap:.5rem}
  .row input[type=range]{width:100%}
  button,select{padding:.35rem .6rem;font:inherit}
  #warn{color:var(--red);white-space:pre-wrap}
  #breakdown{border:1px solid #eee;border-radius:8px;padding:.75rem;background:#fafafa;font-size:.92rem}
```

Add to `<body>` (after `#out`):

```html
<div id="app">
  <h1>Transit Benefit-Cost Model <small>(expanded, endogenous demand)</small></h1>
  <div class="bar">
    <label>Preset: <select id="preset"></select></label>
    <button id="btnExport">Export JSON</button>
    <button id="btnImport">Import JSON</button>
    <span>Optimize fare:</span>
    <button data-opt="welfare">Welfare</button>
    <button data-opt="revenue">Revenue</button>
    <button data-opt="fareboxTarget">Farebox 40%</button>
    <button id="btnSnap">Snap fare to selected</button>
  </div>
  <div id="warn"></div>
  <div class="cards">
    <div class="card"><div>Total annual benefits</div><div class="v" id="cB">–</div></div>
    <div class="card"><div>Net annual cost (incl. MCPF)</div><div class="v" id="cC">–</div></div>
    <div class="card"><div>Benefit-cost ratio</div><div class="v" id="cBCR">–</div></div>
  </div>
  <div id="optout" class="bar"></div>
  <h2>Demand &amp; fare</h2><div class="sliders" id="grpDemand"></div>
  <h2>Service &amp; cost</h2><div class="sliders" id="grpService"></div>
  <h2>Behavioral &amp; second-best</h2><div class="sliders" id="grpBehavior"></div>
  <h2>Breakdown</h2><div id="breakdown"></div>
</div>
```

Add a new `<script id="tbcr-ui">` block AFTER `tbcr-tests`:

```html
<script id="tbcr-ui">
if (typeof document !== 'undefined' && !/[?&]test=1/.test(location.search || '')) {
  const SLIDERS = {
    grpDemand: [
      ['R','Daily ridership (000s)',15,80,1],['f','Average fare ($)',0.5,5,0.05],
      ['dt','Time saved/trip (min)',5,25,0.5],['VOT','Value of time ($/hr)',8,40,1],
      ['alpha','Car-diverted share',0.10,0.60,0.01],['gamma','Agglomeration uplift',0,0.50,0.01],
    ],
    grpService: [
      ['K','Capital cost ($B)',0.5,6,0.1],['H_train','Daily train-hours',50,400,5],
      ['V','Vehicles per train',1,10,1],['c_op','Op cost/veh-hr ($)',80,300,5],
      ['avg_speed','Avg speed (mph)',8,45,1],['service_span_hrs','Service span (hrs)',10,24,1],
    ],
    grpBehavior: [
      ['eps_f','Fare elasticity',-0.60,-0.10,0.01],['eps_t','Time elasticity',-1.0,-0.30,0.01],
      ['lambda','MCPF (shadow price)',1.0,1.5,0.05],['seats_per_vehicle','Seats/vehicle',80,250,10],
      ['peak_hour_share','Peak-hour share',0.08,0.30,0.01],['phi_crush','Crush crowding mult.',1.2,2.5,0.1],
    ],
  };
  const state = { params:null, ref:null, lastOpt:null, selectedOpt:'welfare' };
  const $ = id => document.getElementById(id);
  const fmtM = x => (x>=0?'$':'-$') + Math.abs(x).toFixed(1) + 'M';

  function buildSliders(){
    for (const grp in SLIDERS){
      const host = $(grp);
      SLIDERS[grp].forEach(([key,label,min,max,step])=>{
        const row=document.createElement('div'); row.className='row';
        row.innerHTML = `<label for="s_${key}">${label}</label>`+
          `<input type="range" id="s_${key}" min="${min}" max="${max}" step="${step}">`+
          `<output id="o_${key}"></output>`;
        host.appendChild(row);
        row.querySelector('input').addEventListener('input', e=>{
          state.params[key] = parseFloat(e.target.value);
          $('o_'+key).textContent = e.target.value; render();
        });
      });
    }
  }
  function syncInputsFromParams(){
    Object.keys(state.params).forEach(key=>{
      const el = $('s_'+key);
      if (el){ el.value = state.params[key]; $('o_'+key).textContent = state.params[key]; }
    });
  }
  function loadPreset(id){
    const P = PRESETS[id];
    state.params = { ...P.params };
    state.ref = TBCR.calibrateRef(P.params, P.ref);
    syncInputsFromParams(); render();
  }
  function renderBreakdown(w){
    const b=w.benefits, c=w.costs, d=w.demand;
    $('breakdown').innerHTML =
      `Ridership: <b>${d.R.toFixed(1)}k</b>/day (load factor ${d.load.toFixed(2)}, crowding mult ${d.phi.toFixed(2)}). `+
      `Farebox recovery ${w.FRR.toFixed(0)}%.<br>`+
      `Benefits: CS ${fmtM(b.CS)} · congestion ${fmtM(b.congestion)} · Mohring ${fmtM(b.mohring)} · `+
      `accident ${fmtM(b.accident)} · emissions ${fmtM(b.emissions)} · labor ${fmtM(b.labor)} · `+
      `crowding ${fmtM(b.crowdingDisamenity)} · agglomeration ${fmtM(b.agglomeration)} = <b>${fmtM(b.total)}</b>.<br>`+
      `Costs: annualized capital ${fmtM(c.annualizedCapital)} · `+
      `operating ${c.opNet<0?'deficit '+fmtM(-c.opNet):'surplus offset '+fmtM(c.surplusOffset)} · `+
      `MCPF deadweight ${fmtM(c.mcpfDeadweight)} = net <b>${fmtM(w.netCostWithMCPF)}</b>.`;
  }
  function render(){
    const w = TBCR.computeWelfare(state.params, state.ref);
    $('cB').textContent = fmtM(w.B);
    $('cC').textContent = fmtM(w.netCostWithMCPF);
    const bcrEl = $('cBCR');
    bcrEl.textContent = isFinite(w.BCR)? w.BCR.toFixed(2) : '∞';
    bcrEl.style.color = w.BCR>=1.5?'var(--green)': w.BCR>=1.0?'var(--amber)':'var(--red)';
    renderBreakdown(w);
    if (window.__updateCharts) window.__updateCharts(w);   // defined in Task 11
  }
  function initPresets(){
    const sel = $('preset');
    Object.keys(PRESETS).forEach(id=>{ const o=document.createElement('option'); o.value=id; o.textContent=PRESETS[id].label; sel.appendChild(o); });
    sel.addEventListener('change', e=> loadPreset(e.target.value));
  }
  // export/import/optimize wired in Task 10
  window.__WIDGET = { render, loadPreset, get state(){ return state; }, syncInputsFromParams };
  buildSliders(); initPresets(); loadPreset('us_lrt');
}
</script>
```

- [ ] **Step 2: Verify manually**

Open `transit-bcr.html` (no `?test=1`). Expected: three cards populate; sliders move and update cards + breakdown live; changing preset repopulates sliders; BCR color-codes (green/amber/red).

- [ ] **Step 3: Confirm tests still pass headlessly**

Run: `node run-tests.mjs`
Expected: `OK` — the `tbcr-ui` guard means the UI block never runs under Node, so no `document is not defined` error and all prior tests still pass.

- [ ] **Step 4: Commit**

```bash
git add transit-bcr.html
git commit -m "feat: widget UI shell with presets, live sliders, cards, breakdown"
```

---

## Task 10: JSON import/export UI + fare-optimization UI (markers + snap)

**Files:**
- Modify: `transit-bcr.html` (`tbcr-ui` block)

**Interfaces:**
- Consumes: `TBCR_IO`, `TBCR.optimizeFare`, `state`, `render`, `syncInputsFromParams`.
- Produces: `doExport()` (clipboard + download), `doImport()` (paste → parse → clamp → warn → apply), `runOptimize(objective)` (compute all three, display in `#optout`, set `state.selectedOpt` + `state.lastOpt`), `doSnap()` (move fare to selected objective's fare, rounded to 0.05).

- [ ] **Step 1: Wire handlers**

Inside the `tbcr-ui` guard, before the `buildSliders(); initPresets(); loadPreset('us_lrt');` line, add:

```js
  function doExport(){
    const text = JSON.stringify(TBCR_IO.serializeState(state.params, state.ref), null, 2);
    if (navigator.clipboard) navigator.clipboard.writeText(text);
    const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([text],{type:'application/json'}));
    a.download='transit-bcr-scenario.json'; a.click();
  }
  function doImport(){
    const text = prompt('Paste scenario JSON:'); if(!text) return;
    let obj; try { obj = JSON.parse(text); } catch(e){ $('warn').textContent='Invalid JSON: '+e.message; return; }
    const { params, ref, warnings } = TBCR_IO.parseState(obj);
    Object.assign(state.params, params);
    if (ref && ref.R0!=null) state.ref = TBCR.calibrateRef(state.params, ref);
    $('warn').textContent = warnings.join('\n');
    syncInputsFromParams(); render();
  }
  function runOptimize(objective){
    state.selectedOpt = objective;
    const parts = ['welfare','revenue','fareboxTarget'].map(o=>{
      const r = TBCR.optimizeFare(state.params, state.ref, o, {fareboxTarget:40});
      return `${o}: ${r.fareStar==null?'n/a':'$'+r.fareStar.toFixed(2)}`;
    });
    state.lastOpt = TBCR.optimizeFare(state.params, state.ref, objective, {fareboxTarget:40});
    $('optout').textContent = 'Optimal fares → '+parts.join('  ·  ')+'   (selected: '+objective+')';
    if (window.__updateCharts) window.__updateCharts(TBCR.computeWelfare(state.params, state.ref));
  }
  function doSnap(){
    if(!state.lastOpt || state.lastOpt.fareStar==null) return;
    state.params.f = Math.round(state.lastOpt.fareStar/0.05)*0.05;
    syncInputsFromParams(); render();
  }
  $('btnExport').addEventListener('click', doExport);
  $('btnImport').addEventListener('click', doImport);
  $('btnSnap').addEventListener('click', doSnap);
  document.querySelectorAll('[data-opt]').forEach(b=> b.addEventListener('click', ()=>runOptimize(b.dataset.opt)));
```

- [ ] **Step 2: Verify manually**

Open `transit-bcr.html`. Expected: Export downloads JSON + copies to clipboard; Import accepts pasted JSON, clamps out-of-range, shows warnings in `#warn`; Optimize buttons print all three optimal fares and set the selection; Snap moves the fare slider and recomputes.

- [ ] **Step 3: Add a round-trip regression to the test block**

Insert before `// ---- END TESTS ----`:

```js
// Task 10: export/import idempotent
{
  const P = PRESETS.us_lrt;
  const s1 = TBCR_IO.serializeState(P.params, P.ref);
  const p1 = TBCR_IO.parseState(s1);
  const s2 = TBCR_IO.serializeState(p1.params, p1.ref || P.ref);
  T.ok('round-trip idempotent', JSON.stringify(s1.params) === JSON.stringify(s2.params));
}
```

Run: `node run-tests.mjs` → PASS, exit 0.

- [ ] **Step 4: Commit**

```bash
git add transit-bcr.html
git commit -m "feat: JSON import/export UI and fare-optimization markers with snap"
```

---

## Task 11: Charts (benefit/cost bars, demand curve, welfare curve)

**Files:**
- Modify: `transit-bcr.html` (`<head>` CDN, `<body>` canvases, new `tbcr-charts` block)

**Interfaces:**
- Consumes: Chart.js 4.4.1 (CDN), `state`, `TBCR.*`.
- Produces: `window.__updateCharts(w)` — updates four charts: stacked benefit bar (incl. crowding-disamenity segment), stacked cost bar (incl. MCPF segment), demand curve (R vs f) with current-fare context, welfare-vs-fare curve. Charts are created once on first call. Must be guarded like `tbcr-ui` (browser, non-test).

- [ ] **Step 1: Add Chart.js + canvases**

In `<head>` add:

```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
```

In `<body>`, inside `#app`, before `<h2>Breakdown</h2>`:

```html
<h2>Benefits vs. cost</h2>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
  <canvas id="chBenefit" height="140"></canvas>
  <canvas id="chCost" height="140"></canvas>
  <canvas id="chDemand" height="140"></canvas>
  <canvas id="chWelfare" height="140"></canvas>
</div>
```

- [ ] **Step 2: Add the charts block**

Add a new `<script id="tbcr-charts">` block AFTER `tbcr-ui`:

```html
<script id="tbcr-charts">
if (typeof document !== 'undefined' && !/[?&]test=1/.test(location.search || '') && typeof Chart !== 'undefined') {
  const $ = id => document.getElementById(id);
  let charts = null;
  function init(){
    charts = {
      benefit: new Chart($('chBenefit'), { type:'bar', data:{labels:['Benefits'],datasets:[]},
        options:{indexAxis:'y',scales:{x:{stacked:true},y:{stacked:true}},plugins:{title:{display:true,text:'Annual benefits ($M)'}}} }),
      cost: new Chart($('chCost'), { type:'bar', data:{labels:['Cost'],datasets:[]},
        options:{indexAxis:'y',scales:{x:{stacked:true},y:{stacked:true}},plugins:{title:{display:true,text:'Annual cost ($M)'}}} }),
      demand: new Chart($('chDemand'), { type:'line', data:{labels:[],datasets:[]},
        options:{plugins:{title:{display:true,text:'Demand curve: ridership vs fare'}}} }),
      welfare: new Chart($('chWelfare'), { type:'line', data:{labels:[],datasets:[]},
        options:{plugins:{title:{display:true,text:'Welfare vs fare'}}} }),
    };
  }
  window.__updateCharts = function(w){
    if (!charts) init();
    const b=w.benefits, c=w.costs;
    charts.benefit.data.datasets = [
      {label:'CS',data:[b.CS]},{label:'Congestion',data:[b.congestion]},{label:'Mohring',data:[b.mohring]},
      {label:'Accident',data:[b.accident]},{label:'Emissions',data:[b.emissions]},{label:'Labor',data:[b.labor]},
      {label:'Crowding',data:[b.crowdingDisamenity]},{label:'Agglomeration',data:[b.agglomeration]},
    ]; charts.benefit.update();
    charts.cost.data.datasets = [
      {label:'Annualized capital',data:[c.annualizedCapital]},
      {label:'Operating deficit',data:[Math.max(-c.opNet,0)]},
      {label:'MCPF deadweight',data:[c.mcpfDeadweight]},
      {label:'Surplus offset',data:[-c.surplusOffset]},
    ]; charts.cost.update();
    const st = window.__WIDGET.state, fs=[], Rs=[], Ws=[];
    for (let f=0.5; f<=5.0001; f+=0.1){
      const ww = TBCR.computeWelfare({ ...st.params, f }, st.ref);
      fs.push(f.toFixed(2)); Rs.push(ww.demand.R); Ws.push(ww.W);
    }
    charts.demand.data.labels=fs; charts.demand.data.datasets=[{label:'Ridership (000s)',data:Rs,pointRadius:0}]; charts.demand.update();
    charts.welfare.data.labels=fs; charts.welfare.data.datasets=[{label:'Welfare ($M)',data:Ws,pointRadius:0}]; charts.welfare.update();
  };
  // trigger an initial paint now that the hook exists
  if (window.__WIDGET) window.__WIDGET.render();
}
</script>
```

- [ ] **Step 3: Verify manually**

Open `transit-bcr.html`. Expected: benefit bar shows stacked segments incl. a negative crowding sliver; cost bar shows capital + deficit/MCPF; demand curve slopes down; welfare curve is hump-shaped with a visible peak. Moving any slider updates all four.

- [ ] **Step 4: Confirm headless tests unaffected**

Run: `node run-tests.mjs` → `OK` (charts block guarded, never runs under Node).

- [ ] **Step 5: Commit**

```bash
git add transit-bcr.html
git commit -m "feat: benefit/cost/demand/welfare charts"
```

---

## Task 12: README + final regression sweep

**Files:**
- Create: `README.md`
- Modify: `transit-bcr.html` (`tbcr-tests`)

**Interfaces:**
- Consumes: everything.
- Produces: docs + a consolidated all-preset regression assertion.

- [ ] **Step 1: Add consolidated regression test**

Insert before `// ---- END TESTS ----`:

```js
// Task 12: consolidated regression
{
  Object.keys(PRESETS).forEach(id=>{
    const P=PRESETS[id]; const ap={ ...P.params, lambda:1, load_comfort:10 };
    const ref=TBCR.calibrateRef(ap,P.ref); const w=TBCR.computeWelfare(ap,ref);
    T.eq('R==R0 '+id, w.demand.R, P.ref.R0, 1e-5);
    T.ok('finite BCR '+id, isFinite(w.BCR));
    T.eq('phi==1 '+id, w.demand.phi, 1, 1e-9);
  });
  const anchorP={ ...PRESETS.us_lrt.params, lambda:1, load_comfort:10 };
  const ref=TBCR.calibrateRef(anchorP,PRESETS.us_lrt.ref);
  const w=TBCR.computeWelfare(anchorP,ref);
  T.eq('baseline benefits ~127M', w.B, 127, 0.01*127);
  T.eq('baseline BCR ~1.2', w.BCR, 1.2, 0.06);
}
```

- [ ] **Step 2: Run full suite**

Run: `node run-tests.mjs`
Expected: prints `OK (N passed)`, exit 0. If baseline benefits/BCR miss, reconcile calibration against the source doc BEFORE writing the README — do NOT loosen tolerances to hide a real miss.

- [ ] **Step 3: Write README**

Create `README.md`:

```markdown
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
equals the reference ridership, and the US-LRT baseline reproduces the original model's ~$127M
benefits and ~1.2 BCR. In normal use (default `load_comfort=0.8`) benefits sit modestly below $127M
because of the crowding disamenity — this is intended behavior, not a discrepancy.

## Not modeled

Property-value capitalization, induced demand / land-use dynamics, construction disruption, network
effects, distributional weighting. See the spec in `docs/specs/` for the deferred-features rationale.
```

- [ ] **Step 4: Commit**

```bash
git add README.md transit-bcr.html
git commit -m "docs: README and consolidated regression sweep"
```

---

## Self-Review notes (for the implementer)

- **Anchor definition (important):** the spec's anchor is "`λ=1` **and** `φ=1`." At the US-LRT baseline the default capacity yields peak load ≈1.09 (freqPeak=150/18≈8.3 trains/hr × 3 cars × 150 seats = 3750 seats/hr; peak riders = 40000×0.17×0.6 = 4080 → load≈1.09), so `φ>1` in *normal operation* and a real crowding disamenity applies — correct physics, exactly what the model should capture. It is NOT a bug; do NOT hide it by loosening tolerances. The anchor tests force the spec's `φ=1` condition explicitly via `load_comfort:10`, calibrating the reference under the same regime, and under that regime the baseline reproduces ≈$127M / BCR≈1.2. In normal use benefits sit modestly below $127M; the README notes this.
- **DOM guards:** only `tbcr-ui` and `tbcr-charts` may touch the DOM/Chart, and both are wrapped in `if (typeof document !== 'undefined' && !test-mode)`. The Node runner only evals `tbcr-engine` + `tbcr-presets` + `tbcr-tests`, so UI/chart code never runs headlessly. Never add DOM access to engine/presets/tests blocks.
- **Type consistency:** `computeWelfare` returns `{ demand, benefits, costs, B, netCostWithMCPF, W, BCR, FRR }`; UI, charts, and tests reference exactly these names. `optimizeFare` returns `{ fareStar, value, R, W, BCR, FRR }`.
- **Ref propagation:** the reference (`R0,f0,H0,tWait0,tGen0,GC0`) is fixed by `calibrateRef` when a preset loads or a scenario imports; sliders never mutate the reference, preserving pivot semantics.
- **Script load order in the file:** `tbcr-engine` → `tbcr-presets` → `tbcr-tests` → `tbcr-ui` → `tbcr-charts`. The Node runner concatenates engine+presets+tests in that order; keep it.
