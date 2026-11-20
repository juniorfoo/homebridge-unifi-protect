/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * test-live-ffmpeg-process.test.ts: Contract tests for the spawn-free live FFmpeg test double.
 */
/* eslint-disable sort-imports -- node:test before node:assert, consistent with media effect tests */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { HbpuAbortError } from "homebridge-plugin-utils";
import { TestLiveStreamingFfmpegProcess } from "./test-live-ffmpeg-process.ts";

describe("TestLiveStreamingFfmpegProcess", () => {

  test("exited settles when the parent signal is already aborted at construction", async () => {

    const parent = new AbortController();

    parent.abort(new HbpuAbortError("shutdown"));

    const proc = new TestLiveStreamingFfmpegProcess("pre-aborted", { signal: parent.signal });

    const exit = await proc.exited;

    assert.equal(exit.exitCode, null);
    assert.equal(exit.exitSignal, "SIGTERM");
    assert.ok(proc.signal.aborted);
  });
});
