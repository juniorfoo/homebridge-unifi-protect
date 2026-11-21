/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-live-ffmpeg-spawn.ts: Live-video FFmpeg spawn (production default) with optional test injection via setLiveVideoFfmpegSpawnerForTests.
 */
/* eslint-disable sort-imports -- type and value imports from stream-ffmpeg-process stay paired */
import type { StartStreamRequest } from "homebridge";
import type { FfmpegOptions, HomebridgePluginLogging, IpFamily, StreamingProcessFactory } from "homebridge-plugin-utils";
import type { ChannelProfile } from "./resolution.ts";
import type { ProtectStreamingFfmpegProcess } from "./stream-ffmpeg-process.ts";
import { liveViewOnFailed } from "./stream-ffmpeg-process.ts";

export interface LiveVideoFfmpegSpawnInit {

  args?: string[];
  onProbesizeError: () => void;
  returnPort?: { ipFamily: IpFamily; port: number };
  signal?: AbortSignal;
  suppressLivestreamApiErrors: boolean;
}

export type LiveVideoFfmpegSpawner = (options: FfmpegOptions, init: LiveVideoFfmpegSpawnInit) => ProtectStreamingFfmpegProcess;

let testLiveVideoFfmpegSpawner: LiveVideoFfmpegSpawner | undefined;

/** Test-only: inject a spawn-free FFmpeg factory. Production callers never set this. */
export function setLiveVideoFfmpegSpawnerForTests(spawner: LiveVideoFfmpegSpawner | undefined): void {

  testLiveVideoFfmpegSpawner = spawner;
}

export function spawnLiveVideoFfmpegProcess(options: FfmpegOptions, factory: StreamingProcessFactory, log: HomebridgePluginLogging,
  init: LiveVideoFfmpegSpawnInit): ProtectStreamingFfmpegProcess {

  const spawner = testLiveVideoFfmpegSpawner;

  if(spawner) {

    return spawner(options, init);
  }

  return factory.create(options, {

    args: init.args,
    onFailed: liveViewOnFailed({ log: log, onProbesizeError: init.onProbesizeError, suppressLivestreamApiErrors: init.suppressLivestreamApiErrors }),
    returnPort: init.returnPort,
    signal: init.signal
  }) as ProtectStreamingFfmpegProcess;
}

/** Arguments required to spawn a transcode replacement (subset of startStream state). */
export interface LiveVideoFfmpegSpawnContext {

  channelProfile: ChannelProfile;
  ffmpegArgsThroughVideoMap: string[];
  request: StartStreamRequest;
  sessionInfo: { addressVersion: IpFamily; hasAudioSupport: boolean; videoReturnPort: number };
  targetBitrate: number;
  transcodeReason: string;
  useInterpolationFilter: boolean;
  useTsb: boolean;
}