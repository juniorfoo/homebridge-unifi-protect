/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.ts: The media-subsystem test helpers for homebridge-unifi-protect.
 *
 * This file owns the doubles the streaming, recording, timeshift, and snapshot tests drive: TestCameraHost, the reusable stand-in for the camera-host contract the
 * media classes read their configuration and channel selection through, plus the fMP4 fragment builders and the livestream-subscription doubles that feed a real
 * timeshift buffer without a controller or an FFmpeg process. The fragment builders compose genuine boxes through homebridge-plugin-utils' real writers, so what a
 * buffer parses here is what it would parse on the wire, and the controllable livestream double exposes the steering a recovery or discontinuity test needs.
 *
 * Fidelity to the cited contracts, not invention, is the line these doubles hold: the camera-host surface is the plugin's own, and the segment and subscription shapes
 * are unifi-protect's. The cross-cutting core - the Homebridge runtime, the state store, and the streaming and timeshift stubs - lives in the root harness every
 * subsystem's testing.helpers.ts imports from.
 */
import type { ChannelProfile, SelectChannelOptions } from "./resolution.ts";
import type { ExecProcessFactory, HomebridgePluginLogging, Nullable, RecordingProcessFactory, RtpDemuxerFactory, RtpPortAllocator,
  StreamingProcessFactory } from "homebridge-plugin-utils";
import type { LivestreamDescription, LivestreamInit, LivestreamSubscriptionState, ProtectCameraConfig, Segment, SnapshotOptions, TalkbackSession } from "unifi-protect";
import type { LivestreamHostOptions, ProtectCameraHost } from "./camera-host.ts";
import { SAMPLE_FLAG_NON_SYNC, onAbort, splitMoofMdat } from "homebridge-plugin-utils";
import type { TestClock, TestExecProcessFactory, TestLogEntry, TestStreamingProcess, TestStreamingProcessFactory } from "homebridge-plugin-utils/testing";
import { TestExecProcess, makeBox, makeContainer, makeTrunBox, settle } from "homebridge-plugin-utils/testing";
import { TestStateStore, makeProtectState, makeTestAccessory } from "../testing.helpers.ts";
import type { API } from "homebridge";
import { G2_PRO_CHANNELS } from "../camera.fixtures.ts";
import type { LivestreamSubscription } from "./livestream.ts";
import type { ProtectAccessory } from "../types.ts";
import type { ProtectCameraHints } from "../devices/cameras/camera.ts";
import type { ProtectNvr } from "../nvr/nvr.ts";
import type { ProtectPlatform } from "../platform.ts";
import type { StreamingDelegate } from "./stream-delegate.ts";
import type { TestProtectAccessory } from "../testing.helpers.ts";
import type { TestProtectNvr } from "../nvr/testing.helpers.ts";
import { TestTalkbackFactory } from "unifi-protect/testing";
import { makeCameraConfig } from "../devices/testing.helpers.ts";
import { makeTestNvr } from "../nvr/testing.helpers.ts";

/* The reusable camera-host test double: the small stand-in every media-delegate test constructs a delegate against, in place of a full ProtectCamera. The
 * ProtectCameraHost interface segregation (the dependency-inversion boundary on the camera side of the media stack) exists precisely so the streaming, recording,
 * snapshot, and timeshift delegates type their camera handle as this narrow contract rather than the concrete class - and this double is what cashes that in: it
 * structurally satisfies every member of ProtectCameraHost (the same compile-time proof the production ProtectCamera passes), so a delegate constructs against it
 * with no FFmpeg and no live camera.
 *
 * The shape mirrors TestStreamingDelegate's discipline: controllable fields a test sets to steer a branch (isReachable is the behavior-bearing one - the snapshot
 * delegate's reachability gate reads it), recordable call logs the behavior-bearing interfaces push their arguments into (so a later test asserts an interface was
 * invoked), and settable interface returns (snapshotResult is the Buffer snapshotFromController resolves, the value the two-sided snapshot test threads through the
 * delegate).
 *
 * The context half composes the EXISTING harness doubles rather than reinventing them: accessory is Homebridge's own accessory from makeTestAccessory, which is the
 * production accessory type as it stands, and nvr/platform/api/log all flow from a real makeTestNvr context (so the very next behavior step, which reads
 * platform.codecSupport and nvr.mqtt, finds real doubles there, not sentinels that would throw). The api, nvr and platform handles plus ufp are typed as their
 * production types by the interface, which the intentionally-partial doubles do not structurally satisfy, so each is bridged with a confined
 * `as unknown as <ProductionType>` boundary cast - the same honest harness pattern the construction suites use at their own construction-arg boundaries. The casts
 * bridge the deliberate double->production gap only; tsc still verifies every member is present and interface-typed, so the completeness proof holds.
 *
 * Member order mirrors TestStreamingDelegate: the fields group alphabetized (except where a boundary's return value is kept adjacent to its own call log), then the
 * methods group alphabetized (not one global run). The settable interface predicates hasFeature / selectChannel / selectSubstrateChannel are public arrow-function fields
 * so a test can reassign them, satisfying the interface's method members.
 */
