// Small statistics helpers (no dependencies). Two-sided 95% t critical values for df = 1..30.
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
const tcrit = (df) => (df < 1 ? NaN : df <= 30 ? T95[df - 1] : 1.96);
const clean = (a) => a.filter((v) => v != null && Number.isFinite(v));
export function summarize(raw) {
  const v = clean(raw), n = v.length;
  if (!n) return { n: 0, mean: null, sd: null, ci: null };
  const mean = v.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { n, mean, sd: null, ci: null };
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)), h = tcrit(n - 1) * sd / Math.sqrt(n);
  return { n, mean, sd, ci: [mean - h, mean + h] };
}
// Paired differences (variant - reference) matched by seed.
export function paired(bySeedA, bySeedR) {
  const d = [];
  for (const [seed, a] of bySeedA) { const r = bySeedR.get(seed); if (a != null && r != null && Number.isFinite(a) && Number.isFinite(r)) d.push(a - r); }
  const s = summarize(d);
  return { ...s, excludesZero: s.ci ? s.ci[0] > 0 || s.ci[1] < 0 : null };
}

const metricsOf = (r) => ({
  macroF1: r.test.macro_f1, accuracy: r.test.accuracy, weightedF1: r.test.weighted_f1,
  falseAlarmRate: r.test.false_alarm_rate, detectionRate: r.test.attack_detection_rate,
  test21MacroF1: r.generalization?.test21?.macro_f1 ?? null, novelDetection: r.generalization?.novel_attacks?.detection_rate ?? null,
  commMB: r.comm_mb,
});
export const METRICS = Object.keys(metricsOf({ test: {} }));

// runs: [{variant, seed, result}]. variants: ordered labels. Returns per-variant summaries, paired deltas vs reference, curves.
export function studyStats(runs, variants, planned, targetIn) {
  const by = new Map(variants.map((v) => [v, []]));
  for (const r of runs) by.get(r.variant)?.push(r);
  const finals = variants.map((v) => by.get(v).length ? summarize(by.get(v).map((r) => r.result.test.macro_f1)).mean : null).filter((x) => x != null);
  const target = targetIn ?? (finals.length ? Math.round(0.9 * Math.max(...finals) * 1000) / 1000 : null);
  const classes = runs[0]?.result.classes || [];
  const ref = variants.includes('FedAvg') ? 'FedAvg' : variants[0];
  const seedMap = (v, f) => new Map(by.get(v).map((r) => [r.seed, f(r.result)]));
  const out = variants.map((label) => {
    const rs = by.get(label), M = {};
    for (const m of METRICS) M[m] = summarize(rs.map((r) => metricsOf(r.result)[m]));
    const perClass = Object.fromEntries(classes.map((c, i) => [c, summarize(rs.map((r) => r.result.test.per_class[i]?.f1))]));
    const rtt = rs.map((r) => { const h = r.result.history.find((x) => x.val_macro_f1 >= target); return h ? h.round : null; });
    const len = rs.length ? Math.min(...rs.map((r) => r.result.history.length)) : 0;
    const curve = Array.from({ length: len }, (_, i) => summarize(rs.map((r) => r.result.history[i].val_macro_f1)));
    const pairedVs = label === ref || !by.get(ref).length ? null : Object.fromEntries(['macroF1', 'accuracy', 'falseAlarmRate', 'detectionRate', 'test21MacroF1', 'novelDetection'].map((m) =>
      [m, paired(seedMap(label, (x) => metricsOf(x)[m]), seedMap(ref, (x) => metricsOf(x)[m]))]));
    return { label, n: rs.length, planned, metrics: M, perClass, roundsToTarget: { reached: rtt.filter((x) => x != null).length, ...summarize(rtt) }, curve: curve.map((c) => ({ mean: c.mean, sd: c.sd })), pairedVsReference: pairedVs };
  });
  return { target, reference: ref, classes, variants: out };
}
