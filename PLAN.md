# homebridge-unifi-protect — Optimization & Reliability Plan

This document captures proposed changes for a fork of `homebridge-unifi-protect` (v7.29.0 baseline). It combines code review, architecture analysis, and real-world deployment pain from a multi-camera HKSV setup (8 cameras, UDM Pro, 4-core Intel N150 host, cross-VLAN HomeKit).

**North star to preserve:** minimal config, “just works” defaults, sub-second live view where hardware allows. Optimizations should be **adaptive**, not more feature flags.

---

## Problem summary

| Symptom | Root cause in plugin/system |
|---------|----------------------------|
| Live view dies at ~30s | Usually **network** (UDP SRTP blocked), not plugin — document better; add session telemetry to distinguish |
| High Protect controller load | HKSV forces **always-on Livestream API** per camera; 6× 4K sessions overwhelm UDM |
| High CPU on modest Linux hosts | **Software transcode by default**; one FFmpeg **per viewer**; 15fps→30fps upsampling |
| G4 Doorbell streaming fragile | HKSV quality coupling + API path + doorbell audio/fps mismatch |
| Hard to debug | No structured stream lifecycle logs; FFmpeg errors often silent |

---

## Priority tiers

### P0 — Reliability & debuggability (do first)

Low risk, high value. Makes every future issue faster to diagnose.

#### P0.1 Stream session telemetry

**Goal:** One structured log line per stream start/stop so operators can tell network vs input vs transcode failures without tcpdump.

**Log on start:**
```
Stream started: camera=<name> session=<id> path=RTSP|TSB/API profile=<High|Medium|Low>
  transcode=<yes|no> hw=<yes|no> src=<ip> dst=<ip>:<port> client=<optional>
```

**Log on stop:**
```
Stream ended: camera=<name> session=<id> reason=homekit-stop|ffmpeg-exit|error
  duration=<s> first-frame-ms=<n|null> segments-fed=<n> ffmpeg-exit=<code|null>
```

**Files:**
- `src/protect-stream.ts` — track `firstFrameTime`, `segmentsFed`, stop reason in session object
- `homebridge-plugin-utils` — `FfmpegStreamingProcess` exit code / timeout hooks (if not already exposed)

**Acceptance:** A 30s timeout with `segments-fed=0` implicates input; with segments fed but short duration implicates network/client.

---

#### P0.2 Troubleshooting doc improvements (in-repo)

**Goal:** Encode deployment learnings into upstream-facing docs (or fork docs).

**Add sections:**
- Cross-VLAN UDP SRTP (Homebridge on `.30.x`, Home Hub on `.3.x`) — snapshots work, live view doesn’t
- `[TSB/API]` vs `[RTSP]` log suffix meaning
- “Jellyfin FFmpeg + `videoProcessor`” for Linux QSV (bundled static ffmpeg has no QSV)
- Kernel requirement for Alder Lake-N (`8086:46d4`) — i915 needs 6.9+ / 7.0+

**Files:** `docs/Troubleshooting.md` (or fork `docs/Deployment.md`)

---

#### P0.3 Fail loudly when FFmpeg produces no output

**Goal:** If no segment/keyframe reaches FFmpeg within N seconds of stream start, log **warn** with actionable hint (check UDP path, livestream API, RTSP URL).

**Files:**
- `src/protect-stream.ts` — timer after `startStream`; clear on first stdout/RTP activity
- Consider 10s internal warning, don’t stop session (HomeKit owns the 30s timeout)

---

#### P0.4 Fix TSB `livestream.start()` failure cleanup

**Goal:** When `livestream.start()` fails after FFmpeg is spawned, fail the HomeKit callback, stop FFmpeg, release RTP port reservations, and log a structured stop reason (`livestream-acquire-failed`).

**Current bug** (`protect-stream.ts` ~830): early `return` with no callback, orphaned `FfmpegStreamingProcess`, leaked pending-session ports.

**Files:** `src/protect-stream.ts`

**Acceptance:** Failed acquire never leaves a zombie FFmpeg or reserved UDP ports.

---

#### P0.5 Unify live-view telemetry with existing HKSV telemetry

**Goal:** Extend the existing `Debug.Video.HKSV.Telemetry` pattern (segment counts, pacing, FFmpeg timeout) to live view. Promote start/stop summary lines to default INFO; keep verbose FFmpeg stderr behind debug flags.

