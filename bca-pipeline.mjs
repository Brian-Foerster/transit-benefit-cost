// =============================================================================
// bca-pipeline.mjs — W1 node wrapper for v3 pipeline mode
// (spec docs/specs/2026-07-14-v3-pipeline-mode.md §10). Node >= 22, no new deps.
//
// Prices the stage-2 ridership model's exported per-draw quantity streams
// through TBCR.lifecycleCorePipeline at the corridor central profile, then
// produces the ABC-weighted headline, the full {scenario × uncapped|ABC × λ ×
// band} cross, and the §10 tornado. Emits a deterministic, schema-versioned
// outputs/bca_<corridor>.json.
//
// THREE binding inputs (spec §2; wrapper re-derives nothing another artifact
// owns):
//   1. the §3 export  outputs/bca_export_<corridor>.json.gz (per-draw arrays,
//      abc_weights, routes_removed, base_service, eq_days).
//   2. the corridor cost profile  costs/profiles/<corridor>.json (prices,
//      capital bands, service design, and — INTERIM until oc 08-A3.3 — the
//      central-kernel designation + the five re-priced prior bands; G-E5).
//   3. the engine  transit-bcr.html (tbcr-engine + tbcr-presets script blocks).
//
// G-E5 (interface): NO eq_days value, kernel label, or re-priced prior band is
// literalized in this source. eq_days + kernel labels come from the EXPORT;
// the central-kernel designation + prior (lo,hi) bands come from the cost
// PROFILE (interim). Only engine-owned §4 tornado sweep points (VOT $15/$30,
// SCC $190, γ 0.15, …) appear here — allowed (spec §10).
//
// DESIGN — exact linear decomposition (spec §10 "cached re-pricing from per-draw
// component PVs; true draw-loop rebuilds are never needed"). lifecycleCorePipeline
// is exactly affine in each per-draw quantity stream (each enters additively and
// is scaled by a DRAW-INDEPENDENT year-shape), and pvFund is affine in fareRevDay.
// So for a fixed params object we extract the marginal PV coefficients with a
// handful of unit-stream engine calls, then reconstruct every draw's NPV/BCR with
// an O(n) recombination. A "structural" row (build_years, ramp, discount, …) just
// re-extracts the coefficients for its modified params; a "pure re-pricing" row
// (VOT, γ, λ, pcar, κ, avg_fare, ABC-weight, …) recombines with new coefficients
// and/or new per-draw quantities. Verified draw-for-draw against direct
// lifecycleCorePipeline calls in the tests (byte-exact NPV/BCR).
// =============================================================================

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- engine load (run-tests.mjs extraction pattern) -------------------------
export function loadEngine(htmlPath = join(HERE, 'transit-bcr.html')) {
  const html = readFileSync(htmlPath, 'utf8');
  const block = (id) => {
    const m = html.match(new RegExp('<script id="' + id + '"[^>]*>([\\s\\S]*?)<\\/script>'));
    if (!m) throw new Error('missing script block: ' + id);
    return m[1];
  };
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.document = { getElementById: () => null, createElement: () => ({ style: {}, appendChild() {}, textContent: '', className: '' }) };
  // tbcr-engine defines TBCR; tbcr-presets defines TBCR_IO (parseState/RANGES).
  const code = block('tbcr-engine') + '\n' + block('tbcr-presets');
  new Function('window', 'document', 'globalThis', code)(sandbox, sandbox.document, sandbox);
  return { TBCR: sandbox.TBCR, TBCR_IO: sandbox.TBCR_IO };
}

// ---- percentile helpers (match oc scripts/model.py pct / wpct exactly) ------
// pct: numpy.percentile linear (uncapped columns). wpct: cumulative-weight
// interpolation (ABC columns). ESS = 1/Σw² on the normalized export weights.
export function pctLinear(sortedAsc, q) {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedAsc[0];
  const pos = (q / 100) * (n - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos), frac = pos - lo;
  return sortedAsc[lo] + frac * (sortedAsc[hi] - sortedAsc[lo]);
}
export function argsort(values) {
  const idx = new Array(values.length);
  for (let i = 0; i < values.length; i++) idx[i] = i;
  idx.sort((a, b) => values[a] - values[b]);
  return idx;
}
export function wpctInterp(values, weights, q, idxSorted, total) {
  const n = values.length, t = q / 100;
  const c0 = weights[idxSorted[0]] / total;
  if (t <= c0) return values[idxSorted[0]];
  let cum = weights[idxSorted[0]], xpPrev = c0, fpPrev = values[idxSorted[0]];
  for (let k = 1; k < n; k++) {
    cum += weights[idxSorted[k]];
    const xpk = cum / total, fpk = values[idxSorted[k]];
    if (t <= xpk) return xpk === xpPrev ? fpk : fpPrev + (t - xpPrev) / (xpk - xpPrev) * (fpk - fpPrev);
    xpPrev = xpk; fpPrev = fpk;
  }
  return fpPrev;
}
export function ess(weights) {
  let s = 0, s2 = 0;
  for (const w of weights) { s += w; s2 += w * w; }
  return (s * s) / s2; // = 1/Σw² when Σw = 1 (oc reweight_abc convention)
}

// ---- linear decomposition ---------------------------------------------------
const STREAMS = ['umInfraMin', 'umMarginMin', 'um0InfraMin', 'um0MarginMin', 'carMilesDay', 'fareRevDay'];
// Extract the affine PV coefficients for a params object: run the engine once at
// zero quantities (structural base) and once per unit stream. Exact by linearity.
export function extractCoeffs(TBCR, params) {
  const zero = TBCR.lifecycleCorePipeline(params, {});
  const A = {};
  for (const s of STREAMS) {
    const u = TBCR.lifecycleCorePipeline(params, { [s]: 1 });
    A[s] = { dBen: u.pvBenefits - zero.pvBenefits, dFare: u.pvFareRev - zero.pvFareRev };
  }
  return {
    benefitBase: zero.pvBenefits,
    fundBase: zero.pvCapex + zero.pvOM - zero.pvBaseOMAvoided - zero.pvFareRev,
    lambda: params.lambda ?? 1,
    A,
  };
}
// Reconstruct per-draw NPV & BCR into caller-supplied arrays (exact vs a direct
// lifecycleCorePipeline call — see tests). streams: {stream: Float64Array}.
// outBen (optional) receives the per-draw pvBenefits — the sequencing harness's
// networked mode reads it back for the σ_struct benefit-per-boarding ratio
// (spec 07 N5); pre-existing 5-arg callers are unaffected.
export function reconstruct(C, streams, n, outNpv, outBcr, outBen) {
  const a = STREAMS.map((s) => C.A[s]);
  const arr = STREAMS.map((s) => streams[s]);
  for (let i = 0; i < n; i++) {
    let ben = C.benefitBase, fare = 0;
    for (let j = 0; j < STREAMS.length; j++) { const v = arr[j][i]; ben += a[j].dBen * v; fare += a[j].dFare * v; }
    const subsidyPV = Math.max(C.fundBase - fare, 0);
    const pvNetCost = subsidyPV * C.lambda;
    outNpv[i] = ben - pvNetCost;
    outBcr[i] = pvNetCost !== 0 ? ben / pvNetCost : Infinity;
    if (outBen) outBen[i] = ben;
  }
}

