import { describe, expect, it } from "vitest";
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_FFMPEG_ALLOWLIST_PREFIXES, resolveVideoProcessorPath, validateVideoProcessorPath } from "../src/video-processor.js";

describe("video-processor", () => {

  it("resolves to bundled ffmpeg when primary path is missing", () => {

    const resolved = resolveVideoProcessorPath("/definitely/missing/ffmpeg", process.execPath);

    expect(resolved).toBeTruthy();
  });

  it("accepts executable ffmpeg in allowlisted directories", () => {

    const result = validateVideoProcessorPath(process.execPath, {

      allowlistPrefixes: [ "/" ],
      bundledFfmpegPath: process.execPath
    });

    expect(result.valid).toBe(true);
    expect(result.resolvedPath.length).toBeGreaterThan(0);
  });

  it("rejects non-executable paths", () => {

    const result = validateVideoProcessorPath("/etc/passwd", { allowlistPrefixes: [ "/" ] });

    expect(result.valid).toBe(false);
    expect(result.error).toContain("not executable");
  });

  it("rejects paths outside the allowlist", () => {

    const resolved = resolveVideoProcessorPath(process.execPath);
    const result = validateVideoProcessorPath(resolved, { allowlistPrefixes: [ "/definitely-not-a-real-prefix/" ] });

    expect(result.valid).toBe(false);
    expect(result.error).toContain("outside the allowed locations");
  });

  it("includes jellyfin prefix in defaults", () => {

    expect(DEFAULT_FFMPEG_ALLOWLIST_PREFIXES.some(prefix => prefix.includes("jellyfin"))).toBe(true);
  });

  it("accepts ffmpeg-style binary names regardless of allowlist", () => {

    const tempDir = mkdtempSync(join(tmpdir(), "hbup-ffmpeg-"));
    const ffmpegAlias = join(tempDir, "ffmpeg-custom");

    copyFileSync(process.execPath, ffmpegAlias);
    chmodSync(ffmpegAlias, 0o755);

    const result = validateVideoProcessorPath(ffmpegAlias, {

      allowlistPrefixes: [ "/not-allowed" ]
    });

    expect(result.valid).toBe(true);

    rmSync(tempDir, { force: true, recursive: true });
  });

  it("returns absolute path when no candidates resolve", () => {

    const missingPath = "relative/ffmpeg-does-not-exist";

    expect(resolveVideoProcessorPath(missingPath)).toBe(join(process.cwd(), missingPath));
  });
});