**Privacy:** See P6.2 — client IPs in telemetry must be opt-in or redactable.

**Files:** `src/protect-stream.ts`, `src/protect-record.ts` (reuse field naming)

---

### P1 — Live view path selection (biggest user-facing win)

#### P1.1 Decouple live view from HKSV timeshift buffer

**Current behavior** (`protect-stream.ts` ~445):
```typescript
let useTsb = this.protectCamera.hints.tsbStreaming && this.hksv?.isRecording;
```
When HKSV is on, live view almost always uses Livestream API + TSB, inheriting HKSV recording quality and controller websocket load.

**Proposed behavior:**

| Condition | Live view path |
|-----------|----------------|
| Default (new) | **RTSP** when camera has valid RTSP entries |
| HKSV + `Video.Stream.UseApi` enabled (existing default today) | TSB/API |
| AV1 camera without RTSP H.264 fallback | TSB/API (required today) |
| Package camera + HKSV | TSB/API |
| Explicit `Disable.Video.Stream.UseApi` | RTSP (already works) |

**Change:** Flip default — **`Video.Stream.UseApi` default to `false`** for live view, **or** introduce smart auto-selection:

```
useTsb = hints.tsbStreaming
  && hksv?.isRecording
  && !hints.preferRtspLiveView   // new internal hint
  && (isAv1WithoutRtsp || isPackageCamera || measuredRtspLatency > threshold)
```

**Prefer RTSP when:**
- `request.audio.packet_time < 60` (local/LAN client heuristic — already used for transcode)
- Host profile is “constrained” (see P2.2)
- Protect livestream restart rate exceeds threshold (see P2.3)

**Files:**
- `src/protect-stream.ts` — `startStream()` path selection
- `src/protect-options.ts` — update `Video.Stream.UseApi` description/default
- `src/devices/protect-camera.ts` — `hints.tsbStreaming` / new hints
- `docs/Autoconfiguration.md`, `docs/FeatureOptions.md`

**Breaking change mitigation:** Changelog entry; one release with log line when auto-selecting RTSP: `Live view using RTSP (HKSV active; API path skipped for LAN client)`.

**Acceptance:** Doorbell live view uses `[RTSP]` by default on LAN; Protect livestream API connection count unchanged when only viewing (HKSV still uses API for recording buffer).

---

#### P1.2 Don’t inherit HKSV recording quality for live view

**Current:** When `useTsb`, `rtspEntry = this.hksv?.rtspEntry` — live view forced to whatever HKSV buffer uses (e.g. Low 480×360@15fps).

**Proposed:** When live view uses TSB/API, still select RTSP profile via `findRtsp(request.video.width, request.video.height)` for the **live** transcode/copy path, while HKSV keeps its own `recordingDefault`.

**Files:**
- `src/protect-stream.ts`
- `src/protect-record.ts` / `ProtectTimeshiftBuffer` — may need separate `rtspEntry` for buffer vs stream, or parallel livestream acquire (harder)

**Simpler interim fix:** If P1.1 lands (RTSP default for live view), this matters less. Still fix for users who keep `UseApi`.

---

#### P1.3 Avoid fps upsampling on transcode

**Current:** HomeKit requests 30fps; Protect Low stream is 15fps; FFmpeg transcodes with `fps=30` filter (⛭︎ in logs).

**Proposed transcode ladder:**
1. Match **source fps** when ≤ requested fps (stream 15fps to HomeKit if source is 15fps — HomeKit often accepts)
2. Only upsample fps if session fails or HomeKit RECONFIGURE demands it
3. Never upsample when source is Low profile unless user opts in

**Files:**
- `src/protect-stream.ts` — `streamEncoder()` call site
- `homebridge-plugin-utils` — `FfmpegOptions.streamEncoder()`

---

### P2 — CPU & scale (multi-camera / modest hosts)

#### P2.1 Copy-first transcode policy

**Current:** `Video.Transcode` default **true** → re-encode even on LAN when H.264 profile matches.

**Proposed ladder:**
1. **Copy** (`-codec:v copy`) when: H.264, compatible profile/level, resolution within HomeKit request, no crop/filters
2. **Transcode** when: copy probe fails, non-H.264, crop, high-latency (`packet_time >= 60`), user `Video.Transcode` forced
3. Log which rung was used: `Using copy path` vs `Transcoding because: <reason>`

