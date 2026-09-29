// Synthetic check for fitHaze: render a fake scene with known J, A, β, recover them.
// Run: npx tsx src/lib/look/__tests__/haze-fit.test.ts   (exits 1 on failure)
import {
	ATM_CURV,
	atmPath,
	BETA_M0,
	BETA_R0,
	H_R,
	type Vec3,
} from "../atmosphere";
import { fitHaze } from "../haze-fit";

const W = 400;
const H = 300;
const EYE = 1900;
const A: Vec3 = [0.62, 0.7, 0.82];

// deterministic PRNG
let seed = 12345;
const rnd = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 4294967296;
};

const enc = (c: number) => {
	const v = Math.max(0, Math.min(1, c));
	return Math.round(
		255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055),
	);
};

type Model = (d: number, h: number) => Vec3; // transmittance for range d to altitude h

/**
 * Sky above row 60, then terrain whose range falls log-linearly from 140 km at the skyline to
 * 250 m at the bottom; altitude varies with a slow pattern. Photo at 2× the geo resolution.
 */
function makeScene(model: Model, occluder = false) {
	const geo = new Float32Array(W * H * 4);
	const PW = W * 2;
	const PH = H * 2;
	const photo = {
		width: PW,
		height: PH,
		data: new Uint8ClampedArray(PW * PH * 4),
	};
	const sky = 60;
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			let col: Vec3;
			const gi = ((H - 1 - y) * W + x) * 4;
			if (y < sky) {
				col = [
					A[0] * (1 + (rnd() - 0.5) * 0.02),
					A[1] * (1 + (rnd() - 0.5) * 0.02),
					A[2] * (1 + (rnd() - 0.5) * 0.02),
				];
			} else {
				const f = (y - sky) / (H - 1 - sky);
				const d = Math.exp(
					Math.log(140000) + f * (Math.log(250) - Math.log(140000)),
				);
				const az = ((x / W - 0.5) * 60 * Math.PI) / 180;
				const h =
					1400 + 400 * Math.sin(x * 0.05) * Math.cos(y * 0.07) - 500 * f;
				const px = d * Math.sin(az);
				const py = d * Math.cos(az);
				geo[gi] = px;
				geo[gi + 1] = py;
				geo[gi + 2] = h - (px * px + py * py) * ATM_CURV;
				geo[gi + 3] = d;
				// albedo: greyish with some colour, uniform in [0.03, 0.4]
				const g = 0.03 + rnd() * 0.37;
				const J: Vec3 = [g * (0.95 + rnd() * 0.1), g, g * (0.9 + rnd() * 0.1)];
				const t = model(d, h);
				col = [0, 1, 2].map((c) => J[c] * t[c] + A[c] * (1 - t[c])) as Vec3;
				// an unmodelled saturated-blue sign in front of the 1–5 km terrain (like IMG_7155's
				// panorama board): dark red, bright blue
				if (occluder && x > 40 && x < 200 && d > 1000 && d < 5000)
					col = [0.01, 0.2, 0.9];
			}
			for (let yy = 0; yy < 2; yy++)
				for (let xx = 0; xx < 2; xx++) {
					const k = ((y * 2 + yy) * PW + x * 2 + xx) * 4;
					photo.data[k] = enc(col[0]);
					photo.data[k + 1] = enc(col[1]);
					photo.data[k + 2] = enc(col[2]);
					photo.data[k + 3] = 255;
				}
		}
	return { photo, geo };
}

let failed = 0;
const check = (name: string, got: number, want: number, tol = 0.1) => {
	const rel = Math.abs(got - want) / Math.abs(want);
	const ok = rel <= tol;
	if (!ok) failed++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name.padEnd(22)} got ${got.toPrecision(4).padStart(10)}  want ${want.toPrecision(4).padStart(10)}  (${(rel * 100).toFixed(1)}%)`,
	);
};

const checkAbs = (name: string, got: number, want: number, tol: number) => {
	const ok = Math.abs(got - want) <= tol;
	if (!ok) failed++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name.padEnd(22)} got ${got.toFixed(4).padStart(10)}  want ${want.toFixed(4).padStart(10)}  (±${tol})`,
	);
};

// 1. constant per-channel β (plain Koschmieder on range)
{
	const beta: Vec3 = [3.0e-5, 4.0e-5, 6.0e-5];
	const { photo, geo } = makeScene((d) => [
		Math.exp(-beta[0] * d),
		Math.exp(-beta[1] * d),
		Math.exp(-beta[2] * d),
	]);
	const t0 = performance.now();
	const f = fitHaze({
		photo,
		geo: { kind: "xyzr", data: geo },
		geoW: W,
		geoH: H,
		eyeAlt: EYE,
	});
	console.log(
		`\n[constant β] ${(performance.now() - t0).toFixed(0)} ms, ${f.samples.length} bins, quality ${f.quality.toFixed(2)}`,
	);
	for (let c = 0; c < 3; c++) check(`A[${"rgb"[c]}]`, f.airlight[c], A[c]);
	for (let c = 0; c < 3; c++) check(`beta[${"rgb"[c]}]`, f.beta[c], beta[c]);
	// dark objects: 5th percentile of uniform[0.03, 0.4]
	check(
		"J0 (grey)",
		(f.j0[0] + f.j0[1] + f.j0[2]) / 3,
		0.03 + 0.05 * 0.37,
		0.35,
	);
}

