// Tests for the W1 wrapper (bca-pipeline.mjs), spec 2026-07-14 §9/§11.
// Separate entry from run-tests.mjs (the 236 engine tests stay untouched/green);
// this exercises the wrapper end-to-end on the REAL harbor export.
//
//   (i)   end-to-end run emits a schema-valid artifact
//   (ii)  determinism — two runs byte-identical (G-E6)
//   (iii) hand-check — wrapper's per-draw NPV == direct lifecycleCorePipeline (all draws)
//   (iv)  λ=1 vs λ=1.3 row ordering sanity
//   (v)   G-E7 knob coverage — every §4 knob appears in tornado_row_ids / blocked map
//   plus  G-E4 round-trip (weighted newline P50 vs abc_harbor.json) + ESS.
//   plus  G-E4 seed-drift (existence-gated on bca_export_harbor_seed43.json.gz) — the
//         ABC-weighted headline BCR P50 must be stable (<=2% drift) across the export's
//         RNG seed, for all four {fold,retain}x{LOW,US_TYPICAL} ABC cells.

import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  loadEngine, runPipeline, buildCell, extractCoeffs, reconstruct,
  wpctInterp, argsort, ess, stableStringify,
  TORNADO_ROW_IDS, KNOB_COVERAGE, S4_KNOBS,
} from './bca-pipeline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
const ok = (name, cond) => { if (cond) { passed++; console.log('PASS ' + name); } else { failed++; console.log('FAIL ' + name); } };
const near = (a, b, rel) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(b));

const engine = loadEngine();
const { TBCR } = engine;
const exportPath = join(HERE, '..', 'oc-transit-forecast', 'outputs', 'bca_export_harbor.json.gz');
const exp = JSON.parse(gunzipSync(readFileSync(exportPath)).toString('utf8'));
const profile = JSON.parse(readFileSync(join(HERE, 'costs', 'profiles', 'harbor.json'), 'utf8'));
const n = exp.n;

// ---- (i) end-to-end + schema ------------------------------------------------
const { artifact } = runPipeline({ corridor: 'harbor', engine });
ok('(i) schema_version present', artifact.schema_version === 'bca-pipeline-1');
ok('(i) n_draws matches export', artifact.n_draws === n);
ok('(i) eq_days from export (band+central)', artifact.eq_days.band[0] === 300 && artifact.eq_days.central === 300 && artifact.eq_days.source === 'export');
ok('(i) headline has fold+retain × LOW+US_TYPICAL', ['fold', 'retain'].every(s => artifact.headline[s] && artifact.headline[s].LOW && artifact.headline[s].US_TYPICAL));
ok('(i) headline cells carry uncapped+abc npv/bcr P10/50/90 + p_npv_pos', (() => {
  const c = artifact.headline.retain.US_TYPICAL;
  for (const w of ['uncapped', 'abc']) { const s = c[w]; if (!(s && s.npv.p10 <= s.npv.p50 && s.npv.p50 <= s.npv.p90 && typeof s.p_npv_pos === 'number')) return false; }
  return c.abc.ess > 0 && c.uncapped.ess === null;
})());
ok('(i) full cross present {scenario×weighting×λ×band} = 16', artifact.cross.length === 16);
ok('(i) tornado_row_ids is a flat array of id strings', Array.isArray(artifact.tornado_row_ids) && artifact.tornado_row_ids.every(x => typeof x === 'string'));
ok('(i) blocked map separate from flat list (reliability_restored/roh/fare_sweep)', (() => {
  const b = artifact.tornado.retain.blocked;
  const inFlat = artifact.tornado_row_ids;
  return b.reliability_restored && b.roh && b.fare_sweep && !inFlat.includes('reliability_restored') && !inFlat.includes('roh');
})());
ok('(i) ess block per kernel', Object.keys(artifact.ess).length === Object.keys(exp.abc_weights).length && artifact.ess['543_launch_s500'] > 0);
ok('(i) abc_absent_reason null (harbor ships abc_weights)', artifact.abc_absent_reason === null);
ok('(i) tornado_row_ids sorted + unique', (() => { const a = artifact.tornado_row_ids; const s = [...a].sort(); return a.every((v, i) => v === s[i]) && new Set(a).size === a.length; })());