**Files:**
- `src/protect-stream.ts` — `isTranscoding` decision (~438)
- `src/protect-options.ts` — consider `Video.Transcode` default → `false` with auto-escalation (breaking; gate behind major version or host profile)

---

#### P2.2 Host capability profiles

**Goal:** Auto-tune defaults at plugin startup based on probe results (extend existing Pi / Apple Silicon logic in `protect-camera.ts`).

| Profile | Detection | Live view | HKSV source cap | Transcode |
|---------|-----------|-----------|-----------------|-----------|
| `apple-silicon-hw` | macOS + VideoToolbox | TSB/API OK | High | HW |
| `intel-qsv` | `h264_qsv` probe + renderD128 | RTSP or TSB | Medium–High | HW copy-first |
| `software-constrained` | Linux/no HW, ≤4 cores | **RTSP** | ≤1080p Medium | Copy-first |
| `pi` | existing raspbian hint | RTSP | ≤1080p | Copy-first |

**Files:**
- `src/protect-platform.ts` — extend `FfmpegCodecs.probe()` results
- `src/devices/protect-camera.ts` — `configureVideoStream()`, `recordingDefault`, new `hostProfile` hint
- `src/protect-stream.ts` — consume profile

**Acceptance:** N150-class box auto-logs: `Host profile: software-constrained (QSV unavailable); live view prefers RTSP, HKSV capped at Medium`.

---

#### P2.3 Protect controller load awareness

**Goal:** Detect livestream API instability and adapt without user tuning.

**Signals (already partially exist):**
- `LivestreamManager.restartCount` / `restartLivestream()` frequency
- `Livestream API connection closed by the controller`
- HKSV `Restarting the livestream API to recover from a recording failure`

**Actions when stall rate > threshold (e.g. 3 restarts / 10 min / camera):**
- Log advisory: `Protect livestream API under stress; consider RTSP live view or lower HKSV quality`
- Auto-set `preferRtspLiveView = true` for 30 min (in-memory, per camera)
- **Do not** auto-downgrade HKSV `recordingDefault` at runtime — `protect-record.ts` documents cascading failures from tearing down healthy livestream connections; cap quality at startup via host profile (P2.0/P2.2) instead

**Files:**
- `src/protect-livestream.ts`
- `src/protect-record.ts`
- `src/devices/protect-camera.ts` — hints

---

#### P2.0 Software-constrained HKSV quality cap (interim, before full host profiles)

**Goal:** Extend the existing Pi `recordingDefault` logic to all Linux hosts without hardware transcode (e.g. N150 before QSV). Default HKSV source to Medium or ≤1080p instead of blank/`High`.

**Why urgent:** Today only `raspbian` gets a cap; Linux without QSV leaves `recordingDefault = ""` → 4K HKSV on 6+ cameras overwhelms the UDM livestream API.

**Files:** `src/devices/protect-camera.ts` — `configureVideoStream()` ~1101

---

#### P2.6 SelfHealing policy under API stress

**Goal:** `Device.SelfHealing` (default **on**) reboots cameras after 10 consecutive livestream stall restarts (`protect-livestream.ts` ~147). On a stressed controller with many HKSV cameras, this amplifies outage rather than recovering.

**Proposed:** On constrained hosts or when fleet-wide restart rate exceeds threshold, log advisory and **skip camera reboot**; prefer RTSP live view (P2.3) instead.

**Files:** `src/protect-livestream.ts`, `src/protect-options.ts`

---

#### P2.4 Shared FFmpeg / fanout (large effort — defer or phase)

**Current:** Each HomeKit viewer → separate `FfmpegStreamingProcess` → full transcode.

**Proposed:** One decode/transcode pipeline per camera, fan out SRTP to N sessions (different SSRC/keys).

**Complexity:** High — session teardown, RECONFIGURE, two-way audio, different client bitrates.

**Recommendation:** Phase 2 after P1/P2.1. Prototype copy-path fanout first (lower CPU win still meaningful).

**Files:**
- New `src/protect-stream-fanout.ts` (or similar)
- `src/protect-stream.ts`
- `homebridge-plugin-utils`

---

### P3 — Memory & HKSV hot paths

#### P3.1 Timeshift buffer allocation

