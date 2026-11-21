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

  test("deferReady rejects ready after abort in real exit order", async () => {

    const proc = new TestLiveStreamingFfmpegProcess("defer", { deferReady: true });
    const order: string[] = [];

    void proc.exited.then(() => {

      order.push("exited");
    });
    void proc.ready.then(() => order.push("ready"), () => {

      order.push("ready-rejected");
    });

    proc.crash();
    await proc.exited;
    await proc.ready.catch(() => undefined);

    assert.deepEqual(order, [ "exited", "ready-rejected" ]);
  });

  test("rejectReadyBeforeExit models startup-watchdog teardown before exited settles", async () => {

    const proc = new TestLiveStreamingFfmpegProcess("defer-timeout", { deferReady: true });

    const readyRejected = proc.ready.then(() => "ready" as const, () => "rejected" as const);

    proc.rejectReadyBeforeExit();
    assert.equal(await readyRejected, "rejected");
    await proc.exited;
  });

  test("deferReady rejects when the parent signal is already aborted at construction", async () => {

    const parent = new AbortController();

    parent.abort(new HbpuAbortError("shutdown"));

    const proc = new TestLiveStreamingFfmpegProcess("pre-aborted-defer", { deferReady: true, signal: parent.signal });

    await assert.rejects(proc.ready, (error: unknown) => error instanceof HbpuAbortError);
    await proc.exited;
  });

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