// summary stats for an npv/bcr pair under a weighting (null weights => uncapped)
function summarize(npv, bcr, n, weights) {
  const out = {};
  if (weights) {
    const total = weights.reduce((s, w) => s + w, 0);
    const iN = argsort(npv), iB = argsort(bcr);
    out.npv = { p10: wpctInterp(npv, weights, 10, iN, total), p50: wpctInterp(npv, weights, 50, iN, total), p90: wpctInterp(npv, weights, 90, iN, total) };
    out.bcr = { p10: wpctInterp(bcr, weights, 10, iB, total), p50: wpctInterp(bcr, weights, 50, iB, total), p90: wpctInterp(bcr, weights, 90, iB, total) };
    let wpos = 0; for (let i = 0; i < n; i++) if (npv[i] > 0) wpos += weights[i];
    out.p_npv_pos = wpos / total;
    out.ess = ess(weights);
  } else {
    const sN = Float64Array.from(npv).sort(), sB = Float64Array.from(bcr).sort();
    out.npv = { p10: pctLinear(sN, 10), p50: pctLinear(sN, 50), p90: pctLinear(sN, 90) };
    out.bcr = { p10: pctLinear(sB, 10), p50: pctLinear(sB, 50), p90: pctLinear(sB, 90) };
    let pos = 0; for (let i = 0; i < n; i++) if (npv[i] > 0) pos++;
    out.p_npv_pos = pos / n;
    out.ess = null;
  }
  return out;
}

// ---- quantity assembly ------------------------------------------------------
// Blend factor (spec §3 / spec 06 D8): b_blend = ws + (1-ws)·κ (b_nw = b_work
// today — the nonwork_short tilt is not threaded through the export, spec 06 D8).
// The nonwork_07 row down-weights the non-work leg to 0.7×.
function blendCentral(ws, kappa, n) {
  const b = new Float64Array(n);
  for (let i = 0; i < n; i++) b[i] = ws[i] + (1 - ws[i]) * kappa[i];
  return b;
}
// Pre-blend raw arrays for one scenario, plus the pcar-weighted car-mile variants.
function rawArrays(scen, params) {
  const N = scen.newline.length;
  const f = (a) => Float64Array.from(a);
  // FB batch 2026-07-19: the per-draw behavioral-VOT stream ($/hr) is REQUIRED —
  // the vot_wedge row re-prices the minute streams with it. Old (pre-15-stream)
  // exports fail loudly here, not silently as a zeroed row.
  if (!Array.isArray(scen.vot_behav) || scen.vot_behav.length !== N) {
    throw new Error("export missing per-draw 'vot_behav' stream ($/hr; 15-stream schema, FB batch 2026-07-19) — required by the vot_wedge row; re-export with oc scripts/bca_export.py");
  }
  const vot_behav = f(scen.vot_behav);
  const um_infra = f(scen.um_infra), um_margin = f(scen.um_margin);
  const um0_infra = f(scen.um0_infra), um0_margin = f(scen.um0_margin);
  const total = f(scen.total), newline = f(scen.newline);
  const cm = scen.cm_seg.map(f), cmf = scen.cm_seg_fullod.map(f), cmv = f(scen.cm_visitor);
  const ws = f(params.ws), kappa = f(params.kappa);
  const p0 = f(params.pcar0), p1 = f(params.pcar1), p2 = f(params.pcar2), pv = f(params.pcarv);
  // pcar-weighted diverted car-miles (pre-blend), central + full-OD + band endpoints.
  const carRawCentral = new Float64Array(N), carRawFullod = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    carRawCentral[i] = p0[i] * cm[0][i] + p1[i] * cm[1][i] + p2[i] * cm[2][i] + pv[i] * cmv[i];
    carRawFullod[i] = p0[i] * cmf[0][i] + p1[i] * cmf[1][i] + p2[i] * cmf[2][i] + pv[i] * cmv[i];
  }
  return { N, um_infra, um_margin, um0_infra, um0_margin, total, newline, cm, cmf, cmv, ws, kappa, carRawCentral, carRawFullod, vot_behav };
}
// pcar band-endpoint car-miles (pre-blend) for the pcar_lo / pcar_hi rows.
function carRawPcar(raw, pb, lohi) {
  const N = raw.N, out = new Float64Array(N);
  const a0 = pb.pcar0[lohi], a1 = pb.pcar1[lohi], a2 = pb.pcar2[lohi], av = pb.pcarv[lohi];
  for (let i = 0; i < N; i++) out[i] = a0 * raw.cm[0][i] + a1 * raw.cm[1][i] + a2 * raw.cm[2][i] + av * raw.cmv[i];
  return out;
}
// Assemble the 6 engine quantity streams from raw arrays under a blend vector, a
// car-mile source array, an avg_fare, base_boardings, and optional um-source
// override (no_asc_cs / gamma_asc swap um<->um0).
function assemble(raw, blend, carRaw, avgFare, baseBoardings, umSrc, um0Src) {
  const N = raw.N;
  const s = {
    umInfraMin: new Float64Array(N), umMarginMin: new Float64Array(N),
    um0InfraMin: new Float64Array(N), um0MarginMin: new Float64Array(N),
    carMilesDay: new Float64Array(N), fareRevDay: new Float64Array(N),
  };
  const uI = umSrc ? raw[umSrc.infra] : raw.um_infra, uM = umSrc ? raw[umSrc.margin] : raw.um_margin;
  const u0I = um0Src ? raw[um0Src.infra] : raw.um0_infra, u0M = um0Src ? raw[um0Src.margin] : raw.um0_margin;
  for (let i = 0; i < N; i++) {
    const b = blend[i];
    s.umInfraMin[i] = uI[i] * b;
    s.umMarginMin[i] = uM[i] * b;
    s.um0InfraMin[i] = u0I[i] * b;
    s.um0MarginMin[i] = u0M[i] * b;
    s.carMilesDay[i] = carRaw[i] * b;
    s.fareRevDay[i] = avgFare * (raw.total[i] - baseBoardings);
  }
  return s;
}

