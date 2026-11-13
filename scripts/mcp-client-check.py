"""Checks the Allocyn MCP server with the OFFICIAL MCP Python SDK (an independent client).

Runs against the in-memory contract double (packages/api/test/fixtures/sim-server.ts), over both transports:
stdio and streamable HTTP. It proves the protocol layer works with a third-party client. It does NOT prove
anything about the live network. Needs: pip install mcp
Run: python3 scripts/mcp-client-check.py
"""
import asyncio, json, os, subprocess, sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

try:
    from mcp.client.streamable_http import streamablehttp_client as http_client
except ImportError:  # newer SDK name
    from mcp.client.streamable_http import streamable_http_client as http_client

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(ROOT, "packages/api/test/fixtures/sim-server.ts")
checks = []


def g(obj, *names):
    """The SDK changed attribute naming between versions (camelCase vs snake_case): accept either."""
    for n in names:
        if hasattr(obj, n):
            return getattr(obj, n)
    raise AttributeError(f"{type(obj).__name__} has none of {names}")


def ok(name, cond, detail=""):
    checks.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))


def payload(result):
    text = "".join(getattr(c, "text", "") for c in result.content)
    return json.loads(text)


async def exercise(label, session):
    info = await session.initialize()
    ok(f"{label}: initialize returns server info", g(g(info, "server_info", "serverInfo"), "name") and g(g(info, "server_info", "serverInfo"), "version"), str(info))
    tools = (await session.list_tools()).tools
    names = {t.name for t in tools}
    ok(f"{label}: lists the tools", len(names) >= 10 and {"get_job", "list_jobs", "wait_for_job", "get_job_proof"} <= names, str(sorted(names)))
    ok(f"{label}: every tool has an input schema", all(g(t, "input_schema", "inputSchema").get("type") == "object" for t in tools))
    ok(f"{label}: tools are read-only (no write verbs)", not any(w in n for n in names for w in ("create", "accept", "submit", "evaluate_delivery", "sign")), str(sorted(names)))
    jobs = await session.call_tool("get_job", {"jobId": "job-1"})
    data = payload(jobs)
    ok(f"{label}: get_job reads job-1", not g(jobs, "is_error", "isError") and data["data"]["id"] == "job-1" and data["data"]["status"] == "VERIFIED", str(data)[:200])
    proof = payload(await session.call_tool("get_job_proof", {"jobId": "job-1"}))
    ok(f"{label}: get_job_proof answers", proof.get("success") is True, str(proof)[:200])
    missing = await session.call_tool("get_job", {"jobId": "job-99"})
    ok(f"{label}: unknown job is a tool error, not a crash", g(missing, "is_error", "isError") is True)
    bad = await session.call_tool("get_job", {"jobId": 5})
    ok(f"{label}: invalid arguments are rejected", g(bad, "is_error", "isError") is True)
    await session.send_ping()
    ok(f"{label}: ping", True)
    return names


async def run_stdio():
    params = StdioServerParameters(command="node", args=[FIXTURE, "stdio"], cwd=ROOT)
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as s:
            return await exercise("stdio", s)


async def run_http():
    proc = subprocess.Popen(["node", FIXTURE, "http"], cwd=ROOT, stdout=subprocess.PIPE, text=True)
    try:
        line = proc.stdout.readline().strip()
        port = int(line.split("=")[1])
        async with http_client(f"http://127.0.0.1:{port}/mcp") as streams:
            async with ClientSession(streams[0], streams[1]) as s:
                return await exercise("http", s)
    finally:
        proc.terminate()


async def main():
    a = await run_stdio()
    b = await run_http()
    ok("both transports expose the same tools", a == b)
    failed = [n for n, good in checks if not good]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
    sys.exit(1 if failed else 0)


asyncio.run(main())
