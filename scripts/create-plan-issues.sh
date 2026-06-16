#!/usr/bin/env bash
# Creates GitHub issues from PLAN.md with blocked-by links. Requires: gh, jq
set -euo pipefail
REPO="juniorfoo/homebridge-unifi-protect"
MAP="/tmp/hbup-plan-issues.json"
PLAN="https://github.com/${REPO}/blob/main/PLAN.md"

declare -A TITLES BODIES LABELS

TITLES[0b]="[P0.4] Fix TSB livestream.start() failure cleanup"
LABELS[0b]="tier/P0,size/S,bug,epic/reliability"
BODIES[0b]='## Summary
When `livestream.start()` fails after FFmpeg is spawned, `startStream()` returns without callback, without stopping FFmpeg, and without releasing RTP ports (`protect-stream.ts` ~830).

## Plan
P0.4 · [PLAN.md]('"$PLAN"')

## Files
- `src/protect-stream.ts`

## Acceptance criteria
- [ ] StreamRequestCallback invoked with error on failed acquire
- [ ] Orphaned `FfmpegStreamingProcess` stopped
- [ ] Pending-session RTP ports released
- [ ] Log: `reason=livestream-acquire-failed`'

TITLES[11]="[P6.1] videoProcessor path validation at startup"
LABELS[11]="tier/P6,size/S,enhancement,epic/security"
BODIES[11]='## Summary
Validate `videoProcessor` at bootstrap: absolute path, executable check, optional allowlist. Fail fast at launch.

## Plan
P6.1 · [PLAN.md]('"$PLAN"')

## Files
- `src/protect-platform.ts`

## Acceptance criteria
- [ ] Invalid/non-executable path rejected at startup with clear error
- [ ] Resolved path logged once'

TITLES[0]="[P0] Vitest harness + stream-path unit tests"
LABELS[0]="tier/P0,size/S,enhancement,epic/reliability"
BODIES[0]='## Summary
Bootstrap Vitest and mock-based tests for stream path selection and transcode decisions.

## Plan
PR 0 · [PLAN.md]('"$PLAN"')

## Acceptance criteria
- [ ] `npm test` script
- [ ] Mock `StartStreamRequest` (packet_time 20 vs 60)
- [ ] Mock `findRtsp` profile selection
- [ ] Runs on Node 22'

TITLES[1]="[P0] Stream session telemetry + no-output warning"
LABELS[1]="tier/P0,tier/P6,size/S,enhancement,epic/reliability,epic/security"
BODIES[1]='## Summary
Structured live-view start/stop logs; warn if no FFmpeg output within ~10s. Default INFO omits client IP (P6.2).

## Plan
P0.1, P0.3, P0.5, P6.2 · [PLAN.md]('"$PLAN"')

## Files
- `src/protect-stream.ts`
- `homebridge-plugin-utils` (exit hooks if needed)

## Acceptance criteria
- [ ] Start/stop structured logs (path, profile, transcode, segments-fed, duration)
- [ ] No-output warning without killing session
- [ ] Client IP only with debug telemetry flag'

TITLES[2]="[P1] RTSP-first live view when HKSV active"
LABELS[2]="tier/P1,size/M,enhancement,epic/live-view"
BODIES[2]='## Summary
Prefer RTSP for live view when HKSV is active (LAN heuristic, constrained hosts). Auto-select away from default TSB/API path.

## Plan
P1.1 · [PLAN.md]('"$PLAN"')

## Files
- `src/protect-stream.ts`, `src/protect-options.ts`, `src/devices/protect-camera.ts`

## Acceptance criteria
- [ ] Doorbell LAN live view shows `[RTSP]` with HKSV on
- [ ] AV1, package camera, explicit UseApi still use TSB/API
- [ ] Changelog for default change'

TITLES[2b]="[P2.0] Software-constrained HKSV Medium default"
LABELS[2b]="tier/P2,size/S,enhancement,epic/scale"
BODIES[2b]='## Summary
Cap HKSV `recordingDefault` on Linux without HW transcode (N150 gap — today only Pi is capped).

## Plan
P2.0 · [PLAN.md]('"$PLAN"')

## Files
- `src/devices/protect-camera.ts` ~1101

## Acceptance criteria
- [ ] No-HW Linux → Medium or ≤1080p default, not blank/High'

TITLES[3]="[P1/P2] No fps upsampling; copy-first transcode ladder"
LABELS[3]="tier/P1,tier/P2,size/M,enhancement,epic/live-view,epic/scale"
BODIES[3]='## Summary
Match source fps (no 15→30 upsample by default). Copy-first H.264 with validation and transcode fallback.

## Plan
P1.3, P2.1 · [PLAN.md]('"$PLAN"')

## Files
- `src/protect-stream.ts`, `src/protect-options.ts`, `homebridge-plugin-utils`

## Acceptance criteria
- [ ] Copy path when H.264 compatible; log reason when transcoding
- [ ] Copy failure escalates to transcode'

