// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// A fake luma Device for the memory specs: counts createBuffer / destroy and has a controllable `lost`.
import type { Buffer, Device } from "@luma.gl/core";

export class FakeBuffer {
	destroyed = false;
	byteLength: number;
	id: string;
	usage: number;
	constructor(props: { id: string; byteLength: number; usage: number }) {
		this.byteLength = props.byteLength;
		this.id = props.id;
		this.usage = props.usage;
	}
	write() {}
	destroy() {
		this.destroyed = true;
	}
}

export function fakeDevice() {
	const created: FakeBuffer[] = [];
	let resolveLost!: (v: unknown) => void;
	const lost = new Promise<unknown>((r) => {
		resolveLost = r;
	});
	const device = {
		isLost: false,
		lost,
		type: "webgpu",
		createBuffer: (p: { id: string; byteLength: number; usage: number }) => {
			const b = new FakeBuffer(p);
			created.push(b);
			return b;
		},
	} as unknown as Device;
	return {
		device,
		created,
		/** lose the device and let the onLost hooks run */
		async lose() {
			(device as { isLost: boolean }).isLost = true;
			resolveLost({ reason: "destroyed" });
			await lost;
			await Promise.resolve();
		},
	};
}

export const asBuffer = (b: FakeBuffer) => b as unknown as Buffer;