export class TestCameraHost implements ProtectCameraHost {

  public accessory: ProtectAccessory;
  public accessoryName = "Test Camera";
  public api: API;
  // The flashlight states a streaming session drove, in order. The delegates under these suites never start or stop a session, so it reads empty there.
  public readonly driveFlashlightCalls: boolean[] = [];

  // The settable feature predicate; defaults to "no feature enabled", the quiet default the delegate construction paths read against.
  public hasFeature: (option: string) => boolean = () => false;

  // Whether the camera has an RTSP-enabled stream to draw a direct session from. Defaults true, so every media suite's standing assumption of an RTSP-capable camera
  // holds unchanged; a test about the no-RTSP population flips it.
  public hasRtspStream = true;

  // A complete neutral ProtectCameraHints literal - every boolean false, every number 0, every string empty, no custom name, the nested cropOptions zeroed - so a
  // delegate reads a fully populated hint bag with no behavior turned on (crop false is required for the two-sided snapshot test, which must NOT enter the crop pass).
  public hints: ProtectCameraHints = {

    crop: false,
    cropOptions: { height: 0, width: 0, x: 0, y: 0 },
    enabled: false,
    hardwareDecoding: false,
    hardwareTranscoding: false,
    highResSnapshots: false,
    hksvRecordingIndicator: false,
    ledStatus: false,
    logDoorbell: false,
    logHksv: false,
    logMotion: false,
    motionDuration: 0,
    nameOverride: null,
    nameOwned: false,
    nightVision: false,
    occupancyDuration: 0,
    probesize: 0,
    rtspDefault: "",
    smartDetect: false,
    smartDetectSensors: false,
    smartOccupancy: [],
    standalone: false,
    substrateDefault: "",
    transcode: false,
    transcodeBitrate: 0,
    transcodeHighLatency: false,
    transcodeHighLatencyBitrate: 0,
    tsbStreaming: false,
    twoWayAudio: false,
    twoWayAudioDirect: false
  };

  // Whether this camera can back HomeKit Secure Video. Settable so a recording-behavior test can flip it; defaults false.
  public isHksvCapable = false;

  // Whether the plugin can vouch for this camera's values. No delegate reads it; it completes the device context. Defaults true.
  public isAvailable = true;

  // The behavior-bearing reachability gate: the snapshot delegate returns null before any pipeline when this is false, so the two-sided snapshot test sets it both
  // ways. Defaults true.
  public isReachable = true;

  // Recordable call logs: each behavior-bearing interface pushes its arguments here so a later test can assert the interface was invoked exactly as expected.
  public readonly livestreamCalls: { channelProfile: ChannelProfile; opts?: LivestreamHostOptions }[] = [];

  // The segment-count knob the transmit test sets to fill the timeshift buffer: the number of keyframe-bearing media segments livestream() yields. Defaults 0, which
  // returns the inert (segment-less) livestream double so the construction suites stay on their unchanged path.
  public livestreamMediaSegments = 0;

  // The queue of test-provided subscriptions livestream() hands out in order: each call shifts the head, so a single start consumes one, and a start-twice or
  // id-identity test supplies two DISTINCT-id controllable doubles. When the queue is empty, livestream() falls back to the livestreamMediaSegments-selected parking /
  // inert double - the unchanged path the construction and recording-transmit suites stay on (they never set this queue).
  public livestreamSubscriptions: LivestreamSubscription[] = [];
  public log: HomebridgePluginLogging;

  // The bare device MAC for topic addressing, read through the device projection so it stays consistent with the ufp fixture's mac even if a test reassigns ufp. This is
  // the identity the narrowed live-state view does not carry; a delegate reads it (the MQTT snapshot topic) through protectCamera.mac.
  public get mac(): string {

    return this.ufp.mac;
  }

  public nvr: ProtectNvr;
  public platform: ProtectPlatform;
  public readonly rebootCalls: number[] = [];

  // The error reboot() rejects with when set (default undefined = reboot resolves). A self-heal test sets this to drive the reboot-failure branch, where the timeshift
  // logs that the camera could not be rebooted; the call is still recorded in rebootCalls before the rejection, matching production's invoke-then-fail ordering.
  public rebootError?: Error;

  // The settable channel selectors; default null (no profile resolved), so the snapshot RTSP source - which would call selectChannel - never proceeds past its own
  // !stream guard anyway, keeping the two-sided test on the controller path.
  public selectChannel: (width: number, height: number, options: SelectChannelOptions) => Nullable<ChannelProfile> = () => null;
  public selectSubstrateChannel: () => Nullable<ChannelProfile> = () => null;
  public readonly setStatusLedCalls: boolean[] = [];

