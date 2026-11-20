#!/usr/bin/env python3
"""Upstream line-loss guard for fork merges (also run in CI).

Reads refs and allow-list paths from scripts/upstream-sync.json by default.

Allow-list format (one entry per fork delta):
  LOST:path/to/file:LINE:reason text
  RESURRECTED:path/to/file:LINE:reason text

Keys are KIND plus path plus 1-based line number in the snapshot named by kind:
  LOST        — line present in new_upstream at LINE, missing from head
  RESURRECTED — line present in head at LINE, absent from new_upstream (and not in fork_base)

The checker fails on unmatched deltas, unused allow-list keys, and (with --self-test) a planted loss.

Usage:
  scripts/check-upstream-sync.py [--config PATH] [--self-test]
"""
from __future__ import annotations

import argparse
import collections
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def git_show(rev: str, path: str) -> list[str]:
    if _GIT_SHOW_OVERRIDE is not None:
        override = _GIT_SHOW_OVERRIDE.get((rev, path))
        if override is not None:
            return override
    if rev == "HEAD":
        worktree = ROOT / path
        if worktree.is_file():
            return worktree.read_text(encoding="utf-8").splitlines()
    result = subprocess.run(
        ["git", "show", f"{rev}:{path}"],
        capture_output=True,
        text=True,
        check=False,
        cwd=ROOT,
    )
    return result.stdout.splitlines() if result.returncode == 0 else []


_GIT_SHOW_OVERRIDE: dict[tuple[str, str], list[str]] | None = None


def file_nonempty(lines: list[str]) -> bool:
    return any(line.strip() for line in lines)


def line_numbers_for_stripped(path: str, lines: list[str], stripped: str) -> list[int]:
    return [idx for idx, line in enumerate(lines, start=1) if line.strip() == stripped]


ALLOWLIST_ROW = re.compile(r"^(LOST|RESURRECTED):(.+):(\d+):(.+)$")


@dataclass(frozen=True)
class AllowEntry:
    kind: str
    path: str
    line: int
    reason: str


def load_allowlist(path: Path) -> dict[tuple[str, str, int], AllowEntry]:
    entries: dict[tuple[str, str, int], AllowEntry] = {}
    if not path.is_file():
        return entries
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = ALLOWLIST_ROW.match(line)
        if not match:
            print(f"check-upstream-sync: malformed allow-list row (expected KIND:path:line:reason): {raw}", file=sys.stderr)
            sys.exit(2)
        kind, path_part, line_str, reason = match.groups()
        lineno = int(line_str)
        reason = reason.strip()
        if not reason:
            print(f"check-upstream-sync: allow-list row missing reason: {raw}", file=sys.stderr)
            sys.exit(2)
        key = (kind, path_part.strip(), lineno)
        if key in entries:
            print(f"check-upstream-sync: duplicate allow-list key {kind}:{path_part}:{lineno}", file=sys.stderr)
            sys.exit(2)
        entries[key] = AllowEntry(kind=kind, path=path_part.strip(), line=lineno, reason=reason)
    return entries


def candidate_paths(old_upstream: str, new_upstream: str, fork_base: str, head: str) -> list[str]:
    names: set[str] = set()
    for cmd in (
        ["git", "diff", "--name-only", new_upstream, head],
        ["git", "diff", "--name-only", fork_base, head],
        ["git", "diff", "--name-only", old_upstream, new_upstream],
    ):
        result = subprocess.run(cmd, capture_output=True, text=True, check=True, cwd=ROOT)
        names.update(name for name in result.stdout.split() if name.strip())
    return sorted(names)


def scan_file(
    path: str,
    old_upstream: str,
    new_upstream: str,
    fork_base: str,
    head: str,
    allowlist: dict[tuple[str, str, int], AllowEntry],
    matched: set[tuple[str, str, int]],
) -> tuple[list[str], list[str]]:
    base = git_show(old_upstream, path)
    upstream = git_show(new_upstream, path)
    fork = git_show(fork_base, path)
    current = git_show(head, path)

    if not file_nonempty(upstream) and not file_nonempty(base):
        return [], []

    base_c = collections.Counter(line.strip() for line in base)
    up_c = collections.Counter(line.strip() for line in upstream)
    fork_c = collections.Counter(line.strip() for line in fork)
    head_c = collections.Counter(line.strip() for line in current)

    lost_lines = [line for line in (up_c - base_c) if line and head_c[line] == 0]
    resurrected_lines = [
        line
        for line in (base_c - up_c)
        if line and head_c[line] > 0 and (fork_c - base_c)[line] == 0 and up_c[line] == 0
    ]

    problems: list[str] = []
    report: list[str] = []

    for stripped in lost_lines:
        for lineno in line_numbers_for_stripped(path, upstream, stripped):
            key = ("LOST", path, lineno)
            entry = allowlist.get(key)
            if entry:
                matched.add(key)
                report.append(f"ALLOWED LOST {path}:{lineno}: {entry.reason}")
            else:
                problems.append(f"LOST {path}:{lineno}: {stripped[:160]}")

    for stripped in resurrected_lines:
        for lineno in line_numbers_for_stripped(path, current, stripped):
            key = ("RESURRECTED", path, lineno)
            entry = allowlist.get(key)
            if entry:
                matched.add(key)
                report.append(f"ALLOWED RESURRECTED {path}:{lineno}: {entry.reason}")
            else:
                problems.append(f"RESURRECTED {path}:{lineno}: {stripped[:160]}")

    return problems, report


