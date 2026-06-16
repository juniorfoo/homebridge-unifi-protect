# Fork development, testing, and deployment

This document covers how to build, test, and install this fork of `homebridge-unifi-protect` into a running Homebridge instance (including the **mmr-hmb-01** deployment). It complements [PLAN.md](../PLAN.md) and [HOWTO-mmr-hmb-01.md](../HOWTO-mmr-hmb-01.md).

**GitHub tracking:** implementation work is filed as issues [#1–#14](https://github.com/juniorfoo/homebridge-unifi-protect/issues/15); test harness bootstrap is [#3](https://github.com/juniorfoo/homebridge-unifi-protect/issues/3).

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js ≥ 22** | Matches `package.json` `engines.node` |
| **npm** | Used for install/build |
| **Homebridge ≥ 1.8** | Standard Homebridge host or child bridge |
| **UniFi Protect access** | Manual streaming tests need a real controller |

On a dev machine you only need Node + git. On **mmr-hmb-01**, Homebridge runs as user `homebridge` with config at `/var/lib/homebridge`.

---

## Local build

From the repository root:

```bash
npm ci
npm run build
npm test
```

The plugin entry point is **`dist/index.js`** (compiled from `src/`). Homebridge does **not** run TypeScript directly — you must rebuild after every code change.

Other useful commands:

```bash
npm run lint          # ESLint (runs build-ui first)
npm run test:watch    # Vitest in watch mode
npm run clean         # Remove dist/ and UI artifacts
```

---

## Automated tests

**Vitest** covers the full plugin (`src/`). Coverage thresholds are enforced at **95%** for lines, branches, functions, and statements.

| Command | Purpose |
|---------|---------|
| `npm test` | Run all tests once |
| `npm run test:coverage` | Run tests with coverage report and threshold gate |
| `npm run test:watch` | Re-run on file changes |
| `npm run check` | Lint, build, and test with coverage (pre-deploy gate) |

Pre-deploy gate:

```bash
npm run check
```

### Layout

Tests mirror `src/` — one file per module where practical:

| Path | Tests |
|------|-------|
| `test/helpers/mocks.ts` | Shared Homebridge / NVR / accessory mocks |
| `test/setup.ts` | Global mocks for `homebridge-plugin-utils` |
| `test/host-profile.test.ts`, `test/stream-path.test.ts`, … | Pure helper modules at `src/` root |
| `test/devices/*.test.ts` | Device classes (`src/devices/`) |
| `test/protect-*.test.ts` | Platform, NVR, streaming, HKSV, events |

Hardware-only scenarios (cross-VLAN SRTP, real Protect controller) remain manual — see [HOWTO-mmr-hmb-01.md](../HOWTO-mmr-hmb-01.md) §5.

### Planned next (no Protect hardware)

Tracked in [#3](https://github.com/juniorfoo/homebridge-unifi-protect/issues/3) — blocks copy-first transcode (#7), host profiles (#8), RECONFIGURE (#12).

### What stays manual (Protect + HomeKit)

- Live view duration >60s (UDP SRTP path)
- G4 Doorbell two-way audio on RTSP vs TSB
- HKSV event recording under fleet load
- QSV / Jellyfin FFmpeg on mmr-hmb-01

Use the checklists in [HOWTO-mmr-hmb-01 §5](../HOWTO-mmr-hmb-01.md#5-verification-checklist) and **Manual** / **Security** sections in [PLAN.md](../PLAN.md).

Pre-deploy gate:

```bash
npm run lint && npm run build && npm test
```

---

## Install into Homebridge

Homebridge loads plugins from **`node_modules`**. On a typical Linux install:

```text
/var/lib/homebridge/
├── config.json
├── homebridge.log
└── node_modules/
    └── homebridge-unifi-protect/   ← plugin lives here
```

This fork runs as a **child bridge** on mmr-hmb-01 (port **45066**). Plugin changes require a **child bridge or Homebridge restart** — config.json is unchanged unless you add options.

### Option A — Install from Git (recommended for branch/tag testing)

On the Homebridge host:

```bash
sudo -u homebridge -H bash -lc '
  cd /var/lib/homebridge
  npm install github:juniorfoo/homebridge-unifi-protect#<branch-or-tag>
'
sudo systemctl restart homebridge
```

Examples:

```bash
# Specific branch
npm install github:juniorfoo/homebridge-unifi-protect#issue-1-livestream-fix

# Tagged release (when you publish one)
npm install github:juniorfoo/homebridge-unifi-protect#v7.29.1-fork.1
```

**Homebridge UI:** Plugins → ⋮ → **Install from Git** →  
`https://github.com/juniorfoo/homebridge-unifi-protect.git#<branch>`

`npm install` from git runs `prepublishOnly` (lint + build) on the server — ensure Node 22+ and enough RAM for the build.

### Option B — Symlink (fastest iteration on the server)

Clone the repo on mmr-hmb-01 (or mount it), build locally, symlink into Homebridge:

```bash
# Build (as your user)
cd ~/Projects/homebridge-unifi-protect
npm ci && npm run build

# Link as homebridge user (adjust repo path)
sudo -u homebridge -H bash -lc '
  cd /var/lib/homebridge/node_modules
  rm -rf homebridge-unifi-protect
  ln -s /home/cav/Projects/homebridge-unifi-protect homebridge-unifi-protect
'

sudo systemctl restart homebridge
```

After each edit: `npm run build` in the repo, then restart the child bridge or Homebridge. No reinstall needed.

### Option C — Copy build artifact (one-off)

Less common: `rsync` or `cp -a` the whole plugin directory into `node_modules/homebridge-unifi-protect` after `npm run build`. Use A or B instead unless you have a reason.

---

## Restart and verify

### Restart

Full service (simplest):

```bash
sudo systemctl restart homebridge
```

Or restart only the **UniFi Protect child bridge** in Homebridge UI → Settings → Bridges.

### Confirm the fork is loaded

```bash
# Plugin version (bump package.json version on the fork to tell builds apart)
sudo -u homebridge -H bash -lc '
  node -p "require(\"/var/lib/homebridge/node_modules/homebridge-unifi-protect/package.json\").version"
'

# Recent plugin log lines
grep -E "UniFi Protect|FFmpeg version|Streaming request" \
  /var/lib/homebridge/homebridge.log | tail -30
```

For symlink installs, verify the path resolves to your repo:

```bash
readlink -f /var/lib/homebridge/node_modules/homebridge-unifi-protect
```

---

## Testing a fix on mmr-hmb-01

### General regression (any change)

1. Open live view on G4 Doorbell and one HKSV camera — stream **>60 seconds**.
2. Confirm log path: `[RTSP]` or `[TSB/API]` per your feature options.
3. Trigger an HKSV clip — no burst of `Restarting the livestream API`.
4. Optional: `ps aux | grep ffmpeg` — no stray processes after stopping live view.

Log tail:

```bash
grep -E "Streaming request|Stopped video|livestream|Unable to access|FFmpeg|livestream-acquire" \
  /var/lib/homebridge/homebridge.log | tail -50
```

Per-camera verbose FFmpeg (temporary):

```text
Enable.Debug.Video.FFmpeg.<camera-mac-lowercase-no-colons>
```

### Issue #1 — TSB `livestream.start()` failure cleanup

**Path exercised:** HKSV recording on + **Livestream API** live view (`Video.Stream.UseApi` default).  
If `Disable.Video.Stream.UseApi` is set (mmr-hmb-01 workaround), remove it temporarily to hit the TSB/API code path.

| Check | Expected after fix |
|-------|---------------------|
| Normal live view with HKSV | Still works; no regression |
| Failed acquire (controller restart/blip) | HomeKit gets an error; session ends cleanly |
| `ps aux \| grep ffmpeg` | No orphaned FFmpeg after failure |
| Log | No hung session; future telemetry: `reason=livestream-acquire-failed` (#4) |
| Repeated failures | No “Unable to reserve UDP ports” from leaked reservations |

Automated coverage for #1 should land in #3 (mock failed `livestream.start()`).

---

## Roll back to upstream npm

```bash
sudo -u homebridge -H bash -lc '
  cd /var/lib/homebridge
  npm install homebridge-unifi-protect@7.29.0
'
sudo systemctl restart homebridge
```

Remove any symlink first if you used Option B.

---

## Suggested workflow

1. Implement on a branch → push to `juniorfoo/homebridge-unifi-protect`.
2. `npm run lint && npm run build` locally.
3. Deploy to mmr-hmb-01 via **Git install** (Option A) for first validation; use **symlink** (Option B) for daily iteration.
4. Run manual checklist (above + [HOWTO §5](../HOWTO-mmr-hmb-01.md#5-verification-checklist)).
5. Tag a release (e.g. `v7.29.1-fork.1`) and pin production installs to that tag.
6. Add/run `npm test` once [#3](https://github.com/juniorfoo/homebridge-unifi-protect/issues/3) is done.

Existing mmr-hmb-01 settings (`videoProcessor`, HKSV Medium cap, child bridge, firewall) stay as-is — only the plugin under `node_modules` changes.

---

## Related docs

- [PLAN.md](../PLAN.md) — optimization roadmap and test matrix
- [HOWTO-mmr-hmb-01.md](../HOWTO-mmr-hmb-01.md) — network, QSV, production tuning
- [Troubleshooting.md](./Troubleshooting.md) — upstream streaming debug
- [BestPractices.md](./BestPractices.md) — child bridges