// ---- params assembly (parse + post-parse fiscal injection, spec §3/§4) ------
function carKmDesign(profile, eqDays) {
  const sp = profile.service_plan;
  return { eq_days: eqDays, route_km: sp.route_km, cars_per_train: sp.cars_per_train, periods: sp.periods };
}
function omDesign(profile, exp, scenario, eqDays, avoidableRate) {
  return {
    eq_days: eqDays, avoidable_rate: avoidableRate,
    routes_removed: exp.routes_removed[scenario] || [],
    base_service: (exp.base_service && exp.base_service.rev_hours_weekday) || {},
  };
}
// Central params for a (scenario, band): full central profile -> parseState
// (RANGES clamp + assets normalize + V2_DEFAULTS) -> inject the stripped fiscal
// keys post-parse -> assert neutralized + complete (the three T2 contract asserts).
function buildCentralParams({ TBCR, TBCR_IO }, profile, exp, scenario, eqDays, K) {
  const cp = profile.central_profile;
  const raw = {
    ...cp, K, eq_days: eqDays,
    build_years: profile.build_years,
    peak_hour_share: profile.peak_hour_share,
    peak_direction_share: profile.peak_direction_share,
    traction_gco2_per_km: profile.traction_gco2_per_km.central,
    om_fixed_yr: profile.om.fixed_yr.central,
    om_var_per_car_km: profile.om.var_per_car_km.central,
    avoidable_rate: profile.avoidable_rate.central,
    assets: profile.assets.map((a) => ({ ...a })),
  };
  const parsed = TBCR_IO.parseState({ version: 2, params: raw, referencePoint: null }).params;
  parsed.car_km_yr = TBCR.carKmYr(carKmDesign(profile, eqDays));
  parsed.baseOMAvoidedYr = TBCR.baseOMAvoidedYr(omDesign(profile, exp, scenario, eqDays, parsed.avoidable_rate));
  parsed.seatCap = profile.seat_capacity.seatCap;
  TBCR.assertPipelineCentralNeutralized(parsed);              // G-E3 (T2 carry-fwd 3)
  TBCR.pipelineQuantitiesComplete(parsed, { requireSeatCap: true }); // T2 carry-fwd 1/2
  return parsed;
}
// Apply a tornado override to central params, re-deriving the fiscal constants
// when the override touches eq_days / avoidable_rate (spec §6 couples them).
function overrideParams(TBCR, central, profile, exp, scenario, ov) {
  const p = { ...central, ...ov };
  const eqDays = ov.eq_days ?? central.eq_days;
  if (ov.eq_days != null) p.car_km_yr = TBCR.carKmYr(carKmDesign(profile, eqDays));
  if (ov.eq_days != null || ov.avoidable_rate != null) {
    p.baseOMAvoidedYr = TBCR.baseOMAvoidedYr(omDesign(profile, exp, scenario, eqDays, p.avoidable_rate));
  }
  return p;
}

// Build the central cell for one (scenario, band) — raw arrays, blend, the six
// assembled quantity streams, and the parsed+injected params. Exported so tests
// can reproduce the wrapper's exact per-draw assembly and compare NPV/BCR to a
// direct lifecycleCorePipeline call (deliverable iii; G-E2-style byte check).
export function buildCell(engine, profile, exp, scenario, K, eqDays) {
  const raw = rawArrays(exp.scenarios[scenario], exp.params);
  const blend = blendCentral(raw.ws, raw.kappa, raw.N);
  const streams = assemble(raw, blend, raw.carRawCentral, profile.avg_fare.central, profile.base_boardings);
  const params = buildCentralParams(engine, profile, exp, scenario, eqDays, K);
  return { raw, blend, streams, params };
}

