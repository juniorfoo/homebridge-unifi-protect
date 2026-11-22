/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg-path.ts: Resolve and validate the configured FFmpeg executable before launch probing.
 */
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { env } from "node:process";
import path from "node:path";

export const FFMPEG_CONFIGURATION_HINT = "This plugin requires a working version of FFmpeg. " +
  "If you need to specify a path to your FFmpeg, you can do so under 'Settings | Additional Settings' in the plugin configuration webUI.";
export const FFMPEG_RESOLVED_PATH_LOG = "Using FFmpeg at: %s.";

export interface FfmpegPathLookup { cwd?: string; path?: string; pathext?: string; platform?: NodeJS.Platform }

export function resolveFfmpegExecutablePath(configured: string, lookup: FfmpegPathLookup = {}): string {

  const cwd = lookup.cwd ?? process.cwd();
  const hasDirectory = configured.includes("/") || ((path.sep !== "/") && configured.includes(path.sep));

  if(!path.isAbsolute(configured) && !hasDirectory) {

    return findExecutableInPath(configured, lookup.path ?? env["PATH"] ?? "", cwd, lookup) ?? configured;
  }

  const resolved = path.isAbsolute(configured) ? configured : path.resolve(cwd, configured);

  try {

    return realpathSync(resolved);
  } catch {

    return resolved;
  }
}

export function validateConcreteFfmpegPath(resolvedPath: string): string | undefined {

  try {

    accessSync(resolvedPath, constants.F_OK);
  } catch {

    return "FFmpeg path does not exist: " + resolvedPath;
  }

  return isExecutableFile(resolvedPath) ? undefined : "FFmpeg path is not executable: " + resolvedPath;
}

function findExecutableInPath(command: string, pathVariable: string, cwd: string, lookup: FfmpegPathLookup): string | undefined {

  let cwdReal: string | undefined;

  try {

    cwdReal = realpathSync(cwd);
  } catch {

    return undefined;
  }

  for(const directory of pathVariable.split(path.delimiter)) {

    if(!path.isAbsolute(directory)) {

      continue;
    }

    let directoryReal: string | undefined;

    try {

      directoryReal = realpathSync(directory);
    } catch {

      continue;
    }

    if(directoryReal === cwdReal) {

      continue;
    }

    const pathext = lookup.pathext ?? env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM";
    const win32 = ((lookup.platform ?? process.platform) === "win32") && (path.extname(command) === "");
    const names = win32 ?
      [ command, ...pathext.split(";").filter((extension) => extension.length > 0).flatMap((extension) => {

        const withExtension = command + extension;
        const withExtensionLower = command + extension.toLowerCase();

        return withExtensionLower === withExtension ? [withExtension] : [ withExtension, withExtensionLower ];
      }) ] :
      [command];

    for(const name of names) {

      const candidate = path.join(directory, name);

      if(!isExecutableFile(candidate)) {

        continue;
      }

      return realpathSync(candidate);
    }
  }

  return undefined;
}

function isExecutableFile(filePath: string): boolean {

  try {

    if(!statSync(filePath).isFile()) {

      return false;
    }

    accessSync(filePath, constants.X_OK);

    return true;
  } catch {

    return false;
  }
}
