#!/usr/bin/env python3
import subprocess, os, sys
R=os.environ.get('MUT_R2_REPO', os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
S='src/media/stream.ts'; P='src/media/stream-transcode-policy.ts'; C='src/media/stream-reconfigure.ts'
W='src/media/stream-live-wiring.ts'; T='src/media/test-live-ffmpeg-process.ts'
M=[
('M0 baseline',S,'Replanning live view stream for HomeKit RECONFIGURE (%s).','Replanning live view stream for HomeKit RECONFIGURE (%s).'),
('M1 threshold >= -> >',C,'maxBitRateKbps) >= LIVE_STREAM','maxBitRateKbps) > LIVE_STREAM'),
('M1b threshold 100 -> 1000',C,'TRANSCODE_BITRATE_THRESHOLD_KBPS = 100;','TRANSCODE_BITRATE_THRESHOLD_KBPS = 1000;'),
('M1c bitrate check removed',C,'if((input.nextEncode === "transcode") &&\n','if(false &&\n'),
('M2 baseline=negotiated not applied',S,'                applied: owner.appliedHomeKitVideo,\n                inFlightMaterialityBaseline: owner.reconfigureMaterialityBaseline,','                applied: homeKitStreamVideoSnapshotFromRequest(rebuild.request.video),\n                inFlightMaterialityBaseline: owner.reconfigureMaterialityBaseline,'),
('M3 fps not material',C,'(input.previous.fps !== input.next.fps)) {\n\n    return { material: true, reason: "resolution-or-fps" }','false) {\n\n    return { material: true, reason: "resolution-or-fps" }'),
('M3b width not material',C,'if((input.previous.width !== input.next.width) ||','if(false ||'),
('M4 h264 level not material',C,'if((input.previous.h264Level !== input.next.h264Level) ||','if(false ||'),
('M4b h264 profile not material',C,'|| (input.previous.h264Profile !== input.next.h264Profile)) {','|| false) {'),
('M5 encode-mode not material',C,'if(input.previousEncode !== input.nextEncode) {','if(false) {'),
('M6 queue keeps first not latest',S,'                  owner.pendingReconfigure = updatedRequest;\n','                  owner.pendingReconfigure = owner.pendingReconfigure ?? updatedRequest;\n'),
('M7 no queue during in-flight',S,'const queueForInFlightReplan = copyReplacementMutexHeld || (encodedTargetOutstanding &&','const queueForInFlightReplan = copyReplacementMutexHeld || (false &&'),
('M8 restore-before-ready baseline=applied',C,'  if(input.reconfigureInFlight) {\n\n    return rebuildSnapshot;','  if(false) {\n\n    return rebuildSnapshot;'),
('M9 mutex: RECONFIGURE ignores escalation',S,'const copyReplacementMutexHeld = Boolean(handles?.copyEscalationInFlightRef.current) &&','const copyReplacementMutexHeld = false &&'),
('M9b replan-side escalation guard removed',S,'if(handles.copyEscalationInFlightRef.current && (owner.reconfigureInFlight !== true)) {','if(false) {'),
('M11 no drain after escalation',W,'        } else if(respawned && input.sessionStillOwned()) {\n\n          input.onEscalationSettled?.();','        } else if(respawned && input.sessionStillOwned()) {\n\n          void 0;'),
('M12 replan no ongoing registration',S,'      ongoing.ffmpeg[0] = respawned;\n      owner.transcode = isTranscoding;','      owner.transcode = isTranscoding;'),
('M12b establishment housekeeping uses stale ffmpeg',S,'      ongoingEntry.ffmpeg[0] = currentVideoFfmpegForOngoing();','      ongoingEntry.ffmpeg[0] = activeFfmpeg;'),
('M12c replan no pending->ongoing promotion',S,'        this.ongoingSessions.set(sessionId, ongoing);\n      }\n\n      if(!ongoing) {','      }\n\n      if(!ongoing) {'),
('M12d early registration uses stale local',S,'        ffmpeg: [currentVideoFfmpegForOngoing()],\n        rtpDemuxer: sessionInfo.rtpDemuxer,\n        rtpPortReservations: sessionInfo.rtpPortReservations,\n        toggleLight: sessionInfo.toggleLight\n      });\n    }\n\n    if(useTsb)','        ffmpeg: [activeFfmpeg],\n        rtpDemuxer: sessionInfo.rtpDemuxer,\n        rtpPortReservations: sessionInfo.rtpPortReservations,\n        toggleLight: sessionInfo.toggleLight\n      });\n    }\n\n    if(useTsb)'),
('M12e all currentVideoFfmpegForOngoing -> local',S,'const currentVideoFfmpegForOngoing = (): ProtectStreamingFfmpegProcess => sessionDiagnostics.activeVideoFfmpeg?.current ?? activeFfmpeg;','const currentVideoFfmpegForOngoing = (): ProtectStreamingFfmpegProcess => activeFfmpeg;'),
('M14 endFfmpegBridge active check removed',S,'      if(sessionDiagnostics.activeVideoFfmpeg?.current !== exitedProcess) {\n\n        return;\n      }\n','      if(false) {\n\n        return;\n      }\n'),
('M15 replacement exit bridge not wired',S,'      handles.wireFfmpegExitBridge(respawned);\n','\n'),
('M16 prior ffmpeg not aborted (orphan)',S,'      priorFfmpeg.abort(new HbpuAbortError("replaced"));\n','\n'),
('M17 prior aborted as failed (drops session)',S,'      priorFfmpeg.abort(new HbpuAbortError("replaced"));\n','      priorFfmpeg.abort(new HbpuAbortError("failed"));\n'),
('M18 session-abort listener never unlinked',S,'      unlinkOnFfmpegExitedSettled(respawned.exited, unlinkSessionAbort);\n','\n'),
('M19 replacement not linked to session abort',S,'      sessionSignal.addEventListener("abort", linkSessionAbort);\n    }\n\n    try {\n\n      rebuild.request','      void 0;\n    }\n\n    try {\n\n      rebuild.request'),
('M20 immaterial not saved',S,'              } else {\n\n                rebuild.request = updatedRequest;\n\n                owner.pendingReconfigure &&= updatedRequest;','              } else if(false) {\n\n                rebuild.request = updatedRequest;\n\n                owner.pendingReconfigure &&= updatedRequest;'),
('M21 replan no TSB writer rotation',S,'        tsbResume.rotateSegmentWriter(respawned);\n        primeLiveFfmpegStdinAfterRespawn','        primeLiveFfmpegStdinAfterRespawn'),
('M22 applied never updated after ready',S,'      owner.appliedHomeKitVideo = nextSnapshot;\n      owner.reconfigureAwaitingEncoderReady = false;\n      this.enqueueNegotiatedFollowUpReconfigure(sessionId, owner, rebuild);\n    } catch(error) {','      owner.reconfigureAwaitingEncoderReady = false;\n      this.enqueueNegotiatedFollowUpReconfigure(sessionId, owner, rebuild);\n    } catch(error) {'),
('M23 no drain in replan finally',S,'      if(!deferPendingDrain) {\n\n        this.drainPendingHomeKitReconfigure(sessionId);\n      }','      if(!deferPendingDrain) {\n\n        void 0;\n      }'),
('M25 pendingReconfigure &&= removed',S,'                owner.pendingReconfigure &&= updatedRequest;','                void 0;'),
('M27 dispose before stale-exit check',S,
 '      if(sessionDiagnostics.activeVideoFfmpeg?.current !== exitedProcess) {\n\n        return;\n      }\n\n      void subscription?.[Symbol.asyncDispose]();\n      tsbWriterRail?.getSegmentWriter().abort();',
 '      void subscription?.[Symbol.asyncDispose]();\n      tsbWriterRail?.getSegmentWriter().abort();\n\n      if(sessionDiagnostics.activeVideoFfmpeg?.current !== exitedProcess) {\n\n        return;\n      }'),
('M28 teardown target is exited not active',W,'      const teardownTarget = input.getActiveVideoFfmpeg() ?? exitedProcess;','      const teardownTarget = exitedProcess;'),
('M29 ignore stale during mutex removed',W,'    if(input.copyEscalationInFlightRef.current && !exitingIsActiveEncoder) {\n\n      return;\n    }','    if(false) {\n\n      return;\n    }'),
('M31 crash() rejects ready before abort',T,
 '  crash(reason?: unknown): void {\n\n    this.abort(reason ?? new HbpuAbortError("failed"));\n  }',
 '  crash(reason?: unknown): void {\n\n    this.rejectReadyBeforeExit(reason ?? new HbpuAbortError("failed"));\n  }'),
]
only=set(sys.argv[1:]) if len(sys.argv)>1 else set()
node_bin=os.environ.get('MUT_R2_NODE_BIN', '/home/ubuntu/.nvm/versions/node/v24.22.3/bin')
env=dict(os.environ,CI='true',PATH=node_bin+':'+os.environ.get('PATH',''))
not_applied=False
for name,f,needle,rep in M:
  if only and name.split()[0] not in only: continue
  p=os.path.join(R,f); s=open(p).read(); n=s.count(needle)
  if n!=1:
    print(f'{name} | NOT-APPLIED | needle count {n}',flush=True); not_applied=True; continue
  saved=s
  open(p,'w').write(s.replace(needle,rep))
  try:
    r=subprocess.run(['timeout','400','node','--test','--test-timeout=15000','src/**/*.test.ts'],cwd=R,env=env,capture_output=True,text=True)
    out=r.stdout
    fails=[l.strip() for l in out.splitlines() if l.startswith('✖ ') and 'failing tests' not in l]
    summ=' '.join(l.strip() for l in out.splitlines() if l.startswith('ℹ ') and any(k in l for k in ('tests ','pass ','fail ','cancelled ')))
    st='KILLED' if r.returncode!=0 else 'SURVIVED'
    if r.returncode==124: st='HANG(timeout)'
    print(f'{name} | {st} | rc={r.returncode} | {summ} | {fails[:4]}',flush=True)
  finally:
    open(p,'w').write(saved)
if not_applied:
  sys.exit(2)
sys.exit(0)