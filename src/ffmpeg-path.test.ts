/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg-path.test.ts: Resolution and validation for the configured FFmpeg executable.
 */
/* eslint-disable sort-imports -- node:path is a default import and has to follow the node:test import group this suite shares with the other unit files. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveFfmpegExecutablePath, validateConcreteFfmpegPath } from "./ffmpeg-path.ts";
import path from "node:path";
import ffmpegBundledPath from "ffmpeg-for-homebridge";

describe("ffmpeg path resolution", () => {

  test("a bare command name resolves through PATH, not the process working directory", () => {

    const pathDirectory = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-path-bin-"));
    const workingDirectory = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-path-cwd-"));
    const pathFfmpeg = path.join(pathDirectory, "ffmpeg");

    writeFileSync(pathFfmpeg, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(path.join(workingDirectory, "ffmpeg"), "#!/bin/sh\n", { mode: 0o755 });

    const resolved = resolveFfmpegExecutablePath("ffmpeg", { cwd: workingDirectory, path: pathDirectory });

    assert.equal(resolved, pathFfmpeg);
  });

  test("PATH lookup skips empty and dot entries so a later directory wins over the cwd decoy", () => {

    const usrBin = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-usrbin-"));
    const workingDirectory = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-cwd-decoy-"));
    const realFfmpeg = path.join(usrBin, "ffmpeg");

    writeFileSync(realFfmpeg, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(path.join(workingDirectory, "ffmpeg"), "#!/bin/sh\n", { mode: 0o755 });

    const pathVariable = "." + path.delimiter + usrBin;
    const resolved = resolveFfmpegExecutablePath("ffmpeg", { cwd: workingDirectory, path: pathVariable });

    assert.equal(resolved, realFfmpeg);
  });

  test("PATH lookup skips a non-executable match and keeps scanning", () => {

    const firstDirectory = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-nox-"));
    const secondDirectory = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-good-"));
    const blocked = path.join(firstDirectory, "ffmpeg-test-bin");
    const executable = path.join(secondDirectory, "ffmpeg-test-bin");

    writeFileSync(blocked, "#!/bin/sh\n", { mode: 0o644 });
    writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });

    const resolved = resolveFfmpegExecutablePath("ffmpeg-test-bin", { path: firstDirectory + path.delimiter + secondDirectory });

    assert.equal(resolved, executable);
  });

  test("an absolute bundled path resolves to itself", () => {

    if(typeof ffmpegBundledPath !== "string") {

      return;
    }

    assert.equal(path.isAbsolute(ffmpegBundledPath), true);
    assert.equal(resolveFfmpegExecutablePath(ffmpegBundledPath), ffmpegBundledPath);
  });

  test("a missing absolute path can be validated", () => {

    const missing = path.join(tmpdir(), "hbup-missing-ffmpeg-" + String(Date.now()));

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

    assert.equal(resolveFfmpegExecutablePath(relative, { cwd: tempDirectory }), path.resolve(tempDirectory, relative));
    assert.equal(validateConcreteFfmpegPath(resolveFfmpegExecutablePath(relative, { cwd: tempDirectory })), undefined);
  });

  test("PATH lookup honors execute permission", () => {

    const tempDirectory = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-bin-"));
    const executable = path.join(tempDirectory, "ffmpeg-test-bin");

    writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });

    const resolved = resolveFfmpegExecutablePath("ffmpeg-test-bin", { path: tempDirectory });

    assert.equal(resolved, executable);
  });
});
