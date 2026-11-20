/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-copy-writer-rotation.integration.test.ts: production writer rotation after real child stdin EPIPE.
 */
/* eslint-disable sort-imports */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { BackpressureWriter } from "homebridge-plugin-utils";
import { rotateBackpressureWriterForCopyEscalation } from "./stream-live-feed.ts";

const MEDIA = Buffer.alloc(256 * 1024, 0xab);
const INIT = Buffer.from("fmp4-init");

const COPY_CHILD_SCRIPT = "process.stdin.resume();";
const REPLACEMENT_STDIN_SCRIPT = [
  "const chunks = [];",
  "process.stdin.on('data', (c) => chunks.push(c));",
  "process.stdin.on('end', () => {",
  "  process.stdout.write(Buffer.concat(chunks));",
  "});"
].join("\n");

describe("copy-to-transcode writer rotation (real child stdin)", () => {

  const trackedChildren: ReturnType<typeof spawn>[] = [];

  after(() => {

    for(const child of trackedChildren) {

      if(!child.killed) {

        child.kill("SIGKILL");
      }
    }
  });

  test("pending write on a dead child poisons the writer; production rotation delivers init then media", async () => {

    const copyChild = spawn(process.execPath, [ "-e", COPY_CHILD_SCRIPT ], { stdio: [ "pipe", "ignore", "ignore" ] });

    trackedChildren.push(copyChild);
    const copyStdin = copyChild.stdin;

    assert.ok(copyStdin);

    let activeStdin: Writable = copyStdin;
    const sessionSignal = new AbortController().signal;
    let segmentWriter = new BackpressureWriter(() => activeStdin, { highWaterMark: 4, signal: sessionSignal });

    const pendingWrite = segmentWriter.write(MEDIA);

    copyChild.kill("SIGKILL");

    await assert.rejects(pendingWrite);
    assert.ok(segmentWriter.signal.aborted);

    const abortReason: unknown = segmentWriter.signal.reason;

    assert.ok(abortReason instanceof Error);
    assert.match(abortReason.message, /failed/);

    assert.ok(abortReason.cause instanceof Error);
    assert.equal((abortReason.cause as NodeJS.ErrnoException).code, "EPIPE");

    const replacement = spawn(process.execPath, [ "-e", REPLACEMENT_STDIN_SCRIPT ], { stdio: [ "pipe", "pipe", "ignore" ] });

    trackedChildren.push(replacement);
    const replacementStdin = replacement.stdin;

    assert.ok(replacementStdin);

    activeStdin = replacementStdin;

    segmentWriter = rotateBackpressureWriterForCopyEscalation({

      getStdin: () => activeStdin,
      poisoned: segmentWriter,
      signal: sessionSignal
    });

    const stdoutChunks: Buffer[] = [];
    const outputPromise = new Promise<Buffer>((resolve, reject) => {

      replacement.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      replacement.stdout.on("end", () => resolve(Buffer.concat(stdoutChunks)));
      replacement.on("error", reject);
    });

    await segmentWriter.write(INIT);
    await segmentWriter.write(MEDIA);
    replacementStdin.end();

    const received = await outputPromise;

    assert.equal(received.compare(Buffer.concat([ INIT, MEDIA ])), 0,
      "rotated child must receive the full init plus media payload");
    assert.ok(!segmentWriter.signal.aborted);
  });
});