// =============================================================================
// TORNADO — spec §10. Each row => a documented transform (params override and/or
// per-draw quantity rebuild and/or weight vector). The flat tornado_row_ids +
// the knob_coverage map (G-E7) + the blocked map are emitted regardless of which
// cell the deltas are computed on.
// =============================================================================
const PARAM_ROWS = {
  vot_lo: { VOT: 15 }, vot_hi: { VOT: 30 },
  gamma_015: { gamma: 0.15 }, gamma_025: { gamma: 0.25 },
  lambda_13: { lambda: 1.3 },
  scc_0: { scc: 0 }, scc_190: { scc: 190 },
  carbon_growth_2: { carbon_growth: 0.02 },
  gco2_lo: { gco2_per_mi: 200 }, gco2_hi: { gco2_per_mi: 400 },
  // rebound central 0.4 (external review 2026-07-17 + Duranton–Turner induced-refill
  // evidence); rows at the band ends: 0 (the old no-refill central) and 0.8.
  rebound_0: { rebound: 0 }, rebound_hi: { rebound: 0.8 },
  ext_cong_lo: { c_cong: 0.05 }, ext_cong_hi: { c_cong: 0.25 },
  ext_acc_lo: { c_acc: 0.01 }, ext_acc_hi: { c_acc: 0.05 },
  ext_local_lo: { c_emis_local: 0.007 }, ext_local_hi: { c_emis_local: 0.010 },
  traction_0: { traction_gco2_per_km: 0 },
  mohring_009: { mohring_coef: 0.09 },
  labor_05: { labor_coef: 0.05 },
  disc_2: { discount_rate: 0.02 }, disc_3: { discount_rate: 0.03 }, disc_7: { discount_rate: 0.07 },
  disc_declining: { declining_rate: true },
  build_years_4: { build_years: 4 }, build_years_7: { build_years: 7 },
  ramp_start_1: { ramp_start: 1.0 }, ramp_start_lo: { ramp_start: 0.6 },
  ramp_years_lo: { ramp_years: 3 }, ramp_years_hi: { ramp_years: 8 },
  growth_1: { growth: 0.01 },
  peak_hour_share_lo: { peak_hour_share: 0.08 }, peak_hour_share_hi: { peak_hour_share: 0.30 }, // loadFlag only
  // eq_days_330 override value comes from the EXPORT band (G-E5 — no eq_days value in source);
  // avoidable_marginal from profile.avoidable_rate.marginal. om_lo/om_hi from profile.om's
  // fixed_yr/var_per_car_km [lo,hi] bands (single source of truth — the profile, not a
  // duplicated literal here). All resolved at eval time in computeTornado.
  eq_days_330: null,
  avoidable_marginal: null,
  om_lo: null, om_hi: null,
};
const LOADFLAG_ONLY = new Set(['peak_hour_share_lo', 'peak_hour_share_hi']);
const QUANTITY_ROWS = new Set(['pcar_lo', 'pcar_hi', 'kappa_1', 'nonwork_07', 'transfer_fullod', 'no_asc_cs', 'avg_fare_lo', 'avg_fare_hi', 'crowding_haircut', 'gamma_asc', 'vot_wedge']);
// σ-sensitivity ABC row IDs (spec §10); their KERNEL LABELS come from profile.abc_rows (G-E5).
const WEIGHT_ROW_IDS = ['abc_s350', 'abc_s800'];
const NOTE_ROWS = {
  vot_behav_lo: 'behavioral VOT lo — baked into the exported utility (governs fare response); 0.0% at flat fare, needs a stage-2 re-export to sweep (spec 06 D3)',
  vot_behav_hi: 'behavioral VOT hi — baked into the exported utility; 0.0% at flat fare, needs a stage-2 re-export to sweep (spec 06 D3)',
};
// §4-introduced engine RANGES knobs whose coverage G-E7 enforces (spec §4 "Add:"
// list + the mohring/labor floor changes). Wrapper-side rows that are NOT §4 knobs
// (nonwork_07, pcar/κ re-blends, abc_*, no_asc_cs, gamma_asc, avg_fare, …) are
// covered by their own re-pricing rows, exempt from check-3 (spec §10).
export const S4_KNOBS = [
  'eq_days', 'c_cong', 'c_acc', 'c_emis_local', 'gco2_per_mi', 'scc', 'carbon_growth', 'rebound',
  'traction_gco2_per_km', 'build_years', 'avoidable_rate', 'om_var_per_car_km', 'om_fixed_yr',
  'peak_hour_share', 'VOT', 'mohring_coef', 'labor_coef', 'ramp_start', 'gamma', 'lambda', 'growth',
  'ramp_years', 'discount_rate',
];
export const KNOB_COVERAGE = {
  eq_days: ['eq_days_330'], c_cong: ['ext_cong_lo', 'ext_cong_hi'], c_acc: ['ext_acc_lo', 'ext_acc_hi'],
  c_emis_local: ['ext_local_lo', 'ext_local_hi'], gco2_per_mi: ['gco2_lo', 'gco2_hi'], scc: ['scc_0', 'scc_190'],
  carbon_growth: ['carbon_growth_2'], rebound: ['rebound_0', 'rebound_hi'], traction_gco2_per_km: ['traction_0'],
  build_years: ['build_years_4', 'build_years_7'], avoidable_rate: ['avoidable_marginal'],
  om_var_per_car_km: ['om_lo', 'om_hi'], om_fixed_yr: ['om_lo', 'om_hi'],
  peak_hour_share: ['peak_hour_share_lo', 'peak_hour_share_hi'], VOT: ['vot_lo', 'vot_hi'],
  mohring_coef: ['mohring_009'], labor_coef: ['labor_05'], ramp_start: ['ramp_start_1', 'ramp_start_lo'],
  gamma: ['gamma_015', 'gamma_025', 'gamma_asc'], lambda: ['lambda_13'], growth: ['growth_1'],
  ramp_years: ['ramp_years_lo', 'ramp_years_hi'], discount_rate: ['disc_2', 'disc_3', 'disc_7', 'disc_declining'],
};
const BLOCKED = {
  reliability_restored: 'no reliability term in the engine to restore (v2 §1 deferred all Part-B lines); un-blocks if a Part-B reliability line lands (spec §12)',
  roh: 'rule-of-half needs a um_roh_* stage-2 accumulator absent from the §3 export; un-blocked by oc rider 1 (spec §10/§12)',
  fare_sweep: 'Δfare≠0 design points (fare-burden / receipts rows) need the fare_receipts export stream; the engine hard-guards on fareBurden≠0 without it (spec §3/§12.6). Every current design is flat-fare (fare_burden ≡ 0)',
};
export const TORNADO_ROW_IDS = [
  ...Object.keys(PARAM_ROWS), ...QUANTITY_ROWS, ...WEIGHT_ROW_IDS, ...Object.keys(NOTE_ROWS),
].sort();

// Build the per-draw quantity streams for a quantity-transform row.
function rowStreams(rowId, raw, profile, ctxBlend) {
  const pb = profile.prior_bands, af = profile.avg_fare, bb = profile.base_boardings;
  const blendC = ctxBlend.central;
  switch (rowId) {
    case 'pcar_lo': return assemble(raw, blendC, carRawPcar(raw, pb, 'lo'), af.central, bb);
    case 'pcar_hi': return assemble(raw, blendC, carRawPcar(raw, pb, 'hi'), af.central, bb);
    case 'transfer_fullod': return assemble(raw, blendC, raw.carRawFullod, af.central, bb);
    case 'kappa_1': { const b = new Float64Array(raw.N).fill(1); return assemble(raw, b, raw.carRawCentral, af.central, bb); }
    case 'nonwork_07': {
      const b = new Float64Array(raw.N);
      for (let i = 0; i < raw.N; i++) b[i] = raw.ws[i] + 0.7 * (1 - raw.ws[i]) * raw.kappa[i];
      // recompute the pcar-weighted car-miles nonwork blend uses the SAME carRawCentral, re-blended
      return assemble(raw, b, raw.carRawCentral, af.central, bb);
    }
    case 'no_asc_cs': // CS measured at the no-ASC counterfactual: um := um0
      return assemble(raw, blendC, raw.carRawCentral, af.central, bb,
        { infra: 'um0_infra', margin: 'um0_margin' }, null);
    case 'gamma_asc': // γ on the ASC-inclusive stream: um0 := um (paired with gamma:0.15 param)
      return assemble(raw, blendC, raw.carRawCentral, af.central, bb,
        null, { infra: 'um_infra', margin: 'um_margin' });
    case 'avg_fare_lo': return assemble(raw, blendC, raw.carRawCentral, af.lo, bb);
    case 'avg_fare_hi': return assemble(raw, blendC, raw.carRawCentral, af.hi, bb);
    case 'vot_wedge': {
      // FB batch 2026-07-19: re-price ALL VOT-priced minute streams at each draw's
      // exported behavioral VOT (vot_behav, $/hr) instead of the social-VOT draw.
      // Exact: every VOT-priced term (timeUSD, agglom, laborUSD) is linear in VOT,
      // so scaling the four minute quantities by vot_behav/VOT_social is identical
      // to setting VOT = vot_behav draw-by-draw (tested against a direct engine
      // call). Money streams are NOT re-priced — fareRevDay and the fare_burden /
      // fare_receipts dollar streams stay money-metric (D3/A4). Headline unchanged;
      // this row reports NPV/BCR under behavioral VOT (spec 06 D3 two-VOT split).
      const s = assemble(raw, blendC, raw.carRawCentral, af.central, bb);
      const votSocial = profile.central_profile.VOT;
      for (let i = 0; i < raw.N; i++) {
        const k = raw.vot_behav[i] / votSocial;
        s.umInfraMin[i] *= k; s.umMarginMin[i] *= k;
        s.um0InfraMin[i] *= k; s.um0MarginMin[i] *= k;
      }
      return s;
    }
    case 'crowding_haircut': {
      // Wrapper variant (spec §3 "no CS haircut in v1"): haircut the time streams
      // where the peak load factor exceeds seated comfort (1.0). Harbor's load is
      // ~0.32 (2-car @ 3600 seats/hr), so no draw is haircut -> ≈0 effect (honest).
      const phShare = profile.peak_hour_share, pkDir = profile.peak_direction_share, seatCap = profile.seat_capacity.seatCap;
      const s = assemble(raw, blendC, raw.carRawCentral, af.central, bb);
      for (let i = 0; i < raw.N; i++) {
        const load = raw.newline[i] * phShare * pkDir / seatCap;
        if (load > 1.0) { const h = 1 / load; s.umInfraMin[i] *= h; s.umMarginMin[i] *= h; }
      }
      return s;
    }
    default: throw new Error('unknown quantity row: ' + rowId);
  }
}