  // The settable Buffer snapshotFromController resolves - the value the two-sided snapshot test threads through the delegate's controller source.
  public snapshotResult: Buffer = Buffer.from("test-snapshot");
  public readonly snapshotFromControllerCalls: SnapshotOptions[] = [];

  // The streaming delegate handle the snapshot/recording/timeshift consumers read; default undefined so the snapshot timeshift/RTSP sources early-return on their
  // !stream guards and the pipeline falls through to the controller source.
  public stream: StreamingDelegate | undefined = undefined;
  // The factory the talkback interface connects through: unifi-protect's TestTalkbackFactory, which connects a real TalkbackSession over a fake socket and records each
  // call with its signal and the socket its session dials. A row reaches a connect through the factory's connectCalls, and swaps in a factory built with autoOpen
  // off to hold a session's open pending until it emits the open itself.
  public talkbackFactory = new TestTalkbackFactory();

  // The camera-narrowed Protect device projection; settable, default a G2 Pro config so featureFlags / videoCodec reads resolve to a real record.
  public ufp: Readonly<ProtectCameraConfig>;

  // Whether buffer-backed livestreaming is enabled for this camera - the streaming demand arm of the standing buffer. Settable so a test can steer the
  // streaming arm on and off; defaults false.
  public usesTimeshiftLivestream = false;
  public videoCodecName = "h264";

  // Compose the context half from real harness doubles, bridging each to its interface-required production type at the confined boundary.
  public constructor(init: { accessory: ProtectAccessory; nvr: TestProtectNvr }) {

    this.accessory = init.accessory;

    // The api/log/platform/nvr handles all flow from the real makeTestNvr context. Each is a partial double the interface types as a production handle, so each
    // takes the same confined boundary cast.
    this.api = init.nvr.platform.api as unknown as API;
    this.log = init.nvr.log;
    this.nvr = init.nvr as unknown as ProtectNvr;
    this.platform = init.nvr.platform as unknown as ProtectPlatform;

    // The ufp record is the ONE confined cast makeCameraConfig already documents (it populates the verified read set and casts once to the full wire type), reused
    // here verbatim for the host's device projection.
    this.ufp = makeCameraConfig({ channels: G2_PRO_CHANNELS });
  }

  // The FFmpeg audio-filter chain; the stub builds none.
  public getAudioFilters(): string[] {

    return [];
  }

  // The recordable livestream interface. It records its arguments and hands back a LivestreamSubscription double whose profile is selected by this host's
  // livestreamMediaSegments knob: the default 0 yields the inert double (empty iterator, no-op dispose, "closed" state) the construction suites stay on, while a
  // positive count yields the established segment-yielding double (one init then that many keyframe-bearing media segments, then a parked iterator) the transmit net
  // fills its timeshift buffer from.
  public livestream(channelProfile: ChannelProfile, opts?: LivestreamHostOptions): LivestreamSubscription {

    this.livestreamCalls.push({ channelProfile, opts });

    // Hand out the next test-provided subscription from the queue, if any; otherwise fall back to the livestreamMediaSegments-selected parking / inert double. The queue
    // path is how a standalone timeshift test drives the SUT with a controllable double (and supplies two distinct doubles for the restart / id-identity targets); the
    // fallback preserves the unchanged behavior the construction and recording-transmit suites depend on (they never set the queue).
    return this.livestreamSubscriptions.shift() ?? makeLivestreamSubscriptionDouble({ mediaSegments: this.livestreamMediaSegments });
  }

  // The recordable reboot interface; records the call, then rejects with rebootError when one is set (the self-heal reboot-failure path) or resolves otherwise.
  public async reboot(): Promise<void> {

    this.rebootCalls.push(this.rebootCalls.length + 1);

    if(this.rebootError !== undefined) {

      throw this.rebootError;
    }
  }

  // The recordable status-LED interface; records every requested value and resolves true.
  public async setStatusLed(value: boolean): Promise<boolean> {

    this.setStatusLedCalls.push(value);

    return true;
  }

  // The recordable flashlight interface, which a package session drives as it starts and stops.
  public driveFlashlight(on: boolean): void {

    this.driveFlashlightCalls.push(on);
  }

  // The behavior-bearing controller-snapshot interface: records the options and resolves the settable snapshotResult Buffer - the value the two-sided snapshot test
  // observes flow through the delegate's controller source.
  public async snapshotFromController(opts?: SnapshotOptions): Promise<Buffer> {

    this.snapshotFromControllerCalls.push(opts ?? {});

    return this.snapshotResult;
  }

  // The talkback interface, answered by the talkback factory with a real session over its fake socket, so a relayed two-way audio start opens, sends through and
  // closes the session unifi-protect ships, with only its wire to the controller faked.
  public async talkback(opts?: { signal?: AbortSignal }): Promise<TalkbackSession> {

    return this.talkbackFactory.connect(opts);
  }
}