**Current:** `Buffer.concat()` on every `getLast()`, `getLastKeyframe()`, `transmitStart()` — ~100 segments × N HKSV cameras.

**Proposed:**
- Single struct array `{ data, isKeyframe, ts }` (partially exists)
- Cache concatenated prebuffer with generation counter; invalidate on new segment
- Adaptive buffer depth: full 10s for HKSV recording, shorter when only serving snapshots

**Files:**
- `src/protect-timeshift.ts`
- `src/settings.ts` — expose tunables

---

#### P3.2 Deduplicate segment listeners

**Current:** When HKSV active + live view via TSB, same `"segment"` events fan to TSB maintenance, HKSV transmit, and live view FFmpeg stdin.

**Proposed:** Single segment dispatcher per `LivestreamManager` channel; subscribers register once.

**Files:**
- `src/protect-livestream.ts`
- `src/protect-timeshift.ts`
- `src/protect-stream.ts`

---

### P4 — HomeKit protocol completeness

#### P4.1 Implement `StreamRequestTypes.RECONFIGURE`

**Current:** Logged and ignored (`protect-stream.ts` ~1051). HomeKit may stop/start sessions unnecessarily.

**Proposed:**
- Handle bitrate/fps changes without full teardown where FFmpeg allows
- Minimum viable: adjust `-b:v` via restart only when parameters change materially
- Document limitation if FFmpeg can't hot-swap SRTP params

**Files:**
- `src/protect-stream.ts` — `handleStreamRequest()`
- `homebridge-plugin-utils` — `FfmpegStreamingProcess`

---

### P6 — Security & privacy

Security review of the **current branch** (June 2026) found **no medium, high, or critical issues** — the diff is documentation-only (`HOWTO-mmr-hmb-01.md`, `PLAN.md`). No executable code, auth, or network-facing behavior changed. Items below are **forward-looking guardrails** for planned fork work and doc hygiene.

#### P6.1 `videoProcessor` path validation

**Baseline:** `protect-platform.ts` accepts any `videoProcessor` path from config and passes it to `FfmpegCodecs` / FFmpeg spawn. Compromise of `config.json` (or UI with weak access control) → arbitrary binary execution as the Homebridge user.

**Proposed (when touching platform bootstrap):**
- Resolve path to absolute; reject non-executable paths at startup with clear error
- Optional allowlist prefix (e.g. `/usr/lib/jellyfin-ffmpeg/`, bundled ffmpeg path)
- Log resolved path once at startup (already partially done via FFmpeg version line)

**Files:** `src/protect-platform.ts`

**Acceptance:** Invalid or unexpected `videoProcessor` fails fast at launch, not mid-stream.

---

#### P6.2 Session telemetry privacy

**Risk:** P0.1 / P0.5 propose logging `src=<ip> dst=<ip>:<port> client=<optional>`. Home Hub and viewer IPs in shared logs (Homebridge UI, log aggregators, support bundles) are identifiable metadata.

**Proposed:**
- Default INFO: camera name, session id, path, profile, transcode/hw flags, duration, segments-fed — **no client IP**
- Full client/network tuple only when `Debug.Video.Stream.Telemetry` (or existing HKSV telemetry flag) is enabled
- Document in Troubleshooting that verbose telemetry may contain LAN addresses

**Files:** `src/protect-stream.ts`, `docs/Troubleshooting.md`

---

#### P6.3 SRTP fanout crypto isolation (P2.4 prerequisite)

**Risk:** Shared FFmpeg fanout must not reuse SRTP keys/SSRC across HomeKit sessions. Each viewer negotiates distinct crypto material in `prepareStream()`.

**Proposed:** Fanout prototype must fan out **after** per-session SRTP encryption (separate `FfmpegStreamingProcess` outputs or validated multi-destination mux), never broadcast one session’s keys to multiple clients.

**Files:** future `src/protect-stream-fanout.ts`, `homebridge-plugin-utils`

**Acceptance:** Security review gate before merging P2.4.

---

#### P6.4 Deployment doc & repo hygiene

**Current:** `HOWTO-mmr-hmb-01.md` and Deployment context below contain operator-specific LAN IPs, hostnames, NVR MAC, child-bridge port.

