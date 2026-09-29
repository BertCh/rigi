// Small helpers over luma.gl's stable compute API for the look kernels: one pipeline per WGSL
// entry point (explicit shader layout, cached per device), storage / uniform buffers, one compute
// pass per dispatch, and a readback through our own MAP_READ staging buffer (so luma does not make
// a temporary one per read).
import {
	type BindingDeclaration,
	Buffer,
	type CommandEncoder,
	type ComputePipeline,
	type Device,
} from "@luma.gl/core";

export type BindKind = "uniform" | "storage" | "read-only-storage";

export type Kernel = { pipeline: ComputePipeline; names: string[] };

const cache = new WeakMap<Device, Map<string, Kernel>>();

/** A kernel's WGSL and binding layout; defineKernel registers it for warmKernels. */
export type KernelSpec = {
	id: string;
	source: string;
	layout: [string, BindKind][];
};

const specs: KernelSpec[] = [];

/**
 * Declare a kernel at module level: `source`'s `main`, binding `layout` (name → kind) at group 0,
 * locations in order. `source` must declare exactly those bindings, `@group(0) @binding(i)`, in the
 * same order.
 */
export function defineKernel(
	id: string,
	source: string,
	layout: [string, BindKind][],
): KernelSpec {
	const spec = { id, source, layout };
	specs.push(spec);
	return spec;
}

/** The pipeline of a defined kernel, created on first use and cached per device. */
export function kernel(device: Device, spec: KernelSpec): Kernel {
	let m = cache.get(device);
	if (!m) {
		m = new Map();
		cache.set(device, m);
	}
	let k = m.get(spec.id);
	if (!k) {
		const shader = device.createShader({
			id: `look-${spec.id}`,
			source: spec.source,
			language: "wgsl",
			stage: "compute",
		});
		const pipeline = device.createComputePipeline({
			id: `look-${spec.id}`,
			shader,
			entryPoint: "main",
			shaderLayout: {
				bindings: spec.layout.map(
					([name, type], location): BindingDeclaration =>
						// the ternary narrows `type` for BindingDeclaration's union
						type === "uniform"
							? { name, type, group: 0, location }
							: { name, type, group: 0, location },
				),
			},
		});
		k = { pipeline, names: spec.layout.map(([n]) => n) };
		m.set(spec.id, k);
	}
	return k;
}

/**
 * Create the pipeline of every kernel defined so far (import the kernel modules first), so the
 * first look pass does not pay the WGSL compile. Returns how many failed; never throws.
 */
export function warmKernels(device: Device): number {
	let failed = 0;
	for (const spec of specs)
		try {
			kernel(device, spec);
		} catch (e) {
			failed++;
			console.warn(`[lookgpu] ${spec.id} compile failed`, e);
		}
	return failed;
}

/** A storage buffer (COPY_SRC | COPY_DST too), initialised from `data` or zeroed to `bytes`. */
export function storage(
	device: Device,
	data: ArrayBufferView | number,
): Buffer {
	const usage = Buffer.STORAGE | Buffer.COPY_DST | Buffer.COPY_SRC;
	if (typeof data === "number")
		return device.createBuffer({
			usage,
			byteLength: Math.max(16, Math.ceil(data / 4) * 4),
		});
	// WebGPU wants 4-byte multiples: pad byte arrays
	if (data.byteLength % 4) {
		const p = new Uint8Array(Math.ceil(data.byteLength / 4) * 4);
		p.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
		return device.createBuffer({ usage, data: p });
	}
	return device.createBuffer({ usage, data });
}

/** A uniform buffer from 32-bit words (f32 / i32 / u32 views over one ArrayBuffer), padded to 16 bytes. */
export function uniform(device: Device, words: ArrayBuffer): Buffer {
	const n = Math.max(16, Math.ceil(words.byteLength / 16) * 16);
	const d = new Uint8Array(n);
	d.set(new Uint8Array(words));
	return device.createBuffer({
		usage: Buffer.UNIFORM | Buffer.COPY_DST,
		data: d,
	});
}

/** Record one compute pass: `k` with `bindings`, dispatching `x × y × z` workgroups. */
export function dispatch(
	enc: CommandEncoder,
	k: Kernel,
	bindings: Record<string, Buffer>,
	x: number,
	y = 1,
	z = 1,
) {
	k.pipeline.setBindings(bindings);
	const pass = enc.beginComputePass({});
	pass.setPipeline(k.pipeline);
	pass.dispatch(x, y, z);
	pass.end();
}

/** Record a copy of `src` into a fresh MAP_READ buffer; call `.read()` after submitting. */
export function stage(
	device: Device,
	enc: CommandEncoder,
	src: Buffer,
	bytes: number,
) {
	const size = Math.ceil(bytes / 4) * 4;
	const dst = device.createBuffer({
		usage: Buffer.MAP_READ | Buffer.COPY_DST,
		byteLength: size,
	});
	enc.copyBufferToBuffer({
		sourceBuffer: src,
		destinationBuffer: dst,
		size,
	});
	return {
		read: async () => {
			try {
				const u8 = await dst.readAsync(0, size);
				return u8.buffer.slice(u8.byteOffset, u8.byteOffset + bytes);
			} finally {
				dst.destroy();
			}
		},
	};
}

/** Destroy buffers (after the reads resolved). */
export function release(...bufs: (Buffer | null | undefined)[]) {
	for (const b of bufs) b?.destroy();
}