/* Build a ChannelProfile over one of the host's real channels, so the channel's id and fps reach the code under test exactly as production composes them. A media test
 * hands it wherever that code takes a channel profile, the host's substrate selector and a buffer's start among them. The index picks the channel, the first by
 * default, so a test about a restart can steer the selection onto a different stream than the one already running. The indexed access is guarded because
 * host.ufp.channels[index] widens to ProtectCameraChannelConfig | undefined under noUncheckedIndexedAccess, and a fixture lacking the requested channel throws rather
 * than handing back a profile with no channel behind it.
 */
export function makeChannelProfile(host: TestCameraHost, index = 0): ChannelProfile {

  const channel = host.ufp.channels[index];

  if(!channel) {

    throw new Error("The G2 Pro channel fixture is missing the requested channel.");
  }

  return { channel, name: channel.name, resolution: [ 1920, 1080, 30 ], url: "rtsps://test" };
}

function makeTfdtVersion0Box(baseMediaDecodeTime: number): Buffer {

  const payload = Buffer.alloc(8);

  payload.writeUInt32BE(0, 0);
  payload.writeUInt32BE(baseMediaDecodeTime, 4);

  return makeBox("tfdt", payload);
}

function makeMfhdBox(sequenceNumber: number): Buffer {

  const payload = Buffer.alloc(8);

  payload.writeUInt32BE(0, 0);
  payload.writeUInt32BE(sequenceNumber, 4);

  return makeBox("mfhd", payload);
}

function makeTfhdBox(trackId: number): Buffer {

  const payload = Buffer.alloc(8);

  payload.writeUInt32BE(0, 0);
  payload.writeUInt32BE(trackId, 4);

  return makeBox("tfhd", payload);
}

// Synthesize a genuine fMP4 media fragment on the published fMP4 builders so the production isKeyframe TRUN-flag parse runs against REAL bytes on the REAL path - no
// isKeyframe injection point, so the test exercises the actual fMP4 keyframe coupling rather than a test-only divergence. The fragment is moof>traf>trun with a
// first_sample_flags-bearing trun (the builder sets the data_offset and first_sample_flags TRUN flags, sample_count 1, data_offset 0). The ONLY difference between a
// keyframe and a non-keyframe fragment is that first_sample_flags value: 0 leaves the SAMPLE_FLAG_NON_SYNC bit clear, marking a sync sample (a keyframe), while
// SAMPLE_FLAG_NON_SYNC sets it, marking a non-sync sample (a non-keyframe) the production parse rejects. The mdat carries an empty body - the timeshift never decodes
// the payload, it only parses the moof for keyframe-ness and concatenates the bytes. The returned data buffer is the moof+mdat pair a media Segment delivers. This is
// the single source of truth for both fragment kinds; makeKeyframeFragment and makeNonKeyframeFragment are the two thin selectors over it.
function makeMediaFragment(options: { baseMediaDecodeTime?: number; keyframe?: boolean; sequenceNumber?: number; tag?: number; trackId?: number } = {}):
{ data: Buffer; mdat: Buffer; moof: Buffer; tag?: number } {

  const keyframe = options.keyframe ?? true;
  const trackId = options.trackId ?? 1;
  const baseMediaDecodeTime = options.baseMediaDecodeTime ?? (keyframe ? 0 : 3000);
  const sequenceNumber = options.sequenceNumber ?? 1;
  const moof = makeContainer("moof", [ makeMfhdBox(sequenceNumber), makeContainer("traf", [ makeTfhdBox(trackId), makeTfdtVersion0Box(baseMediaDecodeTime),
    makeTrunBox({ sampleFlagsValue: keyframe ? 0 : SAMPLE_FLAG_NON_SYNC, useFirstSampleFlags: true }) ]) ]);
  const tagPayload = options.tag === undefined ? Buffer.alloc(0) : Buffer.from([ options.tag & 0xFF, (options.tag >> 8) & 0xFF ]);
  const mdat = makeBox("mdat", tagPayload);

  return { data: Buffer.concat([ moof, mdat ]), mdat, moof, tag: options.tag };
}

// The keyframe-bearing fragment: makeMediaFragment with its default keyframe-true selection, so the production isKeyframe parse returns true. This is a thin
// wrapper whose default keyframe path writes first_sample_flags 0, so the KEYFRAME_FRAGMENT const, the segment-yielding parking double, and the keyframe
// self-test all read the identical bytes.
export function makeKeyframeFragment(): { data: Buffer; mdat: Buffer; moof: Buffer } {

  return makeMediaFragment();
}

