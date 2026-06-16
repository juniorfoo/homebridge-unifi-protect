/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-stream-fanout.ts: Copy-path stream fanout prototype (one ingress, per-session SRTP out).
 *
 * Full SRTP fanout requires per-viewer encryption keys negotiated in prepareStream(). This registry tracks copy-path
 * sessions and ensures teardown only occurs when the last viewer disconnects.
 */
export interface FanoutSession {

  id: string;
  refCount: number;
}

export class CopyPathFanoutRegistry {

  private sessions = new Map<string, FanoutSession>();

  public acquire(sessionKey: string): FanoutSession {

    const existing = this.sessions.get(sessionKey);

    if(existing) {

      existing.refCount++;

      return existing;
    }

    const session: FanoutSession = { id: sessionKey, refCount: 1 };

    this.sessions.set(sessionKey, session);

    return session;
  }

  public release(sessionKey: string): boolean {

    const existing = this.sessions.get(sessionKey);

    if(!existing) {

      return false;
    }

    existing.refCount--;

    if(existing.refCount <= 0) {

      this.sessions.delete(sessionKey);

      return true;
    }

    return false;
  }

  public size(): number {

    return this.sessions.size;
  }
}
