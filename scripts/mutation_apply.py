#!/usr/bin/env python3
"""Apply a single unique pattern replacement for mutation scripts."""


def apply_unique(text: str, old: str, new: str, mut_id: str) -> str:
    count = text.count(old)
    if count == 0:
        raise SystemExit(f"APPLY-FAIL: pattern for {mut_id} matched 0 times (needle missing from source)")
    if count != 1:
        raise SystemExit(f"APPLY-FAIL: pattern for {mut_id} matched {count} times, expected exactly 1")
    return text.replace(old, new, 1)