// The non-keyframe-bearing fragment: makeMediaFragment with keyframe false, so the trun first_sample_flags carries SAMPLE_FLAG_NON_SYNC and the production isKeyframe
// parse returns false on the REAL path. The timeshift suite pushes this through the controllable double to exercise the discontinuity keyframe-gate (a
// discontinuity-marked non-keyframe must defer the discontinuity emit until a clean keyframe arrives) and to drive any non-keyframe classification. Built at the use
// site rather than cached in a module const so there is no unused-when-the-suite-changes SSOT cruft to drift.
export function makeNonKeyframeFragment(tag?: number, timing?: { baseMediaDecodeTime?: number; sequenceNumber?: number; trackId?: number }):
{ data: Buffer; mdat: Buffer; moof: Buffer; tag?: number } {

  return makeMediaFragment({ keyframe: false, tag, ...timing });
}

/** Media fragment without tfdt/mfhd (copy-escalation dedup cannot read an identity). */
export function makeUntimedNonKeyframeFragment(tag?: number): { data: Buffer; mdat: Buffer; moof: Buffer; tag?: number } {

  const moof = makeContainer("moof", [makeContainer("traf", [makeTrunBox({ sampleFlagsValue: SAMPLE_FLAG_NON_SYNC, useFirstSampleFlags: true })])]);
  const tagPayload = tag === undefined ? Buffer.alloc(0) : Buffer.from([ tag & 0xFF, (tag >> 8) & 0xFF ]);
  const mdat = makeBox("mdat", tagPayload);

  return { data: Buffer.concat([ moof, mdat ]), mdat, moof, tag };
}

// Carry a fragment's bytes as a media fragment, the shape the builders above hand out: the whole fragment and its moof and mdat halves, split where HBPU's
// splitMoofMdat finds the mdat box, so a fragment HBPU's makeFragment builds reaches a suite as one the builders built would. A fragment with no mdat box throws,
// because every fragment a suite builds carries one, and a split that passed it through would hand a consumer a segment no pool delivers.
export function splitFragment(data: Buffer): { data: Buffer; mdat: Buffer; moof: Buffer } {

  const boxes = splitMoofMdat(data);

  if(!boxes) {

    throw new Error("The fragment holds no mdat box to split it at.");
  }

  return { data, mdat: boxes.mdat, moof: boxes.moof };
}

// One media Segment around a fragment, in the shape unifi-protect's pool hands a consumer: the fragment's bytes and its moof and mdat halves. The discontinuity flag
// marks the first media after a reconnect, the one segment the pool sets it on, which a consumer's discontinuity handling keys on. Every suite and double that feeds a
// livestream a media segment builds it here, so the segment a consumer reads has one shape across them.
export function makeMediaSegment(fragment: { data: Buffer; mdat: Buffer; moof: Buffer }, options: { discontinuity?: boolean } = {}): Segment {

  if(options.discontinuity) {

    return { data: fragment.data, discontinuity: true, mdat: fragment.mdat, moof: fragment.moof, type: "media" };
  }

  return { data: fragment.data, mdat: fragment.mdat, moof: fragment.moof, type: "media" };
}

// The one keyframe fragment and init buffer the segment-yielding double reuses across every yield. The timeshift never mutates segment bytes (it parses and concatenates
// them), so sharing one instance is safe and avoids re-synthesizing the boxes per call. The init bytes are placeholders that carry no readable moov, so the description
// every double's init carries by default is the one the library reads from such bytes: no tracks, which is a stream with no readable audio track.
const KEYFRAME_FRAGMENT = makeKeyframeFragment();
const INIT_SEGMENT_DATA = Buffer.from("test-init-segment");
const NO_TRACKS: LivestreamDescription = { tracks: [] };

/* Build a LivestreamSubscription double for the camera-host stub's livestream interface, in one of two profiles selected by the requested media-segment count:
 *
 *   - mediaSegments === 0 (the default): the byte-identical INERT profile the construction tests rely on - initSegment null, state "closed", whenEstablished resolves
 *     false, an empty iterator, no-op reassess/dispose. The construction suites never exercise it; it exists only so the host's livestream return type-checks
 *     against the production type.
 *   - mediaSegments > 0: the ESTABLISHED segment-yielding profile - initSegment populated, state "live", whenEstablished resolves true, and an iterator yielding one init
 *     segment then mediaSegments keyframe-bearing media segments so the timeshift fills its buffer with real fMP4 the production isKeyframe parse accepts.
 *
 * Required, not incidental: after yielding its media segments the established iterator MUST PARK, never completing. A finite generator returns done, which ends the
 * timeshift's consumeSegments for-await, runs its finally -> finalizeSubscription -> clearBuffer, and wipes the just-filled buffer (the this.subscription?.id ===
 * subscription.id guard is true by then, because start() commits this.subscription mid-drain) - so timeshift.time falls back to zero and the transmit gate would always
 * decline. We park by owning an internal AbortController: [Symbol.asyncDispose] aborts it, and the generator, after its media loop, awaits a promise that resolves on
 * that abort (resolves immediately if already aborted, else via a one-shot "abort" listener). The for-await therefore never completes while filling, the buffer survives,
 * and a real timeshift.stop()/dispose still releases it cleanly. whenEstablished resolves true immediately while the consumer fills its buffer by draining the parking
 * iterator to its park point; a single settle() in the test drains all the microtask-resolved yields before the park, because the generator crosses no macrotask/timer
 * boundary (were one ever added, a single settle() would silently under-drain).
 *
 * The established profile's init carries the description option, defaulting to no tracks, so a recording test steers the audio format the buffer reads from it.
 */
