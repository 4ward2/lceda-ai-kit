#!/usr/bin/env python3
"""Impedance as a routing constraint, per signal class.

Two modes, kept separate on purpose because they have different standing:

  spec    the target impedance each interface standard asks for. These are reference values from
          the interface specifications, not measurements -- check one against the standard before
          committing a board to it.
  solve   given a stackup and a layer, the trace geometry that hits a class's target. This is the
          constraint solved backwards, and it is what you actually need while routing.

    python signal_impedance.py spec
    python signal_impedance.py solve --stackup EXAMPLE-6L-1.6 --layer 1 --class PCIE DDR USB2
"""
from __future__ import annotations

import argparse
import collections
import json
import math
import pathlib
import re
import statistics
import sys

HERE = pathlib.Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


# 分类法的唯一真相源是 signal_taxonomy —— 类别正则、差分配对写法、受控性三档
# 都在那里定义并已在 76151 个真实网名上审计过（tools/signal_classify_audit.py）。
from signal_taxonomy import (CLASSES, CONTROLLED, EXCLUDE,  # noqa: E402,F401
                             Klass, classify, classify_in_board, diff_nets)


def cmd_spec(args) -> None:
    print(f"{'类别':<12}{'单端Ω':>7}{'差分Ω':>7}  说明")
    for k in sorted(CLASSES, key=lambda k: k.name):
        se = f"{k.se}" if k.se else "-"
        diff = f"{k.diff}" if k.diff else "-"
        print(f"{k.name:<12}{se:>7}{diff:>7}  {k.note}")
    print("\n注：以上为各接口规范的目标值，属参考口径，不是本语料的实测值。"
          "PCIe 的 85 与 100 之争、ADC/DAC 是否需要控阻抗，都随设计而异，落板前请按实际规范确认。")


def cmd_solve(args) -> None:
    from impedance import find_stackup, solve_width, use_stackups

    if args.stackups:
        use_stackups(args.stackups)
    stack = find_stackup(args.stackup)
    wanted = [k for k in CLASSES if not args.klass or k.name in {c.upper() for c in args.klass}]
    if not wanted:
        raise SystemExit(f"未知类别；可选: {', '.join(k.name for k in CLASSES)}")

    print(f"{stack['name']}   {stack['layers']} 层 {stack['thicknessMm']} mm   L{args.layer}")
    print(f"\n{'类别':<12}{'目标':<10}{'线宽(底)mil':>12}{'线宽(顶)mil':>12}{'线距mil':>9}  备注")
    for k in wanted:
        for label, target, diff in (("单端", k.se, False), ("差分", k.diff, True)):
            if not target:
                continue
            try:
                if diff:
                    r = solve_width(stack, args.layer, target, True, args.spacing,
                                    args.ref_above, args.ref_below)
                    gap = f"{args.spacing:.2f}"
                else:
                    r = solve_width(stack, args.layer, target, False, 0.0,
                                    args.ref_above, args.ref_below)
                    gap = "-"
            except SystemExit as exc:
                print(f"{k.name:<12}{label+str(target)+'Ω':<10}{'无解':>12}  {exc}")
                continue
            print(f"{k.name:<12}{label + str(target) + 'Ω':<10}"
                  f"{r['widthMil']:>12.2f}{r['widthTopMil']:>12.2f}{gap:>9}  {r['mode']}")
    print(f"\n差分按边缘间距 {args.spacing} mil 求解（--spacing 可改）。"
          "单端与差分的适用性见 `spec` 模式的说明。")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("spec").set_defaults(fn=cmd_spec)

    p = sub.add_parser("solve")
    p.add_argument("--stackup", required=True)
    p.add_argument("--layer", type=int, required=True)
    p.add_argument("--class", dest="klass", nargs="*", default=[])
    p.add_argument("--spacing", type=float, default=5.0, help="差分边缘间距 mil")
    p.add_argument("--ref-above", type=int)
    p.add_argument("--ref-below", type=int)
    p.add_argument("--stackups", help="stackup JSON file")
    p.set_defaults(fn=cmd_solve)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
