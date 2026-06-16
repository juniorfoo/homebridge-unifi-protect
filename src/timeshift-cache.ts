/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * timeshift-cache.ts: Cached concatenation for timeshift buffer reads.
 */
export interface TimeshiftSegmentCacheInput {

  buffer: readonly Buffer[];
  generation: number;
  initSegment?: Buffer;
  sliceStart: number;
}

export interface TimeshiftSegmentCacheEntry {

  data: Buffer;
  generation: number;
  sliceStart: number;
}

export class TimeshiftConcatCache {

  private entry?: TimeshiftSegmentCacheEntry;

  public get(input: TimeshiftSegmentCacheInput): Buffer | null {

    if(!input.initSegment || !input.buffer.length) {

      this.entry = undefined;

      return null;
    }

    if((this.entry?.generation === input.generation) && (this.entry.sliceStart === input.sliceStart)) {

      return this.entry.data;
    }

    const sliced = input.sliceStart >= input.buffer.length ?
      input.buffer :
      input.buffer.slice(input.sliceStart * -1);

    const data = Buffer.concat([ input.initSegment, ...sliced ]);

    this.entry = {

      data: data,
      generation: input.generation,
      sliceStart: input.sliceStart
    };

    return data;
  }

  public invalidate(): void {

    this.entry = undefined;
  }
}

export function computeTimeshiftSliceStart(durationMs: number, segmentLengthMs: number, bufferLength: number): number {

  if(!durationMs) {

    return bufferLength;
  }

  const start = durationMs / segmentLengthMs;

  return start >= bufferLength ? bufferLength : start;
}
