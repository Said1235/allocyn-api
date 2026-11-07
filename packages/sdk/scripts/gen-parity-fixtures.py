#!/usr/bin/env python3
"""Generate lib/contract/fixtures/parity.json by running the REAL helper functions of the vendored
contract (contract/smart_agreement.py) on a fixed corpus of inputs.

The TypeScript tests (lib/contract/parity.test.ts) replay the same inputs through the app's code and
require identical results. Regenerate whenever contract/smart_agreement.py changes:

    python3 scripts/gen-parity-fixtures.py

No GenLayer package is needed: only the pure helper functions are executed, with a tiny stand-in for
the `genlayer` module (the contract's storage classes are never instantiated).
"""
import hashlib
import json
import pathlib
import sys
import types

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "contract" / "smart_agreement.py"
OUT = ROOT / "lib" / "contract" / "fixtures" / "parity.json"


class UserError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


def build_namespace():
    gl = types.SimpleNamespace()
    gl.Contract = object
    gl.vm = types.SimpleNamespace(UserError=UserError, Return=object)
    gl.public = types.SimpleNamespace(
        write=lambda f: f, view=lambda f: f
    )
    class _Any:
        def __class_getitem__(cls, item):
            return cls
    ns = {
        "__name__": "workproof_contract",
        "gl": gl,
        "allow_storage": lambda c: c,
        "Address": _Any,
        "DynArray": _Any,
        "TreeMap": _Any,
        "u32": int,
        "u256": int,
    }
    return ns


def load_contract():
    text = SRC.read_bytes().decode("utf-8")
    lines = [l for l in text.splitlines() if l.strip() != "from genlayer import *"]
    ns = build_namespace()
    exec(compile("\n".join(lines), str(SRC), "exec"), ns)
    return ns


def run(fn, *args):
    try:
        return {"ok": True, "value": fn(*args)}
    except UserError as e:
        return {"ok": False, "kind": "user_error", "message": e.message}
    except Exception as e:  # not a UserError: the contract would fail with a generic error
        return {"ok": False, "kind": "exception", "message": type(e).__name__}


# Boundary cases are derived from the contract's own constants, never retyped.
_NS = load_contract()
_T, _D, _C, _U = _NS["MAX_TITLE_LEN"], _NS["MAX_DESCRIPTION_LEN"], _NS["MAX_CRITERION_LEN"], _NS["MAX_URL_LEN"]
_BOUNDARY = [("x" * n) for L in (_T, _D, _C) for n in (L - 1, L, L + 1)]
_BOUNDARY += [(c * n) for L in (_T, _C) for n in (L, L + 1) for c in ("é", "😀")]

TEXTS = [
    "Logo files", "  padded  ", "", "   ", "\t\n", "a", *_BOUNDARY, "a😀b", "é" * 60,
    "with\nnewline", "with\ttab", "with\rcarriage", "bell\x07", "nul\x00", "del\x7f",
    "\x1cstrip-me\x1d", "\x85next-line\x85", "﻿lead-bom", "tail-bom﻿",
    "\xa0nbsp\xa0", " em space ", "　ideographic　", "a​b",
    "Ünïcödé títle", "日本語のタイトル", "Mixed  inner   spaces", "Tab\tinside", "Line1\n\nLine3",
    " line sep ", "end\n", "\nstart",
]

MAX_LENS = [_T, _D, _C, 5]

URLS = [
    "https://example.com", "https://example.com/", "https://example.com/path?q=1",
    "https://example.com/a/b/c.md", "https://Example.COM/Path", "https://sub.domain.example.org/x",
    "https://example.com:443/x", "https://example.com:0443/x", "https://example.com:8443/x",
    "https://example.com:80/x", "https://example.com:/x", "https://example.com:abc/x",
    "https://example.com:99999/x", "https://example.com:443:80/x", "https://example.com:-1/x",
    "http://example.com", "HTTPS://example.com", "ftp://example.com", "javascript:alert(1)",
    "//example.com", "example.com", "https:/example.com", "https://", "https:///path",
    "https://user@example.com", "https://user:pw@example.com", "https://@example.com",
    "https://example.com#frag", "https://example.com/#frag", "https://example.com/#",
    "https://example.com/p#", "https://example.com/p?x=1#y",
    "https://localhost/x", "https://LOCALHOST/x", "https://printer.local/x", "https://a.localhost/x",
    "https://intranet/x", "https://nodot", "https://192.168.0.1/x", "https://8.8.8.8/x",
    "https://127.0.0.1/", "https://0x7f.0.0.1/", "https://2130706433/", "https://1.2.3/x",
    "https://[::1]/x", "https://[2001:db8::1]/x", "https://[1.2.3.4]/x", "https://[a.b.com]/x",
    "https://example.com./x", "https://exa mple.com", "https://example.com/a b", "https://example.com/\tx",
    "https://-bad.example.com", "https://bad-.example.com", "https://a..example.com",
    "https://.example.com", "https://" + "a" * 63 + ".com", "https://" + "a" * 64 + ".com",
    "https://example.c", "https://example.c0m", "https://example.123", "https://example.co-m",
    "https://example.xn--p1ai", "https://example.xn--", "https://xn--bcher-kva.example",
    "https://bücher.example", "https://münchen.de/x", "https://例え.jp", "https://example.com/é",
    "https://example.com/😀", "https://EXAMPLE.COM:443", "https://example\u212a.com", "https://example.com\\@evil.com",
    "https://example.com@evil.com", "https://evil.com\\.example.com", "https://example.invalid",
    "https://a.test", "https://a.example", "https://a.lan", "https://a.home", "https://a.corp",
    "https://a.internal", "https://a.intranet", "https://a.localdomain", "https://a.localhost",
    "https://example.org/" + "a" * (_U - 20), "https://example.org/" + "a" * (_U - 19), "https://example.org/" + "a" * (_U + 100),
    "  https://example.com/padded  ", "\thttps://example.com", "https://example.com\n", "https://exam\x07ple.com",
    "https://exam\x7fple.com", "https://example.com?query", "https://example.com?#", "https://a-b.example.com/x",
    "https://a_b.example.com", "https://example.com:443@evil.com", "https://example.com%2e/x",
    "https://example.com/%20", "https://1example.com", "https://example-.com", "https://ex.am.ple.co.uk/x",
]