// ---- (ii) determinism (G-E6) ------------------------------------------------
const s1 = stableStringify(runPipeline({ corridor: 'harbor', engine }).artifact) + '\n';
const s2 = stableStringify(runPipeline({ corridor: 'harbor', engine }).artifact) + '\n';
ok('(ii) two runs byte-identical', s1 === s2);
ok('(ii) no wall-clock / run-id embedded (no ISO date, no "timestamp"/"runId")', !/\d{4}-\d\d-\d\dT\d\d:|timestamp|run_?id|generated_at/i.test(s1));
if (existsSync(join(HERE, 'outputs', 'bca_harbor.json'))) {
  const committed = readFileSync(join(HERE, 'outputs', 'bca_harbor.json'), 'utf8');
  ok('(ii/G-E6) committed artifact byte-identical to a fresh run', committed === s1);
}

// ---- (iii) hand-check: wrapper per-draw NPV == direct engine call ------------
{
  const scen = 'retain', K = profile.capital.us_typical.K, eqDays = 300;
  const { raw, streams, params } = buildCell(engine, profile, exp, scen, K, eqDays);
  const C = extractCoeffs(TBCR, params);
  const npv = new Float64Array(n), bcr = new Float64Array(n);
  reconstruct(C, streams, n, npv, bcr);
  // single hand-assembled draw (deliverable iii)
  const i0 = 12345;
  const q0 = { umInfraMin: streams.umInfraMin[i0], umMarginMin: streams.umMarginMin[i0], um0InfraMin: streams.um0InfraMin[i0], um0MarginMin: streams.um0MarginMin[i0], carMilesDay: streams.carMilesDay[i0], fareRevDay: streams.fareRevDay[i0], R0: raw.newline[i0] };
  const d0 = TBCR.lifecycleCorePipeline(params, q0);
  ok('(iii) one draw: wrapper NPV == direct lifecycleCorePipeline', near(npv[i0], d0.npv, 1e-9) && near(bcr[i0], d0.bcrPV, 1e-9));
  // strengthen: all 40k draws match a direct call
  let maxRel = 0;
  for (let i = 0; i < n; i++) {
    const q = { umInfraMin: streams.umInfraMin[i], umMarginMin: streams.umMarginMin[i], um0InfraMin: streams.um0InfraMin[i], um0MarginMin: streams.um0MarginMin[i], carMilesDay: streams.carMilesDay[i], fareRevDay: streams.fareRevDay[i], R0: raw.newline[i] };
    const d = TBCR.lifecycleCorePipeline(params, q);
    const rel = Math.abs(npv[i] - d.npv) / Math.max(1, Math.abs(d.npv));
    if (rel > maxRel) maxRel = rel;
  }
  ok('(iii) decomposition == direct for ALL 40k draws (max rel ' + maxRel.toExponential(2) + ')', maxRel < 1e-10);
}

// ---- (iv) λ ordering --------------------------------------------------------
{
  const byKey = (scen, band, w, lam) => artifact.cross.find(c => c.scenario === scen && c.band === band && c.weighting === w && c.lambda === lam);
  const lo = byKey('retain', 'US_TYPICAL', 'abc', 1.0), hi = byKey('retain', 'US_TYPICAL', 'abc', 1.3);
  ok('(iv) λ=1.3 lowers NPV vs λ=1.0 (higher net public cost)', hi.npv.p50 < lo.npv.p50);
  ok('(iv) λ=1.3 lowers BCR vs λ=1.0', hi.bcr.p50 < lo.bcr.p50);
  ok('(iv) tornado lambda_13 row delta_npv_p50 < 0', artifact.tornado.retain.rows.lambda_13.delta_npv_p50 < 0);
}

// ---- (v) G-E7 knob coverage -------------------------------------------------
{
  const flat = new Set(artifact.tornado_row_ids);
  let allCovered = true, missing = [];
  for (const knob of S4_KNOBS) {
    const rows = KNOB_COVERAGE[knob];
    if (!rows || rows.length === 0 || !rows.every(r => flat.has(r))) { allCovered = false; missing.push(knob); }
  }
  ok('(v/G-E7) every §4 knob maps to a tornado row present in tornado_row_ids' + (allCovered ? '' : ' [missing: ' + missing.join(',') + ']'), allCovered);
  // blocked rows are carried in the blocked map, never the flat list
  ok('(v/G-E7) blocked rows (reliability_restored, roh) NOT in flat list', !flat.has('reliability_restored') && !flat.has('roh'));
}