let physScene: ReturnType<typeof makeScene> | undefined;

// 2. physical, altitude-aware model (what the shader renders)
{
	const kR = 2.5;
	const bM = 4e-4;
	const hM = 1200;
	const model: Model = (d, h) => {
		const pR = atmPath(EYE, h, d, H_R);
		const pM = atmPath(EYE, h, d, hM);
		return [0, 1, 2].map((c) =>
			Math.exp(-kR * BETA_R0[c] * pR - bM * pM),
		) as Vec3;
	};
	const { photo, geo } = makeScene(model);
	physScene = { photo, geo };
	const t0 = performance.now();
	const f = fitHaze({
		photo,
		geo: { kind: "xyzr", data: geo },
		geoW: W,
		geoH: H,
		eyeAlt: EYE,
	});
	console.log(
		`\n[physical] ${(performance.now() - t0).toFixed(0)} ms, ${f.samples.length} bins, quality ${f.quality.toFixed(2)}, hM ${f.hM}`,
	);
	if (process.env.DEBUG)
		for (const s of f.samples)
			console.log(
				`  ${(s.range / 1000).toFixed(2).padStart(7)} km n=${s.n} low ${s.low.map((v) => v.toFixed(4))} fit ${s.fit.map((v) => v.toFixed(4))}`,
			);
	check("rayleighScale", f.rayleighScale, kR);
	check("betaM", f.betaM, bM);
	check("mieScale", f.mieScale, bM / BETA_M0);
	check("hM", f.hM, hM, 0.01);
	for (let c = 0; c < 3; c++) check(`A[${"rgb"[c]}]`, f.airlight[c], A[c]);
	// the physical fit must reproduce the synthetic optical depth at a few test points
	for (const [d, h] of [
		[3000, 1200],
		[20000, 1500],
		[60000, 2000],
	]) {
		const want = model(d, h);
		const pR = atmPath(EYE, h, d, f.hR);
		const pM = atmPath(EYE, h, d, f.hM);
		const got = f.betaR[1] * pR + f.betaM * pM;
		check(`tau_g(${d / 1000} km)`, got, -Math.log(want[1]));
	}
}

// 3. same physical scene with an unmodelled saturated occluder: the robust fit must shrug it off
//    (checked on transmittance: τ itself is poorly constrained once T is a few percent)
{
	const kR = 1.5;
	const bM = 2e-4;
	const model: Model = (d, h) => {
		const pR = atmPath(EYE, h, d, H_R);
		const pM = atmPath(EYE, h, d, 1200);
		return [0, 1, 2].map((c) =>
			Math.exp(-kR * BETA_R0[c] * pR - bM * pM),
		) as Vec3;
	};
	const { photo, geo } = makeScene(model, true);
	const f = fitHaze({
		photo,
		geo: { kind: "xyzr", data: geo },
		geoW: W,
		geoH: H,
		eyeAlt: EYE,
	});
	console.log(
		`\n[occluder] ${f.samples.length} bins, quality ${f.quality.toFixed(2)}, hM ${f.hM}`,
	);
	for (const [d, h] of [
		[3000, 1200],
		[20000, 1500],
		[60000, 2000],
	]) {
		const want = model(d, h);
		for (const c of [1, 2]) {
			const got = Math.exp(
				-f.betaR[c] * atmPath(EYE, h, d, f.hR) -
					f.betaM * atmPath(EYE, h, d, f.hM),
			);
			checkAbs(`T_${"rgb"[c]}(${d / 1000} km)`, got, want[c], 0.03);
		}
	}
}

// 4. range-only input (deck's r32f buffer + a ray function) gives the same fit as xyzr
{
	const { photo, geo } = physScene as ReturnType<typeof makeScene>;
	const range = new Float32Array(W * H);
	for (let i = 0; i < W * H; i++) range[i] = geo[i * 4 + 3];
	const ray = (x: number, y: number): Vec3 => {
		const g = (y * W + x) * 4;
		const r = geo[g + 3] || 1;
		return [geo[g] / r, geo[g + 1] / r, (geo[g + 2] - EYE) / r];
	};
	const a = fitHaze({
		photo,
		geo: { kind: "xyzr", data: geo },
		geoW: W,
		geoH: H,
		eyeAlt: EYE,
	});
	const b = fitHaze({
		photo,
		geo: { kind: "range", data: range, ray },
		geoW: W,
		geoH: H,
		eyeAlt: EYE,
	});
	console.log("\n[range-only]");
	check("rayleighScale", b.rayleighScale, a.rayleighScale, 1e-4);
	check("betaM", b.betaM, a.betaM, 1e-4);
	check("A[g]", b.airlight[1], a.airlight[1], 1e-6);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
