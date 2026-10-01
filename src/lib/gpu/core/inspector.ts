// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// One upstream GPUCommandGraphInspector per device (WAG W0.2), created on first use and dropped with
// the device. Nothing here runs by default: a ComputeGraph is observed only when profiling is on
// (`__RIGI_GPU_PROFILE__`, core/profile.ts) when it encodes, or when a caller asks for the graph
// inspection (core/inspect.ts inspectGraphs, the /dev/graph page). An observed graph encodes through
// the observation handle, which calls the very same CompiledGPUCommandGraph.encode and then records
// the CPU encode times: the recorded commands are unchanged. GPU timings are recorded only for runs
// that read them anyway (timed / profiled ComputeGraph.run), from that same single timestamp read.
//
// Imports only luma.ts, lifecycle.ts and profile.ts; it hands profile.ts its snapshot source
// (getGpuGraphProfile), so profile.ts itself stays free of luma runtime imports.
import type { Device } from "@luma.gl/core";
import { onLost } from "./lifecycle";
import {
	type CompiledGPUCommandGraph,
	GPUCommandGraphInspector,
	type GPUCommandGraphInspectorObservation,
	type GPUCommandGraphInspectorSnapshot,
} from "./luma";
import { setGraphSnapshotSource } from "./profile";

/** Retained samples per duration (upstream default 120: about two seconds of frames). */
const MAX_SAMPLES = 120;

const inspectors = new WeakMap<Device, GPUCommandGraphInspector>();
/** devices with an inspector, for snapshots without a device (weak: never keeps one alive) */
const inspectorDevices = new Set<WeakRef<Device>>();

/** The inspector of `device` (created on first use, dropped when the device is lost). */
export function deviceInspector(device: Device): GPUCommandGraphInspector {
	let inspector = inspectors.get(device);
	if (!inspector) {
		const created = new GPUCommandGraphInspector({ maxSamples: MAX_SAMPLES });
		inspector = created;
		inspectors.set(device, created);
		const ref = new WeakRef(device);
		inspectorDevices.add(ref);
		onLost(device, () => {
			created.clear();
			inspectors.delete(device);
			inspectorDevices.delete(ref);
		});
	}
	return inspector;
}

/**
 * Start observing a compiled graph on its device's inspector. Re-observing an id replaces the older
 * registration (upstream semantics: its handle then stops recording), which is what a cachedGraph
 * rebuilt after an eviction needs.
 */
export function observeCompiledGraph<P>(
	compiled: CompiledGPUCommandGraph<P>,
): GPUCommandGraphInspectorObservation<P> {
	return deviceInspector(compiled.device).observeGraph<P>(compiled);
}

/** One device's inspector snapshot. */
export type DeviceInspectorSnapshot = {
	device: Device;
	snapshot: GPUCommandGraphInspectorSnapshot;
};

/**
 * Snapshots of `device`'s inspector (every device with one when omitted). Empty when nothing was
 * observed: this never creates an inspector.
 */
export function inspectorSnapshots(device?: Device): DeviceInspectorSnapshot[] {
	const devices: Device[] = [];
	if (device) devices.push(device);
	else
		for (const ref of inspectorDevices) {
			const d = ref.deref();
			if (d) devices.push(d);
			else inspectorDevices.delete(ref);
		}
	const out: DeviceInspectorSnapshot[] = [];
	for (const d of devices) {
		const inspector = inspectors.get(d);
		if (inspector) out.push({ device: d, snapshot: inspector.getSnapshot() });
	}
	return out;
}

setGraphSnapshotSource(() => inspectorSnapshots());