// ---- G-E4 round-trip: weighted newline P50 vs abc_harbor.json ---------------
{
  const newline = exp.scenarios.retain.newline, w = exp.abc_weights['543_launch_s500'];
  const idx = argsort(newline), total = w.reduce((a, b) => a + b, 0);
  const p50 = wpctInterp(newline, w, 50, idx, total);
  const refPath = join(HERE, '..', 'oc-transit-forecast', 'outputs', 'abc_harbor.json');
  if (existsSync(refPath)) {
    const ref = JSON.parse(readFileSync(refPath, 'utf8')).kernels['543_launch_s500'];
    ok('(G-E4) weighted retain.newline P50 matches abc_harbor.json to 4 sig figs', Number(p50.toPrecision(4)) === Number(ref.forecast.retain[1].toPrecision(4)));
    ok('(G-E4) central-kernel ESS matches abc_harbor.json', near(ess(w), ref.ess, 1e-6));
  } else {
    ok('(G-E4) weighted P50 ~ 11310 (abc_harbor.json absent — loose check)', near(p50, 11310, 1e-3));
  }
}

// ---- G-E4 seed-drift: ABC-weighted headline BCR P50 stable across export reseed ----
// Existence-gated on bca_export_harbor_seed43.json.gz (a second stage-2 export drawn
// from the same central profile at RNG seed 43). Re-runs the wrapper end-to-end against
// that export and compares the ABC-weighted headline bcr.p50 to the primary export's, for
// all four ABC cells ({fold,retain} x {LOW,US_TYPICAL}). Actuals measured for this export
// pair (2026-07): fold/LOW 0.4510%, fold/US_TYPICAL 0.4252%, retain/LOW 0.4130%,
// retain/US_TYPICAL 0.4277% — all comfortably inside the 2% gate.
{
  const seed43Path = join(HERE, '..', 'oc-transit-forecast', 'outputs', 'bca_export_harbor_seed43.json.gz');
  if (existsSync(seed43Path)) {
    const { artifact: artifact43 } = runPipeline({ corridor: 'harbor', engine, exportPath: seed43Path });
    for (const scen of artifact.scenarios) {
      for (const band of ['LOW', 'US_TYPICAL']) {
        const a = artifact.headline[scen][band].abc.bcr.p50;
        const b = artifact43.headline[scen][band].abc.bcr.p50;
        const drift = Math.abs(a - b) / Math.abs(a);
        ok('(G-E4 seed-drift) ' + scen + '/' + band + ' ABC BCR P50 drift <= 2% across seed43 (got ' +
          (drift * 100).toFixed(2) + '%)', drift <= 0.02);
      }
    }
  }
}

// ---- G-E5 (interface, interim): no eq_days value / kernel label / re-priced ----
// prior-band endpoint literalized in wrapper source.
{
  const src = readFileSync(join(HERE, 'bca-pipeline.mjs'), 'utf8');
  ok('(G-E5) no ABC kernel label literalized in wrapper source', !/543_(launch|matured)/.test(src));
  ok('(G-E5) no eq_days numeric literal in wrapper source', !/eq_days:\s*[0-9]/.test(src));
  ok('(G-E5) no re-priced prior-band numeric endpoint in wrapper source', !/\b(pcar[012v]|vot_behav)\s*:\s*[0-9.]/.test(src));
  ok('(G-E5) eq_days central resolves from export', artifact.eq_days.central === Math.min(...exp.eq_days) && artifact.eq_days.source === 'export');
  ok('(G-E5) central-kernel + abc σ-row labels resolve from profile', artifact.central_kernel === profile.central_kernel && !!profile.abc_rows);
}

// ---- extra: margin-only ramp composition (D6) invariant end-to-end ----------
{
  // early-year benefit with margin-only ramp >= all-ramped (spec §9 invariant) —
  // verified at the wrapper's assembled central cell for one draw.
  const scen = 'retain', K = profile.capital.us_typical.K;
  const { streams, params } = buildCell(engine, profile, exp, scen, K, 300);
  const i = 20000;
  const qMargin = { umInfraMin: streams.umInfraMin[i], umMarginMin: streams.umMarginMin[i], um0InfraMin: streams.um0InfraMin[i], um0MarginMin: streams.um0MarginMin[i] };
  const total = streams.umInfraMin[i] + streams.umMarginMin[i];
  const qAll = { umInfraMin: 0, umMarginMin: total, um0InfraMin: streams.um0InfraMin[i], um0MarginMin: streams.um0MarginMin[i] };
  const wM = TBCR.lifecycleCorePipeline({ ...params, ramp_start: 0.6 }, qMargin);
  const wA = TBCR.lifecycleCorePipeline({ ...params, ramp_start: 0.6 }, qAll);
  ok('(D6) margin-only ramp: opening-year benefit >= all-ramped variant', wM.byYear[params.build_years].benefit >= wA.byYear[params.build_years].benefit - 1e-9);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
