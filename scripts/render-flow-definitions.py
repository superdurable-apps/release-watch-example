#!/usr/bin/env python3
"""Render every Flow listed in dex-app.yaml as strict FDG 2.0.

`make check-fdg-v2` runs this. dexcli analyzes each
TypeScript Flow source with the TypeScript compiler it finds next to the
source (this project's node_modules after make bootstrap), else with the one
of DEX_TYPESCRIPT_NODE_PATH. A
`.json` source is a committed graph, such as a Dex Agents session graph,
checked against what the installed package writes (see committed).
`--output` writes the rendered definitions as JSON.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

# Dex reports a Step group that is neither one run nor one choice as this warning; it never blocks.
ADVISORY_DIAGNOSTICS = frozenset({"v2_step_group_shape"})
# Dex Web's size limit for a definitions file.
MAXIMUM_COMMITTED_GRAPH_BYTES = 8 * 1024 * 1024

ROOT = Path(__file__).resolve().parents[1]
SESSION_GRAPH_CLI = ROOT / "node_modules" / ".bin" / "dex-agents-session-graph"


def blocking_diagnostics(graph):
    return [d for d in graph.get("diagnostics") or []
            if not (d.get("severity") == "warning" and d.get("code") in ADVISORY_DIAGNOSTICS)]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, help="write the rendered definitions as JSON")
    parser.add_argument("--dexcli", default=os.environ.get("DEXCLI", "dexcli"))
    arguments = parser.parse_args()
    try:
        manifest = json.loads((ROOT / "dex-app.yaml").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as failure:
        raise SystemExit("dex-app.yaml must contain valid JSON-compatible YAML") from failure
    # A TypeScript application names each connector by its npm package and exact version.
    for connector in manifest.get("connectors") or []:
        if not isinstance(connector, dict) or not connector.get("package") or not connector.get("version"):
            raise SystemExit("each dex-app.yaml connector of a TypeScript application names its npm package and version")
    entries = manifest.get("flowDefinitions") or []
    if not entries or any(not isinstance(entry, dict) for entry in entries):
        raise SystemExit("dex-app.yaml must list each Flow source as {\"sourcePath\": ...} in flowDefinitions")
    definitions = sorted((render(entry.get("sourcePath"), arguments.dexcli) for entry in entries),
                         key=lambda definition: definition["flowType"])
    flow_types = [definition["flowType"] for definition in definitions]
    if len(set(flow_types)) != len(flow_types):
        raise SystemExit("Flow types must be unique: " + ", ".join(flow_types))
    if arguments.output:
        arguments.output.write_bytes(canonical_json(definitions) + b"\n")
    else:
        print(f"Validated {len(definitions)} strict FDG 2.0 definitions")


def compiler_environment() -> dict[str, str]:
    """The environment of dexcli: a fixed SOURCE_DATE_EPOCH makes generatedAt, and so every render of one
    source, byte-identical; NODE_PATH names a TypeScript compiler when the project has none installed."""
    environment = {**os.environ, "SOURCE_DATE_EPOCH": "0"}
    if not (ROOT / "node_modules" / "typescript").is_dir():
        pinned = os.environ.get("DEX_TYPESCRIPT_NODE_PATH", "")
        if not pinned:
            raise SystemExit("no TypeScript compiler: run make bootstrap first")
        environment["NODE_PATH"] = pinned
    return environment


def committed(source_path: str) -> dict[str, object]:
    """A committed FDG 2.0 graph (.json), such as a Dex Agents session graph, which Dex Web shows as
    committed. After make bootstrap it must equal what the installed @superdurable/dex-agents writes for the
    graph's own Flow type and Action permission, so a dependency update never leaves a stale graph behind."""
    path = ROOT / source_path
    if path.is_symlink() or path.stat().st_size > MAXIMUM_COMMITTED_GRAPH_BYTES:
        raise SystemExit(f"{source_path} must be a regular file of at most 8 MiB")
    try:
        graph = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, RecursionError) as failure:
        raise SystemExit(f"{source_path} is not a JSON FDG 2.0 graph") from failure
    flow = graph.get("flow") if isinstance(graph, dict) else None
    if (not isinstance(flow, dict) or not flow.get("name") or graph.get("schemaVersion") != "2.0"
            or graph.get("valid") is not True or not isinstance(graph.get("diagnostics"), list)
            or not all(isinstance(item, dict) for item in graph["diagnostics"]) or blocking_diagnostics(graph)):
        raise SystemExit(f"{source_path} is not a valid strict FDG 2.0 graph without diagnostics")
    if (ROOT / "node_modules").is_dir():
        v2 = graph.get("v2") if isinstance(graph.get("v2"), dict) else {}
        actions = v2.get("actions") if isinstance(v2.get("actions"), list) else []
        permissions = {action.get("requiredPermission") if isinstance(action, dict) else None for action in actions}
        if len(permissions) != 1 or not all(isinstance(permission, str) and permission for permission in permissions) or not SESSION_GRAPH_CLI.is_file():
            raise SystemExit(f"{source_path} must be a Dex Agents session graph, written by the installed "
                             "@superdurable/dex-agents with one Action permission")
        regenerate = ["npx", "--no-install", "dex-agents-session-graph", "--flow-type", flow["name"],
                      "--permission", permissions.pop()]
        written = subprocess.run(regenerate, cwd=ROOT, check=False, capture_output=True, text=True)
        try:
            current = json.loads(written.stdout) if written.returncode == 0 else None
        except json.JSONDecodeError:
            current = None
        if current != graph:
            raise SystemExit(f"{source_path} differs from the session graph of the installed @superdurable/dex-agents; "
                             f"write it again with: {' '.join(regenerate)} --out {source_path}\n{written.stderr.strip()[:2048]}")
    return {"flowType": flow["name"], "sourcePath": source_path, "schemaVersion": "2.0",
            "digest": "sha256:" + hashlib.sha256(canonical_json(graph)).hexdigest(), "valid": True, "graph": graph}


