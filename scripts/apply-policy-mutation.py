#!/usr/bin/env python3
import pathlib
import sys

from mutation_apply import apply_unique

ROOT = pathlib.Path(__file__).resolve().parent.parent
POLICY = ROOT / "src/media/stream-transcode-policy.ts"

MUTATIONS = {
    "COPY_unknown_fps": (
        """  if(!isLiveSourceFpsKnown(input.sourceFps)) {

    return { logReason: "source frame rate is unknown", mode: "transcode" };
  }

""",
        "",
    ),
    "FP2b": (
        "return Number.isFinite(sourceFps) && (sourceFps > 0);",
        "return (sourceFps > 0);",
    ),
    "FP9_unknown_fps_as_one": (
        """  if(!isLiveSourceFpsKnown(normalizedSourceFps)) {

    return input.requestedFps;
  }""",
        """  if(!isLiveSourceFpsKnown(normalizedSourceFps)) {

    return 1;
  }""",
    ),
    "FPS6_minterpolate_upscale": (
        "return platformInterpolationEnabled && isLiveSourceFpsKnown(normalizedSourceFps) && (normalizedSourceFps >= requestedFps);",
        "return platformInterpolationEnabled && isLiveSourceFpsKnown(normalizedSourceFps);",
    ),
    "I1": (
        "return platformInterpolationEnabled && isLiveSourceFpsKnown(normalizedSourceFps) && (normalizedSourceFps >= requestedFps);",
        "return platformInterpolationEnabled;",
    ),
    "DC6": (
        """  try {

    parsed = parseInit(initData);
  } catch {

    return { sourceDeclaredH264Known: false };
  }
""",
        """  try {

    parsed = parseH264AvcCFromFmp4Init(initData);
  } catch {

    return { sourceDeclaredH264Known: false };
  }
""",
    ),
    "DC4": (
        """  try {

    parsed = parseInit(initData);
  } catch {

    return { sourceDeclaredH264Known: false };
  }
""",
        """  try {

    parsed = parseInit(initData);
  } catch {

    throw new Error("dc4");
  }
""",
    ),
}


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {sys.argv[0]} <{'|'.join(MUTATIONS)}>")
    mut_id = sys.argv[1]
    if mut_id not in MUTATIONS:
        raise SystemExit(f"unknown mutation {mut_id}")
    old, new = MUTATIONS[mut_id]
    text = POLICY.read_text()
    POLICY.write_text(apply_unique(text, old, new, mut_id))


if __name__ == "__main__":
    main()