TITLES[4]="[P2] Host capability profiles at startup"
LABELS[4]="tier/P2,size/M,enhancement,epic/scale"
BODIES[4]='## Summary
Auto-detect apple-silicon-hw, intel-qsv, software-constrained, pi — tune live view, HKSV cap, transcode defaults.

## Plan
P2.2 · [PLAN.md]('"$PLAN"')

## Files
- `src/protect-platform.ts`, `src/devices/protect-camera.ts`, `src/protect-stream.ts`

## Acceptance criteria
- [ ] Startup logs host profile and applied defaults
- [ ] Extends interim HKSV cap logic'

TITLES[5]="[P2] Livestream API stress → prefer RTSP; SelfHealing guard"
LABELS[5]="tier/P2,size/S,enhancement,epic/scale"
BODIES[5]='## Summary
Detect API restart storms; set `preferRtspLiveView` temporarily. Suppress SelfHealing camera reboot under stress. No runtime HKSV downgrade.

## Plan
P2.3, P2.6 · [PLAN.md]('"$PLAN"')

## Files
- `src/protect-livestream.ts`, `src/protect-record.ts`, `src/protect-camera.ts`

## Acceptance criteria
- [ ] Advisory + prefer RTSP after threshold
- [ ] No camera reboot during fleet API stress'

TITLES[6]="[P3] TSB buffer concat cache"
LABELS[6]="tier/P3,size/S,enhancement,epic/memory"
BODIES[6]='## Summary
Cache concatenated TSB prebuffer; reduce `Buffer.concat()` hot path.

## Plan
P3.1 · [PLAN.md]('"$PLAN"')

## Files
- `src/protect-timeshift.ts`, `src/settings.ts`

## Acceptance criteria
- [ ] Cache with generation invalidation; HKSV/snapshot behavior unchanged'

TITLES[7]="[P1] Decouple live view quality from HKSV rtspEntry"
LABELS[7]="tier/P1,size/M,enhancement,epic/live-view"
BODIES[7]='## Summary
TSB/API live view uses `findRtsp()` for live quality, not `hksv.rtspEntry`.

## Plan
P1.2 · [PLAN.md]('"$PLAN"')

## Files
- `src/protect-stream.ts`, possibly `protect-record.ts`

## Acceptance criteria
- [ ] Live view not forced to HKSV Low when buffer uses Low'

TITLES[8]="[P4] RECONFIGURE handling"
LABELS[8]="tier/P4,size/M,enhancement,epic/protocol"
BODIES[8]='## Summary
Handle `StreamRequestTypes.RECONFIGURE` — adjust or restart FFmpeg when HomeKit changes bitrate/fps/resolution.

## Plan
P4.1 · [PLAN.md]('"$PLAN"')

## Files
- `src/protect-stream.ts`, `homebridge-plugin-utils`

## Acceptance criteria
- [ ] RECONFIGURE no longer no-op; document SRTP hot-swap limits'

TITLES[9]="[P2.4] Stream fanout prototype"
LABELS[9]="tier/P2,size/L,enhancement,epic/scale,epic/security"
BODIES[9]='## Summary
One pipeline per camera, fan out SRTP to N viewers. Copy-path prototype first. **P6.3:** distinct SRTP keys per session — security review required before merge.

## Plan
P2.4, P6.3 · [PLAN.md]('"$PLAN"')

## Files
- New `src/protect-stream-fanout.ts`, `protect-stream.ts`, `homebridge-plugin-utils`

## Acceptance criteria
- [ ] Multi-viewer copy fanout reduces CPU
- [ ] Per-viewer SRTP isolation verified
- [ ] Security checklist signed off'

TITLES[10]="[P0/P6] Troubleshooting + deployment doc updates"
LABELS[10]="tier/P0,tier/P6,size/S,documentation,epic/reliability,epic/security"
BODIES[10]='## Summary
Docs: cross-VLAN UDP, log suffixes, QSV/Jellyfin, Alder Lake-N kernel, telemetry privacy. Generalize mmr-hmb-01-specific metadata for public fork.

## Plan
P0.2, P6.4 · [PLAN.md]('"$PLAN"')

## Files
- `docs/Troubleshooting.md`, `HOWTO-mmr-hmb-01.md`

## Acceptance criteria
- [ ] Troubleshooting sections from PLAN P0.2
- [ ] Privacy note for verbose telemetry
- [ ] Setup scripts in repo before `sudo bash` docs'

# blocked-by map: issue_key -> space-separated blocker keys
declare -A BLOCKED_BY
BLOCKED_BY[0b]=""
BLOCKED_BY[11]=""
BLOCKED_BY[0]=""
BLOCKED_BY[1]="0b"
BLOCKED_BY[2]="0b"
BLOCKED_BY[2b]=""
BLOCKED_BY[3]="0 2"
BLOCKED_BY[4]="2b 0"
BLOCKED_BY[5]="2"
BLOCKED_BY[6]=""
BLOCKED_BY[7]="2"
BLOCKED_BY[8]="0"
BLOCKED_BY[9]="3"
BLOCKED_BY[10]="0b 1 2 2b 11"

