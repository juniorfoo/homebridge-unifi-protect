/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * video-processor.ts: Validate configured FFmpeg executables at startup.
 */
import { accessSync, constants, realpathSync } from "node:fs";
import path from "node:path";

export const DEFAULT_FFMPEG_ALLOWLIST_PREFIXES = [

  "/usr/lib/jellyfin-ffmpeg/",
  "/usr/bin/",
  "/usr/local/bin/"
];

export interface VideoProcessorValidation {

  error?: string;
  resolvedPath: string;
  valid: boolean;
}

export function resolveVideoProcessorPath(videoProcessor: string, bundledFfmpegPath?: string): string {

  const candidates = [videoProcessor];

  if(bundledFfmpegPath) {

    candidates.push(bundledFfmpegPath);
  }

  for(const candidate of candidates) {

    try {

      return realpathSync(path.resolve(candidate));
    } catch {

      continue;
    }
  }

  return path.resolve(videoProcessor);
}

export function validateVideoProcessorPath(videoProcessor: string, options?: {

  allowlistPrefixes?: readonly string[];
  bundledFfmpegPath?: string;
}): VideoProcessorValidation {

  const resolvedPath = resolveVideoProcessorPath(videoProcessor, options?.bundledFfmpegPath);

  try {

    accessSync(resolvedPath, constants.X_OK);
  } catch {

    return {

      error: "FFmpeg path is not executable: " + resolvedPath,
      resolvedPath: resolvedPath,
      valid: false
    };
  }

  const allowlistPrefixes = options?.allowlistPrefixes ?? DEFAULT_FFMPEG_ALLOWLIST_PREFIXES;
  const basename = path.basename(resolvedPath);

  if((basename === "ffmpeg") || basename.startsWith("ffmpeg-")) {

    return { resolvedPath: resolvedPath, valid: true };
  }

  const allowed = allowlistPrefixes.some(prefix => resolvedPath.startsWith(path.resolve(prefix)) || resolvedPath.startsWith(prefix));

  if(!allowed) {

    return {

      error: "FFmpeg path is outside the allowed locations: " + resolvedPath,
      resolvedPath: resolvedPath,
      valid: false
    };
  }

  return { resolvedPath: resolvedPath, valid: true };
}
