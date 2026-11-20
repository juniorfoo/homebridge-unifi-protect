/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.ts: The cross-cutting test helpers shared across every unit test in homebridge-unifi-protect.
 *
 * Every accessory, service and characteristic a suite touches is the real thing. This file loads the Homebridge runtime once, through HBPU's Homebridge double, so an
 * accessory is Homebridge's own PlatformAccessory over the hap-nodejs copy Homebridge loads, its services and characteristics are HAP's own, and the API the
 * controller double hands production is HBPU's TestHomebridgeApi, which runs Homebridge's bridge bookkeeping and records the calls Homebridge accepted, with
 * makeTestApi the builder of every such API double, each checked after every test for a warning Homebridge's server logged that the test left untaken. A suite's
 * assertion about HomeKit state therefore reads what production would leave there, and the harness restates no part of HAP or Homebridge to get it. The accessory
 * builder derives every identity through HAP's own UUID generator, the way production derives each accessory's UUID, and the read helpers below give suites the
 * views HAP keeps no log of: the values production wrote to one characteristic, the controller configurations and removals an accessory saw, and the options a camera
 * controller was built with. Beside them, labeledLines renders a captured log as one list across every level, for an assertion that reads levels and order together.
 *
 * Alongside them this file holds the rest of the harness's cross-cutting core: TestStateStore, the facade over unifi-protect's real state store, with makeProtectState
 * to seed it; and the streaming and timeshift stubs every device family that constructs a real camera host shares: the streaming delegate with its controller
 * stand-in and its factory, which satisfies the platform's dependency-inversion contract so a REAL device can be constructed with no FFmpeg, and the timeshift buffer
 * and supervisor doubles.
 *
 * The per-subsystem helpers live beside the code they serve, each importing this file: devices/testing.helpers.ts owns the config builders, the projection doubles,
 * and TestBaseDevice; media/testing.helpers.ts owns TestCameraHost and the fragment and livestream doubles; nvr/testing.helpers.ts owns the NVR and platform doubles
 * and the makeTestNvr composition root. State needs no restating either: TestStateStore runs unifi-protect's own store (src/state/store.ts).
 *
 * Co-located with production code under src/ so the type-check pass covers this file alongside everything else, while tsconfig.build.json excludes every *.helpers.ts,
 * *.fixtures.ts, and *.test.ts from the emitted dist/, so none of the rig reaches the published package.
 */
import { AudioRecordingCodecType, AudioRecordingSamplerate, ChangeReason, H264Level, H264Profile, MediaContainerType, SRTPCryptoSuites,
  VideoCodecType } from "homebridge-plugin-utils";
import type { CameraController, CameraControllerOptions, CharacteristicValue, Controller, ControllerServiceMap, Resolution, WithUUID } from "homebridge";
import type { ControllerIdentity, StreamingDelegate, StreamingDelegateFactory } from "./media/stream-delegate.ts";
import type { DeepPartial, DeviceSelectors, ProtectCameraConfig, ProtectChimeConfig, ProtectFobConfig, ProtectLightConfig, ProtectNvrBootstrap, ProtectNvrConfig,
  ProtectNvrLiveviewConfig, ProtectRelayConfig, ProtectRingtoneConfig, ProtectSensorConfig, ProtectState, ProtectStateRecord, ProtectViewerConfig, StateModelKey,
  StateStore } from "unifi-protect";
import type { ProtectAccessory, ProtectAccessoryContext } from "./types.ts";
import type { TestLogEntry, TestPlatformAccessory } from "homebridge-plugin-utils/testing";
import { formatLogEntry, loadHomebridge, watchServerWarnings } from "homebridge-plugin-utils/testing";
import type { AdvertisedStreams } from "./devices/cameras/camera.ts";
import type { ChannelProfile } from "./media/resolution.ts";
import type { Nullable } from "homebridge-plugin-utils";
import type { ProtectCameraHost } from "./media/camera-host.ts";
import type { SnapshotSource } from "./media/timeshift.ts";
import { controllerIdentityOf } from "./media/stream-delegate.ts";
import { createStateStore } from "unifi-protect";

/**
 * The Homebridge runtime every suite runs on: the hap-nodejs copy and the PlatformAccessory class Homebridge loads from this repository's tree, resolved once for the
 * whole process. The NVR and media helpers build their API doubles over this same runtime, so every accessory a suite meets shares one HAP.
 */
export const runtime = await loadHomebridge(import.meta.url);

/**
 * The builder of every Homebridge API double the suites build, each over the runtime above and checked after every test for a warning or an error Homebridge's server
 * logged that the test left untaken. This module evaluates once per process, before any suite creates its tests, so the builder's one after-each hook sits at the root
 * of each file's test tree and checks every double built through it after each test's own cleanups. A warning fails the test it is checked after: one a `before` hook
 * draws, or one a timer logs once its test has ended, lands on the next test, among the edges HBPU's watchServerWarnings documents. A second builder in a file would
 * lose its check in any test whose first check failed, so every double comes from this one.
 */
export const makeTestApi = watchServerWarnings(runtime);

/**
 * The runtime's HAP namespace, the one production reaches as `api.hap`.
 */
export const hap = runtime.hap;

/**
 * HAP's own Characteristic and Service classes, the namespaces a suite names a kind by (`Characteristic.On`, `Service.Switch`), each exported as a value and, below,
 * as the instance type, the way the class itself serves as both.
 */
export const { Characteristic, Service } = hap;

export type Characteristic = InstanceType<typeof hap.Characteristic>;

export type Service = InstanceType<typeof hap.Service>;

/**
 * A characteristic kind as a suite names one, such as `Characteristic.On`: a class HAP's service methods take where they build or write a characteristic
 * (`getCharacteristic`, `updateCharacteristic`) and where they test for one (`testCharacteristic`), which type the class in each of those roles.
 */
export type CharacteristicKind = WithUUID<new () => Characteristic> & WithUUID<typeof Characteristic>;

/**
 * The accessory every harness builder hands back: Homebridge's own PlatformAccessory over the runtime's HAP, carrying the plugin's typed context, made through an API
 * double so it records every value change and characteristic warning HAP raises on it.
 */
export type TestProtectAccessory = TestPlatformAccessory<ProtectAccessoryContext>;

// The API double whose accessory class builds every accessory makeTestAccessory hands back. An accessory made here is placed on another API's bridge by that API's
// own restore or registration, because each API double runs on the one runtime above and accepts any accessory of its PlatformAccessory class.
const constructionApi = makeTestApi();

// The counter behind each default accessory identity, so accessories built without a seed, same-named or not, never share a UUID: Homebridge skips a registration
// whose UUID it already holds, which would leave a later accessory off the bridge in silence.
let accessorySeeds = 0;

// The next default seed, unique within the process.
function nextSeed(): string {

  accessorySeeds++;

  return "homebridge-unifi-protect.test-accessory." + accessorySeeds.toString();
}

/**
 * The UUID an accessory seeded by `seed` carries, derived through HAP's own generator exactly as production derives each accessory's UUID, so a suite seeds a device's
 * accessory by the same identity production composes for it: the MAC, the MAC plus a suffix, or the controller's MAC plus an owner's suffix.
 *
 * @param seed - The identity the accessory's UUID derives from.
 *
 * @returns The UUID HAP generates for that seed.
 */
export function accessoryUuid(seed: string): string {

  return hap.uuid.generate(seed);
}

/**
 * Build an accessory through the construction API: Homebridge's own PlatformAccessory, born off the bridge as every new accessory is, with the AccessoryInformation
 * service HAP gives it at construction and its Name set to the display name.
 *
 * @param displayName - The accessory's display name. Defaults to "Test Accessory".
 * @param seed        - The identity its UUID derives from through {@link accessoryUuid}. Defaults to a seed unique within the process, so accessories a row builds
 *                      without one never collide.
 *
 * @returns A fresh accessory, typed with the plugin's context.
 */
export function makeTestAccessory(displayName = "Test Accessory", seed = nextSeed()): TestProtectAccessory {

  return new constructionApi.platformAccessory<ProtectAccessoryContext>(displayName, accessoryUuid(seed));
}

// The new values of the changes one characteristic raised for one reason, in the order HAP raised them. The reasons are HBPU's runtime mirror of HAP's own enum, the
// values HAP stamps on each change its event notifications and its update path raise.
function changeValues(accessory: TestPlatformAccessory, characteristic: Characteristic, reason: ChangeReason): Nullable<CharacteristicValue>[] {

  return accessory.changes.filter((change) => (change.characteristic === characteristic) && (change.reason === reason)).map((change) => change.newValue);
}

/**
 * The values production wrote to one characteristic through HAP's update path (`updateValue` and `updateCharacteristic`), in the order it wrote them. HAP raises a
 * change for every such write, a write of an unchanged value included, so a row proving production did NOT rewrite a value reads this rather than the final value.
 * HomeKit's own writes and reads and the event notifications the characteristic sent carry other reasons and stay out, as does any write to another instance of
 * the same kind elsewhere on the accessory.
 *
 * @param accessory      - The accessory whose recorded changes to read.
 * @param characteristic - The characteristic instance whose writes to select.
 *
 * @returns The new value of each update the characteristic raised.
 */
export function writesTo(accessory: TestPlatformAccessory, characteristic: Characteristic): Nullable<CharacteristicValue>[] {

  return changeValues(accessory, characteristic, ChangeReason.UPDATE);
}

/**
 * The event notifications one characteristic sent HomeKit through HAP's `sendEventNotification`, in the order it sent them. HAP stores each notified value as the
 * characteristic's value and raises a change for it, so a row reads what HomeKit was told from this rather than from the final value, and a notification on another
 * instance of the same kind elsewhere on the accessory stays out.
 *
 * @param accessory      - The accessory whose recorded changes to read.
 * @param characteristic - The characteristic instance whose notifications to select.
 *
 * @returns The value of each notification the characteristic sent.
 */
export function eventsFrom(accessory: TestPlatformAccessory, characteristic: Characteristic): Nullable<CharacteristicValue>[] {

  return changeValues(accessory, characteristic, ChangeReason.EVENT);
}

/**
 * Render every captured line led by the level it was said at, in the order the lines were said. HBPU's linesAt answers one level's lines, which is what most
 * assertions want; this answers a whole run as one list, for an assertion that spans levels and reads the order they came in.
 *
 * @param entries - The captured entries to render, a capturing log's whole list or a slice of it.
 *
 * @returns Each line as its level, a colon, and the line as the user reads it.
 */
export function labeledLines(entries: readonly TestLogEntry[]): string[] {

  return entries.map((entry) => entry.level + ": " + formatLogEntry(entry));
}

/**
 * One entry of an accessory's controller log: a controller a streaming-delegate stub handed production, configured onto the accessory or removed from it, numbered by
 * its place in the log.
 */
export interface ControllerEvent {

  readonly controller: unknown;
  readonly kind: "configure" | "remove";
  readonly seq: number;
}

// The controller log of every accessory a stand-in controller was configured onto, keyed weakly so an accessory a suite lets go of leaves no entry behind.
const controllerLogs = new WeakMap<ProtectAccessory, ControllerEvent[]>();

// The live controller log of one accessory, created empty on first reach.
function controllerLog(accessory: ProtectAccessory): ControllerEvent[] {

  let log = controllerLogs.get(accessory);

  if(!log) {

    log = [];
    controllerLogs.set(accessory, log);
  }

  return log;
}

/**
 * The ordered log of every configuration and removal of a streaming-delegate stub's controller on an accessory, in the order HAP ran them. HAP runs the controller's
 * own hooks from inside `configureController` and `removeController`, and only for a removal of the controller it holds, so the log records what HAP did rather than
 * what production asked of it.
 *
 * @param accessory - The accessory whose controller log to read.
 *
 * @returns The live log, so a reference taken before the events it will hold still reads them.
 */
export function controllerEvents(accessory: ProtectAccessory): readonly ControllerEvent[] {

  return controllerLog(accessory);
}

// HAP's camera controller option fields, which its declaration marks private and its own methods read at runtime: what the controller was constructed with.
interface CameraControllerFields {

  readonly delegate: CameraControllerOptions["delegate"];
  readonly recording?: CameraControllerOptions["recording"];
  readonly sensorOptions?: CameraControllerOptions["sensors"];
}