// Evaluate the full tornado for one cell (scenario, band, ABC central kernel).
// eqDaysHi (export band far edge) drives the eq_days_330 row; profile.abc_rows
// maps the σ-sensitivity row ids to their export kernel labels (both G-E5).
// weights === null => the no-ABC degrade (spec 06 §1/§7): the tornado runs on
// the UNCAPPED weighting (numpy-linear P50, same convention as the uncapped
// headline cells) and the cell is labeled weighting:'uncapped', kernel:null.
function computeTornado({ TBCR }, profile, exp, scenario, central, centralCoeffs, centralStreams, raw, ctxBlend, weights, n, eqDaysHi) {
  const npv = new Float64Array(n), bcr = new Float64Array(n);
  const total = weights ? weights.reduce((s, w) => s + w, 0) : n;
  const p50 = weights
    ? (arr) => { const idx = argsort(arr); return wpctInterp(arr, weights, 50, idx, total); }
    : (arr) => pctLinear(Float64Array.from(arr).sort(), 50);
  const centralP50 = p50(centralStreams._npvRef);
  const rows = {};

  const evalParamRow = (params, streams) => {
    const C = extractCoeffs(TBCR, params);
    reconstruct(C, streams, n, npv, bcr);
    return p50(npv);
  };
  const evalQtyRow = (streams) => { reconstruct(centralCoeffs, streams, n, npv, bcr); return p50(npv); };

  for (const id of Object.keys(PARAM_ROWS)) {
    const ov = id === 'avoidable_marginal' ? { avoidable_rate: profile.avoidable_rate.marginal }
      : id === 'eq_days_330' ? { eq_days: eqDaysHi }
        : id === 'om_lo' ? { om_fixed_yr: profile.om.fixed_yr.lo, om_var_per_car_km: profile.om.var_per_car_km.lo }
          : id === 'om_hi' ? { om_fixed_yr: profile.om.fixed_yr.hi, om_var_per_car_km: profile.om.var_per_car_km.hi }
            : PARAM_ROWS[id];
    const params = overrideParams(TBCR, central, profile, exp, scenario, ov);
    const v = evalParamRow(params, centralStreams);
    rows[id] = { label: id, npv_p50: v, delta_npv_p50: v - centralP50 };
    if (LOADFLAG_ONLY.has(id)) rows[id].note = 'loadFlag diagnostic only — no NPV/BCR effect (spec §3/D4)';
  }
  for (const id of QUANTITY_ROWS) {
    const streams = rowStreams(id, raw, profile, ctxBlend);
    let v;
    if (id === 'gamma_asc') { // param(gamma) + quantity(um0:=um)
      const params = overrideParams(TBCR, central, profile, exp, scenario, { gamma: 0.15 });
      v = evalParamRow(params, streams);
    } else v = evalQtyRow(streams);
    rows[id] = { label: id, npv_p50: v, delta_npv_p50: v - centralP50 };
    if (id === 'vot_wedge') {
      // the row reports BCR too (its point is the BCR under behavioral VOT); npv/bcr
      // still hold this row's reconstruct output here.
      rows[id].bcr_p50 = p50(bcr);
      rows[id].note = 'ALL VOT-priced minute streams re-priced at the draw-level exported behavioral VOT (vot_behav) instead of the social-VOT draw; money streams (fareRevDay, fare_burden/fare_receipts) NOT re-priced — money stays money-metric (D3/A4). Headline unchanged.';
    }
  }
  const abcRows = profile.abc_rows || {};
  for (const id of WEIGHT_ROW_IDS) {
    const kernel = abcRows[id];
    if (!kernel || !exp.abc_weights || !exp.abc_weights[kernel]) { rows[id] = { label: id, npv_p50: centralP50, delta_npv_p50: 0, note: 'kernel unavailable in export' }; continue; }
    const w = exp.abc_weights[kernel];
    const idx = argsort(centralStreams._npvRef);
    const tot = w.reduce((s, x) => s + x, 0);
    const v = wpctInterp(centralStreams._npvRef, w, 50, idx, tot);
    rows[id] = { label: id, npv_p50: v, delta_npv_p50: v - centralP50, ess: ess(w) };
  }
  for (const [id, note] of Object.entries(NOTE_ROWS)) {
    rows[id] = { label: id, npv_p50: centralP50, delta_npv_p50: 0, note };
  }
  return {
    cell: weights
      ? { scenario, band: 'US_TYPICAL', weighting: 'abc', kernel: profile.central_kernel }
      : { scenario, band: 'US_TYPICAL', weighting: 'uncapped', kernel: null },
    central_npv_p50: centralP50, rows, blocked: BLOCKED,
  };
}

// NETWORKED MODE (spec 07 N5): a harness-built candidate-given-network export
// carries a `cost_design` block (the harness OWNS capital via capcost.py /
// spec 04 — the wrapper prices it, spec 06 §2 division of labor) and a
// `network_fingerprint`. When present, cost_design OVERRIDES the static cost-
// profile capital + corridor service design so the SAME shared central profile
// (prices / posterior — county-common, spec 07 §6.1) prices any candidate. A
// standalone export (no cost_design) leaves the profile untouched, so the
// committed standalone bca_<corridor>.json is byte-identical (item 2 scope).
function applyCostDesign(profile, exp) {
  const cd = exp.cost_design;
  if (!cd) return profile;
  const p = JSON.parse(JSON.stringify(profile));            // deep clone; never mutate the file object
  if (cd.capital) {                                         // capcost $M -> engine K ($B): cost_$M = K·share·1000
    p.capital = { low: { K: cd.capital.LOW / 1000 }, us_typical: { K: cd.capital.US_TYPICAL / 1000 } };
  }
  if (cd.service_plan) p.service_plan = cd.service_plan;    // car_km design (E5)
  if (cd.base_boardings != null) p.base_boardings = cd.base_boardings; // net-new revenue base (D3)
  if (cd.seat_capacity) p.seat_capacity = cd.seat_capacity; // loadFlag denominator (D4)
  return p;
}

