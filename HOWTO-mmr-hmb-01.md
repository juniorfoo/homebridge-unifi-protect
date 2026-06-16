# Homebridge UniFi Protect on mmr-hmb-01

Setup and optimization guide for running `homebridge-unifi-protect` on **mmr-hmb-01** with a **UniFi UDM Pro** controller and an **Intel N150** (Alder Lake-N) host.

This document covers network requirements, streaming tuning, Intel Quick Sync (QSV) hardware transcoding, and verification steps discovered during troubleshooting in June 2026.

## Quick start (on mmr-hmb-01)

Network/firewall fixes are already in place. To finish QSV + Jellyfin FFmpeg setup, SSH to the host and run:

```bash
sudo bash ~/setup-mmr-hmb-01-qsv.sh
```

That script is also in this repo at `scripts/setup-mmr-hmb-01-qsv.sh`. It requires `sudo` (installs packages, loads `i915`, updates `/var/lib/homebridge/config.json`, restarts Homebridge).

---

## Environment summary

| Component | Value |
|-----------|-------|
| Homebridge host | `mmr-hmb-01` — Ubuntu 24.04, Intel N150, 4 cores, 16 GB RAM |
| Homebridge IP | `192.168.30.100` |
| UniFi Protect / UDM | `mmr-udm-01` — `192.168.3.1`, Protect 7.1.83, UniFi OS 5.1.15 |
| Cameras | 8 (G4 Doorbell, G6 Turrets, NC334-XD) |
| Plugin | `homebridge-unifi-protect` v7.29.0 (child bridge on port 45066) |
| Default FFmpeg | Bundled `ffmpeg-for-homebridge` 8.0 static (no QSV) |

---

## 1. Network — required for live streaming

HomeKit camera **snapshots use TCP** (HAP). **Live video uses UDP SRTP** from Homebridge to the Home Hub / viewing device on ephemeral ports. If UDP is blocked between VLANs, streams start and die after ~30 seconds with:

```
Streaming request: ...
Stopped video streaming session.
```

### Symptom

- Snapshots work
- Live view fails after ~30 seconds
- FFmpeg processes appear briefly in `ps` then disappear
- No FFmpeg errors in logs

### Fix on UniFi UDM

Ensure **LAN In** firewall rules exist **above** any inter-VLAN block rules:

1. **Allow UDP** from Homebridge network (`192.168.30.0/24`) → camera/Home Hub network (`192.168.3.0/24`), ports **Any**
2. **Allow UDP** return path (`192.168.3.0/24` → `192.168.30.0/24`), ports **Any**
3. **Allow TCP** to Homebridge child bridge port **45066** (UniFi Protect)
4. Disable **Isolate network** on either VLAN unless explicit allows are in place
5. Enable **mDNS** reflection between VLANs (Settings → Networks → Multicast DNS)

### Best practice

Move Homebridge to the **same VLAN as the Home Hub and cameras** (`192.168.3.x`) to avoid cross-VLAN UDP entirely.

### Verify

On `mmr-hmb-01`, while opening a live stream in the Home app:

```bash
sudo tcpdump -ni enp1s0 host 192.168.3.31 and udp
```

Replace `192.168.3.31` with your Home Hub IP. You should see continuous UDP packets for the duration of the stream.

---

## 2. Plugin streaming path

### Live view: prefer RTSP on LAN

When HKSV is enabled, the plugin defaults to the **Livestream API + timeshift buffer** (`[TSB/API]` in logs). For troubleshooting or lower Protect controller load, use direct RTSP:

**Feature option** (global or per NVR/camera MAC):

```
Disable.Video.Stream.UseApi
```

Per-device example (NVR MAC `68D79A293B05`):

```
Disable.Video.Stream.UseApi.68D79A293B05
```

Logs should show `[RTSP]` instead of `[TSB/API]`.

### HKSV recording quality

Six cameras at 4K HKSV stresses the UDM Pro livestream API. Cap recording quality on constrained hosts:

```
Enable.Video.HKSV.Record.Only.Medium
```

Per NVR:

```
Enable.Video.HKSV.Record.Only.Medium.68D79A293B05
```

Avoid forcing `Stream.Only.Low` unless needed — G4 Doorbell Low is 15 fps and requires upscaling to HomeKit's 30 fps request.

### Child bridge

Run UniFi Protect as a **child bridge** (already configured). Keeps camera FFmpeg load isolated from other plugins.

---

## 3. Intel Quick Sync (QSV) hardware transcoding

The bundled `ffmpeg-for-homebridge` binary **does not include QSV** on Linux static builds. The N150 **does** support Quick Sync, but three layers must work:

1. **Kernel**: `i915` driver bound to the Intel iGPU (not `simple-framebuffer`)
2. **Userspace**: VA-API drivers (`intel-media-va-driver`)
3. **FFmpeg**: Jellyfin build with `h264_qsv` / `hevc_qsv` encoders
4. **HBUP config**: `videoProcessor` pointing at Jellyfin FFmpeg
5. **Permissions**: `homebridge` user in `video` and `render` groups

When QSV is active, stream logs show a **⚡** (lightning bolt) before the streaming line.

### 3.1 Install packages (Ubuntu 24.04)

```bash
# VA-API and diagnostics
sudo apt update
sudo apt install -y vainfo intel-media-va-driver intel-gpu-tools linux-firmware

# Jellyfin FFmpeg (QSV-enabled build) — ffmpeg only, not the full Jellyfin server
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/jellyfin.gpg

echo "deb [signed-by=/etc/apt/keyrings/jellyfin.gpg arch=amd64] https://repo.jellyfin.org/ubuntu noble main" \
  | sudo tee /etc/apt/sources.list.d/jellyfin.list

sudo apt update
sudo apt install -y jellyfin-ffmpeg7
```

Jellyfin FFmpeg path: `/usr/lib/jellyfin-ffmpeg/ffmpeg`

### 3.2 Enable iGPU driver

```bash
sudo modprobe i915
echo i915 | sudo tee /etc/modules-load.d/i915.conf
```

Verify:

```bash
lspci -k -s 00:02.0          # should show "Kernel driver in use: i915"
ls -la /dev/dri/              # should include renderD128
vainfo                        # should list H264/HEVC encode profiles
/usr/lib/jellyfin-ffmpeg/ffmpeg -hide_banner -encoders 2>/dev/null | grep qsv
```

If `i915` fails to bind and `/dev/dri/card0` stays on `simple-framebuffer`, see **section 3.2.1** below.

### 3.2.1 Alder Lake-N kernel fix (mmr-hmb-01 / Intel N150)

The N150 iGPU is PCI device **`8086:46d4`**. On kernel **6.8.0-124-generic**, the `i915` module **does not list this device** in its supported aliases — so the kernel never binds `i915` to the GPU. Instead, boot falls back to **`simpledrm`** / `simple-framebuffer`:

```
[drm] Initialized simpledrm ... for simple-framebuffer.0 on minor 0
```

Symptoms after reboot:

- `lspci -k -s 00:02.0` — **no** "Kernel driver in use: i915"
- `/dev/dri/` — only `card0`, **no** `renderD128`
- `vainfo --display drm` — `failed to initialize display 'drm'`
- Jellyfin FFmpeg lists `h264_qsv` encoders but **cannot use them**

**Fix:** install the Ubuntu 24.04 HWE kernel (6.17+ includes Alder Lake-N support):

```bash
sudo apt install -y linux-generic-hwe-24.04
sudo reboot
```

After reboot, confirm the running kernel and GPU:

```bash
uname -r                                    # expect 6.17.x-generic
modinfo i915 | grep 46d4                    # should match 8086:46d4
lspci -k -s 00:02.0                         # Kernel driver in use: i915
ls -la /dev/dri/                            # renderD128 present
LIBVA_DRIVER_NAME=iHD vainfo --display drm  # H264/HEVC encode profiles
```

Or run the helper script:

```bash
sudo bash ~/fix-mmr-hmb-01-i915-kernel.sh
```

If HWE still leaves `simple-framebuffer` in charge, add to `/etc/default/grub` → `GRUB_CMDLINE_LINUX_DEFAULT`:

```text
i915.force_probe=46d4
```

Then `sudo update-grub && sudo reboot`. Also verify **integrated graphics is enabled** in the EQ mini PC BIOS.

### 3.3 Homebridge user permissions

```bash
sudo usermod -aG video,render homebridge
```

Restart Homebridge after group changes.

### 3.4 Point HBUP at Jellyfin FFmpeg

In `/var/lib/homebridge/config.json`, on the `UniFi Protect` platform object:

```json
"videoProcessor": "/usr/lib/jellyfin-ffmpeg/ffmpeg"
```

Or set **Settings → Additional Settings → FFmpeg path** in the HBUP web UI.

Keep `Video.Transcode.Hardware` enabled (default).

Restart Homebridge:

```bash
sudo systemctl restart homebridge
```

Startup log should show the Jellyfin FFmpeg version and, after opening a stream, **⚡** on transcode lines.

---

## 4. Automated setup script

A one-shot script installs VA-API, Jellyfin FFmpeg, configures the `i915` driver, adds `homebridge` to `video`/`render`, sets `videoProcessor` in config, and restarts the service.

