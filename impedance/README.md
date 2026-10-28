# impedance

Offline controlled-impedance tools: give a target impedance, get the trace width
(and spacing for differential pairs) for a layer of your stackup.

- `impedance.py` — IPC-2141A closed-form solver: microstrip, symmetric and
  asymmetric stripline, differential coupling, trapezoidal etch compensation,
  core layers expanded to copper/dielectric/copper. Width is found by bisection.
- `signal_impedance.py` + `signal_taxonomy.py` — per signal class (USB2, PCIe,
  DDR, …) reference targets from interface specs, solved on your stackup.
- `server.py` + `static/index.html` — a local web panel (127.0.0.1) over the solver.
- `examples/stackups.example.json` — **hand-written example values**, for trying
  the tools only. Replace them with your fab's stackup.

```sh
python impedance.py list
python impedance.py solve --stackup EXAMPLE-4L-1.6 --layer 1 --target 50
python impedance.py solve --stackup EXAMPLE-4L-1.6 --layer 1 --target 90 --diff --spacing 6
python signal_impedance.py spec
python signal_impedance.py solve --stackup EXAMPLE-6L-1.6 --layer 1 --class USB2
python server.py --stackups my_stackups.json        # http://127.0.0.1:8780
```

Use your own stackups with `--stackups FILE` or `IMPEDANCE_STACKUPS=FILE`.
Format: see the example file (`stackups[].stack[]` rows with `conductorMm`,
`dielectricMm`, `er`, optional `core: true`; `etchCompensation[]` rows with
`layer` = `outer`/`inner`, `copperOz`, `widthDeltaMil`).

The closed-form equations approximate a 2D field solve to within a few percent
inside their validity range. Treat the output as a starting width and confirm it
with your fab before committing a critical board.

## 中文

离线阻抗计算：给目标阻抗，反解某一层的线宽（差分还给线距）。公式为 IPC-2141A 闭式解，
叠层从你自己提供的 JSON 读取；附带的示例叠层是手写的演示数值，不是任何板厂的数据。结果是起始线宽，落板前请与板厂核对。