// =============================================================================
// MAIN PIPELINE
// =============================================================================
export function runPipeline(opts = {}) {
  const engine = opts.engine || loadEngine(opts.htmlPath);
  const { TBCR } = engine;
  const exportPath = opts.exportPath || join(HERE, '..', 'oc-transit-forecast', 'outputs', `bca_export_${opts.corridor || 'harbor'}.json.gz`);

  const exp = JSON.parse(gunzipSync(readFileSync(exportPath)).toString('utf8'));
  // Corridor resolves from the EXPORT when the caller passes none (no-ABC-path
  // fix 2026-07-19: `node bca-pipeline.mjs --export <streetcar gz> ...` used to
  // default the label to 'harbor' and silently ship streetcar quantities under
  // the wrong corridor name). A caller-supplied corridor that CONTRADICTS the
  // export's own declaration is a hard error, not a silent mislabel.
  const corridor = opts.corridor || exp.corridor || 'harbor';
  if (opts.corridor && exp.corridor && exp.corridor !== opts.corridor) {
    throw new Error(`corridor mismatch: wrapper invoked for '${opts.corridor}' but the export declares corridor '${exp.corridor}' (${exportPath}) — refusing to ship one corridor's quantities under another's label`);
  }
  const profilePath = opts.profilePath || join(HERE, 'costs', 'profiles', `${corridor}.json`);
  const profile = applyCostDesign(JSON.parse(readFileSync(profilePath, 'utf8')), exp);

  const n = exp.n;
  // eq_days + kernel labels come from the EXPORT (G-E5); central designation from profile.
  const eqDaysBand = exp.eq_days.slice().sort((a, b) => a - b); // [300, 330]
  const eqDaysCentral = eqDaysBand[0];
  const hasAbc = !!exp.abc_weights;
  const kernelLabels = hasAbc ? Object.keys(exp.abc_weights).sort() : [];
  // no-ABC-path fix 2026-07-19: a no-ABC profile carries no central_kernel;
  // `undefined` used to reach stableStringify and throw (Object.keys(undefined)).
  const centralKernel = profile.central_kernel ?? null;
  if (hasAbc && !exp.abc_weights[centralKernel]) throw new Error('central kernel ' + centralKernel + ' not in export abc_weights');
  const abcAbsentReason = hasAbc ? null : (exp.abc_weights_absent_reason || 'no abc_weights in export');

  const scenarios = Object.keys(exp.scenarios).sort();
  const bands = [['LOW', profile.capital.low.K], ['US_TYPICAL', profile.capital.us_typical.K]];

  // pre-compute raw quantity arrays + central blend per scenario
  const rawByScen = {}, blendByScen = {}, centralStreamsByScen = {};
  for (const scen of scenarios) {
    const raw = rawArrays(exp.scenarios[scen], exp.params);
    rawByScen[scen] = raw;
    blendByScen[scen] = { central: blendCentral(raw.ws, raw.kappa, raw.N) };
    centralStreamsByScen[scen] = assemble(raw, blendByScen[scen].central, raw.carRawCentral, profile.avg_fare.central, profile.base_boardings);
  }

  // ---- central pass: headline + full cross --------------------------------
  // perDraw[scen][band] = {npv, bcr, ben} Float64Arrays at λ=1 (the central
  // profile) — the networked sequencing harness reads these back for its
  // WITHIN-DRAW CV and σ_struct (spec 07 N5). Captured here for free from the
  // λ=1 reconstruct the headline already runs.
  const headline = {}, cross = [], perDraw = {};
  const centralParamsCache = {}, centralCoeffsCache = {};
  for (const scen of scenarios) {
    headline[scen] = {};
    perDraw[scen] = {};
    for (const [bandName, K] of bands) {
      const central = buildCentralParams(engine, profile, exp, scen, eqDaysCentral, K);
      centralParamsCache[scen + '|' + bandName] = central;
      const streams = centralStreamsByScen[scen];
      // headline weightings: uncapped + ABC central kernel, at λ central (=1) and λ=1.3
      for (const lam of [1.0, 1.3]) {
        const C = extractCoeffs(TBCR, { ...central, lambda: lam });
        const npv = new Float64Array(n), bcr = new Float64Array(n);
        const ben = lam === 1.0 ? new Float64Array(n) : undefined;
        reconstruct(C, streams, n, npv, bcr, ben);
        const uncapped = summarize(npv, bcr, n, null);
        const abc = hasAbc ? summarize(npv, bcr, n, exp.abc_weights[centralKernel]) : null;
        for (const [wname, stat] of [['uncapped', uncapped], ['abc', abc]]) {
          if (!stat) continue;
          cross.push({ scenario: scen, band: bandName, weighting: wname, lambda: lam, npv: stat.npv, bcr: stat.bcr, p_npv_pos: stat.p_npv_pos, ess: stat.ess });
        }
        if (lam === 1.0) {
          headline[scen][bandName] = { uncapped, ...(abc ? { abc } : {}) };
          perDraw[scen][bandName] = { npv, bcr, ben };
        }
      }
    }
    // cache central (λ=1) coeffs for tornado at US_TYPICAL
    const centralUS = centralParamsCache[scen + '|US_TYPICAL'];
    centralCoeffsCache[scen] = extractCoeffs(TBCR, centralUS);
  }

  // ---- tornado (per scenario, US_TYPICAL, ABC central kernel; no-ABC exports
  // degrade to the uncapped weighting — spec 06 §1/§7, weights=null) ----------
  const tornado = {};
  for (const scen of scenarios) {
    const central = centralParamsCache[scen + '|US_TYPICAL'];
    const C = centralCoeffsCache[scen];
    const streams = centralStreamsByScen[scen];
    const npvRef = new Float64Array(n), bcrRef = new Float64Array(n);
    reconstruct(C, streams, n, npvRef, bcrRef);
    const streamsWithRef = { ...streams, _npvRef: npvRef };
    const weights = hasAbc ? exp.abc_weights[centralKernel] : null;
    tornado[scen] = computeTornado(engine, profile, exp, scen, central, C, streamsWithRef, rawByScen[scen], blendByScen[scen], weights, n, eqDaysBand[1]);
  }

  // ---- diagnostics --------------------------------------------------------
  const loadFlag = {}, baseOMAvoided = {}, carKmYr = TBCR.carKmYr(carKmDesign(profile, eqDaysCentral));
  for (const scen of scenarios) {
    const raw = rawByScen[scen];
    const sortedR0 = Float64Array.from(raw.newline).sort();
    const medR0 = pctLinear(sortedR0, 50);
    const lf = medR0 * profile.peak_hour_share * profile.peak_direction_share / profile.seat_capacity.seatCap;
    loadFlag[scen] = { median_R0: medR0, peak_load_factor_p50: lf, comfort_threshold: 1.0, fires: lf > 1.0 };
    baseOMAvoided[scen] = TBCR.baseOMAvoidedYr(omDesign(profile, exp, scen, eqDaysCentral, profile.avoidable_rate.central));
  }

  // ---- assemble artifact --------------------------------------------------
  // spec 07 N5: networked ONLY when the export carries cost_design (a harness-
  // built candidate-given-network point). The two network keys are added
  // CONDITIONALLY (spread below), so a standalone export yields the byte-
  // identical committed bca_<corridor>.json — item 2's identity test is scoped
  // to exactly that standalone case.
  const networked = !!exp.cost_design;
  const networkKeys = networked
    ? { network_fingerprint: exp.network_fingerprint || null, networked: true }
    : {};
  const artifact = {
    schema_version: 'bca-pipeline-1',
    corridor,
    generator: 'bca-pipeline.mjs (v3 pipeline mode, spec 2026-07-14 §10)',
    engine_fn: 'TBCR.lifecycleCorePipeline',
    n_draws: n,
    export_seed: exp.seed,
    ...networkKeys,
    eq_days: { band: eqDaysBand, central: eqDaysCentral, source: 'export' },
    central_kernel: centralKernel,
    central_kernel_source: centralKernel != null ? 'cost-profile (interim; oc 08-A3.3 central flag pending)' : null,
    kernel_labels: kernelLabels,
    cost_bands: bands.map((b) => b[0]),
    scenarios,
    abc_absent_reason: abcAbsentReason,
    central_profile: {
      VOT: profile.central_profile.VOT, gamma: profile.central_profile.gamma, lambda: profile.central_profile.lambda,
      scc: profile.central_profile.scc, discount_rate: profile.central_profile.discount_rate, horizon: profile.central_profile.horizon,
      mohring_coef: 0, labor_coef: 0, rebound: profile.central_profile.rebound, carbon_growth: profile.central_profile.carbon_growth,
      growth: profile.central_profile.growth, ramp_start: profile.central_profile.ramp_start, ramp_years: profile.central_profile.ramp_years,
      build_years: profile.build_years, eq_days: eqDaysCentral, peak_hour_share: profile.peak_hour_share, peak_direction_share: profile.peak_direction_share,
      gco2_per_mi: profile.central_profile.gco2_per_mi, traction_gco2_per_km: profile.traction_gco2_per_km.central,
      c_cong: profile.central_profile.c_cong, c_acc: profile.central_profile.c_acc, c_emis_local: profile.central_profile.c_emis_local,
      om_fixed_yr: profile.om.fixed_yr.central, om_var_per_car_km: profile.om.var_per_car_km.central, avoidable_rate: profile.avoidable_rate.central,
      avg_fare: profile.avg_fare.central, base_boardings: profile.base_boardings, seatCap: profile.seat_capacity.seatCap,
      K_low: profile.capital.low.K, K_us_typical: profile.capital.us_typical.K,
    },
    service: { car_km_yr: carKmYr, baseOMAvoidedYr: baseOMAvoided },
    load_flag: loadFlag,
    headline,
    cross,
    tornado,
    tornado_row_ids: TORNADO_ROW_IDS,
    knob_coverage: KNOB_COVERAGE,
    blocked_row_ids: Object.keys(BLOCKED).sort(),
    ess: hasAbc ? Object.fromEntries(kernelLabels.map((l) => [l, ess(exp.abc_weights[l])])) : {},
    cautions: [
      'The vot_* and vot_behav_* rows must not be read jointly at opposite extremes (spec 06 D3).',
      'labor_05 must not be read jointly with the gamma_* rows (spec 06 D9).',
    ],
    optimism_bias_note: 'Flyvbjerg reference-class optimism bias (spec 05 §4.3): rail capital outturns run materially over ex-ante estimates; the US_TYPICAL band internalizes part of this. Reported beside the headline, not applied to the point estimate.',
    notes: [
      'fold and retain are reported separately — no blend of any kind (different cost structures; spec 06 §1).',
      'eq_days central = 300 (anchor_from_apc primary); eq_days_330 is the band far edge (export ships (300,330)).',
      'rebound central = 0.4 (recentered from 0: external review 2026-07-17 + Duranton & Turner induced-refill evidence); rows at 0 (rebound_0) and 0.8 (rebound_hi). Materiality: the car-mile externality slice is ~4% of user benefits.',
      'vot_wedge re-prices the minute streams at the exported per-draw behavioral VOT instead of the social VOT; it is the wrapper pricing-rule toggle, distinct from the vot_behav_lo/hi band rows (spec 06 D3; oc registry vot_behav provenance).',
      'Every current design is flat-fare: fare_burden ≡ 0, so the D3 money-metric transfer and its fare_receipts counterpart are 0; the A4 carve-out holds vacuously (spec §8).',
      'traction_gco2_per_km is clamped by the engine RANGES [0,60]; the physical SCE-grid rate is higher but the term is immaterial to the headline (see profile note + T3 report).',
    ],
  };
  return { artifact, engine, profile, exp, n, scenarios, bands, eqDaysCentral, centralKernel, hasAbc, perDraw };
}

