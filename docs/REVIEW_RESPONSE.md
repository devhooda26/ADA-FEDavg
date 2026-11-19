# Responding to the statistical and methodological critique

This maps each criticism to what the platform now does and what it still cannot do. "Needs authors" means software cannot fix it: the paper text or the argument has to change.

| # | Criticism | What the platform now provides | Limits |
|---|---|---|---|
| 1 | One seed, no confidence intervals; U2R (67 test rows) is 20% of macro-F1 | **Studies** run every variant over 2–20 seeds. The seed changes both the data partition and the model initialisation. Results show mean ± sd, 95% t-intervals, and paired differences against FedAvg (matched by seed). A per-class F1 table shows how much of macro-F1 comes from the rare class. | CIs are only as good as the seed count (use 10+). No multiple-comparison correction. U2R support is a property of KDDTest+, so report weighted metrics and per-class results alongside macro-F1. |
| 2 | No ablations: uniform weights, random clusters, K sweep, local class-weighted loss | Presets **Full ablation** and **Cluster-count sweep**: ADA with K=N (uniform client weights), random clusters with the same sizes, K = 2…8, local class-weighted loss on/off. K=1 is FedAvg. | Pairing is by seed, so use the same seeds across variants (the presets do). |
| 3 | Missing baselines | **FedProx**, **IFCA** (clustered FL), and **FedAvg with global class-balanced loss** (weights = balanced^0.5 by default, adjustable). | SCAFFOLD and CFL are **not implemented**. FedProx and IFCA are simplified (Adam local optimiser; IFCA is scored with its best-by-validation cluster model, which is not how IFCA is normally evaluated). Astraea, FedLC and FedNova are not implemented. |
| 4 | Mechanism claim unsupported | Experiment pages show per-class P/R/F1, confusion matrix, false-alarm rate, attack-detection rate, cluster membership, cluster sizes, and the **true class mix of each cluster**. | Single-run views. Use a study for claims. |
| 5 | Clustering may track benign/DoS ratio, not rare attacks | The cluster class-mix table makes this visible. Alternative distances (**inverse-frequency**, **log-scaled**) are available and compared in the ablation preset. | Whether they help is an empirical question the study answers; do not assume it. |
| 6 | Centralized "upper bound" is not one | Centralized runs use the same number of epochs as federated rounds (same sample passes), optionally with the same class-balanced loss. Both appear in the **Core comparison** and **Full ablation** presets. | The paper's tuning for centralized training is not recoverable. State its epochs, loss and optimiser. |
| 7 | Communication / privacy claims inconsistent; communication metric uninformative | Results report **summary bytes** (the one-time histogram, clients × classes × 4). Studies report **rounds-to-target** and mean ± sd **convergence curves**. The Privacy page now states what is exchanged. | **Needs authors:** the abstract's "without adding a single byte" and the title word "Privacy-Preserving". Either retitle (e.g. "Privacy-Aware") or add DP or secure aggregation, which this platform does not implement. |
| 8 | Sybil / small-cluster weight problem | **Robustness** preset: one simulated client flips labels and reports a fake histogram; compares FedAvg, ADA and ADA with **bounded cluster weights** (`blend`, 0 = paper, 1 = FedAvg). | A toy attack model, one attack type, no formal analysis. |
| 9 | Novelty, positioning, theory | None. | **Needs authors:** related-work positioning and any theory (when equal cluster weights approximate a class-balanced objective). Verify every citation yourself. |
| 10 | Narrow scope | **KDDTest-21**, **known vs novel attack** detection (3,750 test records are attack types unseen in training), **quantity skew** and **feature shift** (synthetic), up to **50 clients**, and **CSV upload** with label mapping for other datasets. | CIC-IDS2017 and FLNet2023 are **not bundled** (they could not be downloaded here); upload sampled CSVs and map their labels. The numpy trainer is slow beyond a few hundred thousand rows. Feature shift is simulated, not real organisational shift. |

## Suggested protocol for a defensible comparison
1. Run **Core comparison** and **Full ablation** at all three skew levels with at least 10 seeds.
2. Read the paired-difference table first: claim an effect only if the CI excludes 0 and the per-class table agrees.
3. Check **ADA vs random clusters** and **ADA vs FedAvg + class-balanced loss**. If they match ADA, the gain is reweighting, not clustering, and the paper should say so.
4. Report Test-21 and novel-attack results next to KDDTest+.
5. Export tables with the CSV / LaTeX buttons.

## Indicative observations (not evidence)
Single-seed runs in development, 30 rounds, moderate skew: FedAvg macro-F1 0.488, ADA-FedAvg 0.468 (the paper reports 0.516 and 0.604). A 10-round run gave ADA 0.485 vs random clusters 0.482. These are one seed each and prove nothing either way. They are the reason to run the studies before drawing conclusions.
