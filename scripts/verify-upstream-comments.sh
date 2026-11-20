#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 <<'PY'
import pathlib, sys

media_text = ""
for path in sorted(pathlib.Path("src/media").rglob("*.ts")):
  if path.name.endswith(".test.ts"):
    continue
  media_text += path.read_text() + "\n"

required = [
  "Consume Segments from a livestream subscription",
  "not written here. Skip it.",
  "We transcode based in the following circumstances:",
  "Check to see if we're transcoding. If we are, set the right FFmpeg encoder options. If not, copy the video stream.",
  "Configure our audio parameters.",
  "Some housekeeping for our FFmpeg and demuxer sessions.",
  "This closes the stop-during-establishment race; an organic FFmpeg exit during the",
  "so no separate pending delete is needed below.",
  "Delete the ongoing entry. The pending entry, if there was one, was already deleted by the disposal helper.",
]

missing = [snippet for snippet in required if snippet not in media_text]
if missing:
  print("MISSING required upstream comment fragments:")
  for snippet in missing:
    print("-", snippet)
  sys.exit(1)

print("OK: round-19 required upstream comment fragments present in src/media/*.ts")
PY