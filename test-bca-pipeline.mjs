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

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  loadEngine, runPipeline, buildCell, extractCoeffs, reconstruct,
  wpctInterp, argsort, ess, stableStringify, perDrawArtifact,
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

// ---- spec 07 N5: NETWORKED MODE ---------------------------------------------
// A harness-built candidate-given-network export carries cost_design (capital +
// service override) + network_fingerprint. The wrapper must: (a) override the
// static profile capital with cost_design's, (b) mark the artifact networked +
// carry the fingerprint, (c) return per-draw ΔNPV (perDraw) the harness reads
// back. The committed-artifact identity test (ii/G-E6 above) stays scoped to the
// STANDALONE harbor artifact (no cost_design) — verified there.
{
  // build a networked export from the real standalone harbor export
  const fp = 'deadbeefcafe0123456789ab';
  const capOverride = { LOW: 1804.2, US_TYPICAL: 2945.2 };  // capcost bands ($M), != profile 2018/3605
  const netExp = {
    ...exp,
    network_fingerprint: fp,
    cost_design: {
      capital: capOverride,
      service_plan: { route_km: 19.47, cars_per_train: 2, periods: [
        { period: 'peak', headway: 5.0, hours: 6.0 },
        { period: 'offpeak', headway: 10.0, hours: 13.0 }] },
      base_boardings: 8650,
      seat_capacity: { seatCap: 3600 },
    },
  };
  const gz = join(tmpdir(), `bca_export_harbor_${fp.slice(0, 12)}.json.gz`);
  writeFileSync(gz, gzipSync(Buffer.from(JSON.stringify(netExp), 'utf8')));
  const { artifact: netArt, perDraw } = runPipeline({ corridor: 'harbor', engine, exportPath: gz });

  ok('(N5) networked artifact carries network_fingerprint + networked=true',
    netArt.network_fingerprint === fp && netArt.networked === true);
  ok('(N5) standalone artifact has NO network keys (byte-identity scope preserved)',
    artifact.network_fingerprint === undefined && artifact.networked === undefined);
  ok('(N5) cost_design capital OVERRODE profile K (US_TYPICAL = 2945.2/1000 B)',
    Math.abs(netArt.central_profile.K_us_typical - capOverride.US_TYPICAL / 1000) < 1e-9 &&
    Math.abs(artifact.central_profile.K_us_typical - profile.capital.us_typical.K) < 1e-9 &&
    netArt.central_profile.K_us_typical !== artifact.central_profile.K_us_typical);
  ok('(N5) per-draw ΔNPV returned for both scenarios × both bands (n arrays)', (() => {
    for (const s of ['fold', 'retain']) for (const b of ['LOW', 'US_TYPICAL']) {
      const pd = perDraw[s] && perDraw[s][b];
      if (!(pd && pd.npv.length === n && pd.ben.length === n)) return false;
    }
    return true;
  })());
  const pda = perDrawArtifact('harbor', netExp, perDraw, n);
  ok('(N5) perDrawArtifact schema: fp + n + scenarios×bands npv arrays + p50 scalars', (() => {
    if (pda.schema !== 'bca-per-draw-npv-1' || pda.network_fingerprint !== fp || pda.n !== n) return false;
    const c = pda.scenarios.fold.US_TYPICAL;
    return Array.isArray(c.npv) && c.npv.length === n && typeof c.ben_p50 === 'number' &&
      typeof c.npv_p50 === 'number' && typeof c.bcr_p50 === 'number';
  })());
  // cost_design capital lowers |NPV| (less capital => less negative) vs the profile K
  ok('(N5) lower capcost capital => less-negative NPV than profile K standalone',
    netArt.headline.fold.US_TYPICAL.abc.npv.p50 > artifact.headline.fold.US_TYPICAL.abc.npv.p50);
  // networked determinism: a second run byte-identical
  const r2 = runPipeline({ corridor: 'harbor', engine, exportPath: gz }).artifact;
  ok('(N5) networked run deterministic (byte-identical)',
    stableStringify(netArt) === stableStringify(r2));
}

