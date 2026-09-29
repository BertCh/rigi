// GPU atlases for the roll drape (./multi-drape-layer.ts), filled one photo at a time.
//
// The layout is fixed up front from the photos' sizes, so a photo's range map, people mask and
// pixels can be written into their cells as soon as each is ready (the drape grows while the rest
// are computed) and nothing is rebuilt or re-uploaded as a whole:
//   - photo atlases (rgba8, mip-mapped): the first ATLAS0_PHOTOS photos at 1024 px cells, the rest
//     spread over up to three more atlases with smaller cells (≤ 768 px), so a 60-photo roll is
//     4096² + 3 × 3072² ≈ 240 MB with mips instead of 60 × 1024² × 4/3 ≈ 340 MB;
//   - one r32f range atlas (the shadow maps, nearest: the shader filters the TEST, not the range);
//   - one r8 people-mask atlas with the range atlas's layout (linear: soft cut-outs).
// Rects are top-left origin: photo rects in atlas uv, range/mask rects in texels.
import type { Device, Texture } from "@luma.gl/core";
import type { ForegroundMask } from "#/lib/segment";

/** Photos in the full-resolution first atlas. */
export const ATLAS0_PHOTOS = 16;
/** Photo atlases the shader binds (sampler count stays well under WebGL2's 16 units). */
export const MAX_PHOTO_ATLASES = 4;
/** Largest atlas side (px): safe on every WebGL2 device and keeps each atlas ≤ 64 MB. */
const MAX_SIDE = 4096;

type Rect = [number, number, number, number];

/** Texels per coarse range cell (per side). */
export const COARSE = 8;

/** A range map max-pooled over COARSE² blocks: the farthest terrain each block sees (0 = sky). */
export type CoarseRange = { width: number; height: number; data: Float32Array };

function coarsen(data: Float32Array, w: number, h: number): CoarseRange {
	const cw = Math.ceil(w / COARSE);
	const ch = Math.ceil(h / COARSE);
	const out = new Float32Array(cw * ch);
	for (let y = 0; y < h; y++) {
		const row = Math.floor(y / COARSE) * cw;
		for (let x = 0; x < w; x++) {
			const v = data[y * w + x];
			const i = row + Math.floor(x / COARSE);
			if (v > out[i]) out[i] = v;
		}
	}
	return { width: cw, height: ch, data: out };
}

export type DrapeCell = {
	/** Which photo atlas (0..3). */
	atlas: number;
	/** Photo rect in its atlas (uv). */
	photo: Rect;
	/** Photo pixel rect in its atlas (for the upload). */
	photoPx: Rect;
	/** Range / mask rect (texels). */
	range: Rect;
};

export type DrapeItem = {
	id: string;
	width: number;
	height: number;
	rangeW: number;
	rangeH: number;
};

/** Cell grid for n items: columns × rows, as square as possible. */
function grid(n: number) {
	const cols = Math.ceil(Math.sqrt(n));
	return { cols, rows: Math.ceil(n / cols) };
}

/** Photo atlas plan: [{ first photo, count, cell px }]. */
export function planAtlases(n: number) {
	const plan: { first: number; count: number; cell: number }[] = [];
	if (!n) return plan;
	plan.push({ first: 0, count: Math.min(n, ATLAS0_PHOTOS), cell: 1024 });
	const rest = n - plan[0].count;
	if (rest <= 0) return plan;
	const m = Math.min(MAX_PHOTO_ATLASES - 1, Math.ceil(rest / ATLAS0_PHOTOS));
	const per = Math.ceil(rest / m);
	const cell = Math.min(768, Math.floor(MAX_SIDE / grid(per).cols));
	for (let i = 0, first = plan[0].count; i < m && first < n; i++, first += per)
		plan.push({ first, count: Math.min(per, n - first), cell });
	return plan;
}

/** Most photos the atlases can hold (512 px cells in the extra atlases). */
export const MAX_PHOTOS =
	ATLAS0_PHOTOS + (MAX_PHOTO_ATLASES - 1) * (MAX_SIDE / 512) ** 2;

export class DrapeAtlas {
	readonly ids: string[];
	readonly cells: DrapeCell[];
	readonly photo: Texture[] = [];
	readonly range: Texture;
	readonly mask: Texture;
	/** Per photo: pixels and range map both written (the photo drapes only then). */
	readonly ready: boolean[];
	private hasPhoto: boolean[];
	private hasRange: boolean[];
	/** Per photo: its range map max-pooled over COARSE × COARSE texel blocks (CPU occlusion cull). */
	readonly coarse: (CoarseRange | null)[];
	/** Bumped on every write (the layer redraws on change). */
	version = 0;
	/** Bumped when a photo becomes ready (the layer rebuilds its per-tile photo lists). */
	readyVersion = 0;
	private destroyed = false;

