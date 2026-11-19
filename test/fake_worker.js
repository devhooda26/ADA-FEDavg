const out = (o) => console.log(JSON.stringify(o));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
if (process.env.FAKE_FAIL) { out({ type: 'error', message: 'boom' }); process.exit(1); }
out({ type: 'progress', stage: 'preparing' });
out({ type: 'progress', stage: 'partitioned', classes: ['benign', 'dos'], clients: [{ id: 0, samples: 10, distribution: [1, 0], cluster: 0 }] });
for (let r = 1; r <= 2; r++) out({ type: 'progress', stage: 'training', round: r, rounds: 2, val_macro_f1: 0.5, val_accuracy: 0.9, loss: 1 });
if (process.env.FAKE_HANG) setInterval(() => {}, 1000);
else {
  // FAKE_VARY: deterministic metrics depending on seed and method so statistics can be checked
  const v = process.env.FAKE_VARY, seed = Number(arg('--seed', 0)), f1 = v ? 0.5 + 0.01 * seed + (arg('--method') === 'ada' ? 0.05 : 0) : 0.6;
  out({ type: 'result', source: 'generated', classes: ['benign', 'dos'], config: {}, generalization: v ? { test21: { macro_f1: f1 - 0.1 }, novel_attacks: { detection_rate: 0.3 } } : null,
    test: { accuracy: 0.8, macro_f1: f1, weighted_f1: 0.7, false_alarm_rate: 0.02, attack_detection_rate: 0.9, per_class: [{ class: 'benign', f1: 0.9 }, { class: 'dos', f1 }], confusion: [] },
    history: [{ round: 1, val_macro_f1: 0.4 }, { round: 2, val_macro_f1: f1 }], clients: null, jsd: null, clusters: null, comm_mb: 1, duration_s: 1 });
}