// ---- per-draw NPV emission (spec 07 N5 networked mode) ----------------------
// The sequencing harness's within-draw CV needs per-draw ΔNPV, not just the
// summary bands. The linear decomposition already produced them for free at the
// λ=1 headline pass (perDraw), so emit them as a compact companion file the
// harness reads back — the documented mechanism for "reading 40k per-draw NPVs
// back from node." Per (scenario, band): the full per-draw NPV array at the
// central profile (λ=1) plus the ben/npv/bcr P50 scalars the harness reuses for
// σ_struct (benefit-per-boarding) and the §7 marginal-BCR stopping test.
export function perDrawArtifact(corridor, exp, perDraw, n) {
  const out = {
    schema: 'bca-per-draw-npv-1',
    corridor,
    network_fingerprint: exp.network_fingerprint || null,
    n, lambda: 1.0,
    note: 'per-draw ΔNPV at the central profile (λ=1), λ-1 headline pass of bca-pipeline.mjs; scenarios×bands. npv is the full (n,) array; *_p50 are conveniences (spec 07 N5).',
    scenarios: {},
  };
  for (const scen of Object.keys(perDraw).sort()) {
    out.scenarios[scen] = {};
    for (const band of Object.keys(perDraw[scen]).sort()) {
      const { npv, bcr, ben } = perDraw[scen][band];
      const sN = Float64Array.from(npv).sort(), sBen = Float64Array.from(ben).sort(), sBcr = Float64Array.from(bcr).sort();
      out.scenarios[scen][band] = {
        npv: Array.from(npv),
        npv_p50: pctLinear(sN, 50),
        ben_p50: pctLinear(sBen, 50),
        bcr_p50: pctLinear(sBcr, 50),
      };
    }
  }
  return out;
}