**Not a code vulnerability** (operator-owned RFC1918 metadata), but for a **public fork:**
- Generalize or redact MACs/IPs/hostnames in committed docs, or keep HOWTO outside the public tree
- Add referenced setup scripts (`scripts/setup-mmr-hmb-01-qsv.sh`) in-repo and review before documenting `sudo bash` entry points (supply chain / idempotency)
- Cross-VLAN UDP guidance (`ports Any`) is operational — document minimum required ports where possible (ephemeral UDP SRTP + child-bridge TCP), not blanket allow rules

**Files:** `HOWTO-mmr-hmb-01.md`, `docs/Troubleshooting.md`

---

#### P6.5 Baseline codebase notes (no change required today)

| Area | Notes |
|------|-------|
| Protect credentials | Stored in Homebridge `config.json` — standard Homebridge trust model; out of fork scope unless adding new secret surfaces |
| Two-way audio talkback | WebSocket to controller (`getWsEndpoint("talkback")`) — existing; RTSP-first live view must not regress auth on talkback path |
| MQTT snapshot publish | `protect-stream.ts` publishes JPEG as base64 data URL when MQTT enabled — expected; ensure MQTT broker access is documented as trust boundary |
| `curl -sk` in HOWTO verification | TLS verify skip for local UDM connectivity check only — hygiene note, not product defect |
| `ffmpegErrorCheck()` suppression | Known TSB/API errors logged as “safely ignored” — P0.5 should distinguish suppressed-known vs actionable-unknown for operators |

---

### P5 — Explicit non-goals

Do **not** pursue in this fork unless requirements change:

- More per-device feature flags without auto-selection logic
- Pooling FFmpeg across **cameras**
- Sub-200ms live view target on software-transcode Linux
- Reducing HKSV pacing buffer (`protect-record.ts`) — load-bearing for stall absorption
- Removing bundled `ffmpeg-for-homebridge` default (keep; override via `videoProcessor` for QSV)

---

## Suggested PR sequence

| PR | Title | Tier | Risk | Est. size |
|----|-------|------|------|-----------|
| 0 | Vitest harness + stream-path unit tests | P0 | Low | S |
| 0b | Fix TSB livestream start failure cleanup | P0.4 | Low | S |
| 1 | Stream session telemetry + no-output warning (privacy-safe defaults) | P0/P6.2 | Low | S |
| 2 | RTSP-first live view when HKSV active (LAN heuristic) | P1 | Medium | M |
| 2b | Software-constrained HKSV Medium default | P2.0 | Low | S |
| 3 | No fps upsampling; copy-first transcode ladder | P1/P2 | Medium | M |
| 4 | Host capability profiles at startup | P2 | Low | M |
| 5 | Livestream API stress → prefer RTSP; SelfHealing guard | P2/P2.6 | Low | S |
| 6 | TSB buffer concat cache | P3 | Low | S |
| 7 | Decouple live view quality from HKSV rtspEntry (if UseApi kept) | P1 | Medium | M |
| 8 | RECONFIGURE handling | P4 | Medium | M |
| 9 | Stream fanout prototype (after P6.3 review) | P2.4/P6.3 | High | L |
| 10 | Troubleshooting + deployment doc updates | P0/P6.4 | None | S |
| 11 | `videoProcessor` path validation at startup | P6.1 | Low | S |

**Start with PR 0b + PR 1 + PR 2** — fixes silent failure bug, adds diagnosability, and addresses the deployment that motivated this fork (doorbell + fleet load + opaque failures).

---

## Test plan (fork)

**Deploy / manual test procedure:** [docs/Development.md](docs/Development.md) (build, install into Homebridge, mmr-hmb-01 checklist, rollback).