/**
 * The options a real camera controller was built with, read from the fields HAP keeps them in, which its declaration marks private, so one harness function reads
 * them rather than each suite reaching into HAP, the way HBPU's handler accessors read HAP's handler fields. HAP clears the recording and sensor options once the
 * controller initializes its services, so a row reads them before the controller is configured onto an accessory.
 *
 * @param controller - The camera controller to read.
 *
 * @returns The streaming delegate, the recording arm and the sensor links the controller was constructed with.
 */
export function cameraControllerOptions(controller: CameraController): Pick<CameraControllerOptions, "delegate" | "recording" | "sensors"> {

  const fields = controller as unknown as CameraControllerFields;

  return { delegate: fields.delegate, recording: fields.recording, sensors: fields.sensorOptions };
}

/* A thin facade over unifi-protect's real state store. This double owns no observe, queue, dedup, or reduction mechanics of its own: it constructs the genuine
 * StateStore through createStateStore - the package's one documented value-export, published for exactly this harness use - and delegates its reads to it, so the engine
 * a test drives is the library's own and cannot drift from a contract restated here. Dispatch is package-internal except through that factory, so reaching it from a
 * harness is the sanctioned path rather than a way around the export law.
 *
 * The ergonomic write helpers stay, re-expressed as event synthesizers: each resolves its record, then dispatches the TypedEvent the controller would have sent, so a
 * test still writes in per-slice terms while the reducer decides what actually changed. Two semantics therefore come from the real engine rather than from this file.
 * A write that changes nothing by value leaves the state reference untouched, so it notifies no observer at all. A patch carrying a nested object deep-merges into that
 * subtree rather than replacing it, so keys the patch omits keep their stored values.
 *
 * observerCount wraps the generator protocol rather than reading a registration set: the wrapper repeats the real store's pre-registration abort check, then counts one
 * live iteration per instance. The async-generator protocol runs a generator's finally exactly once on every exit path - abort, break, or return() - so a bare counter is
 * exact and needs no identity set behind it.
 */
export class TestStateStore {

  private observers = 0;
  private readonly store: StateStore;

  public constructor(initialState: ProtectState) {

    this.store = createStateStore({ initialState, refresh: disabledRefresh, refreshIntervalMs: false });
  }

  // The number of live observe iterations. Nonzero after a minimal camera construction settles (the base observers plus the camera's own); zero after cleanup.
  public get observerCount(): number {

    return this.observers;
  }

  // The current state - the same synchronous read surface production code calls as client.state.snapshot().
  public snapshot(): ProtectState {

    return this.store.snapshot();
  }

  // The device-collection selector catalog - the same read surface production code reaches as client.state.selectors, the real store's own catalog.
  public get selectors(): DeviceSelectors {

    return this.store.selectors;
  }

  // Patch a camera record, exactly as the controller's realtime update packet would.
  public pushCameraPatch(id: string, patch: Partial<ProtectCameraConfig>): void {

    this.requirePresent({ id, label: "camera", record: this.snapshot().cameras.get(id) });
    this.patchRecord("camera", id, patch);
  }

  // Push a partial featureFlags patch. A one-level patch is all this needs: the reducer merges key-wise into the stored featureFlags, so every flag the test did not name
  // keeps its value. This is the shared composing helper the doorbell promotion and package-capability flip tests use.
  public pushCameraFeatureFlags(id: string, flags: Partial<ProtectCameraConfig["featureFlags"]>): void {

    this.requirePresent({ id, label: "camera", record: this.snapshot().cameras.get(id) });
    this.patchRecord("camera", id, { featureFlags: flags });
  }

  // Push the controller's drain frame for a camera: every top-level boolean in its featureFlags reads false, with the lists left as they stand, as the controller
  // delivers the block on a deep re-adopt before the real values follow. The frame derives from the camera's own record, so it covers every flag the record carries.
  public pushCameraFeatureFlagsDrain(id: string): void {

    const record = this.requirePresent({ id, label: "camera", record: this.snapshot().cameras.get(id) });
    const drain = Object.fromEntries(Object.entries(record.featureFlags).filter((entry) => typeof entry[1] === "boolean").map((entry) => [ entry[0], false ]));

    this.patchRecord("camera", id, { featureFlags: drain });
  }

  // Push the paired Access reader's supportUnlock capability live. accessDeviceMetadata is OPTIONAL - a camera with no paired reader carries none - and the reducer
  // replaces an absent subtree wholesale while merging a present one key-wise, so this single patch shape serves both the first appearance and a later flip.
  public pushCameraSupportUnlock(id: string, supportUnlock: boolean): void {

    this.requirePresent({ id, label: "camera", record: this.snapshot().cameras.get(id) });
    this.patchRecord("camera", id, { accessDeviceMetadata: { featureFlags: { supportUnlock } } });
  }

  // Patch a light record - the slice the light's brightness and status-indicator reactions read.
  public pushLightPatch(id: string, patch: Partial<ProtectLightConfig>): void {

    this.requirePresent({ id, label: "light", record: this.snapshot().lights.get(id) });
    this.patchRecord("light", id, patch);
  }

  // Push a partial lightDeviceSettings patch. The light's ledLevel and isIndicatorEnabled selectors both read into that one nested object, so a test moves exactly one of
  // them and the reducer's key-wise merge leaves the sibling - and therefore the sibling's observer - alone.
  public pushLightDeviceSettings(id: string, settings: Partial<ProtectLightConfig["lightDeviceSettings"]>): void {

    this.requirePresent({ id, label: "light", record: this.snapshot().lights.get(id) });
    this.patchRecord("light", id, { lightDeviceSettings: settings });
  }

  // Patch a sensor record - the carrier the base device-info observers and the whole sensor family run on.
  public pushSensorPatch(id: string, patch: Partial<ProtectSensorConfig>): void {

    this.requirePresent({ id, label: "sensor", record: this.snapshot().sensors.get(id) });
    this.patchRecord("sensor", id, patch);
  }

  // Patch a relay record. A patch carrying a fresh outputs array wakes the outputs observer, while a ledSettings-only patch leaves the outputs array untouched so that
  // observer stays parked - the reducer's copy-on-write replacing only the subtree it actually changed.
  public pushRelayPatch(id: string, patch: Partial<ProtectRelayConfig>): void {

    this.requirePresent({ id, label: "relay", record: this.snapshot().relays.get(id) });
    this.patchRecord("relay", id, patch);
  }

  // Push a fresh outputs array for a relay, composing each simplified { id, name?, state } into the full output record shape makeRelayConfig builds. This is the
  // broadcast a real per-output state change delivers, so a test can move output state without hand-building the wire record. The lone cast is confined here, exactly as
  // makeRelayConfig confines its own, since the simplified output is not the full wire shape.
  public pushRelayOutputs(id: string, outputs: { id: number; name?: Nullable<string>; state: "off" | "on" }[]): void {

    this.pushRelayPatch(id, { outputs: outputs.map((output) => ({ id: output.id, name: output.name ?? null, state: output.state })) as ProtectRelayConfig["outputs"] });
  }

  // Patch a fob record - the slice the battery and identity observers read.
  public pushFobPatch(id: string, patch: Partial<ProtectFobConfig>): void {

    this.requirePresent({ id, label: "fob", record: this.snapshot().fobs.get(id) });
    this.patchRecord("fob", id, patch);
  }

  // Push a fresh battery status for a fob. The reducer merges into the stored wirelessConnectionState, so the LoRa link state around the battery survives and exactly the
  // fob's battery observers wake, each deduped on its own primitive.
  public pushFobBattery(id: string, batteryStatus: { isLow: boolean; percentage: Nullable<number> }): void {

    this.requirePresent({ id, label: "fob", record: this.snapshot().fobs.get(id) });
    this.patchRecord("fob", id, { wirelessConnectionState: { batteryStatus } });
  }

  // Patch a chime record - the slice the doorbell's chime-volume reduction reads.
  public pushChimePatch(id: string, patch: Partial<ProtectChimeConfig>): void {

    this.requirePresent({ id, label: "chime", record: this.snapshot().chimes.get(id) });
    this.patchRecord("chime", id, patch);
  }

  // Patch a viewer record - how the suite drives the observer-driven active-liveview reflection, since the projection double records rather than folds.
  public pushViewerPatch(id: string, patch: Partial<ProtectViewerConfig>): void {

    this.requirePresent({ id, label: "viewer", record: this.snapshot().viewers.get(id) });
    this.patchRecord("viewer", id, patch);
  }

  // Patch the NVR record - the one slice that is a single nullable record rather than a map, so it carries no id. When a test moves systemInfo it passes a FRESH
  // systemInfo object, so the nvr-systeminfo owner's narrow reaction wakes and its re-read returns the new value.
  public pushNvrPatch(patch: Partial<ProtectNvrConfig>): void {

    this.requirePresent({ label: "nvr", record: this.snapshot().nvr ?? undefined });
    this.patchRecord("nvr", "", patch);
  }

  // Replace the controller's ringtone library. Ringtones are reduced BOOTSTRAP-ONLY - the controller broadcasts no ringtone realtime packet - so a bootstrap is the only
  // event that can write this slice at all.
  public pushRingtones(ringtones: ProtectRingtoneConfig[]): void {

    this.store.dispatch({ data: this.bootstrapReplacing({ ringtones }), kind: "bootstrapLoaded" });
  }

  // Replace the controller's saved liveviews. This goes through the same bootstrap as the ringtone library, for a different reason: replacing a whole collection is ONE
  // atomic transition, and a bootstrap reconciles every slice in a single dispatch, so one push wakes the collection's observer exactly once. Per-id events would reduce
  // the same end state through one dispatch per added and removed record, waking that observer once per record.
  public pushLiveviews(liveviews: ProtectNvrLiveviewConfig[]): void {

    this.store.dispatch({ data: this.bootstrapReplacing({ liveviews }), kind: "bootstrapLoaded" });
  }

  // Remove a camera record outright. Presence-free by design, mirroring the reducer's own tolerance for a removal naming an id it does not hold. The fixture for
  // absence-tolerance tests - a projection's config getter throws once its record is gone, and predicates that must survive that are exercised against exactly this.
  public removeCameraRecord(id: string): void {

    this.store.dispatch({ id, kind: "deviceRemoved", modelKey: "camera" });
  }

  // Add a camera record outright, exactly as the controller's realtime add packet would - the counterpart to removeCameraRecord, so a test can model a record that
  // vanishes and returns within the removal grace and assert what the camera's observers do across the gap.
  public addCameraRecord(config: ProtectCameraConfig): void {

    this.store.dispatch({ data: config, id: config.id, kind: "deviceAdded", modelKey: "camera" });
  }

  // Remove a sensor record outright. Presence-free by design, mirroring the reducer's own tolerance for a removal naming an id it does not hold. The fixture for
  // absence-tolerance tests - a projection's config getter throws once its record is gone, and predicates that must survive that are exercised against exactly this.
  public removeSensorRecord(id: string): void {

    this.store.dispatch({ id, kind: "deviceRemoved", modelKey: "sensor" });
  }

  // Add a sensor record outright, exactly as the controller's realtime add packet would - the counterpart to removeSensorRecord, so a test can model a record that
  // vanishes and returns within the removal grace and assert what the sensor carrier's observers do across the gap.
  public addSensorRecord(config: ProtectSensorConfig): void {

    this.store.dispatch({ data: config, id: config.id, kind: "deviceAdded", modelKey: "sensor" });
  }

  /* Observe a selector over the state. The real store owns the semantics - lazy registration when iteration begins, a baseline seeded at that moment, an unbounded
   * in-order queue, drain-then-close on abort, and deregistration on every exit path - and this wrapper adds only the count. It repeats the store's own already-aborted
   * check first so the count never moves for an iteration the store declines to register, which keeps observerCount equal to real registration rather than merely
   * netting to zero.
   */
  public async *observe<T>(selector: (state: ProtectState) => T, opts: { signal?: AbortSignal } = {}): AsyncGenerator<T> {

    if(opts.signal?.aborted) {

      return;
    }

    this.observers++;

    try {

      yield* this.store.observe(selector, opts);
    } finally {

      this.observers--;
    }
  }

