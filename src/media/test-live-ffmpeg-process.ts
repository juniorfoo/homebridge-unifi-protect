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
  deferReady?: boolean;
  rejectExited?: boolean;
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
  #rejectExitedRejector?: (reason: unknown) => void;
  #rejectReady?: (reason: unknown) => void;
  #resolveReady?: () => void;
  readonly #deferReady: boolean;

  constructor(id: string, init?: TestLiveStreamingFfmpegProcessInit) {

    this.id = id;
    this.stderrLog = init?.stderrLog ?? [];
    this.returnPort = init?.returnPort;
    this.blockStdin = init?.blockStdin ?? false;
    this.pipeBreakOnTeardown = init?.pipeBreakOnTeardown ?? this.blockStdin;
    this.#deferReady = Boolean(init?.deferReady);

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

    if(init?.rejectExited) {

      this.exited = new Promise((_resolve, reject) => {

        this.#rejectExitedRejector = reject;
      });
    } else {

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
    }

    if(this.#deferReady) {

      this.ready = new Promise<void>((resolve, reject) => {

        this.#resolveReady = resolve;
        this.#rejectReady = reject;
      });
    } else {

      this.ready = Promise.resolve();
    }

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

    if(this.#deferReady && this.#controller.signal.aborted && this.#rejectReady) {

      this.#rejectDeferredReady(this.#controller.signal.reason ?? new HbpuAbortError("shutdown"));
    }
  }

  releaseReady(): void {

    const resolve = this.#resolveReady;

    this.#resolveReady = undefined;
    this.#rejectReady = undefined;
    resolve?.();
  }

  /** Real FfmpegProcess order after a runtime failure: exited settles, then ready rejects with the abort reason. */
  crash(reason?: unknown): void {

    this.abort(reason ?? new HbpuAbortError("failed"));
  }

  /** Startup-watchdog path: ready rejects before exited settles (unless exited already settled). */
  rejectReadyBeforeExit(reason?: unknown): void {

    const reject = this.#rejectReady;
    const abortReason = reason ?? new HbpuAbortError("timeout");

    this.#resolveReady = undefined;
    this.#rejectReady = undefined;
    reject?.(abortReason);
    this.abort(abortReason);
  }

  #rejectDeferredReady(reason: unknown): void {

    if(!this.#deferReady || !this.#rejectReady) {

      return;
    }

    const reject = this.#rejectReady;

    this.#resolveReady = undefined;
    this.#rejectReady = undefined;
    reject(reason);
  }

  rejectExitedNow(reason: unknown = new Error("ffmpeg exited rejected")): void {

    if(this.#exitedSettled) {

      return;
    }

    this.#exitedSettled = true;
    this.#rejectExitedRejector?.(reason);
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

    this.#rejectDeferredReady(this.#controller.signal.reason ?? reason ?? new HbpuAbortError("shutdown"));

    this.#parentAbort?.();
  }

  get returnPortAssigned(): Nullable<number> {

    return this.returnPort?.port ?? null;
  }
}
