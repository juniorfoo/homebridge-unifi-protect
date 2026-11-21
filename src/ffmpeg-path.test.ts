/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg-path.test.ts: Resolution and validation for the configured FFmpeg executable.
 */
/* eslint-disable sort-imports -- node:path is a default import and has to follow the node:test import group this suite shares with the other unit files. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";
import { env } from "node:process";
import assert from "node:assert/strict";
import { isBareCommandName, isConcreteFfmpegPath, resolveFfmpegExecutablePath, validateConcreteFfmpegPath } from "./ffmpeg-path.ts";
import path from "node:path";
import ffmpegBundledPath from "ffmpeg-for-homebridge";

describe("ffmpeg path resolution", () => {

  test("a bare command name resolves through PATH, not the process working directory", () => {

    const tempDirectory = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-path-"));
    const fakeCwdFfmpeg = path.join(tempDirectory, "ffmpeg");

    writeFileSync(fakeCwdFfmpeg, "#!/bin/sh\n", { mode: 0o755 });

    const previousWorkingDirectory = process.cwd();

    try {

      process.chdir(tempDirectory);
      assert.equal(isBareCommandName("ffmpeg"), true);
      assert.notEqual(resolveFfmpegExecutablePath("ffmpeg"), path.resolve("ffmpeg"));
      assert.ok(resolveFfmpegExecutablePath("ffmpeg").includes(path.sep), "PATH resolution yields an absolute path");
    } finally {

      process.chdir(previousWorkingDirectory);
    }
  });

  test("an absolute bundled path resolves to itself", () => {

    if(typeof ffmpegBundledPath !== "string") {

      throw new Error("ffmpeg-for-homebridge did not publish a bundled path");
    }

    const bundledPath = ffmpegBundledPath;

    assert.equal(path.isAbsolute(bundledPath), true);
    assert.equal(resolveFfmpegExecutablePath(bundledPath), bundledPath);
  });

  test("a missing absolute path stays concrete for validation", () => {

    const missing = path.join(tmpdir(), "hbup-missing-ffmpeg-" + String(Date.now()));

    assert.equal(isConcreteFfmpegPath(missing, resolveFfmpegExecutablePath(missing)), true);
    assert.match(validateConcreteFfmpegPath(missing) ?? "", /does not exist/);
  });

  test("a non-executable absolute path is rejected", () => {

    const tempDirectory = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-nox-"));
    const nonExecutable = path.join(tempDirectory, "ffmpeg");

    writeFileSync(nonExecutable, "#!/bin/sh\n", { mode: 0o644 });
    assert.match(validateConcreteFfmpegPath(nonExecutable) ?? "", /not executable/);
  });

  test("a relative path with a directory component resolves against the working directory", () => {

    const tempDirectory = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-rel-"));
    const relative = path.join("bin", "ffmpeg");
    const executable = path.join(tempDirectory, relative);

    mkdirSync(path.dirname(executable), { recursive: true });
    writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });

    const previousWorkingDirectory = process.cwd();

    try {

      process.chdir(tempDirectory);
      assert.equal(resolveFfmpegExecutablePath(relative), path.resolve(relative));
      assert.equal(validateConcreteFfmpegPath(resolveFfmpegExecutablePath(relative)), undefined);
    } finally {

      process.chdir(previousWorkingDirectory);
    }
  });

  test("PATH lookup honors execute permission", () => {

    const tempDirectory = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-bin-"));
    const executable = path.join(tempDirectory, "ffmpeg-test-bin");

    writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });

    const previousPath = env["PATH"];

    try {

      env["PATH"] = tempDirectory + path.delimiter + (previousPath ?? "");
      const resolved = resolveFfmpegExecutablePath("ffmpeg-test-bin");

      assert.equal(resolved, executable);
      assert.equal(isConcreteFfmpegPath("ffmpeg-test-bin", resolved), true);
    } finally {

      env["PATH"] = previousPath;
    }
  });
});