// ---- deterministic serialization (spec §9 / G-E6) ---------------------------
// Sorted keys, stable float formatting (6 significant figures), non-finite ->
// string, "\n" terminator. No timestamps / run-ids / wall-clock embedded.
function sig6(x) {
  if (x === 0) return 0;
  const d = Math.ceil(Math.log10(Math.abs(x)));
  const p = 6 - d, m = Math.pow(10, p);
  return Math.round(x * m) / m;
}
export function stableStringify(v, indent = 0) {
  const pad = '  '.repeat(indent), pad1 = '  '.repeat(indent + 1);
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'number') {
    if (!isFinite(v)) return JSON.stringify(v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : 'NaN');
    return JSON.stringify(Number.isInteger(v) ? v : sig6(v));
  }
  if (t === 'string' || t === 'boolean') return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return '[\n' + v.map((e) => pad1 + stableStringify(e, indent + 1)).join(',\n') + '\n' + pad + ']';
  }
  const keys = Object.keys(v).sort();
  if (keys.length === 0) return '{}';
  return '{\n' + keys.map((k) => pad1 + JSON.stringify(k) + ': ' + stableStringify(v[k], indent + 1)).join(',\n') + '\n' + pad + '}';
}

// ---- headline print ---------------------------------------------------------
function fmt$(x) { return (x >= 0 ? '+' : '-') + '$' + Math.abs(x / 1000).toFixed(2) + 'B'; }
function printHeadline(artifact) {
  const H = artifact.headline;
  console.log('\n=== v3 pipeline BCA — ' + artifact.corridor + ' (n=' + artifact.n_draws + ') ===');
  console.log('central profile: λ=' + artifact.central_profile.lambda + ', γ=' + artifact.central_profile.gamma +
    ', SCC=$' + artifact.central_profile.scc + ', VOT=$' + artifact.central_profile.VOT + ', eq_days=' + artifact.eq_days.central +
    ', build_years=' + artifact.central_profile.build_years);
  console.log('K: LOW=$' + artifact.central_profile.K_low + 'B  US_TYPICAL=$' + artifact.central_profile.K_us_typical + 'B');
  console.log('\n' + 'scenario  band        weighting  NPV_P50        BCR_P50   ESS');
  console.log('-'.repeat(70));
  for (const scen of artifact.scenarios) {
    for (const band of artifact.cost_bands) {
      const cell = H[scen][band];
      for (const w of ['uncapped', 'abc']) {
        const s = cell[w]; if (!s) continue;
        console.log(
          scen.padEnd(9), band.padEnd(11), w.padEnd(10),
          fmt$(s.npv.p50).padEnd(14), s.bcr.p50.toFixed(4).padEnd(9),
          s.ess == null ? '—' : Math.round(s.ess).toLocaleString('en-US'));
      }
    }
  }
  console.log('-'.repeat(70));
  console.log('optimism bias: ' + artifact.optimism_bias_note);
}

// ---- CLI --------------------------------------------------------------------
// Standalone:  node bca-pipeline.mjs [corridor] [exportPath]
//                -> outputs/bca_<corridor>.json (committed; item 2 identity test)
// Networked:   node bca-pipeline.mjs <corridor> --export <gz> [--profile <json>]
//                [--out <json>] [--npv-out <json>]
//                -> a FINGERPRINT-NAMED output (outputs/bca_<corridor>_<fp12>.json
//                   by default, from the export's network_fingerprint) + a
//                   companion per-draw NPV file (bca_<corridor>_<fp12>.npv.json
//                   by default) the sequencing harness reads back (spec 07 N5).
function parseArgs(argv) {
  const o = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--export') o.exportPath = argv[++i];
    else if (a === '--profile') o.profilePath = argv[++i];
    else if (a === '--out') o.outPath = argv[++i];
    else if (a === '--npv-out') o.npvOutPath = argv[++i];
    else o.positional.push(a);
  }
  return o;
}
function main(argv) {
  const a = parseArgs(argv);
  // corridor may be omitted when --export is given — it then resolves from the
  // export's own `corridor` field inside runPipeline (no-ABC-path fix
  // 2026-07-19; the old `|| 'harbor'` default silently mislabeled the artifact).
  const corridorArg = a.positional[0] || (a.exportPath ? undefined : 'harbor');
  // back-compat: a bare second positional is still the export path (old form)
  const exportPath = a.exportPath || a.positional[1];
  const t0 = process.hrtime.bigint();
  const { artifact, n, scenarios, perDraw } = runPipeline({ corridor: corridorArg, exportPath, profilePath: a.profilePath });
  const corridor = artifact.corridor;
  const t1 = process.hrtime.bigint();
  const runtimeMs = Number(t1 - t0) / 1e6;
  const outDir = join(HERE, 'outputs');
  mkdirSync(outDir, { recursive: true });

  // networked runs emit to a fingerprint-named file so distinct candidate/cycle
  // points never collide; the standalone path keeps the committed name.
  const fp = artifact.network_fingerprint ? String(artifact.network_fingerprint).slice(0, 12) : null;
  const outPath = a.outPath || join(outDir, fp ? `bca_${corridor}_${fp}.json` : `bca_${corridor}.json`);
  writeFileSync(outPath, stableStringify(artifact) + '\n');

  let npvMsg = '';
  if (artifact.networked || a.npvOutPath) {
    const npvOutPath = a.npvOutPath || join(outDir, `bca_${corridor}_${fp || 'standalone'}.npv.json`);
    // full-precision, compact JSON (ephemeral, gitignored, harness-read) — the
    // canonical sig6 serializer is for committed artifacts, not the per-draw pipe.
    writeFileSync(npvOutPath, JSON.stringify(perDrawArtifact(corridor, { network_fingerprint: artifact.network_fingerprint }, perDraw, n)));
    npvMsg = '\nwrote ' + npvOutPath + ' (per-draw ΔNPV, spec 07 N5)';
  }
  printHeadline(artifact);
  console.log('\nwrote ' + outPath + npvMsg);
  console.log('runtime: ' + runtimeMs.toFixed(0) + ' ms (n=' + n + ', ' + scenarios.length + ' scenarios × 2 bands; exact linear-decomposition kernel).');
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) main(process.argv.slice(2));