**On mmr-hmb-01** (already copied to `~/setup-mmr-hmb-01-qsv.sh`):

```bash
sudo bash ~/setup-mmr-hmb-01-qsv.sh
```

**From this repo:**

```bash
sudo bash scripts/setup-mmr-hmb-01-qsv.sh
```

The script backs up `config.json` with a timestamp suffix before editing.

---

## 5. Verification checklist

After completing setup:

- [ ] `ping` or `curl -sk https://192.168.3.1/` succeeds from `mmr-hmb-01`
- [ ] Home app live view runs **longer than 30 seconds**
- [ ] Log shows intended path: `[RTSP]` or `[TSB/API]`
- [ ] `vainfo` reports Intel iHD driver with encode profiles
- [ ] `/usr/lib/jellyfin-ffmpeg/ffmpeg -encoders | grep qsv` lists encoders
- [ ] Homebridge log: `Using FFmpeg version:` references Jellyfin build (not `homebridge-alpine-x86_64-static`)
- [ ] Stream log includes **⚡** when hardware transcode is active
- [ ] `id homebridge` includes `video` and `render` groups
- [ ] HKSV events record without frequent `Restarting the livestream API` warnings

### Useful log grep

```bash
grep -E "UniFi Protect|Streaming request|Stopped video|FFmpeg version|livestream API" \
  /var/lib/homebridge/homebridge.log | tail -50
```

### Debug FFmpeg (temporary)

Per-camera feature option:

```
Enable.Debug.Video.FFmpeg.<camera-mac-without-colons-lowercase>
```

Or platform-wide: `"verboseFfmpeg": true` in config.

---

## 6. Current recommended feature options

These reflect the tuned state for this deployment (adjust MAC suffixes as needed):

| Option | Purpose |
|--------|---------|
| `Disable.Video.Stream.UseApi.68D79A293B05` | RTSP for live view; reduces livestream API load |
| `Enable.Video.HKSV.Record.Only.Medium.68D79A293B05` | Cap HKSV source quality fleet-wide on the NVR |

Remove per-camera `Stream.Only.Low` / `Record.Only.Low` overrides once streaming is stable.

---

## 7. Troubleshooting reference

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| Stream dies at ~30s | UDP blocked cross-VLAN | Fix UDM firewall rules (section 1) |
| `[TSB/API]` + livestream disconnects | Protect controller overload | RTSP live view; lower HKSV quality |
| Transcode ⛭︎ but no ⚡ | Software FFmpeg in use | Jellyfin FFmpeg + QSV setup (section 3) |
| `vainfo` fails | i915 not loaded | Section 3.2 |
| High CPU on 4-core box | Many 4K HKSV + software transcode | QSV + Medium HKSV + RTSP live view |
| Snapshots slow on Pi-like hosts | TSB snapshot path under load | `Disable.Video.HighResSnapshots` |

---

## 8. Fork builds — install and test on mmr-hmb-01

When running this **fork** (not the npm release), use [docs/Development.md](docs/Development.md) for the full workflow. Short version on mmr-hmb-01:

```bash
# One-time or per-branch install
sudo -u homebridge -H bash -lc '
  cd /var/lib/homebridge
  npm install github:juniorfoo/homebridge-unifi-protect#<branch-or-tag>
'
sudo systemctl restart homebridge
```

For daily dev on the server, symlink the cloned repo into `node_modules` (see Development.md § Option B).

**Verify the fork loaded:**

```bash
sudo -u homebridge -H bash -lc \
  'node -p "require(\"/var/lib/homebridge/node_modules/homebridge-unifi-protect/package.json\").version"'
grep -E "Streaming request|Stopped video" /var/lib/homebridge/homebridge.log | tail -20
```

**Tests:** run `npm test` locally (Vitest). Until the broader stream-path suite lands ([#3](https://github.com/juniorfoo/homebridge-unifi-protect/issues/3)), CI gate is `npm run lint && npm run build && npm test` before deploy, then the §5 checklist after.

**Roll back to npm:**

```bash
sudo -u homebridge -H bash -lc 'cd /var/lib/homebridge && npm install homebridge-unifi-protect@7.29.0'
sudo systemctl restart homebridge
```

---

## 9. References

- [Fork development, testing, and deployment](docs/Development.md)
- [HBUP Troubleshooting — network / video](docs/Troubleshooting.md)
- [HBUP Feature Options](docs/FeatureOptions.md)
- [HBUP Configuration Reference — `videoProcessor`](docs/ConfigurationReference.md)
- [Homebridge mDNS / advertised interfaces](https://github.com/homebridge/homebridge/wiki/mDNS-Options)
- [Jellyfin FFmpeg on Linux](https://jellyfin.org/docs/general/installation/linux/)
