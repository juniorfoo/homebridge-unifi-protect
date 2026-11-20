/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * test-live-ffmpeg-process.ts: Spawn-free fake for HomeKit live video FFmpeg used in copy-escalation effect tests.
 */
import type { FfmpegProcessExitInfo, FfmpegStreamingReturnPort, Nullable } from "homebridge-plugin-utils";
import { HbpuAbortError } from "homebridge-plugin-utils";
import { Writable } from "node:stream";

export interface TestLiveStreamingFfmpegProcessInit {

  blockStdin?: boolean;
  /** When true (default for blockStdin), abort/terminateStdin breaks the pipe like a dead child (EPIPE) without synthetic drain. */
  pipeBreakOnTeardown?: boolean;
  returnPort?: FfmpegStreamingReturnPort;
  signal?: AbortSignal;
  stderrLog?: readonly string[];
}

export class TestLiveStreamingFfmpegProcess {

  readonly abortCalls: unknown[] = [];
  readonly stdinWrites: Buffer[] = [];
  readonly stdin: Writable;
  readonly returnPort?: FfmpegStreamingReturnPort;
  readonly id: string;
  stderrLog: readonly string[];
  returnPortClosed = false;
  readonly blockStdin: boolean;
  readonly pipeBreakOnTeardown: boolean;
  deferredStdinCallbacks: ((error?: Error) => void)[] = [];

  #controller = new AbortController();
  #parentAbort?: () => void;
  readonly ready: Promise<void>;
  readonly exited: Promise<FfmpegProcessExitInfo>;
  #exitedSettled = false;

  constructor(id: string, init?: TestLiveStreamingFfmpegProcessInit) {

    this.id = id;
    this.stderrLog = init?.stderrLog ?? [];
    this.returnPort = init?.returnPort;
    this.blockStdin = init?.blockStdin ?? false;
    this.pipeBreakOnTeardown = init?.pipeBreakOnTeardown ?? this.blockStdin;

    this.stdin = new Writable({

      highWaterMark: this.blockStdin ? 0 : 16 * 1024,
      write: (chunk, _encoding, callback): void => {

        this.stdinWrites.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));

        if(this.blockStdin) {

          this.deferredStdinCallbacks.push(callback);

          return;
        }

        callback();
      }
    });

    let resolveExited!: (value: FfmpegProcessExitInfo) => void;

    this.exited = new Promise((resolve) => {

      resolveExited = resolve;
    });

    const settleExited = (): void => {

      if(this.#exitedSettled) {

        return;
      }

      this.#exitedSettled = true;
      resolveExited({ exitCode: null, exitSignal: "SIGTERM" });
    };

    this.#controller.signal.addEventListener("abort", settleExited, { once: true });

    if(init?.signal) {

      const onParentAbort = (): void => {

        if(!this.#controller.signal.aborted) {

          this.abort(init.signal?.reason);
        }
      };

      if(init.signal.aborted) {

        onParentAbort();
      } else {

        init.signal.addEventListener("abort", onParentAbort, { once: true });
        this.#parentAbort = (): void => init.signal?.removeEventListener("abort", onParentAbort);
      }
    }

    this.ready = Promise.resolve();
  }

  get signal(): AbortSignal {

    return this.#controller.signal;
  }

  /** Break stdin like a real FFmpeg exit: fail pending writes with EPIPE, no synthetic drain. */
  terminateStdinLikeProcessExit(reason: unknown = Object.assign(new Error("write EPIPE"), { code: "EPIPE" })): void {

    const callbacks = this.deferredStdinCallbacks.splice(0);

    for(const callback of callbacks) {

      callback(reason instanceof Error ? reason : new Error(String(reason)));
    }

    if(!this.stdin.destroyed) {

      this.stdin.destroy(reason as Error);
    }
  }

  /** Unblock a backpressured stdin write and emit `drain` (test-only; not used when simulating process death). */
  releaseStdinDrain(): void {

    const callbacks = this.deferredStdinCallbacks.splice(0);

    for(const callback of callbacks) {

      callback();
    }

    if(callbacks.length > 0) {

      this.stdin.emit("drain");
    }
  }

  abort(reason?: unknown): void {

    this.abortCalls.push(reason ?? new HbpuAbortError("shutdown"));

    if(this.returnPort) {

      this.returnPortClosed = true;
    }

    if(this.pipeBreakOnTeardown) {

      this.terminateStdinLikeProcessExit();
    } else {

      this.releaseStdinDrain();

      if(!this.stdin.destroyed) {

        this.stdin.destroy();
      }
    }

    if(!this.#controller.signal.aborted) {

      this.#controller.abort(reason ?? new HbpuAbortError("shutdown"));
    }

    this.#parentAbort?.();
  }

  get returnPortAssigned(): Nullable<number> {

    return this.returnPort?.port ?? null;
  }
}
