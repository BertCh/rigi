// Dev-only visual test bench for the Step Inside splat renderer (src/lib/nearfield/three-splats.ts).
// A synthetic cloud (coloured ellipsoid blobs, a ground plane of flat splats, a ring of needle splats and
// a far blob behind a ridge) over a large terrain mesh drawn with logarithmicDepthBuffer, so occlusion in
// both directions is visible. Query: ?n=200000&logdepth=1&truth=0&aa=1. A .splat-v1 or 3DGS .ply can be
// loaded from the file input. Playwright hook: window.__splatLab (scripts/nearfield/splat-lab-check.mjs).
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { decodeGaussianPly, decodeSplatV1 } from "#/lib/nearfield/splat-io";
import { ThreeSplats } from "#/lib/nearfield/three-splats";
import { type GaussianCloud, PROVENANCE_CODE } from "#/lib/nearfield/types";

type LabSearch = { n?: number; logdepth?: number; truth?: number; aa?: number };

export const Route = createFileRoute("/lab/splats")({
	validateSearch: (s: Record<string, unknown>): LabSearch => {
		const num = (v: unknown) =>
			v === undefined || v === "" ? undefined : Number(v);
		return {
			n: num(s.n),
			logdepth: num(s.logdepth),
			truth: num(s.truth),
			aa: num(s.aa),
		};
	},
	head: () => ({ meta: [{ title: "Splat lab" }] }),
	component: SplatLab,
});

// ---- synthetic scene (Y up, metres) ----

