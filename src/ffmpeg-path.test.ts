/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg-path.test.ts: Resolution and validation for the configured FFmpeg executable.
 */
/* eslint-disable sort-imports -- node:path is a default import and has to follow the node:test import group this suite shares with the other unit files. */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveFfmpegExecutablePath, validateConcreteFfmpegPath } from "./ffmpeg-path.ts";
import path from "node:path";
import ffmpegBundledPath from "ffmpeg-for-homebridge";

describe("ffmpeg path resolution", () => {

  test("a bare command name resolves through an absolute PATH directory, not the cwd decoy", () => {

    const binDirectory = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-path-bin-"));
    const workingDirectory = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-path-cwd-"));
    const pathFfmpeg = path.join(binDirectory, "ffmpeg");

    writeFileSync(pathFfmpeg, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(path.join(workingDirectory, "ffmpeg"), "#!/bin/sh\n", { mode: 0o755 });

    const resolved = resolveFfmpegExecutablePath("ffmpeg", { cwd: workingDirectory, path: binDirectory });

    assert.equal(resolved, pathFfmpeg);
  });

  test("an empty PATH segment is skipped so only the absolute directory is searched", () => {

    const binDirectory = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-empty-seg-"));
    const workingDirectory = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-empty-cwd-"));
    const pathFfmpeg = path.join(binDirectory, "ffmpeg");

    writeFileSync(pathFfmpeg, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(path.join(workingDirectory, "ffmpeg"), "#!/bin/sh\n", { mode: 0o755 });

    const pathVariable = path.delimiter + binDirectory;
    const resolved = resolveFfmpegExecutablePath("ffmpeg", { cwd: workingDirectory, path: pathVariable });

    assert.equal(resolved, pathFfmpeg);
  });

  test("a lone dot PATH segment is skipped because non-absolute PATH entries are ignored", () => {

    const binDirectory = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-dot-only-"));
    const workingDirectory = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-dot-cwd-"));

    writeFileSync(path.join(binDirectory, "ffmpeg"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(path.join(workingDirectory, "ffmpeg"), "#!/bin/sh\n", { mode: 0o755 });

    const resolved = resolveFfmpegExecutablePath("ffmpeg", { cwd: workingDirectory, path: "." });

    assert.equal(resolved, "ffmpeg");
    assert.equal(path.isAbsolute(resolved), false);
  });

  test("a relative PATH segment alone is skipped so a later absolute directory wins", () => {

    const relativeOnly = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-rel-only-"));
    const binDirectory = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-rel-bin-"));
    const pathFfmpeg = path.join(binDirectory, "ffmpeg-test-bin");

    writeFileSync(path.join(relativeOnly, "ffmpeg-test-bin"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(pathFfmpeg, "#!/bin/sh\n", { mode: 0o755 });

    const pathVariable = path.basename(relativeOnly) + path.delimiter + binDirectory;
    const resolved = resolveFfmpegExecutablePath("ffmpeg-test-bin", { cwd: path.dirname(relativeOnly), path: pathVariable });

    assert.equal(resolved, pathFfmpeg);
  });

  test("absolute PATH entries that canonicalize to cwd are skipped", () => {

    const workingDirectory = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-aliases-"));
    const binDirectory = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-aliases-bin-"));
    const pathFfmpeg = path.join(binDirectory, "ffmpeg");

    writeFileSync(pathFfmpeg, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(path.join(workingDirectory, "ffmpeg"), "#!/bin/sh\n", { mode: 0o755 });

    for(const alias of [ workingDirectory + path.sep + ".", workingDirectory + path.sep + "//.", workingDirectory + "//." ]) {

      const pathVariable = alias + path.delimiter + binDirectory;
      const resolved = resolveFfmpegExecutablePath("ffmpeg", { cwd: workingDirectory, path: pathVariable });

      assert.equal(resolved, pathFfmpeg, "PATH entry " + alias + " must not select the cwd decoy");
    }
  });

  test("a PATH entry that symlinks to the cwd is skipped", () => {

    const workingDirectory = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-symlink-cwd-"));
    const aliasDirectory = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-symlink-alias-"));
    const binDirectory = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-symlink-bin-"));
    const pathFfmpeg = path.join(binDirectory, "ffmpeg");

    writeFileSync(pathFfmpeg, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(path.join(workingDirectory, "ffmpeg"), "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync(workingDirectory, path.join(aliasDirectory, "cwd-link"));

    const pathVariable = path.join(aliasDirectory, "cwd-link") + path.delimiter + binDirectory;
    const resolved = resolveFfmpegExecutablePath("ffmpeg", { cwd: workingDirectory, path: pathVariable });

    assert.equal(resolved, pathFfmpeg);
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

  test("a relative configured path with a directory component resolves against the working directory", () => {

    const tempDirectory = mkdtempSync(path.join(tmpdir(), "hbup-ffmpeg-rel-"));
    const relative = path.join("bin", "ffmpeg");
    const executable = path.join(tempDirectory, relative);

    mkdirSync(path.dirname(executable), { recursive: true });
    writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });

    assert.equal(resolveFfmpegExecutablePath(relative, { cwd: tempDirectory }), path.resolve(tempDirectory, relative));
    assert.equal(validateConcreteFfmpegPath(resolveFfmpegExecutablePath(relative, { cwd: tempDirectory })), undefined);
  });
});