  /* Build the bootstrap that carries one replaced collection and changes nothing else - the write path for both whole-collection helpers. Every modeled collection is
   * rebuilt from the current snapshot, one line per slice with no selectivity, and nvr and authUserId are carried across verbatim, so applyBootstrap's reconciliation is
   * the identity on every slice the caller did not replace: reconcileMap re-keys each collection against its own records, finds no addition, removal, or value change,
   * and returns the very map it was handed, records and all. The nvr line preserves an unchanged record by reference and carries a null through unchanged, and the
   * adoption normalization ahead of it reads the controller MAC off that same nvr, going inert when it is null.
   *
   * The single cast is what lets that work. ProtectNvrBootstrap describes the controller's full bootstrap document: it requires a non-nullable nvr, which the store
   * legitimately holds as null before a controller identity exists, plus the further fields it requires that ProtectState does not model and applyBootstrap never reads -
   * accessKey, lastUpdateId, the group and unmodeled-device collections among them. Fabricating them would be invention, and fabricating the nvr in particular would
   * silently overwrite the null slice these fixtures depend on, so the literal carries exactly the fields the reducer consumes and the cast confines the gap, in the same
   * wire-shape idiom the config builders use.
   */
  private bootstrapReplacing(replacements: { liveviews?: ProtectNvrLiveviewConfig[]; ringtones?: ProtectRingtoneConfig[] }): ProtectNvrBootstrap {

    const state = this.snapshot();

    return {

      authUserId: state.authUserId,
      cameras: [...state.cameras.values()],
      chimes: [...state.chimes.values()],
      fobs: [...state.fobs.values()],
      lights: [...state.lights.values()],
      liveviews: replacements.liveviews ?? [...state.liveviews.values()],
      nvr: state.nvr,
      relays: [...state.relays.values()],
      ringtones: replacements.ringtones ?? [...state.ringtones.values()],
      sensors: [...state.sensors.values()],
      users: [...state.users.values()],
      viewers: [...state.viewers.values()]
    } as unknown as ProtectNvrBootstrap;
  }

  /* Dispatch one device patch. Each per-slice helper above holds a precise Partial of its own record type, but a TypedEvent pairs a model key with a patch typed against
   * the whole record union and the two carry no typed correlation, so the widening lands here once rather than at every helper.
   */
  private patchRecord(modelKey: StateModelKey, id: string, patch: object): void {

    this.store.dispatch({ id, kind: "devicePatched", modelKey, patch: patch as DeepPartial<ProtectStateRecord> });
  }

  // The one presence guard behind every write helper. The reducer no-ops a patch naming an id it does not hold, which would let a mistargeted push silently do nothing;
  // throwing here keeps a test's own mistake loud. The nvr singleton carries no id, so its message names no record.
  private requirePresent<T>(options: { id?: string; label: string; record: T | undefined }): T {

    if(options.record === undefined) {

      throw new Error("The " + options.label + " record to patch is not present in the store double" + ((options.id === undefined) ? "." : ": " + options.id + "."));
    }

    return options.record;
  }
}

// The refresh callback the real store's options require. Constructing the double with refreshIntervalMs false disables the bootstrap-refresh failsafe outright, so the
// loop never starts, nothing here ever runs, and there is no timer or resource for a test to dispose. It throws rather than fabricating a bootstrap so that were the
// failsafe ever enabled by accident, the harness would fail loudly instead of quietly reducing an invented document.
async function disabledRefresh(): Promise<ProtectNvrBootstrap> {

  throw new Error("The store double disables the bootstrap refresh failsafe, so its refresh callback is never called.");
}

/**
 * Build a complete ProtectState for the store double, populated with whichever device-slice records the caller supplies and empty collections everywhere else.
 * Mirrors the real reduced state's shape (unifi-protect's reducer), so the real memoized selectors read it natively. Every slice keys its records by their own id,
 * exactly as the reducer does; the lone nvr slice is a single nullable record rather than a map. Omitting any option yields the empty starting value for that slice
 * (an empty Map, or null for nvr), so a bare makeProtectState() is the empty-everywhere baseline the observe and selector tests seed.
 *
 * @param options - cameras / chimes / fobs / lights / liveviews / relays / ringtones / sensors / viewers: the config records to key into the matching map slice, each
 *                  keyed by its own id; nvr: the single controller config record set on the nvr slice (defaults to null). The users slice is intentionally not exposed:
 *                  no test seeds it (it is not surfaced in HomeKit), so it stays the empty Map the reducer starts from.
 *
 * @returns a full ProtectState ready to seed a TestStateStore.
 */
export function makeProtectState(options: { cameras?: ProtectCameraConfig[]; chimes?: ProtectChimeConfig[]; fobs?: ProtectFobConfig[]; lights?: ProtectLightConfig[];
  liveviews?: ProtectNvrLiveviewConfig[]; nvr?: Nullable<ProtectNvrConfig>; relays?: ProtectRelayConfig[]; ringtones?: ProtectRingtoneConfig[];
  sensors?: ProtectSensorConfig[]; viewers?: ProtectViewerConfig[]; } = {}): ProtectState {

  return {

    authUserId: null,
    bootstrapId: 1,
    cameras: new Map((options.cameras ?? []).map((camera): [string, ProtectCameraConfig] => [ camera.id, camera ])),
    chimes: new Map((options.chimes ?? []).map((chime): [string, ProtectChimeConfig] => [ chime.id, chime ])),
    fobs: new Map((options.fobs ?? []).map((fob): [string, ProtectFobConfig] => [ fob.id, fob ])),
    lights: new Map((options.lights ?? []).map((light): [string, ProtectLightConfig] => [ light.id, light ])),
    liveviews: new Map((options.liveviews ?? []).map((liveview): [string, ProtectNvrLiveviewConfig] => [ liveview.id, liveview ])),
    nvr: options.nvr ?? null,
    relays: new Map((options.relays ?? []).map((relay): [string, ProtectRelayConfig] => [ relay.id, relay ])),
    ringtones: new Map((options.ringtones ?? []).map((ringtone): [string, ProtectRingtoneConfig] => [ ringtone.id, ringtone ])),
    sensors: new Map((options.sensors ?? []).map((sensor): [string, ProtectSensorConfig] => [ sensor.id, sensor ])),
    users: new Map(),
    viewers: new Map((options.viewers ?? []).map((viewer): [string, ProtectViewerConfig] => [ viewer.id, viewer ]))
  };
}

// The steerable recording face of a streaming-delegate double: the narrow HomeKit Secure Video slice the camera family reads off this.stream.hksv - whether a recording
// is open, whether it is actively transmitting, and the recording-off command the delegate teardown issues. Every recording-active command is recorded, so a test can
// assert both that a teardown disabled recording and that a connection-release deliberately did not.
export interface TestRecordingDelegate {

  isRecording: boolean;
  isTransmitting: boolean;
  updateRecordingActive: (isActive: boolean) => void;
  updateRecordingActiveCalls: boolean[];
}

// Build a recording-delegate double in a chosen recording state, defaulting to idle. A test installs it on a TestStreamingDelegate's hksv arrangement point through the
// harness's confined double-to-production cast, exactly as the factory installs the timeshift supervisor double.
export function makeRecordingDelegateDouble(state: { isRecording?: boolean; isTransmitting?: boolean } = {}): TestRecordingDelegate {

  const hksv: TestRecordingDelegate = {

    isRecording: state.isRecording ?? false,
    isTransmitting: state.isTransmitting ?? false,
    updateRecordingActive: (isActive: boolean): void => { hksv.updateRecordingActiveCalls.push(isActive); },
    updateRecordingActiveCalls: []
  };

  return hksv;
}

// The steerable buffer face of the timeshift-supervisor double: the members the session-source and snapshot paths read off the running buffer.
export interface TestTimeshiftBuffer {

  channelProfile: Nullable<ChannelProfile>;
  getInitPlusTrailingFromLastKeyframe?: () => Nullable<Buffer>;
  getLast: (duration: number) => Nullable<Buffer>;
  isStarted: boolean;
  snapshotSource: () => SnapshotSource;
}

// A steerable timeshift-supervisor double the streaming-delegate factory installs at create time, so the construction-time activation kick and the per-lifecycle-edge
// availability kicks land on a spy rather than an inert stand-in. reconcileCalls tallies every reconcile the camera fires; the buffer members are steerable so the
// session-source and snapshot tests drive the buffer-liveness and empty-read branches.
export interface TestTimeshiftSupervisor {

  readonly buffer: TestTimeshiftBuffer;
  reconcile: () => Promise<void>;
  reconcileCalls: number;
  shutdown: () => void;
  shutdownCalls: number;
}

// Build a fresh timeshift-supervisor double. Every reconcile increments reconcileCalls (the per-edge tally the availability/activation/snapshot kick tests read), and the
// steerable buffer members default to "not running, nothing to give" - the quiet default the construction paths read against.
export function makeTimeshiftSupervisorDouble(): TestTimeshiftSupervisor {

  const buffer: TestTimeshiftBuffer = {

    channelProfile: null,
    getInitPlusTrailingFromLastKeyframe: (): Nullable<Buffer> => null,
    getLast: (): Nullable<Buffer> => null,
    isStarted: false,
    snapshotSource: (): SnapshotSource => ({ kind: "empty" })
  };

  const supervisor: TestTimeshiftSupervisor = {

    buffer,
    reconcile: (): Promise<void> => {

      supervisor.reconcileCalls++;

      return Promise.resolve();
    },
    reconcileCalls: 0,
    shutdown: (): void => { supervisor.shutdownCalls++; },
    shutdownCalls: 0
  };

  return supervisor;
}

/* The controller a TestStreamingDelegate hands the camera: a stand-in HAP's own configureController and removeController accept, so a camera's controller lifecycle runs
 * through the real accessory. Its id is the real camera controller's, so HAP's one-controller-per-id rule refuses a second configure on an accessory exactly as it
 * refuses a second camera controller. It builds no services. HAP calls its configureServices from inside configureController and its handleControllerRemoved from
 * inside removeController, and each appends to the controller log of the accessory the delegate was built for, so a row reads the configure and remove order across a
 * rebuild through controllerEvents.
 */
class TestStreamingController implements Controller {

  readonly #accessory: Nullable<ProtectAccessory>;

  public constructor(accessory: Nullable<ProtectAccessory>) {

    this.#accessory = accessory;
  }

  public configureServices(): void {

    this.#record("configure");
  }

  public constructServices(): ControllerServiceMap {

    return {};
  }

  public controllerId(): string {

    return "camera";
  }

  public handleControllerRemoved(): void {

    this.#record("remove");
  }

  public initWithServices(): void {

    // Nothing to restore: the stand-in builds no services, so HAP holds no saved service map for it.
  }

  // Append one lifecycle event to the log of the accessory the delegate was built for. A delegate the media suites build for a host takes no accessory, and its
  // controller is never configured, so a configure reaching one is a rig mistake and says so.
  #record(kind: ControllerEvent["kind"]): void {

    if(!this.#accessory) {

      throw new Error("A streaming delegate built without an accessory has no controller log to record a " + kind + " in.");
    }

    const log = controllerLog(this.#accessory);

    log.push({ controller: this, kind, seq: log.length });
  }
}

/* The stub StreamingDelegate, typed as the abstraction and entirely FFmpeg-free. The controller is the stand-in above, which tests identity-match through the
 * accessory's controller log; ffmpegOptions is the one documented cast boundary on this class - the camera family reads maxSourcePixels off it (via
 * selectSubstrateChannel, never at construction) and hardwareEncodes off it (the HKSV acknowledgment marker), with the ceiling injectable and the encoder answer
 * configurable so the substrate-channel pixel cap and the hardware marker are both exercisable, and the timeshift supervisor's hardware decoder check calls
 * resetHardwareDecoderRefusal and videoDecoder on it, the reset counted and clearing a refusal flag a row can raise, each decoder read recorded with the codec it
 * names and whether that flag stood, and the decoder answering the empty list of a software decode, so the check never spawns FFmpeg; hksv is null, the correct
 * pre-HKSV-configuration state cleanup reads through this.stream?.hksv?.isRecording; shutdown records its calls; and resetProbesizeOverride is a recordable no-op.
 */
export class TestStreamingDelegate implements StreamingDelegate {

