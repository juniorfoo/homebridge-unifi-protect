#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
git show origin/main:src/media/stream.ts > /tmp/upstream-stream.ts
python3 <<'PY'
import pathlib, re, sys, subprocess

upstream = pathlib.Path("/tmp/upstream-stream.ts").read_text()
media_text = ""
for path in sorted(pathlib.Path("src/media").rglob("*.ts")):
  if path.name.endswith(".test.ts"):
    continue
  media_text += path.read_text() + "\n"

def comment_blocks(text: str) -> list[str]:
  blocks: list[str] = []
  for match in re.finditer(r"//[^\n]*(?:\n\s*//[^\n]*)*", text):
    block = match.group(0).strip()
    if block.startswith("//"):
      blocks.append(block)
  for match in re.finditer(r"/\*[\s\S]*?\*/", text):
    blocks.append(match.group(0).strip())
  return blocks

missing: list[str] = []
for block in comment_blocks(upstream):
  normalized = re.sub(r"\s+", " ", block)
  media_normalized = re.sub(r"\s+", " ", media_text)
  if normalized not in media_normalized and block not in media_text:
    missing.append(block)

if missing:
  print("Upstream stream.ts comment blocks not found verbatim in src/media/*.ts:")
  for block in missing:
    snippet = block.replace("\n", " ")[:120]
    print("-", snippet + ("..." if len(block) > 120 else ""))
  sys.exit(1)

print("OK: every upstream stream.ts comment block appears verbatim somewhere in src/media/*.ts")
PY