#!/usr/bin/env python3
"""Offline controlled-impedance calculator over a user-supplied stackup file.

The impedance is computed with the IPC-2141A closed-form equations. They approximate a 2D field
solve, typically within a few percent over their validity range; treat the result as a starting
width to confirm with your fab, not as a substitute for the fab's own number on a critical board.

Trapezoidal etch: the width you give is the bottom (wider) width; the top is narrower by the
etch-compensation delta for that copper weight, and the mean of the two is used.

Stackups come from a JSON file you provide (see examples/stackups.example.json). Pass it with
--stackups, or set IMPEDANCE_STACKUPS. Without either, the bundled example file is used.

    python impedance.py list
    python impedance.py show EXAMPLE-4L-1.6
    python impedance.py calc  --stackup EXAMPLE-4L-1.6 --layer 1 --width 7.5
    python impedance.py solve --stackup EXAMPLE-4L-1.6 --layer 1 --target 50
    python impedance.py solve --stackup EXAMPLE-4L-1.6 --layer 1 --target 90 --diff --spacing 6
"""
from __future__ import annotations

import argparse
import functools
import json
import math
import os
import pathlib
import sys

EXAMPLE = pathlib.Path(__file__).resolve().parent / "examples" / "stackups.example.json"
_SOURCE = [os.environ.get("IMPEDANCE_STACKUPS") or str(EXAMPLE)]
MM_PER_MIL = 0.0254

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def use_stackups(path) -> None:
    """Point the solver at another stackup JSON file."""
    _SOURCE[0] = str(path)
    _library.cache_clear()


@functools.lru_cache(maxsize=1)
def _library() -> dict:
    return json.loads(pathlib.Path(_SOURCE[0]).read_text(encoding="utf-8"))


def stackups() -> list:
    return _library()["stackups"]


def etch_table() -> list:
    return _library().get("etchCompensation") or []


def etch_delta_mil(finished_oz: float, outer: bool) -> float:
    """Etch-compensation width delta in mil for the nearest copper weight on this layer type."""
    want = "outer" if outer else "inner"
    best, best_err = None, 1e9
    for row in etch_table():
        if row.get("layer") != want:
            continue
        err = abs(float(row.get("copperOz") or 0) - finished_oz)
        if err < best_err:
            best, best_err = row, err
    return float(best.get("widthDeltaMil") or 0) if best else 0.0


def expand(stack: list) -> list:
    """Flatten a stackup into an alternating copper / dielectric sequence.

    A core entry carries copper on *both* faces, so it expands into copper, dielectric, copper.
    Without that expansion an inner signal layer sits at the wrong depth and the impedance is
    wrong by the core thickness.
    """
    out = []
    for row in stack:
        material = str(row.get("material") or "")
        t_cond = float(row.get("conductorMm") or 0)
        t_diel = float(row.get("dielectricMm") or 0)
        er = float(row.get("er") or 0)
        if row.get("core") or "芯板" in material or "core" in material.lower():
            if t_cond:
                out.append({"kind": "cu", "t": t_cond, "name": row.get("name")})
            out.append({"kind": "di", "t": t_diel, "er": er, "name": row.get("name")})
            if t_cond:
                out.append({"kind": "cu", "t": t_cond, "name": row.get("name")})
        elif t_cond and not t_diel:
            out.append({"kind": "cu", "t": t_cond, "name": row.get("name")})
        else:
            out.append({"kind": "di", "t": t_diel, "er": er, "name": row.get("name")})
    return out


def copper_indices(seq: list) -> list:
    return [i for i, e in enumerate(seq) if e["kind"] == "cu"]


def gap(seq: list, a: int, b: int) -> tuple:
    """(thickness mm, weighted Er) of the dielectric between two copper indices."""
    lo, hi = sorted((a, b))
    t = sum(e["t"] for e in seq[lo + 1:hi] if e["kind"] == "di")
    if t <= 0:
        return 0.0, 0.0
    er = sum(e["t"] * e["er"] for e in seq[lo + 1:hi] if e["kind"] == "di") / t
    return t, er


# ----------------------------------------------------------------- IPC-2141A closed forms

def z_microstrip(w: float, t: float, h: float, er: float) -> float:
    return (87.0 / math.sqrt(er + 1.41)) * math.log(5.98 * h / (0.8 * w + t))


def z_stripline_sym(w: float, t: float, b: float, er: float) -> float:
    return (60.0 / math.sqrt(er)) * math.log(4.0 * b / (0.67 * math.pi * (0.8 * w + t)))