	constructor(
		private device: Device,
		items: DrapeItem[],
	) {
		this.ids = items.map((i) => i.id);
		this.ready = items.map(() => false);
		this.hasPhoto = items.map(() => false);
		this.hasRange = items.map(() => false);
		this.coarse = items.map(() => null);
		this.cells = [];
		for (const [a, p] of planAtlases(items.length).entries()) {
			const { cols, rows } = grid(p.count);
			const W = cols * p.cell;
			const H = rows * p.cell;
			this.photo.push(
				device.createTexture({
					width: W,
					height: H,
					format: "rgba8unorm",
					mipLevels: device.getMipLevelCount(W, H),
					sampler: {
						minFilter: "linear",
						magFilter: "linear",
						mipmapFilter: "linear",
						addressModeU: "clamp-to-edge",
						addressModeV: "clamp-to-edge",
						maxAnisotropy: 8,
					},
				}),
			);
			for (let j = 0; j < p.count; j++) {
				const it = items[p.first + j];
				const s = p.cell / Math.max(it.width, it.height);
				const w = Math.max(1, Math.round(it.width * s));
				const h = Math.max(1, Math.round(it.height * s));
				const x = (j % cols) * p.cell;
				const y = Math.floor(j / cols) * p.cell;
				this.cells.push({
					atlas: a,
					photo: [x / W, y / H, w / W, h / H],
					photoPx: [x, y, w, h],
					range: [0, 0, 0, 0],
				});
			}
		}
		// range cells: the largest range map, so every one fits unscaled
		const rw = Math.max(1, ...items.map((i) => i.rangeW));
		const rh = Math.max(1, ...items.map((i) => i.rangeH));
		const { cols, rows } = grid(Math.max(1, items.length));
		items.forEach((it, k) => {
			this.cells[k].range = [
				(k % cols) * rw,
				Math.floor(k / cols) * rh,
				it.rangeW,
				it.rangeH,
			];
		});
		const sampler = (f: "nearest" | "linear") =>
			({
				minFilter: f,
				magFilter: f,
				addressModeU: "clamp-to-edge",
				addressModeV: "clamp-to-edge",
			}) as const;
		this.range = device.createTexture({
			width: cols * rw,
			height: rows * rh,
			format: "r32float",
			sampler: sampler("nearest"),
		});
		// cleared to "no person" so photos drape before (or without) their mask
		this.mask = device.createTexture({
			data: new Uint8Array(cols * rw * rows * rh),
			width: cols * rw,
			height: rows * rh,
			format: "r8unorm",
			sampler: sampler("linear"),
		});
	}

	/** Estimated GPU bytes (photo mips counted at 4/3). */
	get bytes() {
		const px = this.photo.reduce((s, t) => s + t.width * t.height, 0);
		return Math.round(
			px * 4 * (4 / 3) + this.range.width * this.range.height * 5,
		);
	}

	/** Scale the photo into its cell (off the main thread) and upload it. */
	async setPhoto(k: number, img: HTMLImageElement | ImageBitmap) {
		const c = this.cells[k];
		if (!c) return;
		const [x, y, w, h] = c.photoPx;
		const bmp = await createImageBitmap(img, {
			resizeWidth: w,
			resizeHeight: h,
			resizeQuality: "high",
		});
		if (this.destroyed) return bmp.close();
		const tex = this.photo[c.atlas];
		tex.copyExternalImage({ image: bmp, x, y, width: w, height: h });
		bmp.close();
		if (this.device.type === "webgl") tex.generateMipmapsWebGL();
		this.hasPhoto[k] = true;
		this.markReady(k);
	}

	/** The photo's range map (row 0 = top, 0 = sky), sized rangeW × rangeH. */
	setRange(k: number, data: Float32Array) {
		if (this.destroyed || !this.cells[k]) return;
		const [x, y, w, h] = this.cells[k].range;
		this.range.writeData(data, { x, y, width: w, height: h });
		this.coarse[k] = coarsen(data, w, h);
		this.hasRange[k] = true;
		this.markReady(k);
	}

	private markReady(k: number) {
		const was = this.ready[k];
		this.ready[k] = this.hasPhoto[k] && this.hasRange[k];
		if (this.ready[k] !== was) this.readyVersion++;
		this.version++;
	}

	/** People mask (any size, row 0 = top), resampled bilinearly into the range cell. */
	setMask(k: number, fg: ForegroundMask | null) {
		if (this.destroyed || !this.cells[k]) return;
		const [x, y, w, h] = this.cells[k].range;
		const out = new Uint8Array(w * h);
		if (fg) {
			for (let j = 0; j < h; j++) {
				const fy = Math.min(
					Math.max(((j + 0.5) / h) * fg.height - 0.5, 0),
					fg.height - 1,
				);
				const y0 = Math.floor(fy);
				const y1 = Math.min(y0 + 1, fg.height - 1);
				const ty = fy - y0;
				for (let i = 0; i < w; i++) {
					const fx = Math.min(
						Math.max(((i + 0.5) / w) * fg.width - 0.5, 0),
						fg.width - 1,
					);
					const x0 = Math.floor(fx);
					const x1 = Math.min(x0 + 1, fg.width - 1);
					const tx = fx - x0;
					const d = fg.data;
					const a =
						d[y0 * fg.width + x0] * (1 - tx) + d[y0 * fg.width + x1] * tx;
					const b =
						d[y1 * fg.width + x0] * (1 - tx) + d[y1 * fg.width + x1] * tx;
					out[j * w + i] = Math.round(a * (1 - ty) + b * ty);
				}
			}
		}
		this.mask.writeData(out, { x, y, width: w, height: h });
		this.version++;
	}

	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		for (const t of this.photo) t.destroy();
		this.range.destroy();
		this.mask.destroy();
	}
}
