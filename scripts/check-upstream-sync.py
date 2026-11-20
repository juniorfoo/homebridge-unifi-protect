#!/usr/bin/env python3
"""Line-level upstream sync guard for fork merges (manual use during syncs, not CI).

Usage:
  scripts/check-upstream-sync.py OLD_UPSTREAM NEW_UPSTREAM FORK_BASE HEAD [ALLOWLIST]

Arguments are git refs (tags or commits). Example during a v8.2.2 sync:

  scripts/check-upstream-sync.py v8.1.0 v8.2.2 c0b913d HEAD scripts/upstream-sync-allowlist.txt

For each file that differs between NEW_UPSTREAM and HEAD, compares stripped line multisets:
  - LOST: lines added in upstream (NEW vs OLD) but absent from HEAD (should be present unless allow-listed)
  - RESURRECTED: lines removed upstream (OLD vs NEW) that reappear in HEAD without being in FORK_BASE

ALLOWLIST is optional: one stripped line per row (exact match); deliberate fork deltas only.
"""
from __future__ import annotations

import collections
import subprocess
import sys
from pathlib import Path


def git_show(rev: str, path: str) -> list[str]:
    result = subprocess.run(
        ["git", "show", f"{rev}:{path}"],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.splitlines() if result.returncode == 0 else []


def load_allowlist(path: Path | None) -> set[str]:
    if not path or not path.is_file():
        return set()

    return {line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip() and not line.startswith("#")}


def main() -> int:
    if len(sys.argv) < 5:
        print(__doc__, file=sys.stderr)
        return 2

    old_upstream, new_upstream, fork_base, head = sys.argv[1:5]
    allow_path = Path(sys.argv[5]) if len(sys.argv) > 5 else None
    allowed = load_allowlist(allow_path)

    diff_names = subprocess.run(
        ["git", "diff", "--name-only", new_upstream, head],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()

    exit_code = 0
    for rel in diff_names:
        if not rel.strip():
            continue
        base = git_show(old_upstream, rel)
        upstream = git_show(new_upstream, rel)
        fork = git_show(fork_base, rel)
        current = git_show(head, rel)
        if not upstream:
            continue

        base_c = collections.Counter(line.strip() for line in base)
        up_c = collections.Counter(line.strip() for line in upstream)
        fork_c = collections.Counter(line.strip() for line in fork)
        head_c = collections.Counter(line.strip() for line in current)

        lost = [line for line in (up_c - base_c) if line and head_c[line] == 0 and line not in allowed]
        resurrected = [
            line
            for line in (base_c - up_c)
            if line and head_c[line] > 0 and (fork_c - base_c)[line] == 0 and up_c[line] == 0 and line not in allowed
        ]

        if lost or resurrected:
            exit_code = 1
            print(
                f"=== {rel}: upstream-added missing in head={len(lost)}, "
                f"upstream-removed resurrected={len(resurrected)}"
            )
            for line in lost:
                print("  LOST:", line[:200])
            for line in resurrected:
                print("  RESURRECTED:", line[:200])

    if exit_code == 0:
        print("check-upstream-sync: clean (no unexpected upstream line loss/resurrection)")

    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())