#!/usr/bin/env python3
"""Local impedance panel: target impedance -> trace width / spacing, served on 127.0.0.1.

The solver is offline (impedance.py, IPC-2141A closed forms) and reads stackups from a JSON file
you provide. Nothing is sent anywhere.

    python server.py                                   # bundled example stackups
    python server.py --stackups my_fab_stackups.json --port 8780
"""
from __future__ import annotations

import argparse
import http.server
import json
import pathlib
import socketserver
import sys
import traceback
import urllib.parse

HERE = pathlib.Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import impedance as imp  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

STATIC = HERE / "static"


def list_stackups() -> dict:
    rows = [{"name": s.get("name"), "layers": s.get("layers"), "thicknessMm": s.get("thicknessMm")}
            for s in imp.stackups()]
    return {"stackups": rows}


def solve_impedance(payload: dict) -> dict:
    """Target impedance -> trace width (and spacing for differential pairs).

    Input: target ohms (required), layer (default 1), diff, spacing (edge spacing in mil, required
    for diff), stackup (name; defaults to the first one in the file).
    """
    try:
        name = str(payload.get("stackup") or "").strip()
        stack = imp.find_stackup(name) if name else imp.stackups()[0]
        diff = bool(payload.get("diff"))
        spacing = float(payload.get("spacing") or 0)
        if diff and spacing <= 0:
            return {"error": "差分需要线距 spacing（mil） / differential pairs need spacing (mil)"}
        result = imp.solve_width(stack, int(payload.get("layer") or 1), float(payload["target"]),
                                 diff, spacing)
        return {"result": result, "stackup": stack.get("name"), "unit": "mil"}
    except KeyError:
        return {"error": "缺少 target（目标阻抗 Ω） / missing target"}
    except SystemExit as exc:                      # impedance.py reports domain errors this way
        return {"error": str(exc)}
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(STATIC), **kw)

    def log_message(self, fmt, *args):
        pass

    def _json(self, payload, status=200):
        raw = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if urllib.parse.urlparse(self.path).path == "/api/stackups":
            try:
                return self._json(list_stackups())
            except Exception as exc:
                return self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)
        return super().do_GET()

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            payload = {}
        try:
            if u.path == "/api/impedance":
                return self._json(solve_impedance(payload))
        except Exception as exc:
            return self._json({"error": f"{type(exc).__name__}: {exc}",
                               "trace": traceback.format_exc()[-1500:]}, 500)
        return self._json({"error": "unknown endpoint"}, 404)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stackups", type=pathlib.Path, help="stackup JSON (default: example file)")
    ap.add_argument("--port", type=int, default=8780)
    a = ap.parse_args()
    if a.stackups:
        imp.use_stackups(a.stackups)
    print(f"叠层 / stackups: {len(imp.stackups())}")
    print(f"http://127.0.0.1:{a.port}")
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", a.port), Handler) as httpd:
        httpd.serve_forever()


if __name__ == "__main__":
    main()