  // The controller identity this stub controller was built for, mirroring production's ProtectStreamingDelegate.builtFor so the live capability reconcile's staleness
  // check (rebuild only when a term has appeared since this.stream.builtFor) exercises against the real value the factory recorded at create time.
  public readonly builtFor: ControllerIdentity;
  public controller: CameraController;
  public readonly ffmpegOptions: StreamingDelegate["ffmpegOptions"];
  // Whether the hardware decoder's refusal mark stands on this delegate's FFmpeg options. A row raises it in place of a refusal HBPU's process would read, and the
  // reset clears it, as production's reset clears the mark.
  public hardwareDecoderRefused = false;
  // Whether this stub reports the host running its hardware encoder, read through the ffmpegOptions.hardwareEncodes closure. Defaults false, the software-neutral state
  // that suppresses the HKSV hardware marker, so a marker test opts in by setting it true before the acknowledgment fires.
  public hardwareEncodes = false;
  public hksv: StreamingDelegate["hksv"];
  public readonly probesize: number;
  // How many times production cleared the hardware decoder's refusal mark on this delegate's FFmpeg options - the supervisor's decoder check clears it for each new
  // stream it checks.
  public resetHardwareDecoderRefusalCalls = 0;
  // How many times production wound this delegate's probesize self-tuning back - the controller-reboot recovery walk calls it.
  public resetProbesizeOverrideCalls = 0;
  // How many times production tore this delegate down - cleanup and the NVR disconnect walk both call shutdown.
  public shutdownCalls = 0;
  public timeshift: StreamingDelegate["timeshift"];
  // Each read production made of the video decoder arguments on this delegate's FFmpeg options, in order: the input codec it named, and whether the refusal mark
  // stood at the read, so a row tells a read the mark would have answered from one it did not.
  public readonly videoDecoderCalls: { inputCodec?: string; refused: boolean }[] = [];

  /**
   * Build a stub delegate.
   *
   * @param options                 - Delegate inputs.
   * @param options.accessory       - The accessory whose controller log the stub's controller records into. Defaults to none, for a host whose controller is never
   *                                  configured.
   * @param options.builtFor        - The controller identity the stub was built for. Defaults to the record with every term false: a delegate built for nothing, so
   *                                  any term a test raises is an appearance.
   * @param options.maxSourcePixels - The hardware pixel ceiling ffmpegOptions reports. Defaults to no ceiling.
   */
  public constructor({ accessory = null, builtFor = { hksvCapable: false, isDoorbell: false, twoWayAudio: false }, maxSourcePixels = Infinity }:
    { accessory?: Nullable<ProtectAccessory>; builtFor?: ControllerIdentity; maxSourcePixels?: number } = {}) {

    this.builtFor = builtFor;

    // The stand-in controller, which HAP configures and removes through its own controller registry. The delegate contract types the field as HAP's camera controller,
    // which the stand-in is not, so the crossing takes this one cast; HAP's configureController and removeController take the stand-in as it is.
    this.controller = new TestStreamingController(accessory) as unknown as CameraController;

    // The confined cast boundary: the camera family reads maxSourcePixels and hardwareEncodes off ffmpegOptions, and the supervisor's decoder check calls
    // resetHardwareDecoderRefusal and videoDecoder on it. An Infinity ceiling means "no hardware pixel cap" - the pass-everything-through default - while a finite
    // injected ceiling lets the recording-channel cap path select against a real constraint. The hardwareEncodes closure reads the configurable field, which defaults
    // false so the HKSV hardware marker is absent unless a test opts in. The reset is counted and clears the refusal flag, and each videoDecoder read is recorded
    // and answers the empty list of a software decode, which ends the check before its spawn, so a check over this stub never runs FFmpeg.
    this.ffmpegOptions = {

      hardwareEncodes: (): boolean => this.hardwareEncodes,
      maxSourcePixels: (): number => maxSourcePixels,
      resetHardwareDecoderRefusal: (): void => {

        this.resetHardwareDecoderRefusalCalls++;
        this.hardwareDecoderRefused = false;
      },
      videoDecoder: (options: { inputCodec?: string } = {}): string[] => {

        this.videoDecoderCalls.push({ inputCodec: options.inputCodec, refused: this.hardwareDecoderRefused });

        return [];
      }
    } as unknown as StreamingDelegate["ffmpegOptions"];
    this.hksv = null;

    // The fixed probesize the stub advertises - consumers read it through camera.stream.probesize; an inert test value with no behavioral role in the suites.
    this.probesize = 16384;
    this.timeshift = null;
  }

  // The snapshot entry point is void fire-and-forget on the paths that reach it; the stub does nothing.
  public handleSnapshotRequest(): void {

    // Nothing to do - the stub takes no snapshots.
  }

  public resetProbesizeOverride(): void {

    // Nothing to reset - the stub holds no probesize override state, so the call is recorded and nothing else happens.
    this.resetProbesizeOverrideCalls++;
  }

  public shutdown(): void {

    // Nothing to tear down beyond the record - the stub holds no FFmpeg sessions.
    this.shutdownCalls++;
  }
}

/* Build HAP's own camera controller for a camera, with the arms production's delegate gives one: the recording arm and the motion and occupancy links where the camera
 * can back HomeKit Secure Video, and the streaming arm always. A registration therefore builds exactly the services production's does, and the delegates behind it do
 * nothing, because the rows it serves read those services and no session ever starts.
 *
 * @param camera      - The camera the controller is for.
 * @param resolutions - The resolutions the controller advertises.
 *
 * @returns The controller, ready to configure on the camera's accessory.
 */
function makeRealCameraController(camera: ProtectCameraHost, resolutions: Resolution[]): CameraController {

  const idle = async (): Promise<void> => Promise.resolve();
  const video = { parameters: { levels: [H264Level.LEVEL4_0], profiles: [H264Profile.MAIN] }, resolutions, type: VideoCodecType.H264 };
  const options = {

    delegate: { handleSnapshotRequest: idle, handleStreamRequest: idle, prepareStream: idle },
    ...(camera.isHksvCapable ? {

      recording: {

        delegate: { closeRecordingStream: idle, handleRecordingStreamRequest: idle, updateRecordingActive: idle, updateRecordingConfiguration: idle },
        options: {

          audio: { codecs: [{ audioChannels: 1, samplerate: AudioRecordingSamplerate.KHZ_32, type: AudioRecordingCodecType.AAC_LC }] },
          mediaContainerConfiguration: [{ fragmentLength: 4000, type: MediaContainerType.FRAGMENTED_MP4 }],
          prebufferLength: 4000,
          video
        }
      },
      sensors: { motion: camera.accessory.getService(hap.Service.MotionSensor), occupancy: camera.accessory.getService(hap.Service.OccupancySensor) }
    } : {}),
    streamingOptions: {

      supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
      video: { codec: { levels: [H264Level.LEVEL4_0], profiles: [H264Profile.MAIN] }, resolutions }
    }
  };

  return new hap.CameraController(options as unknown as CameraControllerOptions);
}

// The stub StreamingDelegateFactory satisfying the platform's dependency-inversion interface. Records every create call (the camera identity, the resolutions array,
// the recording audio format and the probe the derivation handed it, the delegate it returned, and whether the accessory carried a MotionSensor service at that moment)
// so tests can assert the interface was exercised exactly once with exactly the advertised resolutions, read what the derivation's probe produced, prove a motion
// sensor stood before the controller that captures it was built, and hand back the recorded delegate's stand-in controller for identity assertions. The
// maxSourcePixels ceiling is forwarded into every delegate it creates - set it before construction to exercise the recording-channel pixel cap with a finite value.
export class TestStreamingDelegateFactory implements StreamingDelegateFactory {

  public readonly createCalls: { audioFormat: AdvertisedStreams["audioFormat"]; camera: ProtectCameraHost; delegate: TestStreamingDelegate; motionSensorPresent: boolean;
    probe: AdvertisedStreams["probe"]; resolutions: Resolution[]; }[] = [];

  public maxSourcePixels = Infinity;

  // Whether each delegate carries HAP's own camera controller rather than the stand-in, for a row that reads the services a real registration gives an accessory. Off by
  // default, since the stand-in builds no services and a row reading the controller log reads the stand-in's. Set it before construction.
  public realControllers = false;

  public create(camera: ProtectCameraHost, derived: AdvertisedStreams): StreamingDelegate {

    // Capture the camera's controller identity through the same derivation production's ProtectStreamingDelegate reads at its own construction. This makes a
    // construction whose capabilities are present yield a delegate already built for the current identity, so the capability reconcile's staleness check is a no-op
    // (zero controller churn), and only a genuine late capability - a delegate built before it appeared - rebuilds. The camera's own accessory is the one production
    // configures the delegate's controller onto, so its controller log is the one the stand-in records into.
    const delegate = new TestStreamingDelegate({ accessory: camera.accessory, builtFor: controllerIdentityOf(camera), maxSourcePixels: this.maxSourcePixels });

    // Install the timeshift-supervisor double at create time - before the camera's construction-time activation kick reads it - so the kick and the per-edge availability
    // kicks land on a spy rather than an inert stand-in. Cast at the confined double->production boundary the harness uses throughout.
    delegate.timeshift = makeTimeshiftSupervisorDouble() as unknown as StreamingDelegate["timeshift"];

    if(this.realControllers) {

      delegate.controller = makeRealCameraController(camera, derived.resolutions);
    }

    this.createCalls.push({ audioFormat: derived.audioFormat, camera, delegate,
      motionSensorPresent: camera.accessory.getService(camera.api.hap.Service.MotionSensor) !== undefined, probe: derived.probe, resolutions: derived.resolutions });

    return delegate;
  }
}

/* The reusable camera-host test double: the small stand-in every media-delegate test constructs a delegate against, in place of a full ProtectCamera. The
 * ProtectCameraHost interface segregation (the dependency-inversion seam on the camera side of the media stack) exists precisely so the streaming, recording,
 * snapshot, and timeshift delegates type their camera handle as this narrow contract rather than the concrete class - and this double is what cashes that in: it
 * structurally satisfies every member of ProtectCameraHost (the same compile-time proof the production ProtectCamera passes), so a delegate constructs against it
 * with no FFmpeg and no live camera.
 *
 * The shape mirrors TestStreamingDelegate's discipline: controllable fields a test sets to steer a branch (isReachable is the behavior-bearing one - the snapshot
 * delegate's reachability gate reads it), recordable call logs the behavior-bearing seams push their arguments into (so a later test asserts a seam was invoked),
 * and settable seam returns (snapshotResult is the Buffer snapshotFromController resolves, the value the two-sided snapshot test threads through the delegate).
 *
 * The context half composes the EXISTING harness doubles rather than reinventing them: accessory is a real TestAccessory, and nvr/platform/api/log all flow from a
 * real makeTestNvr context (so the very next behavior step, which reads platform.codecSupport and nvr.mqtt, finds real doubles there, not sentinels that would
 * throw). The four context handles (accessory/api/nvr/platform) plus ufp are typed as their production types by the interface, which the intentionally-partial
 * doubles do not structurally satisfy, so each is bridged with a confined `as unknown as <ProductionType>` seam cast - the same honest harness pattern the
 * construction suites use at their own construction-arg boundaries. The casts bridge the deliberate double->production gap only; tsc still verifies every member is
 * present and interface-typed, so the completeness proof holds.
 *
 * Member order mirrors TestStreamingDelegate: the fields group alphabetized, then the methods group alphabetized (not one global run). The settable seam predicates
 * hasFeature / selectChannel / selectSubstrateChannel are public arrow-function fields so a test can reassign them, satisfying the interface's method members.
 */
export class TestCameraHost implements ProtectCameraHost {

  public accessory: ProtectAccessory;
  public accessoryName = "Test Camera";
  public api: API;

  // The settable feature predicate; defaults to "no feature enabled", the quiet default the delegate construction paths read against.
  public hasFeature: (option: string) => boolean = () => false;

  // A complete neutral ProtectHints literal - every boolean false, every number 0, every string empty, the nested cropOptions zeroed - so a delegate reads a fully
  // populated hint bag with no behavior turned on (crop false is load-bearing for the two-sided snapshot test, which must NOT enter the crop pass).
  public hints: ProtectHints = {

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
    nightVision: false,
    occupancyDuration: 0,
    probesize: 0,
    rtspDefault: "",
    smartDetect: false,
    smartDetectSensors: false,
    smartOccupancy: [],
    standalone: false,
    substrateDefault: "",
    syncName: false,
    transcodeBitrate: 0,
    transcodeHighLatencyBitrate: 0,
    tsbStreaming: false,
    twoWayAudio: false,
    twoWayAudioDirect: false
  };

  // Whether this camera can back HomeKit Secure Video. Settable so a recording-behavior test can flip it; defaults false.
  public isHksvCapable = false;

  // The behavior-bearing reachability gate: the snapshot delegate returns null before any pipeline when this is false, so the two-sided snapshot test sets it both
  // ways. Defaults true.
  public isReachable = true;