def run_check(config: dict, allow_path: Path) -> int:
    old_upstream = config["old_upstream"]
    new_upstream = config["new_upstream"]
    fork_base = config["fork_base"]
    head = config["head"]

    allowlist = load_allowlist(allow_path)
    matched: set[tuple[str, str, int]] = set()
    all_problems: list[str] = []
    allowed_report: list[str] = []

    for path in candidate_paths(old_upstream, new_upstream, fork_base, head):
        problems, report = scan_file(path, old_upstream, new_upstream, fork_base, head, allowlist, matched)
        all_problems.extend(problems)
        allowed_report.extend(report)

    stale = [key for key in allowlist if key not in matched]
    if stale:
        all_problems.extend(
            f"STALE ALLOWLIST {kind}:{path}:{lineno}: {allowlist[(kind, path, lineno)].reason}"
            for kind, path, lineno in sorted(stale)
        )

    if all_problems:
        print("check-upstream-sync: FAIL")
        for item in all_problems:
            print(" ", item)
        print(f"  allow-list entries: {len(allowlist)} matched {len(matched)} stale {len(stale)}")
        return 1

    print("check-upstream-sync: clean")
    print(f"  allow-list entries: {len(allowlist)} (all matched deliberate fork deltas)")
    return 0


def self_test_loss(config: dict, allow_path: Path) -> int:
    """Verify the guard fails when a known upstream line is missing from head."""
    global _GIT_SHOW_OVERRIDE
    probe = "src/media/stream-encode-policy.ts"
    upstream_lines = git_show(config["new_upstream"], probe)
    if not upstream_lines:
        print("self-test-loss: skip (no upstream snapshot for stream-encode-policy.ts)", file=sys.stderr)
        return 0
    target_idx = next((i for i, line in enumerate(upstream_lines) if line.strip()), None)
    if target_idx is None:
        print("self-test-loss: skip (empty upstream file)", file=sys.stderr)
        return 0
    lineno = target_idx + 1
    head_lines = git_show(config["head"], probe)
    planted = [line for i, line in enumerate(head_lines) if i != target_idx]

    _GIT_SHOW_OVERRIDE = {(config["head"], probe): planted}
    code = run_check(config, allow_path)
    _GIT_SHOW_OVERRIDE = None

    if code == 0:
        print("self-test-loss: FAIL (expected failure after planted loss)", file=sys.stderr)
        print(f"  planted removal: {probe}:{lineno}", file=sys.stderr)
        return 1
    print(f"self-test-loss: OK (detected planted loss at {probe}:{lineno})")
    return 0


def self_test_resurrection(config: dict, allow_path: Path) -> int:
    """Verify the guard fails when a resurrected upstream-removed line appears on head."""
    global _GIT_SHOW_OVERRIDE
    probe = "src/media/stream.ts"
    fork_lines = git_show(config["fork_base"], probe)
    upstream_lines = git_show(config["new_upstream"], probe)
    head_lines = git_show(config["head"], probe)
    if not fork_lines or not upstream_lines:
        print("self-test-resurrection: skip (missing stream.ts snapshots)", file=sys.stderr)
        return 0
    base_c = collections.Counter(line.strip() for line in fork_lines)
    up_c = collections.Counter(line.strip() for line in upstream_lines)
    resurrected = [line for line in (base_c - up_c) if line and up_c[line] == 0]
    if not resurrected:
        print("self-test-resurrection: skip (no resurrected candidates)", file=sys.stderr)
        return 0
    planted_line = resurrected[0]
    planted = [*head_lines, planted_line]
    lineno = len(planted)
    _GIT_SHOW_OVERRIDE = {(config["head"], probe): planted}
    code = run_check(config, allow_path)
    _GIT_SHOW_OVERRIDE = None
    if code == 0:
        print("self-test-resurrection: FAIL (expected failure after planted resurrection)", file=sys.stderr)
        print(f"  planted line at {probe}:{lineno}", file=sys.stderr)
        return 1
    print(f"self-test-resurrection: OK (detected planted resurrection at {probe}:{lineno})")
    return 0


def self_test(config: dict, allow_path: Path) -> int:
    if self_test_loss(config, allow_path) != 0:
        return 1
    if self_test_resurrection(config, allow_path) != 0:
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Upstream line sync guard for fork merges.")
    parser.add_argument("--config", type=Path, default=ROOT / "scripts" / "upstream-sync.json")
    parser.add_argument("--self-test", action="store_true", help="Run planted-loss self-test after normal check")
    args = parser.parse_args()

    config = json.loads(args.config.read_text(encoding="utf-8"))
    allow_path = (ROOT / config["allowlist"]).resolve() if not Path(config["allowlist"]).is_absolute() else Path(config["allowlist"])

    code = run_check(config, allow_path)
    if code != 0:
        return code
    if args.self_test:
        return self_test(config, allow_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())