function mulberry32(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const hillY = (x: number, z: number) =>
	1.6 * Math.exp(-((x - 6) ** 2 + (z + 2) ** 2) / 5) - 0.3;
function terrainY(x: number, z: number): number {
	const r = Math.hypot(x, z);
	const ridge =
		260 *
		Math.exp(-(((z + 1000) / 150) ** 2)) *
		(0.75 + 0.25 * Math.sin(x / 140));
	const far =
		Math.max(0, r - 500) *
		0.18 *
		(0.6 + 0.4 * Math.sin(x / 300) * Math.cos(z / 260));
	return hillY(x, z) + ridge + far;
}

export function makeSyntheticCloud(n: number, seed = 7): GaussianCloud {
	const rnd = mulberry32(seed);
	const gauss = () => {
		const u = Math.max(rnd(), 1e-9);
		return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
	};
	const positions = new Float32Array(3 * n);
	const scales = new Float32Array(3 * n);
	const rotations = new Float32Array(4 * n);
	const colors = new Uint8Array(4 * n);
	const provenance = new Uint8Array(n);
	const put = (
		i: number,
		p: [number, number, number],
		s: [number, number, number],
		q: [number, number, number, number],
		c: [number, number, number, number],
		prov: number,
	) => {
		positions.set(p, 3 * i);
		scales.set(s, 3 * i);
		rotations.set(q, 4 * i);
		colors.set(
			c.map((v) => Math.max(0, Math.min(255, Math.round(v)))),
			4 * i,
		);
		provenance[i] = prov;
	};
	const randQuat = (): [number, number, number, number] => {
		const q = [gauss(), gauss(), gauss(), gauss()];
		const l = Math.hypot(...q);
		return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
	};
	const blobs: {
		c: [number, number, number];
		r: [number, number, number];
		col: number[];
		prov: number;
	}[] = [
		{
			c: [-4, 1.2, 0],
			r: [1, 1.2, 0.8],
			col: [230, 60, 50],
			prov: PROVENANCE_CODE.observed,
		},
		{
			c: [0, 1.5, -1],
			r: [0.8, 1.5, 0.8],
			col: [250, 200, 40],
			prov: PROVENANCE_CODE.observed,
		},
		{
			c: [4.5, 1, 0],
			r: [1.2, 1, 1],
			col: [60, 120, 240],
			prov: PROVENANCE_CODE.reconstructed,
		},
		{
			c: [2, 2.5, -5],
			r: [1.5, 0.6, 0.6],
			col: [180, 80, 220],
			prov: PROVENANCE_CODE.generated,
		},
		{
			c: [-3, 0.8, 4],
			r: [0.6, 0.8, 0.6],
			col: [40, 200, 160],
			prov: PROVENANCE_CODE.reconstructed,
		},
	];
	const nFar = Math.min(20000, Math.floor(n * 0.03));
	const nNeedle = Math.floor(n * 0.07);
	const nPlane = Math.floor(n * 0.4);
	const nBlob = n - nFar - nNeedle - nPlane;
	// same scene at any n: blob splats shrink as n grows (like a finer 3DGS fit), 1 at 200k
	const blobScale = Math.cbrt(200000 / Math.max(n, 1));
	let i = 0;
	// ground plane of flat splats with a checker tint (flat along y)
	const side = Math.ceil(Math.sqrt(nPlane));
	const cell = 24 / side;
	for (let k = 0; k < nPlane; k++, i++) {
		const gx = k % side;
		const gz = Math.floor(k / side);
		const x = -12 + (gx + 0.5) * cell;
		const z = -12 + (gz + 0.5) * cell;
		const chk = (Math.floor(x / 2) + Math.floor(z / 2)) & 1;
		const base = chk ? [200, 190, 170] : [110, 130, 90];
		put(
			i,
			[x, 0, z],
			[cell * 0.7, 0.002, cell * 0.7],
			[1, 0, 0, 0],
			[
				base[0] + 20 * gauss(),
				base[1] + 20 * gauss(),
				base[2] + 20 * gauss(),
				255,
			],
			PROVENANCE_CODE.reconstructed,
		);
	}
	// ellipsoid blobs of small splats
	for (let k = 0; k < nBlob; k++, i++) {
		const b = blobs[k % blobs.length];
		let dx: number;
		let dy: number;
		let dz: number;
		do {
			dx = 2 * rnd() - 1;
			dy = 2 * rnd() - 1;
			dz = 2 * rnd() - 1;
		} while (dx * dx + dy * dy + dz * dz > 1);
		const shade = 0.6 + 0.4 * (dy * 0.5 + 0.5);
		const s = (0.03 + 0.04 * rnd()) * blobScale;
		put(
			i,
			[b.c[0] + dx * b.r[0], b.c[1] + dy * b.r[1], b.c[2] + dz * b.r[2]],
			[s, s * (0.5 + rnd()), s * (0.5 + rnd())],
			randQuat(),
			[b.col[0] * shade, b.col[1] * shade, b.col[2] * shade, 120 + 100 * rnd()],
			b.prov,
		);
	}
	// torus of elongated needles tangent to the ring: shows anisotropic ellipse shapes
	for (let k = 0; k < nNeedle; k++, i++) {
		const t = (2 * Math.PI * k) / nNeedle;
		const ph = 2 * Math.PI * rnd();
		const R = 2.2;
		const r = 0.25 * Math.sqrt(rnd());
		const x = (R + r * Math.cos(ph)) * Math.cos(t);
		const y = 4 + r * Math.sin(ph);
		const zz = (R + r * Math.cos(ph)) * Math.sin(t) - 3;
		// rotate local x onto the ring tangent (-sin t, 0, cos t): rotation about +y by -(t + pi/2)
		const a = -(t + Math.PI / 2) / 2;
		put(
			i,
			[x, y, zz],
			[0.25, 0.015, 0.015],
			[Math.cos(a), 0, Math.sin(a), 0],
			[255, 140 + 100 * Math.cos(3 * t), 40, 230],
			PROVENANCE_CODE.observed,
		);
	}
	// a far blob behind the ridge at z=-1000 (half hidden by the terrain)
	for (let k = 0; k < nFar; k++, i++) {
		const d = [gauss(), gauss(), gauss()];
		put(
			i,
			[d[0] * 90, 420 + d[1] * 90, -1600 + d[2] * 60],
			[9, 9, 9],
			[1, 0, 0, 0],
			[240, 240, 255, 200],
			PROVENANCE_CODE.generated,
		);
	}
	return {
		count: n,
		frame: "enu",
		positions,
		scales,
		rotations,
		colors,
		provenance,
	};
}

function makeTerrain(): THREE.Mesh {
	const g = new THREE.PlaneGeometry(8000, 8000, 400, 400);
	g.rotateX(-Math.PI / 2);
	const pos = g.attributes.position as THREE.BufferAttribute;
	const col = new Float32Array(pos.count * 3);
	for (let i = 0; i < pos.count; i++) {
		const x = pos.getX(i);
		const z = pos.getZ(i);
		const y = terrainY(x, z);
		pos.setY(i, y);
		const snow = Math.min(1, Math.max(0, (y - 150) / 120));
		col[3 * i] = 0.35 + 0.55 * snow;
		col[3 * i + 1] = 0.4 + 0.5 * snow;
		col[3 * i + 2] = 0.3 + 0.65 * snow;
	}
	g.setAttribute("color", new THREE.BufferAttribute(col, 3));
	g.computeVertexNormals();
	// a finer local mesh so the hill that cuts through the splat plane is smooth
	const m = new THREE.Mesh(
		g,
		new THREE.MeshLambertMaterial({ vertexColors: true }),
	);
	m.name = "terrain";
	const lg = new THREE.PlaneGeometry(40, 40, 160, 160);
	lg.rotateX(-Math.PI / 2);
	const lp = lg.attributes.position as THREE.BufferAttribute;
	for (let i = 0; i < lp.count; i++)
		lp.setY(i, hillY(lp.getX(i), lp.getZ(i)) + 0.01);
	lg.computeVertexNormals();
	const local = new THREE.Mesh(
		lg,
		new THREE.MeshLambertMaterial({ color: 0x5b6b4a }),
	);
	local.name = "hill";
	m.add(local);
	return m;
}

type Lab = {
	stats: () => unknown;
	setView: (name: string) => void;
	measure: (ms: number) => Promise<{
		fps: number;
		frames: number;
		sorts: number;
		lastSortMs: number;
	}>;
	ready: boolean;
	splats: () => ThreeSplats | null;
	error?: string;
};

function SplatLab() {
	const search = Route.useSearch();
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const apiRef = useRef<{
		load: (c: GaussianCloud, frame: string) => void;
	} | null>(null);
	const [info, setInfo] = useState("");
	const [truth, setTruth] = useState(!!search.truth);
	const splatsRef = useRef<ThreeSplats | null>(null);
	const truthRef = useRef(truth);
	truthRef.current = truth;

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const n = search.n ?? 200000;
		const logDepth = search.logdepth !== 0;
		const renderer = new THREE.WebGLRenderer({
			canvas,
			antialias: search.aa !== 0,
			logarithmicDepthBuffer: logDepth,
			preserveDrawingBuffer: true,
		});
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		const scene = new THREE.Scene();
		scene.background = new THREE.Color(0x9fc3e6);
		scene.add(new THREE.HemisphereLight(0xffffff, 0x445533, 1.2));
		const sun = new THREE.DirectionalLight(0xffffff, 1.6);
		sun.position.set(300, 500, 200);
		scene.add(sun);
		const terrain = makeTerrain();
		scene.add(terrain);
		const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 50000);
		const controls = new OrbitControls(camera, canvas);
		const views: Record<string, [number[], number[]]> = {
			default: [
				[0, 3, 14],
				[0, 1.5, 0],
			],
			hill: [
				[9, 1.2, 6],
				[4.5, 1, -1],
			],
			far: [
				[0, 3, 14],
				[0, 120, -1000],
			],
			top: [
				[0.01, 22, 0.01],
				[0, 0, 0],
			],
			needles: [
				[0, 4.3, 1.5],
				[0, 4, -3],
			],
		};
		const setView = (name: string) => {
			const v = views[name] ?? views.default;
			camera.position.fromArray(v[0]);
			controls.target.fromArray(v[1]);
			controls.update();
		};
		setView("default");

		const group = new THREE.Group();
		scene.add(group);
		const load = (cloud: GaussianCloud, frame: string) => {
			splatsRef.current?.dispose();
			group.rotation.set(
				frame === "camera" ? Math.PI : frame === "enu" ? -Math.PI / 2 : 0,
				0,
				0,
			);
			const t0 = performance.now();
			const s = new ThreeSplats(cloud, { truth: truthRef.current });
			group.add(s);
			splatsRef.current = s;
			setInfo(
				`${cloud.count.toLocaleString()} splats, packed in ${(performance.now() - t0).toFixed(0)} ms`,
			);
			if (frame !== "yup" && cloud.count) {
				// frame a loaded cloud: from its own camera origin for a camera-frame cloud, else from outside
				group.updateMatrixWorld(true);
				const box = new THREE.Box3();
				const v = new THREE.Vector3();
				const step = Math.max(1, Math.floor(cloud.count / 20000));
				for (let i = 0; i < cloud.count; i += step)
					box.expandByPoint(
						v.fromArray(cloud.positions, 3 * i).applyMatrix4(group.matrixWorld),
					);
				const c = box.getCenter(new THREE.Vector3());
				const r = box.getSize(new THREE.Vector3()).length() / 2;
				if (frame === "camera") camera.position.set(0, 0, 0.01);
				else
					camera.position.copy(c).add(new THREE.Vector3(0, r * 0.5, r * 1.5));
				controls.target.copy(c);
				controls.update();
			}
		};
		apiRef.current = { load };
		load(makeSyntheticCloud(n), "yup");

		const resize = () => {
			const w = canvas.clientWidth;
			const h = canvas.clientHeight;
			renderer.setSize(w, h, false);
			camera.aspect = w / h;
			camera.updateProjectionMatrix();
		};
		resize();
		window.addEventListener("resize", resize);
		let frames = 0;
		let orbit: { rate: number } | null = null;
		let raf = 0;
		let last = performance.now();
		const loop = () => {
			raf = requestAnimationFrame(loop);
			const now = performance.now();
			const dt = (now - last) / 1000;
			last = now;
			if (orbit) {
				const off = camera.position.clone().sub(controls.target);
				off.applyAxisAngle(new THREE.Vector3(0, 1, 0), orbit.rate * dt);
				camera.position.copy(controls.target).add(off);
			}
			controls.update();
			renderer.render(scene, camera);
			frames++;
		};
		loop();

		const lab: Lab = {
			ready: true,
			splats: () => splatsRef.current,
			stats: () => ({
				...splatsRef.current?.stats,
				logDepth,
				calls: renderer.info.render.calls,
				triangles: renderer.info.render.triangles,
				programs: renderer.info.programs?.length,
			}),
			setView,
			measure: async (ms: number) => {
				const s = splatsRef.current;
				const sorts0 = s?.stats.sorts ?? 0;
				orbit = { rate: 0.6 };
				await new Promise((r) => setTimeout(r, 300));
				const f0 = frames;
				const t0 = performance.now();
				await new Promise((r) => setTimeout(r, ms));
				const fps = ((frames - f0) * 1000) / (performance.now() - t0);
				orbit = null;
				return {
					fps,
					frames: frames - f0,
					sorts: (s?.stats.sorts ?? 0) - sorts0,
					lastSortMs: s?.stats.lastSortMs ?? 0,
				};
			},
		};
		window.__splatLab = lab;
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener("resize", resize);
			controls.dispose();
			splatsRef.current?.dispose();
			splatsRef.current = null;
			terrain.traverse((o) => {
				if (o instanceof THREE.Mesh) {
					o.geometry.dispose();
					(o.material as THREE.Material).dispose();
				}
			});
			renderer.dispose();
			window.__splatLab = undefined;
		};
		// truth is applied live below; only n / logdepth rebuild the scene
	}, [search.n, search.logdepth, search.aa]);

	useEffect(() => {
		splatsRef.current?.setTruth(truth);
	}, [truth]);

	const onFile = async (f: File) => {
		try {
			const buf = await f.arrayBuffer();
			const cloud = f.name.toLowerCase().endsWith(".ply")
				? decodeGaussianPly(buf, { frame: "camera" })
				: decodeSplatV1(buf);
			apiRef.current?.load(cloud, cloud.frame);
		} catch (e) {
			setInfo(`load failed: ${(e as Error).message}`);
		}
	};

	if (!import.meta.env.DEV)
		return <p style={{ padding: 16 }}>The splat lab is dev-only.</p>;
	return (
		<div style={{ position: "fixed", inset: 0, background: "#0e1012" }}>
			<canvas
				ref={canvasRef}
				style={{ width: "100%", height: "100%", display: "block" }}
			/>
			<div
				style={{
					position: "absolute",
					top: 8,
					left: 8,
					padding: "6px 10px",
					background: "rgba(0,0,0,0.55)",
					color: "#eee",
					font: "12px system-ui",
					borderRadius: 6,
					display: "flex",
					gap: 12,
					alignItems: "center",
				}}
			>
				<span data-testid="splat-info">{info}</span>
				<label>
					<input
						type="checkbox"
						checked={truth}
						onChange={(e) => setTruth(e.target.checked)}
					/>{" "}
					Truth
				</label>
				<input
					type="file"
					accept=".ply,.splat,.splat-v1,.bin"
					onChange={(e) => {
						const f = e.target.files?.[0];
						if (f) onFile(f);
					}}
				/>
			</div>
		</div>
	);
}