export function makeLivestreamSubscriptionDouble(options: { description?: LivestreamDescription; mediaSegments?: number } = {}): LivestreamSubscription {

  const mediaSegments = options.mediaSegments ?? 0;
  const init = { codec: "h264", data: INIT_SEGMENT_DATA, description: options.description ?? NO_TRACKS };

  // The inert profile: preserved byte-for-byte so the construction suites stay green.
  if(mediaSegments === 0) {

    return {

      id: "test-livestream-subscription",
      initSegment: null,
      reassess: (): void => { /* No-op: the double has no recovery loop to re-decide. */ },
      state: "closed",
      whenEstablished: async (): Promise<boolean> => false,
      [Symbol.asyncIterator]: async function *(): AsyncGenerator<Segment> { /* The double delivers no segments. */ },
      [Symbol.asyncDispose]: async (): Promise<void> => { /* No-op: the double owns no resources to release. */ }
    };
  }

  // The established profile owns a dispose-abort controller so its iterator can park after the media loop. Disposing aborts it, releasing the park.
  const disposed = new AbortController();

  return {

    id: "test-livestream-subscription",
    initSegment: init,
    reassess: (): void => { /* No-op: the double has no recovery loop to re-decide. */ },
    state: "live",
    whenEstablished: async (): Promise<boolean> => true,
    [Symbol.asyncIterator]: async function *(): AsyncGenerator<Segment> {

      yield { ...init, type: "init" };

      for(let i = 0; i < mediaSegments; i++) {

        yield makeMediaSegment(KEYFRAME_FRAGMENT);
      }

      // Park: await the dispose-abort so the consumer's for-await never completes and the filled buffer survives. onAbort resolves the park at once when the double is
      // already disposed, and otherwise on the one-shot abort.
      await new Promise<void>((resolve) => {

        onAbort(disposed.signal, () => resolve());
      });
    },
    [Symbol.asyncDispose]: async (): Promise<void> => { disposed.abort(); }
  };
}

// A process-local monotonic counter minting a distinct default id per controllable double. Distinct ids are required: the timeshift's consumeSegments finally guards
// teardown on this.subscription?.id === subscription.id, so a restart test (start A, then start B) and the id-identity guard test need two doubles whose ids genuinely
// differ - or the guard cannot tell them apart and the test is vacuous.
let controllableLivestreamCounter = 0;

/**
 * The controllable livestream-subscription double: a queue-driven LivestreamSubscription a test feeds segments into one at a time and can end or throw-into, plus a
 * recording surface for behavior-first assertions. It generalizes makeLivestreamSubscriptionDouble's drain-loop/park iterator so a standalone ProtectTimeshiftBuffer test
 * can drive the SUT's full emission/lifecycle surface (an init segment, keyframe and non-keyframe media, a discontinuity-marked segment, a graceful end, and an iterator
 * error) without a recording delegate in the loop.
 *
 * @property disposed       - True once the double's asyncDispose ran; a test asserts a start-validation failure or a stop disposed the subscription.
 * @property end            - Enqueue a graceful end. Processed AFTER any already-queued segments (drain-then-close), so queued media is never dropped, then the iterator
 *                            returns and the timeshift's consumeSegments finally runs.
 * @property push           - Enqueue one media (or init) segment and wake the iterator. One push plus one settle() processes exactly that one segment; MULTIPLE pushes
 *                            plus one settle() drain all of them in a single macrotask, so an intermediate-state test must settle() after EACH push.
 * @property reassessCalls  - The number of times the timeshift called reassess() (its transmit-start recovery escalation).
 * @property releaseEstablishment - Resolve a deferred whenEstablished() to true, committing a start that was held in flight; the release handle for the
 *                                  deferEstablishment gate.
 * @property throwError     - Enqueue an iterator error. Processed after queued segments, then thrown into the for-await so the timeshift classifies it (and self-heals).
 */
export interface ControllableLivestreamDouble extends LivestreamSubscription {

  readonly disposed: boolean;
  end(): void;
  push(segment: Segment): void;
  readonly reassessCalls: number;
  // Resolve a deferred whenEstablished() to true, committing a start that was held in flight - the release handle for the deferEstablishment gate.
  releaseEstablishment(): void;
  throwError(error: unknown): void;
}