def z_stripline_asym(w: float, t: float, h1: float, h2: float, er: float) -> float:
    base = (80.0 / math.sqrt(er)) * math.log(1.9 * (2.0 * h1 + t) / (0.8 * w + t))
    return base * (1.0 - h1 / (4.0 * h2)) if h2 > 0 else base


def diff_factor(spacing: float, h: float, stripline: bool) -> float:
    if h <= 0:
        return 2.0
    if stripline:
        return 2.0 * (1.0 - 0.347 * math.exp(-2.9 * spacing / h))
    return 2.0 * (1.0 - 0.48 * math.exp(-0.96 * spacing / h))


# ----------------------------------------------------------------------------- geometry

def find_stackup(name: str) -> dict:
    for s in stackups():
        if str(s.get("name") or "").upper() == name.upper():
            return s
    matches = [s for s in stackups() if name.upper() in str(s.get("name") or "").upper()]
    if len(matches) == 1:
        return matches[0]
    if matches:
        raise SystemExit("型号不唯一，候选: " + ", ".join(sorted(m["name"] for m in matches)[:12]))
    raise SystemExit(f"找不到叠层 {name}")


def geometry(stack: dict, layer: int, ref_above: int | None, ref_below: int | None) -> dict:
    seq = expand(stack["stack"])
    cu = copper_indices(seq)
    n = len(cu)
    if not 1 <= layer <= n:
        raise SystemExit(f"该叠层只有 {n} 个铜层，layer 需在 1..{n}")
    idx = cu[layer - 1]
    t = seq[idx]["t"]

    above = ref_above if ref_above else (layer - 1 if layer > 1 else None)
    below = ref_below if ref_below else (layer + 1 if layer < n else None)
    outer = layer in (1, n)

    if outer:
        ref = below if layer == 1 else above
        if ref is None:
            raise SystemExit("外层需要一个参考层")
        h, er = gap(seq, idx, cu[ref - 1])
        return {"mode": "microstrip", "t": t, "h": h, "er": er, "outer": True,
                "ref": ref, "layers": n}

    if above is None or below is None:
        raise SystemExit("内层需要上下两个参考层")
    h1, er1 = gap(seq, idx, cu[above - 1])
    h2, er2 = gap(seq, idx, cu[below - 1])
    er = (h1 * er1 + h2 * er2) / (h1 + h2) if (h1 + h2) else 0.0
    near, far = (h1, h2) if h1 <= h2 else (h2, h1)
    symmetric = abs(h1 - h2) <= 0.02 * max(h1, h2)
    return {"mode": "stripline" if symmetric else "stripline-asym",
            "t": t, "h": near, "hFar": far, "b": h1 + h2 + t, "er": er,
            "outer": False, "refAbove": above, "refBelow": below, "layers": n}


def impedance(stack: dict, layer: int, width_mil: float, spacing_mil: float, diff: bool,
              ref_above=None, ref_below=None) -> dict:
    g = geometry(stack, layer, ref_above, ref_below)
    finished_oz = float((stack.get("outerCopperOz") if g["outer"]
                         else stack.get("innerCopperOz")) or 1.0)
    # W1 is the wider (bottom) width you specify, W2 = W1 - delta is the etched top; the mean of
    # the two is fed to the closed-form equations.
    delta_mil = etch_delta_mil(finished_oz, g["outer"])
    w_eff = (width_mil - delta_mil / 2.0) * MM_PER_MIL
    s = spacing_mil * MM_PER_MIL

    if g["mode"] == "microstrip":
        z0 = z_microstrip(w_eff, g["t"], g["h"], g["er"])
        href = g["h"]
        strip = False
    elif g["mode"] == "stripline":
        z0 = z_stripline_sym(w_eff, g["t"], g["b"], g["er"])
        href = g["b"]
        strip = True
    else:
        z0 = z_stripline_asym(w_eff, g["t"], g["h"], g["hFar"], g["er"])
        href = g["b"]
        strip = True

    out = {**g, "widthMil": width_mil, "widthTopMil": width_mil - delta_mil,
           "etchDeltaMil": delta_mil, "copperOz": finished_oz, "z0": z0}
    if diff:
        out["spacingMil"] = spacing_mil
        out["zdiff"] = z0 * diff_factor(s, href, strip)
    return out


def solve_width(stack: dict, layer: int, target: float, diff: bool, spacing_mil: float,
                ref_above=None, ref_below=None) -> dict:
    key = "zdiff" if diff else "z0"
    lo, hi = 0.5, 200.0
    f = lambda w: impedance(stack, layer, w, spacing_mil, diff, ref_above, ref_below)[key]
    if f(lo) < target or f(hi) > target:
        raise SystemExit(f"目标 {target}Ω 超出 0.5–200 mil 线宽能达到的范围 "
                         f"({f(hi):.1f}–{f(lo):.1f}Ω)")
    for _ in range(80):                      # impedance decreases monotonically with width
        mid = (lo + hi) / 2
        if f(mid) > target:
            lo = mid
        else:
            hi = mid
    return impedance(stack, layer, (lo + hi) / 2, spacing_mil, diff, ref_above, ref_below)