ORDER=(0b 11 0 1 2 2b 3 4 5 6 7 8 9 10)

echo "[]" > "$MAP"

for key in "${ORDER[@]}"; do
  url=$(gh issue create --repo "$REPO" --title "${TITLES[$key]}" --label "${LABELS[$key]}" --body "${BODIES[$key]}")
  num="${url##*/}"
  echo "Created #$num (${key}): ${TITLES[$key]}"
  jq --arg k "$key" --argjson n "$num" --arg u "$url" '. += [{"key": $k, "number": $n, "url": $u}]' "$MAP" > "${MAP}.tmp" && mv "${MAP}.tmp" "$MAP"
done

# Build key -> number lookup
declare -A NUM
while IFS= read -r row; do
  k=$(echo "$row" | jq -r .key)
  n=$(echo "$row" | jq -r .number)
  NUM[$k]=$n
done < <(jq -c '.[]' "$MAP")

# Build blocks map (reverse of blocked-by)
declare -A BLOCKS
for key in "${ORDER[@]}"; do
  for blocker in ${BLOCKED_BY[$key]:-}; do
    BLOCKS[$blocker]+=" $key"
  done
done

link_deps() {
  local key="$1"
  local num="${NUM[$key]}"
  local blocked=""
  local blocks=""
  for b in ${BLOCKED_BY[$key]:-}; do
    blocked+="- #${NUM[$b]}\n"
  done
  [[ -z "$blocked" ]] && blocked="- _(none — can start immediately)_\n"
  for b in ${BLOCKS[$key]:-}; do
    blocks+="- #${NUM[$b]}\n"
  done
  [[ -z "$blocks" ]] && blocks="- _(none)_\n"

  local dep_section="

---

## Dependencies
**Blocked by:**
${blocked}
**Blocks:**
${blocks}
_Tracking: [PLAN.md]('"$PLAN"') · Key: \`${key}\`_"

  gh issue edit "$num" --repo "$REPO" --body "${BODIES[$key]}${dep_section}"
}

for key in "${ORDER[@]}"; do
  link_deps "$key"
  echo "Linked dependencies for #${NUM[$key]} (${key})"
done

# GitHub native blocked-by via GraphQL
add_blocked_by() {
  local issue_num="$1"
  local blocker_num="$2"
  local issue_id blocker_id
  issue_id=$(gh api "repos/${REPO}/issues/${issue_num}" --jq .node_id)
  blocker_id=$(gh api "repos/${REPO}/issues/${blocker_num}" --jq .node_id)
  gh api graphql -f query="
    mutation(\$issue: ID!, \$blocker: ID!) {
      addBlockedBy(input: {issueId: \$issue, blockingIssueId: \$blocker}) {
        clientMutationId
      }
    }" -f issue="$issue_id" -f blocker="$blocker_id" >/dev/null 2>&1 || \
  echo "  (GraphQL blocked-by #${blocker_num}->#${issue_num}: may require Projects beta or repo setting)"
}

echo "Adding GitHub blocked-by relationships..."
for key in "${ORDER[@]}"; do
  for blocker in ${BLOCKED_BY[$key]:-}; do
    add_blocked_by "${NUM[$key]}" "${NUM[$blocker]}"
    echo "  #${NUM[$blocker]} blocks #${NUM[$key]}"
  done
done

# Roadmap tracking issue
ROADMAP_BODY="Master tracker for the [Optimization & Reliability Plan](${PLAN}).

## Implementation issues (14)

| # | Key | Title |
|---|-----|-------|
"
for key in "${ORDER[@]}"; do
  ROADMAP_BODY+="| #${NUM[$key]} | \`${key}\` | ${TITLES[$key]} |
"
done

ROADMAP_BODY+="
## Recommended start order
1. #${NUM[0b]} — bugfix (orphaned FFmpeg)
2. #${NUM[1]} + #${NUM[2]} + #${NUM[2b]} — telemetry, RTSP-first, HKSV cap (parallel after bugfix)
3. Follow dependency graph on each issue

## Epics (labels)
- \`epic/reliability\` — P0 items
- \`epic/live-view\` — P1 items
- \`epic/scale\` — P2 items
- \`epic/memory\` — P3 items
- \`epic/protocol\` — P4 items
- \`epic/security\` — P6 items"

roadmap_url=$(gh issue create --repo "$REPO" --title "Epic: Optimization & Reliability Plan (PLAN.md roadmap)" --label "documentation,epic/reliability,epic/live-view,epic/scale" --body "$ROADMAP_BODY")
roadmap_num="${roadmap_url##*/}"
echo ""
echo "Roadmap tracker: $roadmap_url"
echo ""
echo "=== Issue map ==="
jq -r '.[] | "#\(.number) (\(.key)): \(.url)"' "$MAP"
echo "Roadmap: #${roadmap_num}"
