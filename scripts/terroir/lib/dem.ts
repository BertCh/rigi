// AWS Terrarium DEM sampler (z12, bilinear), with a disk cache. height = R*256 + G + B/256 - 32768.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng, type Raster } from "./png";

const Z = 12;
export class Dem {
	private tiles = new Map<string, Raster | null>();
	constructor(private cacheDir: string) {
		mkdirSync(join(cacheDir, "terrarium"), { recursive: true });
	}

	private async tile(x: number, y: number): Promise<Raster | null> {
		const key = `${x}_${y}`;
		const hit = this.tiles.get(key);
		if (hit !== undefined) return hit;
		const f = join(this.cacheDir, "terrarium", `${Z}_${key}.png`);
		let buf: Buffer | null = null;
		if (existsSync(f)) buf = readFileSync(f);
		else {
			const r = await fetch(
				`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`,
			);
			if (r.ok) {
				buf = Buffer.from(await r.arrayBuffer());
				writeFileSync(f, buf);
			}
		}
		const t = buf ? decodePng(buf) : null;
		this.tiles.set(key, t);
		return t;
	}
	/** Prefetch every tile covering a bbox. */
	async prefetch(bbox: [number, number, number, number]) {
		const [x0, y1] = this.tileXY(bbox[1], bbox[0]);
		const [x1, y0] = this.tileXY(bbox[3], bbox[2]);
		const jobs: Promise<unknown>[] = [];
		for (let x = Math.floor(x0); x <= Math.floor(x1); x++)
			for (let y = Math.floor(y0); y <= Math.floor(y1); y++) {
				jobs.push(this.tile(x, y));
				if (jobs.length >= 8) {
					await Promise.all(jobs);
					jobs.length = 0;
				}
			}
		await Promise.all(jobs);
	}
	private tileXY(lat: number, lon: number): [number, number] {
		const n = 2 ** Z;
		const s = Math.sin((lat * Math.PI) / 180);
		return [
			((lon + 180) / 360) * n,
			(0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n,
		];
	}
	/** Sync after prefetch; returns null where no tile. */
	sample(lat: number, lon: number): number | null {
		const [fx, fy] = this.tileXY(lat, lon);
		const px = (fx - Math.floor(fx)) * 256 - 0.5,
			py = (fy - Math.floor(fy)) * 256 - 0.5;
		const at = (gx: number, gy: number) => {
			const tx = Math.floor(fx) + Math.floor(gx / 256),
				ty = Math.floor(fy) + Math.floor(gy / 256);
			const t = this.tiles.get(`${tx}_${ty}`);
			if (!t) return NaN;
			const lx = ((gx % 256) + 256) % 256,
				ly = ((gy % 256) + 256) % 256;
			const i = (ly * 256 + lx) * t.channels;
			return t.data[i] * 256 + t.data[i + 1] + t.data[i + 2] / 256 - 32768;
		};
		const x0 = Math.floor(px),
			y0 = Math.floor(py),
			ax = px - x0,
			ay = py - y0;
		const v =
			(at(x0, y0) * (1 - ax) + at(x0 + 1, y0) * ax) * (1 - ay) +
			(at(x0, y0 + 1) * (1 - ax) + at(x0 + 1, y0 + 1) * ax) * ay;
		return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
	}
}
