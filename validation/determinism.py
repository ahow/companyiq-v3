#!/usr/bin/env python3
"""Determinism analysis across 3 Microsoft runs (same corpus, runs 2&3; run1 fresh)."""
import json, statistics

runs = {}
for n in (1, 2, 3):
    with open(f"validation/ms_run{n}.json") as f:
        data = json.load(f)
    runs[n] = {d["m"]: d for d in data}

measures = sorted(runs[1].keys())
totals = {n: round(sum(runs[n][m]["s"] for m in measures), 2) for n in runs}
met = {n: sum(1 for m in measures if runs[n][m]["v"] == "Yes") for n in runs}

print("=" * 70)
print("DETERMINISM CHECK — MICROSOFT (id 553), 3 runs, Framework 7 (34 measures)")
print("=" * 70)
print(f"Run totals (sum of measure scores): {totals}")
print(f"Verdict 'Yes' counts:               {met}")
print(f"Company total_score (DB):           run1=47, run2=51, run3=47")
print()

# Per-measure dispersion
score_disp = []
verdict_flips = []
for m in measures:
    s = [runs[n][m]["s"] for n in (1, 2, 3)]
    v = [runs[n][m]["v"] for n in (1, 2, 3)]
    rng = max(s) - min(s)
    score_disp.append(rng)
    if len(set(v)) > 1:
        verdict_flips.append((m, v, s))

print(f"Per-measure score range (max-min) across 3 runs:")
print(f"  mean={statistics.mean(score_disp):.3f}  max={max(score_disp):.2f}  "
      f"measures w/ any change={sum(1 for r in score_disp if r>0)}/{len(measures)}")
print()
print(f"Verdict flips (Yes/No disagreements across runs): {len(verdict_flips)}/{len(measures)}")
for m, v, s in verdict_flips:
    print(f"  measure {m}: verdicts={v} scores={s}")
print()

# Compare run2 vs run3 (BOTH reuse run1's frozen corpus -> pure scoring noise)
print("-" * 70)
print("NOISE FLOOR (runs 2 & 3 share the SAME frozen 60-doc corpus):")
print("-" * 70)
pure = [(m, runs[2][m]["s"], runs[3][m]["s"]) for m in measures if runs[2][m]["s"] != runs[3][m]["s"]]
flips23 = [(m, runs[2][m]["v"], runs[3][m]["v"]) for m in measures if runs[2][m]["v"] != runs[3][m]["v"]]
print(f"  total_score: run2=51 vs run3=47  (delta={abs(51-47)}pp)")
print(f"  measures with different score: {len(pure)}/{len(measures)}")
for m, a, b in pure:
    print(f"    measure {m}: run2={a} run3={b}")
print(f"  verdict flips run2 vs run3: {len(flips23)}/{len(measures)}")
for m, a, b in flips23:
    print(f"    measure {m}: run2={a} run3={b}")
