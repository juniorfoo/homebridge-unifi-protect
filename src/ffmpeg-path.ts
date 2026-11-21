/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg-path.ts: Resolve and validate the configured FFmpeg executable before launch probing.
 */
import { accessSync, constants, realpathSync } from "node:fs";
import { env } from "node:process";
import path from "node:path";

// The startup log line for the resolved absolute FFmpeg path, emitted once after a successful probe.
export const FFMPEG_RESOLVED_PATH_LOG = "Using FFmpeg at: %s.";

// Whether a configured value names a bare command with no directory component, which must be resolved through PATH rather than the process working directory.
export function isBareCommandName(execPath: string): boolean {

  return !path.isAbsolute(execPath) && !hasDirectoryComponent(execPath);
}

// Whether a configured value carries a directory component, including explicit relative prefixes.
export function hasDirectoryComponent(execPath: string): boolean {

  return execPath.includes("/") || ((path.sep !== "/") && execPath.includes(path.sep));
}

// Resolve the configured FFmpeg value to the absolute path that startup validation and logging use.
export function resolveFfmpegExecutablePath(configured: string): string {

  if(isBareCommandName(configured)) {

    return findExecutableInPath(configured) ?? configured;
  }

  if(path.isAbsolute(configured)) {

    return tryRealpath(configured);
  }

  return tryRealpath(path.resolve(configured));
}

// Whether the configured value points at a concrete filesystem path that can be validated before the probe runs.
export function isConcreteFfmpegPath(configured: string, resolvedPath: string): boolean {

  if(!isBareCommandName(configured)) {

    return true;
  }

  return resolvedPath !== configured;
}

// Validate that a resolved concrete path exists and is executable. Returns an error sentence when validation fails.
export function validateConcreteFfmpegPath(resolvedPath: string): string | undefined {

  try {

    accessSync(resolvedPath, constants.F_OK);
  } catch {

    return "FFmpeg path does not exist: " + resolvedPath;
  }

  try {

    accessSync(resolvedPath, constants.X_OK);
  } catch {

    return "FFmpeg path is not executable: " + resolvedPath;
  }

  return undefined;
}

function findExecutableInPath(command: string): string | undefined {

  const pathVariable = env["PATH"] ?? "";

  for(const directory of pathVariable.split(path.delimiter)) {

    if(!directory) {

      continue;
    }

    const candidate = path.join(directory, command);

    try {

      accessSync(candidate, constants.X_OK);

      return realpathSync(candidate);
    } catch {

      continue;
    }
  }

  return undefined;
}

function tryRealpath(filePath: string): string {

  try {

    return realpathSync(filePath);
  } catch {

    return filePath;
  }
}