/* Build a controllable LivestreamSubscription double for a standalone timeshift behavior test.
 *
 * Each active `for await` iterator owns its own queue. `push`/`end`/`throwError` broadcast to every active iterator (pooled shared-feed fanout). When no iterator is
 * active, items are held in an orphan queue replayed into the next iterator that attaches (so a broken first consumer does not strand segments for a second consumer).
 *
 * The iterator drain-loop processes the whole queue, then parks on a one-shot resolver until another broadcast wake (the lost-wakeup-safe pattern). The park keeps
 * `isStarted` true on the timeshift buffer: while the queue is open and the double is not ended, the generator suspends instead of completing, so `consumeSegments`
 * stays attached.
 *
 * `end`/`throwError`/`dispose` set global terminated, enqueue terminal items to every active iterator, and make further `push`/`end`/`throwError` no-ops. When
 * `deferEstablishment` is set, `whenEstablished()` parks until `releaseEstablishment()` resolves true (otherwise `whenEstablished` resolves immediately, default true).
 *
 * An iterator created after global terminate with no pending orphan items completes immediately (does not park forever).
 */
/** After the drain loop, park only when the iterator has not terminated (end/error drain paths set terminated true). */
function shouldParkControllableIteratorAfterDrain(terminated: boolean): boolean {

  return !terminated;
}

export function makeControllableLivestreamDouble(options: { deferEstablishment?: boolean; description?: LivestreamDescription; id?: string;
  initSegment?: LivestreamInit | null; state?: LivestreamSubscriptionState; whenEstablished?: boolean; } = {}): ControllableLivestreamDouble {

  type QueueItem = { kind: "segment"; segment: Segment } | { kind: "end" } | { kind: "error"; error: unknown };

  // One queue and park resolver per active iterator so a pooled buffer plus live session each receive the same pushed segments (shared encoder fanout).
  interface IteratorFanout { queue: QueueItem[]; terminated: boolean; wakeResolver: (() => void) | null }
  const iterators = new Set<IteratorFanout>();
  // Segments pushed while no iterator is attached are replayed into the next iterator (not fan-out to concurrent iterators).
  const orphanQueue: QueueItem[] = [];
  let terminated = false;
  let disposed = false;
  let reassessCalls = 0;

  const initSegment = (options.initSegment === undefined) ? { codec: "h264", data: INIT_SEGMENT_DATA, description: options.description ?? NO_TRACKS } :
    options.initSegment;

  const wakeAll = (): void => {

    for(const iterator of iterators) {

      const resolve = iterator.wakeResolver;

      iterator.wakeResolver = null;
      resolve?.();
    }
  };

  let establishmentResolver: ((established: boolean) => void) | null = null;

  const enqueue = (item: QueueItem): void => {

    if(terminated) {

      return;
    }

    if((item.kind === "end") || (item.kind === "error")) {

      terminated = true;
    }

    if(iterators.size === 0) {

      orphanQueue.push(item);

      return;
    }

    for(const iterator of iterators) {

      if(!iterator.terminated) {

        iterator.queue.push(item);
      }
    }

    wakeAll();
  };

  return {

    get disposed(): boolean {

      return disposed;
    },
    end: (): void => enqueue({ kind: "end" }),
    id: options.id ?? ("controllable-livestream-" + (++controllableLivestreamCounter).toString()),
    initSegment,
    push: (segment: Segment): void => enqueue({ kind: "segment", segment }),
    reassess: (): void => { reassessCalls++; },
    get reassessCalls(): number {

      return reassessCalls;
    },
    releaseEstablishment: (): void => {

      const resolve = establishmentResolver;

      establishmentResolver = null;
      resolve?.(true);
    },
    state: options.state ?? "live",
    throwError: (error: unknown): void => enqueue({ error, kind: "error" }),
    whenEstablished: async (): Promise<boolean> => {

      if(options.deferEstablishment) {

        return new Promise<boolean>((resolve) => { establishmentResolver = resolve; });
      }

      return options.whenEstablished ?? true;
    },
    [Symbol.asyncIterator]: async function *(): AsyncGenerator<Segment> {

      const fanout: IteratorFanout = { queue: [], terminated: false, wakeResolver: null };

      iterators.add(fanout);

      if(orphanQueue.length > 0) {

        fanout.queue.push(...orphanQueue);
        orphanQueue.length = 0;
      }

      if((terminated) && (fanout.queue.length === 0)) {

        iterators.delete(fanout);

        return;
      }

      try {

        while(!fanout.terminated) {

          while(fanout.queue.length > 0) {

            const item = fanout.queue.shift();

            if(!item) {

              break;
            }

            switch(item.kind) {

              case "end": {

                fanout.terminated = true;

                return;
              }

              case "error": {

                fanout.terminated = true;

                throw item.error;
              }

              case "segment": {

                yield item.segment;

                break;
              }

              default: {

                throw new Error("The controllable livestream double received an unknown queue item kind.");
              }
            }
          }

          if(shouldParkControllableIteratorAfterDrain(fanout.terminated)) {

            // eslint-disable-next-line no-await-in-loop -- The park is intentionally serial: the generator suspends here until a push/end/throwError/dispose wakes it.
            await new Promise<void>((resolve) => { fanout.wakeResolver = resolve; });
          }
        }
      } finally {

        fanout.terminated = true;

        const resolvePark = fanout.wakeResolver;

        fanout.wakeResolver = null;
        resolvePark?.();
        iterators.delete(fanout);
      }
    },
    [Symbol.asyncDispose]: async (): Promise<void> => {

      disposed = true;
      enqueue({ kind: "end" });
    }
  };
}

