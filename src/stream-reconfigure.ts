/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-reconfigure.ts: HomeKit RECONFIGURE handling helpers.
 */
export interface StreamVideoParameters {

  fps: number;
  height: number;
  maxBitRate: number;
  width: number;
}

export interface ReconfigureDecision {

  reason: string;
  restart: boolean;
}

export function hasMaterialStreamChange(previous: StreamVideoParameters, next: StreamVideoParameters): boolean {

  return (previous.width !== next.width) ||
    (previous.height !== next.height) ||
    (previous.fps !== next.fps) ||
    (Math.abs(previous.maxBitRate - next.maxBitRate) >= 100);
}

export function decideReconfigure(previous: StreamVideoParameters | undefined, next: StreamVideoParameters): ReconfigureDecision {

  if(!previous) {

    return { reason: "initial", restart: false };
  }

  if(!hasMaterialStreamChange(previous, next)) {

    return { reason: "immaterial", restart: false };
  }

  return { reason: "material-change", restart: true };
}