  // Recordable call logs: each behavior-bearing seam pushes its arguments here so a later test can assert the seam was invoked exactly as expected.
  public readonly livestreamCalls: { channelProfile: ChannelProfile; opts?: { segmentLength?: number; signal?: AbortSignal; urgency?: () => number } }[] = [];

  // The segment-count knob the transmit test sets to fill the timeshift buffer: the number of keyframe-bearing media segments livestream() yields. Defaults 0, which
  // returns the inert (segment-less) livestream double so the construction suites stay on their unchanged path.
  public livestreamMediaSegments = 0;

  // The queue of test-provided subscriptions livestream() hands out in order: each call shifts the head, so a single start consumes one, and a start-twice or
  // id-identity test supplies two DISTINCT-id controllable doubles. When the queue is empty, livestream() falls back to the livestreamMediaSegments-selected parking /
  // inert double - the unchanged path the construction and recording-transmit suites stay on (they never set this queue).
  public livestreamSubscriptions: LivestreamSubscription[] = [];
  public log: HomebridgePluginLogging;

  // The bare device MAC for topic addressing, read through the device projection so it stays consistent with the ufp fixture's mac even if a test reassigns ufp. This is
  // the identity the narrowed live-state view no longer carries; a delegate reads it (the MQTT snapshot topic) through protectCamera.mac.
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
  public selectChannel: (width: number, height: number, opts?: { biasHigher?: boolean; maxPixels?: number }) => Nullable<ChannelProfile> = () => null;
  public selectSubstrateChannel: () => Nullable<ChannelProfile> = () => null;
  public readonly setStatusLedCalls: boolean[] = [];

  // The settable Buffer snapshotFromController resolves - the value the two-sided snapshot test threads through the delegate's controller source.
  public snapshotResult: Buffer = Buffer.from("test-snapshot");
  public readonly snapshotFromControllerCalls: SnapshotOptions[] = [];

  // The streaming delegate handle the snapshot/recording/timeshift consumers read; default undefined so the snapshot timeshift/RTSP sources early-return on their
  // !stream guards and the pipeline falls through to the controller source.
  public stream: StreamingDelegate | undefined = undefined;
  public readonly talkbackCalls: { signal?: AbortSignal }[] = [];

  // The camera-narrowed Protect device projection; settable, default a G2 Pro config so featureFlags / videoCodec reads resolve to a real record.
  public ufp: Readonly<ProtectCameraConfig>;

  // Whether buffer-backed livestreaming is enabled and this camera is capable of it - the streaming demand arm of the standing buffer. Settable so a test can steer the
  // streaming arm on and off; defaults false.
  public usesTimeshiftLivestream = false;
  public videoCodecName = "h264";