/**
 * Build a TestCameraHost wired to a real makeTestNvr context, returning the host plus its test-side handles. This is the media-delegate counterpart to makeTestNvr: it
 * composes the existing doubles (a TestStateStore-backed makeTestNvr context and an accessory from makeTestAccessory) into the camera-host interface every
 * media-delegate test constructs against, so a delegate is unit-constructed with no real camera. The single boundary casts live inside TestCameraHost's constructor
 * (the doubles are not the production handle types); the host returned here is the production-interface-typed double.
 *
 * @param options - clock: an optional controllable TestClock forwarded into the makeTestNvr platform double's clock interface and re-returned, so a test holds the one
 *                  clock every delegate built against this host reads through platform.clock - the recording delegate's transmit pacing and the streaming delegate's
 *                  probesize reset among them - and advances it to fire what is due (omitted, makeTestNvr creates a fresh TestClock seeded at TEST_CLOCK_EPOCH);
 *                  recordingProcessFactory: the test recording-process factory injected into the makeTestNvr platform double's recordingProcessFactory interface, so a
 *                  transmit test's delegate constructs its FFmpeg process through the test double (omitted, makeTestNvr installs a fresh default factory); userOptions:
 *                  feature-option config strings forwarded to the makeTestNvr context's REAL FeatureOptions engine (for a later behavior test that steers a feature-gated
 *                  delegate path); the default empty context is the quiet-default host.
 *
 * @returns accessory: the accessory backing the host; clock: the controllable TestClock installed on the platform double (the one clock every delegate built against
 *          this host reads, so a test advances it to release the recording delegate's transmit pacing or to fire the streaming delegate's probesize reset); controller:
 *          the AbortController behind the context's signal (abort it in suite teardown); host: the TestCameraHost double under test; logEntries: every line the
 *          construction and transmit paths logged (so a transmit test can assert on captured telemetry); nvr: the NVR double backing the context.
 */
export function makeTestCameraHost(options: { clock?: TestClock; codecSupport?: { hostSystem: string }; execProcessFactory?: ExecProcessFactory;
  recordingProcessFactory?: RecordingProcessFactory; rtpDemuxerFactory?: RtpDemuxerFactory; rtpPorts?: RtpPortAllocator;
  streamingProcessFactory?: StreamingProcessFactory; userOptions?: string[]; } = {}):
{ accessory: TestProtectAccessory; clock: TestClock; controller: AbortController; host: TestCameraHost; logEntries: readonly TestLogEntry[]; nvr: TestProtectNvr } {

  const store = new TestStateStore(makeProtectState());
  const { clock, controller, logEntries, nvr } = makeTestNvr({ clock: options.clock, codecSupport: options.codecSupport, execProcessFactory: options.execProcessFactory,
    recordingProcessFactory: options.recordingProcessFactory, rtpDemuxerFactory: options.rtpDemuxerFactory, rtpPorts: options.rtpPorts, store,
    streamingProcessFactory: options.streamingProcessFactory, userOptions: options.userOptions });
  const accessory = makeTestAccessory();
  const host = new TestCameraHost({ accessory, nvr });

  return { accessory, clock, controller, host, logEntries, nvr };
}

/**
 * End every FFmpeg process double the given factories built that has not ended, as a killed child ends, since a double has no child to kill: each streaming process
 * and each one-shot run a row left running. A process's ending is read from the process itself, from exited for a streaming process and from result() for a one-shot
 * run, each looked at after one settle, by which time an ending the row has already driven has settled. It is never read from stdin, which a caller may end while
 * its process runs on, as the return-audio process's is ended with its session description. A pending run ended here while its own signal stands ends as failed and
 * asks its onFailed, so a row reads its log lines before it ends through here.
 *
 * @param factories - The process factories whose recorded processes the row ends.
 */
export async function endPendingProcesses(factories: readonly (TestExecProcessFactory | TestStreamingProcessFactory)[]): Promise<void> {

  const pending = new Set<TestExecProcess | TestStreamingProcess>();

  for(const factory of factories) {

    for(const { process } of factory.createCalls) {

      const ending: Promise<unknown> = (process instanceof TestExecProcess) ? process.result() : process.exited;

      pending.add(process);
      void ending.then(() => void pending.delete(process), () => void pending.delete(process));
    }
  }

  await settle();

  for(const process of pending) {

    process.exit({ exitCode: null, exitSignal: "SIGKILL" });
  }

  await settle();
}