# --------------------------------------------------------------------------------- CLI

def report(r: dict) -> None:
    mode = {"microstrip": "外层微带", "stripline": "对称带状线",
            "stripline-asym": "非对称带状线"}[r["mode"]]
    print(f"  结构        {mode}   （{r['layers']} 铜层）")
    print(f"  介质        Er {r['er']:.3f}   厚度 {r['h']*1000:.1f} um"
          + (f" / 远端 {r['hFar']*1000:.1f} um" if "hFar" in r else ""))
    print(f"  导体        {r['t']*1000:.1f} um（{r['copperOz']:.1f} oz）")
    print(f"  线宽        底 W1 {r['widthMil']:.3f} mil / 顶 W2 {r['widthTopMil']:.3f} mil"
          f"   （蚀刻补偿 {r['etchDeltaMil']:.2f} mil）")
    print(f"              = 底 {r['widthMil']*MM_PER_MIL*1000:.1f} um / "
          f"顶 {r['widthTopMil']*MM_PER_MIL*1000:.1f} um")
    print(f"  单端 Z0     {r['z0']:.2f} Ω")
    if "zdiff" in r:
        print(f"  线距        {r['spacingMil']:.3f} mil = {r['spacingMil']*MM_PER_MIL*1000:.1f} um")
        print(f"  差分 Zdiff  {r['zdiff']:.2f} Ω")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stackups", help="stackup JSON file (default: $IMPEDANCE_STACKUPS or the example)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list")
    p.add_argument("--layers", type=int)
    p.add_argument("--thickness", type=float)
    p.add_argument("--like")

    sub.add_parser("show").add_argument("stackup")

    for name in ("calc", "solve"):
        p = sub.add_parser(name)
        p.add_argument("--stackup", required=True)
        p.add_argument("--layer", type=int, required=True)
        p.add_argument("--ref-above", type=int)
        p.add_argument("--ref-below", type=int)
        p.add_argument("--diff", action="store_true")
        p.add_argument("--spacing", type=float, default=0.0, help="边缘间距 mil（差分必填）")
        if name == "calc":
            p.add_argument("--width", type=float, required=True, help="顶部线宽 mil")
        else:
            p.add_argument("--target", type=float, required=True, help="目标阻抗 Ω")

    args = ap.parse_args()
    if args.stackups:
        use_stackups(args.stackups)

    if args.cmd == "list":
        rows = stackups()
        if args.layers:
            rows = [s for s in rows if s.get("layers") == args.layers]
        if args.thickness:
            rows = [s for s in rows if abs(float(s.get("thicknessMm") or 0) - args.thickness) < 1e-6]
        if args.like:
            rows = [s for s in rows if args.like.upper() in str(s.get("name") or "").upper()]
        print(f"匹配 {len(rows)} 条")
        for s in sorted(rows, key=lambda s: str(s.get("name")))[:60]:
            print(f"  {s['name']:<26} {s['layers']}层 {s['thicknessMm']}mm  "
                  f"外{s.get('outerCopperOz')}oz 内{s.get('innerCopperOz')}oz")
        return

    if args.cmd == "show":
        s = find_stackup(args.stackup)
        print(f"{s['name']}   {s['layers']} 层  {s['thicknessMm']} mm")
        seq = expand(s["stack"])
        cu = 0
        for e in seq:
            if e["kind"] == "cu":
                cu += 1
                print(f"  L{cu:<3} 铜  {e['t']*1000:>7.1f} um   {e.get('name') or ''}")
            else:
                print(f"       介质 {e['t']*1000:>7.1f} um  Er {e['er']:<6} {e.get('name') or ''}")
        return

    if args.diff and args.spacing <= 0:
        raise SystemExit("差分计算需要 --spacing")
    s = find_stackup(args.stackup)
    print(f"{s['name']}   {s['layers']} 层 {s['thicknessMm']} mm   L{args.layer}")
    if args.cmd == "calc":
        report(impedance(s, args.layer, args.width, args.spacing, args.diff,
                         args.ref_above, args.ref_below))
    else:
        report(solve_width(s, args.layer, args.target, args.diff, args.spacing,
                           args.ref_above, args.ref_below))


if __name__ == "__main__":
    main()