  // Compose the context half from real harness doubles, bridging each to its interface-required production type at the confined seam.
  public constructor(init: { accessory: TestAccessory; nvr: TestProtectNvr }) {

    // The double is a partial TestAccessory; the interface requires the production ProtectAccessory. The confined seam cast bridges the deliberate gap.
    this.accessory = init.accessory as unknown as ProtectAccessory;

    // The api/log/platform/nvr handles all flow from the real makeTestNvr context. Each is a partial double the interface types as a production handle, so each
    // takes the same confined seam cast.
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

  // The recordable livestream seam. It records its arguments and hands back a LivestreamSubscription double whose profile is selected by this host's
  // livestreamMediaSegments knob: the default 0 yields the inert double (empty iterator, no-op dispose, "closed" state) the construction suites stay on, while a
  // positive count yields the established segment-yielding double (one init then that many keyframe-bearing media segments, then a parked iterator) the transmit net
  // fills its timeshift buffer from.
  public livestream(channelProfile: ChannelProfile, opts?: { segmentLength?: number; signal?: AbortSignal; urgency?: () => number }): LivestreamSubscription {

    this.livestreamCalls.push({ channelProfile, opts });

    // Hand out the next test-provided subscription from the queue, if any; otherwise fall back to the livestreamMediaSegments-selected parking / inert double. The queue
    // path is how a standalone timeshift test drives the SUT with a controllable double (and supplies two distinct doubles for the restart / id-identity targets); the
    // fallback preserves the unchanged behavior the construction and recording-transmit suites depend on (they never set the queue).
    return this.livestreamSubscriptions.shift() ?? makeLivestreamSubscriptionDouble({ mediaSegments: this.livestreamMediaSegments });
  }

  // The recordable reboot seam; records the call, then rejects with rebootError when one is set (the self-heal reboot-failure path) or resolves otherwise.
  public async reboot(): Promise<void> {

    this.rebootCalls.push(this.rebootCalls.length + 1);

    if(this.rebootError !== undefined) {

      throw this.rebootError;
    }
  }

  // The recordable status-LED seam; records every requested value and resolves true.
  public async setStatusLed(value: boolean): Promise<boolean> {

    this.setStatusLedCalls.push(value);

    return true;
  }

  // The behavior-bearing controller-snapshot seam: records the options and resolves the settable snapshotResult Buffer - the value the two-sided snapshot test
  // observes flow through the delegate's controller source.
  public async snapshotFromController(opts?: SnapshotOptions): Promise<Buffer> {

    this.snapshotFromControllerCalls.push(opts ?? {});

    return this.snapshotResult;
  }

  // The recordable talkback seam. NOT exercised by the construction suites - TalkbackSession has a private constructor and #private fields, so there is no
  // constructible literal; the never-called stub returns a confined sentinel cast, the same harness pattern TestStreamingDelegate uses for its opaque
  // CameraController sentinel.
  public async talkback(opts?: { signal?: AbortSignal }): Promise<TalkbackSession> {

    this.talkbackCalls.push(opts ?? {});

    // The opaque sentinel: TalkbackSession is uninstantiable from a test, and the construction suites never call talkback, so the return is a confined cast no
    // path reads.
    return { hbupTestSentinel: "talkback-session" } as unknown as TalkbackSession;
  }
}

// Synthesize a genuine fMP4 media fragment on the published fMP4 builders so the production isKeyframe TRUN-flag parse runs against REAL bytes on the REAL path - no
// isKeyframe injection seam, so the test exercises the actual fMP4 keyframe coupling rather than a test-only divergence. The fragment is moof>traf>trun with a
// first_sample_flags-bearing trun (the builder sets the data_offset and first_sample_flags TRUN flags, sample_count 1, data_offset 0). The ONLY difference between a
// keyframe and a non-keyframe fragment is that first_sample_flags value: 0 leaves the SAMPLE_FLAG_NON_SYNC bit clear, marking a sync sample (a keyframe), while
// SAMPLE_FLAG_NON_SYNC sets it, marking a non-sync sample (a non-keyframe) the production parse rejects. The mdat carries an empty body - the timeshift never decodes
// the payload, it only parses the moof for keyframe-ness and concatenates the bytes. The returned data buffer is the moof+mdat pair a media Segment delivers. This is
// the single source of truth for both fragment kinds; makeKeyframeFragment and makeNonKeyframeFragment are the two thin selectors over it.
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

/** Media fragment with mfhd sequence only (no tfdt): copy-escalation dedup mfhd fallback path. */
export function makeMfhdOnlyNonKeyframeFragment(sequenceNumber: number, tag?: number): { data: Buffer; mdat: Buffer; moof: Buffer; tag?: number } {

  const mfhdPayload = Buffer.alloc(8);

  mfhdPayload.writeUInt32BE(0, 0);
  mfhdPayload.writeUInt32BE(sequenceNumber, 4);
  const moof = makeContainer("moof", [ makeBox("mfhd", mfhdPayload),
    makeContainer("traf", [makeTrunBox({ sampleFlagsValue: SAMPLE_FLAG_NON_SYNC, useFirstSampleFlags: true })]) ]);
  const tagPayload = tag === undefined ? Buffer.alloc(0) : Buffer.from([ tag & 0xFF, (tag >> 8) & 0xFF ]);
  const mdat = makeBox("mdat", tagPayload);

  return { data: Buffer.concat([ moof, mdat ]), mdat, moof, tag };
}

// The one keyframe fragment and init buffer the segment-yielding double reuses across every yield. The timeshift never mutates segment bytes (it parses and concatenates
// them), so sharing one instance is safe and avoids re-synthesizing the boxes per call.
const KEYFRAME_FRAGMENT = makeKeyframeFragment();
const INIT_SEGMENT_DATA = Buffer.from("test-init-segment");

/* Build a LivestreamSubscription double for the camera-host stub's livestream seam, in one of two profiles selected by the requested media-segment count:
 *
 *   - mediaSegments === 0 (the default): the byte-identical INERT profile the construction tests rely on - initSegment null, state "closed", whenEstablished resolves
 *     false, an empty iterator, no-op reassess/dispose. The construction suites never exercise it; it exists only so the host's livestream return type-checks
 *     against the production type.
 *   - mediaSegments > 0: the ESTABLISHED segment-yielding profile - initSegment populated, state "live", whenEstablished resolves true, and an iterator yielding one init
 *     segment then mediaSegments keyframe-bearing media segments so the timeshift fills its buffer with real fMP4 the production isKeyframe parse accepts.
 *
 * LOAD-BEARING: after yielding its media segments the established iterator MUST PARK, never completing. A finite generator returns done, which ends the timeshift's
 * consumeSegments for-await, runs its finally -> finalizeSubscription -> clearBuffer, and wipes the just-filled buffer (the this.subscription?.id === subscription.id
 * guard is true by then, because start() commits this.subscription mid-drain) - so timeshift.time falls back to zero and the transmit gate would always decline. We park
 * by owning an internal AbortController: [Symbol.asyncDispose] aborts it, and the generator, after its media loop, awaits a promise that resolves on that abort (resolves
 * immediately if already aborted, else via a one-shot "abort" listener). The for-await therefore never completes while filling, the buffer survives, and a real
 * timeshift.stop()/dispose still releases it cleanly. whenEstablished resolves true immediately while the consumer fills its buffer by draining the parking iterator to
 * its park point; a single settle() in the test drains all the microtask-resolved yields before the park, because the generator crosses no macrotask/timer boundary (were
 * one ever added, a single settle() would silently under-drain).
 */
export function makeLivestreamSubscriptionDouble(options: { mediaSegments?: number } = {}): LivestreamSubscription {

  const mediaSegments = options.mediaSegments ?? 0;

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
    initSegment: { codec: "h264", data: INIT_SEGMENT_DATA },
    reassess: (): void => { /* No-op: the double has no recovery loop to re-decide. */ },
    state: "live",
    whenEstablished: async (): Promise<boolean> => true,
    [Symbol.asyncIterator]: async function *(): AsyncGenerator<Segment> {

      yield { codec: "h264", data: INIT_SEGMENT_DATA, type: "init" };

      for(let i = 0; i < mediaSegments; i++) {

        yield { data: KEYFRAME_FRAGMENT.data, mdat: KEYFRAME_FRAGMENT.mdat, moof: KEYFRAME_FRAGMENT.moof, type: "media" };
      }

      // Park: await the dispose-abort so the consumer's for-await never completes and the filled buffer survives. Resolve immediately if already disposed, else on the
      // one-shot abort.
      await new Promise<void>((resolve) => {

        if(disposed.signal.aborted) {

          resolve();

          return;
        }

        disposed.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    [Symbol.asyncDispose]: async (): Promise<void> => { disposed.abort(); }
  };
}

// A process-local monotonic counter minting a distinct default id per controllable double. Distinct ids are LOAD-BEARING: the timeshift's consumeSegments finally guards
// teardown on this.subscription?.id === subscription.id, so a restart test (start A, then start B) and the id-identity guard test need two doubles whose ids genuinely
// differ - or the guard cannot discriminate and the test is vacuous.
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
export function makeControllableLivestreamDouble(options: { deferEstablishment?: boolean; id?: string; initSegment?: { codec: string; data: Buffer } | null;
  state?: LivestreamSubscriptionState; whenEstablished?: boolean; } = {}): ControllableLivestreamDouble {

  type QueueItem = { kind: "segment"; segment: Segment } | { kind: "end" } | { kind: "error"; error: unknown };

  // One queue and park resolver per active iterator so a pooled buffer plus live session each receive the same pushed segments (shared encoder fanout).
  interface IteratorFanout { queue: QueueItem[]; terminated: boolean; wakeResolver: (() => void) | null }
  const iterators = new Set<IteratorFanout>();
  // Segments pushed while no iterator is attached are replayed into the next iterator (not fan-out to concurrent iterators).
  const orphanQueue: QueueItem[] = [];
  let terminated = false;
  let disposed = false;
  let reassessCalls = 0;

  // Resolve the init segment, distinguishing "option omitted" (default to a populated init so start() commits) from "option explicitly null" (the start-validation arm
  // the timeshift declines on). A plain ?? cannot make that distinction - it treats an explicit null as nullish and would override it with the default - so we branch on
  // strict undefined.
  const initSegment = (options.initSegment === undefined) ? { codec: "h264", data: INIT_SEGMENT_DATA } : options.initSegment;

  const wakeAll = (): void => {

    for(const iterator of iterators) {

      const resolve = iterator.wakeResolver;

      iterator.wakeResolver = null;
      resolve?.();
    }
  };

  // The deferred-establishment gate for the shutdown-versus-in-flight-start race. When deferEstablishment is set, whenEstablished() parks on this resolver until the
  // test calls releaseEstablishment(), so a start can be held in flight while shutdown() runs and then committed afterward. The release resolves to true specifically,
  // since a release-to-decline would never commit the subscription. Without the gate, whenEstablished resolves immediately.
  let establishmentResolver: ((established: boolean) => void) | null = null;

  // Enqueue an item for every active iterator (pooled fanout), unless the double has globally terminated.
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

        // The drain-loop: process the whole queue, then park only when it is empty and we have not yet terminated. On wake, the outer while re-checks the queue.
        while(!fanout.terminated) {

          // Drain every queued item before considering a park, so no item pushed under a single wake is stranded.
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

          // The queue is empty and we have not terminated: park on a fresh one-shot resolver until a control method wakes us, then re-check the queue.
          if(!fanout.terminated) {

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

      // Record the dispose and, if the double has not already terminated, signal a graceful end so the parked iterator completes its finally. Idempotent: a second
      // dispose after termination no-ops via the enqueue terminated-guard.
      disposed = true;
      enqueue({ kind: "end" });
    }
  };
}

/**
 * Build a TestCameraHost wired to a real makeTestNvr context, returning the host plus its test-side handles. This is the media-delegate counterpart to makeTestNvr:
 * it composes the existing doubles (a TestStateStore-backed makeTestNvr context and a TestAccessory) into the camera-host seam every media-delegate test constructs
 * against, so a delegate is unit-constructed with no real camera. The single seam casts live inside TestCameraHost's constructor (the doubles are not the
 * production handle types); the host returned here is the production-interface-typed double.
 *
 * @param options - clock: an optional controllable TestClock forwarded into the makeTestNvr platform double's clock seam and re-returned, so a transmit test holds the
 *                  exact instance the recording delegate reads via platform.clock and advances it to release pacing (omitted, a fresh default TestClock is created);
 *                  recordingProcessFactory: the test recording-process factory injected into the makeTestNvr platform double's recordingProcessFactory seam, so a
 *                  transmit test's delegate constructs its FFmpeg process through the test double (omitted, makeTestNvr installs a fresh default factory); userOptions:
 *                  feature-option config strings forwarded to the makeTestNvr context's REAL FeatureOptions engine (for a later behavior test that steers a feature-gated
 *                  delegate path); the default empty context is the quiet-default host.
 *
 * @returns accessory: the TestAccessory backing the host; clock: the controllable TestClock installed on the platform double (the same instance the recording delegate
 *          reads, so a transmit test advances it to release pacing); controller: the AbortController behind the context's signal (abort it in suite teardown); host: the
 *          TestCameraHost double under test; logEntries: every line the construction and transmit paths logged (so a transmit test can assert on captured telemetry);
 *          nvr: the NVR double backing the context.
 */
export function makeTestCameraHost(options: { clock?: TestClock; recordingProcessFactory?: RecordingProcessFactory; userOptions?: string[] } = {}):
{ accessory: TestAccessory; clock: TestClock; controller: AbortController; host: TestCameraHost; logEntries: TestLogEntry[]; nvr: TestProtectNvr } {

  const store = new TestStateStore(makeProtectState());
  const { clock, controller, logEntries, nvr } = makeTestNvr({ clock: options.clock, recordingProcessFactory: options.recordingProcessFactory, store,
    userOptions: options.userOptions });
  const accessory = makeTestAccessory();
  const host = new TestCameraHost({ accessory, nvr });

  return { accessory, clock, controller, host, logEntries, nvr };
}

// One captured log line from the harness's recording sinks. `parameters` is the raw argument list exactly as the caller passed it, so a media test can read a structured
// object argument straight off it; `formatted` is the single line Homebridge's logger would write, derived by running util.format over those parameters the same way the
// real sink does, so a test asserting on final substituted text reads it rather than reassembling the arguments. `level` is the severity the line was emitted at.
export interface TestLogEntry {

  formatted: string;
  level: "debug" | "error" | "info" | "warn";
  parameters: unknown[];
}

// One recorded MQTT subscription registration: the composed topic tail, the human-readable type label, the registration kind, the per-subscription init options
// production passed (the lifetime signal lives there, so a test can assert which signal scoped each registration and observe it abort with its owner), and the captured
// handler closure. getValue is present on a "get" registration, setValue on a "set" registration; both are captured so a test can FIND a subscription by topic / kind
// and INVOKE its handler directly - the path the production MQTT subscribeGet / subscribeSet handlers take that the HomeKit onSet machinery does not exercise (the
// chime's switch(value) tone dispatch and empty-payload default, the viewer's liveview name lookup and unknown-name error).
export interface TestMqttSubscription {

  getValue?: () => string;
  init?: { signal?: AbortSignal };
  kind: "get" | "set";
  setValue?: (value: string, rawValue: string) => Promise<void> | void;
  topic: string;
  type: string;
}

/* A minimal recording double of the homebridge-plugin-utils MqttClient surface ProtectBase's wrappers and the event dispatcher reach: publish, subscribeGet,
 * subscribeSet, and unsubscribe. Registration-recording, plus handler CAPTURE - delivering a message to a registered handler (and releasing it when its signal
 * aborts) is homebridge-plugin-utils' contract, pinned by its own tests, so the double does not stand up a broker; it captures each handler closure onto the
 * recorded subscription so a test can find it by topic / kind and invoke it directly. That lets a test exercise the plugin's own MQTT-specific dispatch (the
 * chime's switch(value) tone dispatch and empty-payload default, the viewer's liveview name lookup and unknown-name error) - the handler bodies that the
 * HomeKit onSet machinery never reaches. What THIS double proves is the plugin's side of the seam: which subscriptions a device registered, on which topics,
 * carrying which lifetime signal, what each handler does, and what was published.
 */
export class TestMqttClient {

  public readonly published: { message: string; topic: string }[] = [];
  // When set, publish() rejects with this error instead of recording, so a test can drive the guarded-publish failure path. Persistent for the double's per-test
  // lifetime; every test builds a fresh client, so there is no reset machinery.
  public publishRejection: Nullable<Error> = null;
  public readonly subscriptions: TestMqttSubscription[] = [];
  public readonly unsubscribes: { id: string; topic: string }[] = [];

  public async publish(topic: string, message: string): Promise<void> {

    if(this.publishRejection) {

      throw this.publishRejection;
    }

    this.published.push({ message, topic });
  }

  public subscribeGet(topic: string, type: string, getValue: () => string, init?: { signal?: AbortSignal }): void {

    this.subscriptions.push({ getValue, init, kind: "get", topic, type });
  }

  public subscribeSet(topic: string, type: string, setValue: (value: string, rawValue: string) => Promise<void> | void, init?: { signal?: AbortSignal }): void {

    this.subscriptions.push({ init, kind: "set", setValue, topic, type });
  }

  public unsubscribe(id: string, topic: string): void {

    this.unsubscribes.push({ id, topic });
  }
}

// One recorded homebridge API registration call: which registration verb production invoked and the accessories it carried (snapshotted for the update verb, which
// receives the whole live array).
export interface TestApiCall {

  accessories: TestAccessory[];
  kind: "publishExternal" | "register" | "unregister" | "update";
}

// The platform double's honest structural type. The members mirror what ProtectBase and the camera-family construction paths read off nvr.platform: the HAP
// namespaces plus the deterministic uuid generator, the injected wall-clock seam (the recording delegate reads platform.clock for its pacing-time primitives), the
// platform-accessory class and the four registration recorders (the doorbell's configurePackageCamera and the NVR removal tail drive them), the platform's mutable
// accessories array, a concrete codecSupport (the real platform getter throws before the FFmpeg probe - a concrete object with a non-raspbian hostSystem keeps the
// recording-default switch on its default branch), the ProtectOptions-shaped config, the REAL FeatureOptions engine, the log sinks, the recording-process factory seam
// (the recording delegate constructs its FFmpeg process through it), and the streaming-delegate factory seam.
export interface TestProtectPlatform {

  readonly accessories: TestAccessory[];
  readonly api: {

    hap: { Characteristic: typeof Characteristic; Service: typeof Service; uuid: { generate: (seed: string) => string } };
    platformAccessory: typeof TestAccessory;
    publishExternalAccessories: (pluginName: string, accessories: TestAccessory[]) => void;
    registerPlatformAccessories: (pluginName: string, platformName: string, accessories: TestAccessory[]) => void;
    unregisterPlatformAccessories: (pluginName: string, platformName: string, accessories: TestAccessory[]) => void;
    updatePlatformAccessories: (accessories: TestAccessory[]) => void;
  };
  readonly clock: Clock;
  readonly codecSupport: { hostSystem: string };
  readonly config: ProtectOptions;
  readonly debug: (...parameters: unknown[]) => void;
  readonly featureOptions: FeatureOptions;
  readonly log: {

    debug: (...parameters: unknown[]) => void;
    error: (...parameters: unknown[]) => void;
    info: (...parameters: unknown[]) => void;
    warn: (...parameters: unknown[]) => void;
  };
  readonly pluginLog: HomebridgePluginLogging;
  readonly recordingProcessFactory: RecordingProcessFactory;
  readonly streamingDelegateFactory: TestStreamingDelegateFactory;
}

// The options scheduleDeviceRemoval accepts on the NVR double, mirroring the production chokepoint's widened options shape.
export interface TestScheduleDeviceRemovalOptions {

  accessory: TestAccessory;
  reason?: string;
  remove?: () => void;
  stillGone: () => boolean;
}

/* The shared recording event-dispatch double: a REAL ProtectEventDispatch whose motion delivery is overridden to record into an array rather than touch HomeKit or arm a
 * reset timer. The override's arity and parameter types mirror production's motionEventHandler (event-dispatch.ts) exactly, so it type-checks as a true override; the two
 * parameters the recording path deliberately does not read carry the underscore prefix the house no-unused-vars rule reserves for intentionally-unused arguments, and
 * their types still anchor the override against production. Recording arms NO reset timer, so a motion test leaks no handle.
 *
 * This serves every family and base-capability path whose motion routes through the firehose - the light family's lastMotion observer and the base motion trigger / the
 * base motion-set MQTT seam alike - injected through makeTestNvr's dispatch seam and read back off nvr.events. It is the SSOT for that recording shape: the
 * light suite and the device-motion concern net share this one definition rather than each carrying its own near-identical subclass.
 */
export class TestRecordingDispatch extends ProtectEventDispatch {

  public readonly calls: { id: string; kind: string }[] = [];

  public override motionEventHandler(protectDevice: ProtectDevice, _detectedObjects: string[] = [], _metadata?: ProtectEventMetadata): void {

    this.calls.push({ id: protectDevice.protectId, kind: "motion" });
  }
}

/* The NVR double, mirroring each member the camera-family construction and lifecycle paths read. The construction surface comprises the unifi-protect client shape
 * (connection health for isReachable, the controllerName fallback ProtectBase.name uses for controller-scoped owners, the nvr config record behind the ufp
 * read-through, and the store double as client.state), the controller options, the platform double, a REAL un-aborted AbortSignal (composeSignals input and the
 * harness-level teardown lever), and an mqtt that defaults to null (every MQTT wrapper optional-chains into a no-op) or, opt-in, the recording double. The events
 * member is the REAL ProtectEventDispatch, constructed against this double, so event-timer behavior in tests is the production implementation rather than a mirror.
 *
 * The removal machinery mirrors ProtectNvr's stability-gated, graced device removal faithfully but without real timers: removalStable is a mutable gate (defaulting
 * to true so lifecycle tests schedule without ceremony), scheduleDeviceRemoval applies the production gate / idempotency / interval resolution (the interval comes
 * from the REAL FeatureOptions through getFeatureNumber, so the registered DelayDeviceRemoval default governs unless a test overrides it) and either removes
 * immediately or records a manually-fireable timer entry whose fire body is the production fire body (delete, re-check stability and stillGone, remove); the
 * removal tail is the production presence-guarded splice with the bridged-gated unregister recording. Every call is recorded so tests assert decisions, not just
 * outcomes.
 */
export class TestProtectNvr {

  public readonly client: {

    readonly chimes: readonly Chime[];
    connection: { isHealthy: boolean };
    controllerName: string | null;
    readonly liveviews: readonly ProtectNvrLiveviewConfig[];
    nvr: { config: ProtectNvrConfig };
    readonly ringtones: readonly ProtectRingtoneConfig[];
    state: TestStateStore;
  };

  public readonly config: ProtectNvrOptions;
  public readonly events: ProtectEventDispatch;
  public readonly log: {

    debug: (...parameters: unknown[]) => void;
    error: (...parameters: unknown[]) => void;
    info: (...parameters: unknown[]) => void;
    warn: (...parameters: unknown[]) => void;
  };

  public readonly mqtt: Nullable<TestMqttClient>;

  // The NVR lifecycle phase, settable and defaulting to the organic "running" state. The recording delegate reads nvr.phase to suppress its induced-disruption (reboot /
  // shutdown) error logs, so a transmit test that asserts the early-end telemetry log fires needs this to be "running".
  public phase: NvrPhase = "running";
  public readonly platform: TestProtectPlatform;
  public removalStable = true;
  public readonly signal: AbortSignal;

  // The managed-device registry, mirroring ProtectNvr.configuredDevices: a Map keyed by accessory UUID whose values are the constructed device objects. The
  // controller-owner motion fanouts resolve a member camera through it - the security-system fanout reads configuredDevices.get(accessory.UUID)?.protectId, the liveviews
  // fanout reaches it through getDeviceById. A test seeds a minimal member double through the ProtectDevices cast at the construction seam, exactly as the device-class
  // doubles are cast elsewhere. Both fanouts read only a narrow slice of the device (protectId for the security path, accessory / accessoryName for the liveviews path),
  // so the seeded double carries just that slice.
  public readonly configuredDevices = new Map<string, ProtectDevices>();

  // The recorded machinery: every cancelled removal UUID, the pending manually-fireable removal timers keyed by accessory UUID, and every schedule decision with its
  // resolved interval.
  public readonly cancelledRemovals: string[] = [];
  public readonly removalTimers = new Map<string, { fire: () => void }>();
  public readonly scheduledRemovals: { interval: number; options: TestScheduleDeviceRemovalOptions }[] = [];

  // The once-per-option feature log gate, mirroring ProtectNvr.logFeature's featureLog record.
  readonly #featureLog: Record<string, boolean> = {};

  public constructor(init: { client: TestProtectNvr["client"]; config: ProtectNvrOptions; dispatch?: (nvr: ProtectNvr) => ProtectEventDispatch;
    log: TestProtectNvr["log"]; mqtt: Nullable<TestMqttClient>; platform: TestProtectPlatform; signal: AbortSignal; }) {

    this.client = init.client;
    this.config = init.config;
    this.log = init.log;
    this.mqtt = init.mqtt;
    this.platform = init.platform;
    this.signal = init.signal;

    // The real event dispatcher, wired against this double - its constructor reads only the platform's HAP namespace, the log, and the NVR handle itself. The optional
    // dispatch factory is the reusable injection seam: when omitted, the default factory is byte-identical to today's new ProtectEventDispatch(this), so every existing
    // consumer is unchanged; a test injects a recording subclass (overriding motionEventHandler to record without arming the real reset timer) to assert the device
    // observers' firehose routing without leaking a dangling timer handle. The factory runs at exactly the point this.events was assigned before, the last write in
    // the constructor, so nothing reads events before this line either way.
    this.events = (init.dispatch ?? ((nvr: ProtectNvr): ProtectEventDispatch => new ProtectEventDispatch(nvr)))(this as unknown as ProtectNvr);
  }

  // Read-through to the controller record, mirroring the production getter.
  public get ufp(): Readonly<ProtectNvrConfig> {

    return this.client.nvr.config;
  }

  // Cancel every pending delayed removal, mirroring the production all-bets-are-off rule when the controller leaves good-state.
  public cancelAllDeviceRemovals(): void {

    this.removalTimers.clear();
  }

  // Cancel a single pending delayed removal by accessory UUID, recording the cancellation. Idempotent, like production.
  public cancelDeviceRemovalFor(uuid: string): void {

    this.removalTimers.delete(uuid);
    this.cancelledRemovals.push(uuid);
  }

  // The production controller-scoped feature-number read: the REAL FeatureOptions engine resolves the option against the controller MAC, returning the registered
  // default when unconfigured and null when a test's user options disabled it.
  public getFeatureNumber(option: string): Nullable<number | undefined> {

    return this.platform.featureOptions.getInteger(option, this.ufp.mac);
  }

  // Return the managed Protect device whose protectId matches, or null - the production one-liner (nvr.ts), mirrored so the liveviews motion fanout resolves a member
  // camera against the seeded configuredDevices registry as production does. We match on the non-throwing protectId, so a wrapper whose store-backed record has
  // been removed still resolves (and reports unavailable) rather than throwing - the property the recovery policy and firehose lookups depend on.
  public getDeviceById(deviceId: string): Nullable<ProtectDevices> {

    return [...this.configuredDevices.values()].find((device) => device.protectId === deviceId) ?? null;
  }

  // The production controller-scoped feature test, mirrored for any double-side caller that consults controller scope.
  public hasFeature(option: string, device?: { mac?: string }): boolean {

    return this.platform.featureOptions.test(option, device?.mac, this.ufp.mac);
  }

  // Mirror ProtectNvr.logFeature: log a controller- or globally-scoped feature message once per option.
  public logFeature(option: string, message: string): void {

    option = option.toLowerCase();

    if(this.#featureLog[option] || ![ "global", "controller" ].includes(this.platform.featureOptions.scope(option, undefined, this.ufp.mac))) {

      return;
    }

    this.#featureLog[option] = true;
    this.log.info(message);
  }

  // The composition-root construction seams, mirroring production: each constructs the REAL device-family class, faithful to ProtectNvr (the harness already constructs
  // real device objects). The double sits ABOVE the device layer exactly as the real NVR does - it value-imports the device classes - so routing construction through it
  // forms no module-initialization cycle, the property the live attach relies on.
  public createDoorbellCapability(camera: ProtectCamera, device: Camera, signal: AbortSignal): DoorbellCapability {

    return new DoorbellCapability(this as unknown as ProtectNvr, { camera: camera, device: device, signal: signal });
  }

  public createPackageCamera(accessory: ProtectAccessory, device: Camera): ProtectCameraPackage {

    return new ProtectCameraPackage(this as unknown as ProtectNvr, accessory, device);
  }

  // The sweep-stale removal seam, mirroring production: route the camera's request to the REAL DoorbellCapability.removeServices SSOT, with the platform's HAP namespace
  // and the double's log - so suite D exercises the actual removal logic, not a stand-in. The double's structural HAP shape is cast to the production parameter type
  // through unknown, the same confined-cast discipline every other harness seam uses; the log shape already satisfies HomebridgePluginLogging structurally.
  public removeStaleDoorbellServices(accessory: ProtectAccessory): void {

    DoorbellCapability.removeServices(accessory, this.platform.api.hap as unknown as HAP, this.log);
  }

  // The production removal tail, mirrored: a presence guard so a stale double-fire is a no-op (never a splice(-1) corruption), the bridged-gated unregister, the
  // splice, and the cache persist.
  public removeAccessoryFromHomeKit(accessory: TestAccessory): void {

    const index = this.platform.accessories.indexOf(accessory);

    if(index === -1) {

      return;
    }

    if(accessory._associatedHAPAccessory.bridged) {

      this.platform.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    this.platform.accessories.splice(index, 1);
    this.platform.api.updatePlatformAccessories(this.platform.accessories);
  }

  // The production removal chokepoint, mirrored without real timers: gate on stability, dedup per accessory UUID, resolve the grace interval through the real
  // feature-option engine, then either remove immediately (interval disabled) or record a manually-fireable timer entry whose fire body is the production fire body.
  public scheduleDeviceRemoval(options: TestScheduleDeviceRemovalOptions): void {

    const { accessory, reason, stillGone } = options;
    const remove = options.remove ?? ((): void => this.removeAccessoryFromHomeKit(accessory));

    if(!this.removalStable) {

      return;
    }

    if(this.removalTimers.has(accessory.UUID)) {

      return;
    }

    const interval = this.getFeatureNumber("Nvr.DelayDeviceRemoval") ?? 0;

    this.scheduledRemovals.push({ interval, options });

    if(reason) {

      this.log.info(reason);
    }

    if(interval <= 0) {

      remove();

      return;
    }

    this.removalTimers.set(accessory.UUID, { fire: (): void => {

      this.removalTimers.delete(accessory.UUID);

      if(this.removalStable && stillGone()) {

        remove();
      }
    } });
  }
}

/**
 * Build the NVR config record the construction path reads through nvr.ufp: the host (the last fallback in the camera's RTSP host chain), the controller MAC (the
 * feature-option controller scope key, and the chime / ringtone nvrMac filter key), the RTSP(S) ports (the RTSPS port pinned to the fixture value so channel profile
 * URLs match the golden-master corpus), plus the controller-owner read set: a marketName / name / type for setInfo's Model and the system-info accessory's display
 * name, and a populated systemInfo so the nvr-systeminfo owner's initial pass (which dereferences systemInfo.cpu.temperature with no optional chaining) and its
 * MQTT JSON.stringify read meaningfully. The single confined cast seam for the controller record, mirroring makeCameraConfig's discipline.
 *
 * @param options - hardwareRevision: OPT-IN with no default (stays undefined) - the security-system owner writes nvr.ufp.hardwareRevision onto HardwareRevision
 *                  unconditionally, so buildSecuritySystem (in security-system.test.ts) opts a value in to net that write non-vacuously, while the default omission
 *                  keeps ProtectBase.setInfo's HardwareRevision length-guard short-circuited for the device-info concern net; mac: the controller MAC override
 *                  (defaults to "74ACB9FFFFFF"), so a multi-controller test seeds two stores with distinct controller identities and the owners scope their accessories
 *                  apart; marketName / name / type: identity overrides setInfo and the system-info accessory read; temperature: the optional systemInfo.cpu.temperature
 *                  override, so the observer's reactive refresh can be asserted on a known value.
 *
 * @returns an NVR config record the construction path reads as real.
 */
export function makeNvrConfig(options: { doorbellSettings?: ProtectNvrConfig["doorbellSettings"]; hardwareRevision?: string; mac?: string; marketName?: string;
  name?: string; temperature?: number; type?: string; } = {}): ProtectNvrConfig {

  const populated = {

    host: "nvr.test",
    mac: options.mac ?? "74ACB9FFFFFF",
    marketName: options.marketName ?? "UniFi Dream Machine SE",
    name: options.name ?? "Test Controller",
    ports: { rtsp: 7447, rtsps: FIXTURE_RTSPS_PORT },
    systemInfo: {

      cpu: { averageLoad: 12.5, temperature: options.temperature ?? 40 },
      memory: { available: 2048, free: 1024, total: 4096 },
      storage: { available: 500, devices: [], isRecycling: false, size: 1000, type: "hdd", used: 500 }
    },
    type: options.type ?? "UDMPRO",

    // OPT-IN only: the doorbell settings the message-switch net seeds so getMessages sees a truthy source and its builtin-message list. Kept absent by default (the
    // conditional spread keeps the key missing rather than present-as-undefined) so every non-doorbell consumer reads the same shape as before.
    ...(options.doorbellSettings !== undefined ? { doorbellSettings: options.doorbellSettings } : {}),

    // OPT-IN only: when the caller passes a value (the security-system owner does), it lands on the record; otherwise the field stays absent so setInfo's length-guard
    // remains short-circuited and the committed device-info default-omission assertion stays accurate. The conditional spread keeps the key absent rather than
    // present-as-undefined, so an `in` check or a length read sees the same shape as when the option is omitted.
    ...(options.hardwareRevision !== undefined ? { hardwareRevision: options.hardwareRevision } : {})
  };

  return populated as unknown as ProtectNvrConfig;
}

/**
 * Build the NVR / platform double pair for real device construction, returning the double plus its test-side handles. The double is honestly typed as
 * TestProtectNvr; the single cast to ProtectNvr is confined to the construction seam in the test itself, mirroring the reachability suite's discipline - the
 * casts live at the seam, and the instance under test is the production class.
 *
 * @param options - chimes: the HELD chime projection doubles client.chimes exposes (omitted, the empty default), kept as the same instances across every access so the
 *                  doorbell's cross-device setChimeVolume write hits, and a test's updateRejection lever is set on, ONE projection - a per-access rebuild would silently
 *                  break the rejection drive; clock: an optional controllable TestClock installed on the platform double's clock seam and returned so a transmit test can
 *                  advance virtual time to drive the recording delegate's pacing (omitted, a fresh default TestClock seeded at 0 is created); controllerName: the
 *                  controller label (defaults
 *                  to "Test Controller"); dispatch: an optional event-dispatch factory threaded into the NVR double's events seam (omitted, the default builds the real
 *                  ProtectEventDispatch unchanged; a test injects a recording subclass to assert the device observers' firehose routing without arming the real reset
 *                  timer); mqtt: pass true to install the recording MQTT double (the default null makes every MQTT wrapper a no-op, matching an unconfigured broker);
 *                  overrideAddress: the controller-level address override for rtspHost-chain tests; recordingProcessFactory: an optional test recording-process factory
 *                  installed on the platform double's recordingProcessFactory seam (omitted, a fresh default factory is created so the recording delegate constructs its
 *                  FFmpeg process through the test double); sharedPlatform: an optional { accessories, apiCalls } pair captured from a previously built double, so a
 *                  second controller reconciles over the SAME platform accessories array and registration recorder as the first, mirroring production's one shared
 *                  ProtectPlatform - the seam a multi-controller test uses to prove one controller's reconcile leaves the other's switches untouched (omitted, each call
 *                  builds its own fresh accessories array and apiCalls recorder); store: the state-store double backing client.state; userOptions: feature-option config
 *                  strings (the production options array shape, e.g. "Enable.Device.SyncName" or "Disable.Nvr.DelayDeviceRemoval") applied to the REAL FeatureOptions
 *                  engine.
 *
 * @returns apiCalls: every homebridge accessory-registration call the platform double recorded; clock: the controllable TestClock installed on the platform double (the
 *          same instance the recording delegate reads via platform.clock, so a transmit test advances it to release pacing); controller: the AbortController behind
 *          nvr.signal (abort it in suite teardown); factory: the stub streaming-delegate factory; logEntries: every line the construction path logged; mqtt: the
 *          recording MQTT double when requested, else null; nvr: the NVR double.
 */
export function makeTestNvr(options: { chimes?: TestChimeProjection[]; clock?: TestClock; controllerName?: string; dispatch?: (nvr: ProtectNvr) => ProtectEventDispatch;
  doorbellMessages?: ProtectNvrOptions["doorbellMessages"]; doorbellSettings?: ProtectNvrConfig["doorbellSettings"]; mqtt?: boolean; overrideAddress?: string;
  recordingProcessFactory?: RecordingProcessFactory;
  sharedPlatform?: { accessories: TestAccessory[]; apiCalls: TestApiCall[] }; store: TestStateStore; userOptions?: string[]; }):
{ apiCalls: TestApiCall[]; clock: TestClock; controller: AbortController; factory: TestStreamingDelegateFactory; logEntries: TestLogEntry[];
  mqtt: Nullable<TestMqttClient>; nvr: TestProtectNvr; } {

  // Reuse the caller-supplied accessories array and registration recorder when sharing a platform across controllers, so a second controller sees and reconciles over
  // the first's switches; otherwise each call gets its own fresh pair, keeping every existing single-controller call unchanged.
  const accessories = options.sharedPlatform?.accessories ?? [];
  const apiCalls = options.sharedPlatform?.apiCalls ?? [];

  // The HELD chime projection doubles client.chimes returns: the SAME instances captured once here, never a per-access rebuild. The doorbell's setChimeVolume filters
  // client.chimes and calls update() on the matching projection, and a test asserts that projection's updateCalls / sets its updateRejection lever, so they must be
  // one instance. A rebuild getter would hand the write a fresh projection each pass and a test's rejection would go unseen, so the failure drive would pass vacuously.
  const chimes = options.chimes ?? [];
  const clock = options.clock ?? new TestClock();
  const controller = new AbortController();

  // The stable fallback the client.nvr.config getter returns when the store carries no nvr slice, built once so every fallback read is the SAME reference (the existing
  // camera consumers - which never seed the nvr slice - keep reading a fixed record with a stable reference). The doorbell settings the message-switch net seeds ride
  // this fallback, since the camera-family store the doorbell tests build never seeds an nvr slice.
  const defaultNvrConfig = makeNvrConfig(options.doorbellSettings !== undefined ? { doorbellSettings: options.doorbellSettings } : {});
  const factory = new TestStreamingDelegateFactory();
  const logEntries: TestLogEntry[] = [];
  const recordingProcessFactory = options.recordingProcessFactory ?? new TestRecordingProcessFactory();
  const mqtt = options.mqtt ? new TestMqttClient() : null;
  const sink = (level: TestLogEntry["level"]): ((...parameters: unknown[]) => void) => (...parameters: unknown[]): void => {

    // Capture both channels: the raw argument list for media tests that read a structured object argument, and the util.format line the real Homebridge sink would emit.
    logEntries.push({ formatted: util.format(...parameters as [string, ...unknown[]]), level, parameters });
  };
  const log = { debug: sink("debug"), error: sink("error"), info: sink("info"), warn: sink("warn") };
  const client = {

    // The HELD chime projections, exposed as the production client.chimes array the doorbell's setChimeVolume filters by cameraIds and writes through. A plain held
    // property (not a store-rebuild getter like liveviews / ringtones below): the volume write and the test's assertion / rejection lever must see the SAME instance, so
    // the projections are captured once above. Projected to the library's Chime shape through the confined seam cast, exactly as the other client members project.
    chimes: chimes as unknown as Chime[],
    connection: { isHealthy: true },
    controllerName: options.controllerName ?? "Test Controller",

    // The controller-wide liveview collection, read through the store double's CURRENT state, mirroring the production client.liveviews array the viewer reconciles its
    // switches against. A getter (not a held array) closing over options.store so a pushLiveviews changes what the viewer reads, exactly as the live projection does.
    get liveviews(): readonly ProtectNvrLiveviewConfig[] {

      return [...options.store.snapshot().liveviews.values()];
    },

    // The controller record, read THROUGH the store double's CURRENT nvr slice rather than a held value, so nvr.ufp (the production getter reads client.nvr.config) and
    // selectNvr(state) are ONE source: a pushNvrPatch that moves systemInfo by reference changes both at once, which is what lets the nvr-systeminfo owner's observer
    // reaction be asserted non-vacuously. Falls back to the stable default when the store carries no nvr slice, preserving every non-seeding consumer (the sole prior
    // reader, the camera family, never seeds it). Mirrors the liveviews / ringtones store-backed getters above.
    nvr: { get config(): ProtectNvrConfig {

      return options.store.snapshot().nvr ?? defaultNvrConfig;
    } },

    // The controller-wide ringtone collection, read through the store double's CURRENT state, mirroring the production client.ringtones array the chime filters its
    // speaker switches against. A getter closing over options.store so a pushRingtones changes what the chime reads, exactly as the live projection does.
    get ringtones(): readonly ProtectRingtoneConfig[] {

      return [...options.store.snapshot().ringtones.values()];
    },
    state: options.store
  };

  // The homebridge API double: a deterministic, injective uuid generator (a pure function of the seed, so tests can pre-compute cached-accessory UUIDs), the
  // platform-accessory class, and the four registration recorders. The publish / register recorders also maintain the bridged flag, mirroring how standalone
  // publication leaves a real accessory unbridged while bridge registration marks it bridged.
  const api = {

    hap: { Characteristic: Characteristic, Service: Service, uuid: { generate: (seed: string): string => "uuid:" + seed } },
    platformAccessory: TestAccessory,
    publishExternalAccessories: (_pluginName: string, published: TestAccessory[]): void => {

      for(const accessory of published) {

        accessory._associatedHAPAccessory.bridged = false;
      }

      apiCalls.push({ accessories: published, kind: "publishExternal" });
    },
    registerPlatformAccessories: (_pluginName: string, _platformName: string, registered: TestAccessory[]): void => {

      for(const accessory of registered) {

        accessory._associatedHAPAccessory.bridged = true;
      }

      apiCalls.push({ accessories: registered, kind: "register" });
    },
    unregisterPlatformAccessories: (_pluginName: string, _platformName: string, unregistered: TestAccessory[]): void => {

      apiCalls.push({ accessories: unregistered, kind: "unregister" });
    },
    updatePlatformAccessories: (updated: TestAccessory[]): void => {

      apiCalls.push({ accessories: [...updated], kind: "update" });
    }
  };

  const nvr = new TestProtectNvr({

    client: client,
    config: { address: "nvr.test", ...(options.doorbellMessages !== undefined ? { doorbellMessages: options.doorbellMessages } : {}), mqttTopic: "test/protect",
      password: "test-password", username: "test-user", ...(options.overrideAddress !== undefined ? { overrideAddress: options.overrideAddress } : {}) },
    dispatch: options.dispatch,
    log: log,
    mqtt: mqtt,
    platform: {

      accessories: accessories,
      api: api,
      clock: clock,
      codecSupport: { hostSystem: "macOS" },
      config: { controllers: [], debugAll: false, options: [], ringDelay: 0, verboseFfmpeg: false, videoProcessor: "ffmpeg" },
      debug: sink("debug"),
      featureOptions: new FeatureOptions(featureOptionCategories, featureOptions, options.userOptions ?? []),
      log: log,
      pluginLog: log,
      recordingProcessFactory: recordingProcessFactory,
      streamingDelegateFactory: factory
    },
    signal: controller.signal
  });

  return { apiCalls, clock, controller, factory, logEntries, mqtt, nvr };
}

/**
 * Build a pre-linked doorbell-plus-package accessory pair shaped like a bridged restart restore, pushed into the platform double's accessories array. Homebridge
 * restores BRIDGED cached accessories at startup; external (standalone) accessories are never restored, so a standalone package has no restart-shaped fixture -
 * mirroring the production exclusion. The identity values are deliberate fixture literals rather than derivations from the production constants: like the
 * golden-master corpus, they pin what persisted state in the field actually looks like, so a drift in the persistence-critical identity suffix breaks these
 * fixtures loudly instead of silently following along.
 *
 * @param options - mac: the parent doorbell's MAC (defaults to the camera builder's default); name: the parent's display name; nvr: the NVR double whose platform
 *                  accessories array receives the pair.
 *
 * @returns packageAccessory: the cached package camera accessory; parentAccessory: the cached parent doorbell accessory.
 */
export function makeTestAccessoryFamily(options: { mac?: string; name?: string; nvr: TestProtectNvr }):
{ packageAccessory: TestAccessory; parentAccessory: TestAccessory } {

  const mac = options.mac ?? "74ACB9000001";
  const name = options.name ?? "Test Doorbell";
  const parentAccessory = new TestAccessory(name, "uuid:" + mac);

  parentAccessory.context = { mac: mac, nvr: options.nvr.ufp.mac };

  const packageAccessory = new TestAccessory(name + " Package Camera", "uuid:" + mac + ".PackageCamera");

  packageAccessory.context = { nvr: options.nvr.ufp.mac, packageCamera: mac };

  options.nvr.platform.accessories.push(parentAccessory, packageAccessory);

  return { packageAccessory, parentAccessory };
}

/**
 * Settle the asynchronous machinery a construction or push sets in motion: one macrotask tick, which lets every pending microtask chain - the floating configure
 * IIFE, the observe loops' lazy registration, a store wake's drain-and-react - run to quiescence before a test asserts. The store double wakes exclusively
 * through the microtask queue (no timers), so a single setImmediate is a complete settle.
 *
 * @returns a promise that resolves after one macrotask turn.
 */
export async function settle(): Promise<void> {

  await new Promise<void>((resolve) => setImmediate(resolve));
}