**Automated tests:** none today — add Vitest via PR 0 / [#3](https://github.com/juniorfoo/homebridge-unifi-protect/issues/3) before large refactors.

### Unit / integration
- Mock `StartStreamRequest` with varying `packet_time` (20 vs 60) → assert RTSP vs TSB path
- Mock `findRtsp` with High/Medium/Low → assert profile selection without HKSV override
- Transcode decision matrix: H.264 match → copy; crop enabled → transcode

### Manual (real Protect)
- G4 Doorbell: live view >60s, `[RTSP]` in log, no 15→30 upsample unless needed
- 6+ HKSV cameras: monitor `Restarting livestream API` rate before/after P1.1
- Apple Home on LAN: ⚡ with QSV host; no ⚡ but stable on software host
- Cross-VLAN (if available): telemetry shows `segments-fed` vs timeout

### Regression
- Package camera + HKSV still uses TSB/API
- AV1 camera without RTSP still requires HKSV + API path
- Two-way doorbell audio sessions
- Child bridge restart / config reload

### Security
- `livestream.start()` failure → callback error, FFmpeg stopped, ports released (P0.4)
- Default stream telemetry logs **no** client IP; full tuple only with debug flag (P6.2)
- Invalid `videoProcessor` path rejected at startup (P6.1)
- SelfHealing does not reboot cameras during fleet-wide API stall storm (P2.6)

---

## Configuration defaults (proposed end state)

| Option | Today | Proposed |
|--------|-------|----------|
| `Video.Stream.UseApi` | `true` | `false` (or auto: true only when needed) |
| `Video.Transcode` | `true` | `false` with auto-escalation on copy failure |
| `Video.Transcode.Hardware` | `true` | unchanged |
| `Video.HKSV.Record.Only.*` | user-driven | host profile suggests Medium on constrained |

Per-device overrides remain for power users; defaults should work on N150 + UDM + 6 HKSV without feature-flag archaeology.

---

## Reference: key code locations

| Area | File | Functions / lines |
|------|------|-------------------|
| Live view path | `src/protect-stream.ts` | `startStream()`, `useTsb` ~445 |
| Transcode decision | `src/protect-stream.ts` | `isTranscoding` ~438 |
| Session lifecycle | `src/protect-stream.ts` | `handleStreamRequest()`, `stopStream()` |
| HKSV pacing | `src/protect-record.ts` | `handleRecordingStreamRequest()` |
| TSB buffer | `src/protect-timeshift.ts` | `getLast()`, `eventHandlers.segment` |
| Livestream pool | `src/protect-livestream.ts` | `acquire()`, `restartLivestream()` |
| Feature options | `src/protect-options.ts` | `Video.Stream.UseApi`, `Video.Transcode` |
| Host tuning | `src/devices/protect-camera.ts` | `configureVideoStream()`, Pi cap ~1107 |
| FFmpeg path | `src/protect-platform.ts` | `videoProcessor`, `FfmpegCodecs.probe()` |
| Constants | `src/settings.ts` | `PROTECT_HKSV_TIMEOUT`, segment resolution |

---

## Deployment context (mmr-hmb-01)

Captured for validation; not fork-specific code.

- Homebridge `192.168.30.100`, Home Hub `192.168.3.31`, UDM `192.168.3.1`
- Intel N150, Ubuntu 24.04 → upgrading to 26.04 for i915 / `8086:46d4`
- Jellyfin FFmpeg 7.1.4 via `videoProcessor`
- `Disable.Video.Stream.UseApi` on NVR MAC — manual workaround for P1.1
- Fixed inter-VLAN UDP — outside plugin but telemetry (P0.1) would have saved hours

---

## Open questions for fork owner

1. **Breaking changes:** OK to flip `Video.Stream.UseApi` default in a major fork release?
2. **Scope:** Plugin-only, or also patch `homebridge-plugin-utils` for fanout / FFmpeg hooks?
3. **Upstream:** Intent to PR back to `hjdhjd/homebridge-unifi-protect` or long-lived fork?
4. **Hardware test matrix:** Access to Mac (VideoToolbox), Intel QSV, Pi, and UDM for CI/manual runs?
5. **Telemetry privacy:** Client IP in logs — never by default, or hash/truncate (e.g. last octet only)?
6. **Public fork docs:** Redact mmr-hmb-01-specific IPs/MACs in committed HOWTO, or keep private?
7. **SelfHealing:** Disable by default on constrained hosts, or only suppress camera reboot under API stress?
8. **Fanout gate:** Require explicit security review checklist (P6.3) before P2.4 merge?

---

## Security review log

| Date | Scope | Result |
|------|-------|--------|
| June 2026 | Branch diff: `HOWTO-mmr-hmb-01.md`, `PLAN.md` only | **No medium/high/critical findings.** Docs-only; no runtime attack surface added. Optional hygiene: redact deployment metadata for public repos; review setup scripts before documenting `sudo bash`. |

Forward-looking items from that review are captured in **P6** above (telemetry privacy, `videoProcessor` validation, fanout SRTP isolation, doc hygiene).

---

*Generated from analysis session June 2026. Baseline plugin v7.29.0. Security review added June 2026.*