TERMS = [
    {"title": "Logo files", "description": "A short description.", "criteria": [("C1", "First"), ("C2", "Second")]},
    {"title": "Ünïcödé 日本 😀", "description": "Line1\nLine2\tTabbed \"quoted\" \\ back",
     "criteria": [("C1", "É criterion"), ("C2", "emoji 😀"), ("C3", "del\x7f? no")][:2]},
    {"title": "t", "description": "d", "criteria": [("C1", "a"), ("C2", "b"), ("C3", "c"), ("C4", "d"), ("C5", "e")]},
    {"title": "Quotes \" and \\ slashes /", "description": "<script>alert(1)</script> & more", "criteria": [("C1", "x"), ("C2", "y")]},
]

ADDRESSES = [
    ("0x" + "ab" * 20, "0x" + "cd" * 20),
    ("0x5729a3b514654Ec5966A1DCa8e5088ef7A70bBDA", "0x1111111111111111111111111111111111111111"),
]

OVERALL = [
    [], ["MET"], ["MET", "MET"], ["MET", "NOT_MET"], ["NOT_MET", "NOT_MET"], ["MET", "UNVERIFIABLE"],
    ["NOT_MET", "UNVERIFIABLE"], ["UNVERIFIABLE"], ["MET", "MET", "MET", "MET", "MET"],
    ["MET", "NOT_MET", "UNVERIFIABLE", "MET"],
]

WS = [
    "", " ", "a", "  a  b   c  ", "a\tb\nc\rd", "\x1ca\x1d", "\x85a\x85", " a b　c",
    "a​b", "😀  😀", "Mixed Case TEXT", "İSTANBUL", "ΣΊΣΥΦΟΣ", "ǅ", "ß", "\u212a", "K", "é",
]


def main():
    ns = load_contract()
    src_bytes = SRC.read_bytes()
    out = {
        "sourceSha256": hashlib.sha256(src_bytes).hexdigest(),
        "python": sys.version.split()[0],
        "constants": {
            k: ns[k]
            for k in (
                "SCHEMA_VERSION", "MIN_CRITERIA", "MAX_CRITERIA", "MAX_DELIVERIES", "MAX_TITLE_LEN",
                "MAX_DESCRIPTION_LEN", "MAX_CRITERION_LEN", "MAX_URL_LEN", "MAX_CONTENT_BYTES",
                "MAX_EXCERPT_LEN", "MIN_EXCERPT_LEN",
            )
        },
        "reservedTlds": list(ns["RESERVED_TLDS"]),
        "reasonForStatus": ns["REASON_FOR_STATUS"],
        "cleanText": [],
        "cleanUrl": [],
        "text": [],
        "terms": [],
        "agreement": [],
        "canonical": [],
        "overall": [],
    }
    for t in TEXTS:
        for max_len in MAX_LENS:
            for nl in (False, True):
                out["cleanText"].append(
                    {"value": t, "max": max_len, "newlines": nl, "result": run(ns["_clean_text"], t, "field", max_len, nl)}
                )
    for u in URLS:
        out["cleanUrl"].append({"value": u, "result": run(ns["_clean_url"], u)})
    for w in WS:
        out["text"].append({
            "value": w,
            "strip": w.strip(),
            "normWs": ns["_norm_ws"](w),
            "len": len(w),
            "dupKey": ns["_norm_ws"](w.strip()).lower(),
        })
    for t in TERMS:
        crit = [{"id": i, "text": x} for i, x in t["criteria"]]
        out["terms"].append({
            "title": t["title"], "description": t["description"], "criteria": crit,
            "hash": ns["_terms_hash"](t["title"], t["description"], crit),
            "canonical": ns["_canonical_bytes"]({
                "v": ns["SCHEMA_VERSION"], "title": t["title"], "description": t["description"],
                "criteria": [{"id": c["id"], "text": c["text"]} for c in crit],
            }).decode("ascii"),
        })
    for client, worker in ADDRESSES:
        th = out["terms"][0]["hash"]
        hexc = bytes.fromhex(client[2:]).hex()
        hexw = bytes.fromhex(worker[2:]).hex()
        out["agreement"].append({
            "jobId": "job-7", "client": client, "worker": worker, "termsHash": th,
            "hash": ns["_agreement_hash"]("job-7", hexc, hexw, th),
        })
    for obj in [
        {}, {"b": 1, "a": 2}, {"k": "é"}, {"k": "\x7f"}, {"k": "😀"}, {"k": "\n\t\"\\/"},
        {"list": [1, "a", None, True, False]}, {"nested": {"z": 1, "a": {"y": 2, "b": 3}}},
        {"n": -5}, {"s": "  "}, {"s": "\x00\x1f"},
    ]:
        out["canonical"].append({"input": obj, "output": ns["_canonical_bytes"](obj).decode("ascii")})
    for s in OVERALL:
        out["overall"].append({"statuses": s, "result": ns["_derive_overall"](s)})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=True, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(out['cleanText'])} text, {len(out['cleanUrl'])} url cases")


if __name__ == "__main__":
    main()