def render(source_path: object, dexcli: str) -> dict[str, object]:
    if isinstance(source_path, str) and source_path.endswith(".json") and (ROOT / source_path).is_file():
        return committed(source_path)
    if not isinstance(source_path, str) or not source_path.endswith(".ts") or not (ROOT / source_path).is_file():
        raise SystemExit(f"Flow source does not exist or is not a .ts file or a committed .json graph: {source_path}")
    with tempfile.TemporaryDirectory(prefix="fdg-") as temporary:
        output = Path(temporary) / "flow"
        result = subprocess.run(
            [dexcli, "visualize", source_path, "--language", "typescript", "--schema-version", "2.0", "--json",
             "--out", str(output)],
            cwd=ROOT, check=False, capture_output=True, text=True, env=compiler_environment())
        try:
            graph = json.loads(output.with_suffix(".json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            graph = None
    # The renderer can exit nonzero and still write actionable diagnostics; show them.
    if result.returncode != 0 or not isinstance(graph, dict) or graph.get("valid") is not True or blocking_diagnostics(graph):
        diagnostics = json.dumps(graph.get("diagnostics"), ensure_ascii=False)[:8192] if isinstance(graph, dict) else ""
        raise SystemExit(f"strict FDG 2.0 rendering failed for {source_path}: "
                         + (result.stderr or result.stdout).strip()[:2048] + "\n" + diagnostics)
    flow_type = (graph.get("flow") or {}).get("name")
    if graph.get("schemaVersion") != "2.0" or not flow_type:
        raise SystemExit(f"{source_path} did not render a named FDG 2.0 Flow")
    return {"flowType": flow_type, "sourcePath": source_path, "schemaVersion": "2.0",
            "digest": "sha256:" + hashlib.sha256(canonical_json(graph)).hexdigest(), "valid": True, "graph": graph}


def canonical_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


if __name__ == "__main__":
    main()