// ---- FB batch 2026-07-19: vot_behav stream + rebound recenter + vot_wedge ----
{
  // (FB-1) schema acceptance: the 15-stream export ships per-draw vot_behav
  // ($/hr), duplicated verbatim into both scenario blocks (um_roh precedent).
  for (const s of ['fold', 'retain']) {
    const v = exp.scenarios[s].vot_behav;
    ok('(FB-1) ' + s + '.vot_behav is an (n,) finite positive $/hr stream',
      Array.isArray(v) && v.length === n && v.every((x) => Number.isFinite(x) && x > 0 && x < 100));
  }

  // (FB-2) rebound recenter: central 0.4 (external review 2026-07-17 +
  // Duranton–Turner), rows at 0 / 0.8, old rebound_05/rebound_08 ids retired.
  ok('(FB-2) central rebound = 0.4 (profile + artifact)',
    profile.central_profile.rebound === 0.4 && artifact.central_profile.rebound === 0.4);
  ok('(FB-2) row set {rebound_0, rebound_hi}; {rebound_05, rebound_08} retired; knob coverage updated',
    artifact.tornado_row_ids.includes('rebound_0') && artifact.tornado_row_ids.includes('rebound_hi') &&
    !artifact.tornado_row_ids.includes('rebound_05') && !artifact.tornado_row_ids.includes('rebound_08') &&
    KNOB_COVERAGE.rebound.join(',') === 'rebound_0,rebound_hi');
  ok('(FB-2) rebound rows directional (less refill => higher NPV; more => lower)',
    ['fold', 'retain'].every((s) =>
      artifact.tornado[s].rows.rebound_0.delta_npv_p50 > 0 && artifact.tornado[s].rows.rebound_hi.delta_npv_p50 < 0));

  // (FB-3) vot_wedge: row present with bcr_p50; arithmetic verified by the exact
  // linearity identity — scaling the four minute streams by vot_behav/VOT_social
  // under central params equals a direct lifecycleCorePipeline call at
  // VOT = vot_behav (every VOT-priced term — timeUSD, agglom, laborUSD — is
  // linear in VOT; money streams untouched), draw for draw.
  ok('(FB-3) vot_wedge in tornado_row_ids and rows, carrying bcr_p50 + note',
    artifact.tornado_row_ids.includes('vot_wedge') &&
    ['fold', 'retain'].every((s) => {
      const r = artifact.tornado[s].rows.vot_wedge;
      return r && typeof r.bcr_p50 === 'number' && typeof r.npv_p50 === 'number' && /money-metric/.test(r.note);
    }));
  {
    const scen = 'retain', K = profile.capital.us_typical.K;
    const { raw, streams, params } = buildCell(engine, profile, exp, scen, K, 300);
    const C = extractCoeffs(TBCR, params);
    const votSocial = profile.central_profile.VOT;
    const wS = {
      umInfraMin: new Float64Array(n), umMarginMin: new Float64Array(n),
      um0InfraMin: new Float64Array(n), um0MarginMin: new Float64Array(n),
      carMilesDay: streams.carMilesDay, fareRevDay: streams.fareRevDay,
    };
    for (let i = 0; i < n; i++) {
      const k = raw.vot_behav[i] / votSocial;
      wS.umInfraMin[i] = streams.umInfraMin[i] * k; wS.umMarginMin[i] = streams.umMarginMin[i] * k;
      wS.um0InfraMin[i] = streams.um0InfraMin[i] * k; wS.um0MarginMin[i] = streams.um0MarginMin[i] * k;
    }
    const npvW = new Float64Array(n), bcrW = new Float64Array(n);
    reconstruct(C, wS, n, npvW, bcrW);
    let allMatch = true, maxRel = 0;
    for (const i of [7, 12345, 39999]) {
      const q = { umInfraMin: streams.umInfraMin[i], umMarginMin: streams.umMarginMin[i], um0InfraMin: streams.um0InfraMin[i], um0MarginMin: streams.um0MarginMin[i], carMilesDay: streams.carMilesDay[i], fareRevDay: streams.fareRevDay[i], R0: raw.newline[i] };
      const d = TBCR.lifecycleCorePipeline({ ...params, VOT: raw.vot_behav[i] }, q);
      const rel = Math.abs(npvW[i] - d.npv) / Math.max(1, Math.abs(d.npv));
      if (rel > maxRel) maxRel = rel;
      if (rel > 1e-9 || !near(bcrW[i], d.bcrPV, 1e-9)) allMatch = false;
    }
    ok('(FB-3) wedge reconstruct == direct engine call at VOT=vot_behav, per draw (max rel ' + maxRel.toExponential(2) + ')', allMatch);
    // artifact row = weighted P50 of exactly these arrays (sig6-rounded on write)
    const w = exp.abc_weights[profile.central_kernel], tot = w.reduce((a, b) => a + b, 0);
    const p50N = wpctInterp(npvW, w, 50, argsort(npvW), tot);
    const p50B = wpctInterp(bcrW, w, 50, argsort(bcrW), tot);
    ok('(FB-3) artifact vot_wedge npv_p50/bcr_p50 match the hand-built wedge streams',
      near(artifact.tornado[scen].rows.vot_wedge.npv_p50, p50N, 1e-5) &&
      near(artifact.tornado[scen].rows.vot_wedge.bcr_p50, p50B, 1e-5));
    // headline is UNCHANGED by the wedge (pricing-rule row, not a central move):
    // wedge BCR ≈ (vot_behav/VOT_social)·headline — loose band around the mean ratio
    const ratio = artifact.tornado[scen].rows.vot_wedge.bcr_p50 / artifact.headline[scen].US_TYPICAL.abc.bcr.p50;
    ok('(FB-3) wedge BCR / headline BCR in the behavioral/social band (got ' + ratio.toFixed(4) + ')', ratio > 0.6 && ratio < 0.85);
  }

  // (FB-4) backward-compat failure mode: a pre-15-stream export (no vot_behav)
  // must fail loudly with a clear re-export message, not degrade silently.
  {
    const noVb = { ...exp, scenarios: { fold: { ...exp.scenarios.fold }, retain: { ...exp.scenarios.retain } } };
    delete noVb.scenarios.fold.vot_behav;
    delete noVb.scenarios.retain.vot_behav;
    const gz = join(tmpdir(), 'bca_export_harbor_no_vot_behav.json.gz');
    writeFileSync(gz, gzipSync(Buffer.from(JSON.stringify(noVb), 'utf8')));
    let threw = false, msg = '';
    try { runPipeline({ corridor: 'harbor', engine, exportPath: gz }); } catch (e) { threw = true; msg = e.message; }
    ok('(FB-4) export without vot_behav throws a clear error naming the stream + re-export path',
      threw && /vot_behav/.test(msg) && /re-export/.test(msg));
  }
}

// ---- SC batch 2026-07-19: streetcar no-ABC degrade path ---------------------
// The streetcar export ships NO abc_weights (no calibration target until
// post-launch, spec 05; spec 06 §1/§7 degrade convention). First real exercise
// of the wrapper's no-ABC path + the two latent bugs it exposed:
//   (SC-2) `central_kernel: undefined` reached stableStringify and threw
//          (Object.keys(undefined)) — no-ABC profiles carry no central_kernel;
//   (SC-4) a --export run without a corridor positional silently labeled the
//          artifact 'harbor' — corridor now resolves from the export, and a
//          contradicting caller corridor is a hard error.
{
  const scExportPath = join(HERE, '..', 'oc-transit-forecast', 'outputs', 'bca_export_streetcar.json.gz');
  const scProfilePath = join(HERE, 'costs', 'profiles', 'streetcar.json');
  if (existsSync(scExportPath) && existsSync(scProfilePath)) {
    const scExp = JSON.parse(gunzipSync(readFileSync(scExportPath)).toString('utf8'));
    const scProfile = JSON.parse(readFileSync(scProfilePath, 'utf8'));
    // corridor deliberately OMITTED — must resolve from the export (SC-4 fix)
    const { artifact: sc } = runPipeline({ engine, exportPath: scExportPath, profilePath: scProfilePath });

    // (SC-1) degrade acceptance: uncapped-only, abc cells absent, reason populated
    // NOTE (R2 review, 2026-07-20): the /post-launch/ reason regex below pins the
    // STANDALONE no-weights convention. oc spec 06's 2026-07-17 amendment reads the
    // ABC weights as county-posterior properties applicable to any corridor under
    // the same draws — if the standalone streetcar export ever adopts that reading
    // and ships county weights, UPDATE this test; its failure would not be a regression.
    ok('(SC-1) corridor resolved from export (no caller corridor)', sc.corridor === 'streetcar');
    ok('(SC-1) abc_absent_reason populated verbatim from the export',
      typeof sc.abc_absent_reason === 'string' && sc.abc_absent_reason === scExp.abc_weights_absent_reason && /post-launch/.test(sc.abc_absent_reason));
    ok('(SC-1) headline cells are uncapped-ONLY (no abc key, all four cells)',
      ['fold', 'retain'].every(s => ['LOW', 'US_TYPICAL'].every(b => {
        const c = sc.headline[s][b];
        return c.uncapped && !('abc' in c) && c.uncapped.ess === null && c.uncapped.npv.p10 <= c.uncapped.npv.p50 && c.uncapped.npv.p50 <= c.uncapped.npv.p90;
      })));
    ok('(SC-1) cross is the uncapped-only half: 8 rows, no abc weighting',
      sc.cross.length === 8 && sc.cross.every(c => c.weighting === 'uncapped' && c.ess === null));
    ok('(SC-1) kernel_labels [] + ess {} + central_kernel/source null',
      sc.kernel_labels.length === 0 && Object.keys(sc.ess).length === 0 && sc.central_kernel === null && sc.central_kernel_source === null);
    ok('(SC-1) tornado degrades to the uncapped weighting (cell labeled, kernel null)',
      ['fold', 'retain'].every(s => {
        const t = sc.tornado[s];
        return t && t.cell.weighting === 'uncapped' && t.cell.kernel === null &&
          t.rows.abc_s350.note === 'kernel unavailable in export' && t.rows.abc_s350.delta_npv_p50 === 0 &&
          t.rows.abc_s800.note === 'kernel unavailable in export';
      }));
    ok('(SC-1) tornado uncapped central P50 == headline uncapped US_TYPICAL P50 (same convention)',
      ['fold', 'retain'].every(s => near(sc.tornado[s].central_npv_p50, sc.headline[s].US_TYPICAL.uncapped.npv.p50, 1e-6)));

    // (SC-2) serialization survives (the undefined-central_kernel crash) — and
    // is deterministic across runs
    let ser1 = null, ser2 = null, serThrew = false;
    try {
      ser1 = stableStringify(sc) + '\n';
      ser2 = stableStringify(runPipeline({ engine, exportPath: scExportPath, profilePath: scProfilePath }).artifact) + '\n';
    } catch (e) { serThrew = true; }
    ok('(SC-2) no-ABC artifact serializes (undefined central_kernel crash fixed) + deterministic',
      !serThrew && ser1 === ser2);
    if (existsSync(join(HERE, 'outputs', 'bca_streetcar.json'))) {
      const committed = readFileSync(join(HERE, 'outputs', 'bca_streetcar.json'), 'utf8');
      ok('(SC-2/G-E6) committed bca_streetcar.json byte-identical to a fresh run', committed === ser1);
    }

    // (SC-3) profile smoke: capcost-derived honest-subset capital, sane BCR band,
    // corridor-specific fiscal facts (no fold: baseOMAvoided == 0; loadFlag fires)
    ok('(SC-3) K bands are the capcost at-grade honest subset (0.754 / 1.220 $B)',
      near(sc.central_profile.K_low, 0.754, 1e-9) && near(sc.central_profile.K_us_typical, 1.220, 1e-9));
    ok('(SC-3) BCR P50 in a sane band (positive, << 1, below harbor\'s)', (() => {
      for (const s of ['fold', 'retain']) for (const b of ['LOW', 'US_TYPICAL']) {
        const v = sc.headline[s][b].uncapped.bcr.p50;
        if (!(v > 0.01 && v < 0.5)) return false;
      }
      return sc.headline.fold.US_TYPICAL.uncapped.bcr.p50 < artifact.headline.fold.US_TYPICAL.uncapped.bcr.p50;
    })());
    ok('(SC-3) NPV strictly negative all cells, p_npv_pos == 0',
      ['fold', 'retain'].every(s => ['LOW', 'US_TYPICAL'].every(b => {
        const u = sc.headline[s][b].uncapped; return u.npv.p90 < 0 && u.p_npv_pos === 0;
      })));
    ok('(SC-3) no route folded: baseOMAvoidedYr == 0 both scenarios; avoidable_marginal row inert',
      sc.service.baseOMAvoidedYr.fold === 0 && sc.service.baseOMAvoidedYr.retain === 0 &&
      ['fold', 'retain'].every(s => Math.abs(sc.tornado[s].rows.avoidable_marginal.delta_npv_p50) < 1e-9));
    ok('(SC-3) single-car 10-min streetcar: loadFlag fires and crowding_haircut actually bites (harbor: ≈0)',
      ['fold', 'retain'].every(s => sc.load_flag[s].fires === true) &&
      ['fold', 'retain'].every(s => sc.tornado[s].rows.crowding_haircut.delta_npv_p50 < 0) &&
      ['fold', 'retain'].every(s => artifact.tornado[s].rows.crowding_haircut.delta_npv_p50 === 0));

    // (SC-4) corridor-mismatch guard: a contradicting caller corridor throws
    {
      let threw = false, msg = '';
      try { runPipeline({ corridor: 'harbor', engine, exportPath: scExportPath, profilePath: scProfilePath }); }
      catch (e) { threw = true; msg = e.message; }
      ok('(SC-4) corridor mismatch (caller harbor vs export streetcar) throws loudly',
        threw && /corridor mismatch/.test(msg) && /streetcar/.test(msg));
    }
  } else {
    ok('(SC) streetcar export/profile present (expected in this checkout)', false);
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
