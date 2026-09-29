// WP-E GPU check of WARP_GLSL (headless Chromium WebGL2 via playwright). Run under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- npx tsx tools/concord/field/glsl-check.mts [--patched <root>]
// 1. Compiles WARP_GLSL in the three.js dialect (GLSL 3 + three's texture2D / varying defines) and in
//    the deck dialect (#version 300 es), renders warpUV / warpAt for a synthetic field into RGBA32F,
//    and compares: GPU vs the CPU mirror (warpAtCPU / sampleField), three vs deck (bitwise), and
//    warpOn = 0 vs plain vUv (bitwise).
// 2. With --patched <root> (a copy of the repo with tools/concord/field/hooks.patch.txt applied):
//    compiles + links the patched deck composite program (classic, no look defines).
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { IDENTITY_INTRINSICS, sampleField } from "../../../src/lib/concord/core";
import {
	type FieldCue,
	fitField,
	packWarpTexture,
	WARP_GLSL,
} from "../../../src/lib/concord/field";

const W = 160;
const H = 120;
const cam = {
	pose: { yaw: 0, pitch: 0, roll: 0, vfov: 45 },
	eye: [0, 0, 0] as [number, number, number],
	aspect: 4 / 3,
	intr: { ...IDENTITY_INTRINSICS },
};
// synthetic field: terrain below v = 0.3, smooth residuals
const gw = 64;
const gh = 48;
const rangeM = new Float32Array(gw * gh);
for (let j = 0; j < gh; j++)
	for (let i = 0; i < gw; i++) {
		const v = (j + 0.5) / gh;
		rangeM[j * gw + i] = v < 0.3 ? 0 : 800 * 25 ** ((1 - v) / 0.7);
	}
const cues: FieldCue[] = [];
for (let k = 0; k < 80; k++) {
	const u = ((k * 0.618) % 1) * 0.9 + 0.05;
	const v = 0.35 + ((k * 0.382) % 1) * 0.6;
	cues.push({
		kind: "point",
		u,
		v,
		world: [0, 0, 0],
		depthM: 800 * 25 ** ((1 - v) / 0.7),
		sigmaPx: 0.5,
		source: "synthetic",
		residualPx: [8 * Math.sin(u * 6), 6 * Math.cos(v * 7)],
		conf: 1,
	});
}
const field = fitField(cues, { w: gw, h: gh, rangeM }, cam, {
	maxMetres: 1e9,
	fade: [2, 3],
});
const tex = packWarpTexture(field);

const body = `
uniform sampler2D tWarp;
uniform float uScale;
uniform float uOn;
uniform vec2 uSize;
${WARP_GLSL}
`;
const threeFs = `#version 300 es
#define varying in
#define texture2D texture
precision highp float;
precision highp int;
out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
${body}
void main() {
  vec2 vUv = gl_FragCoord.xy / uSize;
  vec2 uvG = warpUV(tWarp, uScale, uOn, vUv);
  gl_FragColor = vec4(uvG, warpAt(tWarp, uScale, vec2(vUv.x, 1.0 - vUv.y)));
}`;
const deckFs = `#version 300 es
precision highp float;
${body}
out vec4 fragColor;
void main() {
  vec2 vUv = gl_FragCoord.xy / uSize;
  vec2 uvG = warpUV(tWarp, uScale, uOn, vUv);
  fragColor = vec4(uvG, warpAt(tWarp, uScale, vec2(vUv.x, 1.0 - vUv.y)));
}`;
const plainFs = `#version 300 es
precision highp float;
uniform vec2 uSize;
out vec4 fragColor;
void main() { vec2 vUv = gl_FragCoord.xy / uSize; fragColor = vec4(vUv, 0.0, 0.0); }`;

let patchedDeck: { vs: string; fs: string } | null = null;
const pi = process.argv.indexOf("--patched");
if (pi > 0) {
	const root = path.resolve(process.argv[pi + 1]);
	const m = await import(
		pathToFileURL(path.join(root, "src/lib/deck/composite-shader.ts")).href
	);
	// luma injects module uniform blocks after the precision line; do the same by hand
	const fs = (m.compositeFs as string).replace(
		"precision highp float;\n",
		`precision highp float;\n${m.compositeModule.fs}\n`,
	);
	patchedDeck = { vs: m.compositeVs, fs };
}

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const page = await browser.newPage();
// tsx (esbuild keepNames) wraps functions in __name(); define it in the page
await page.addInitScript("window.__name = (f) => f;");
await page.goto("about:blank");
const out = await page.evaluate(
	({ threeFs, deckFs, plainFs, tex, W, H, patchedDeck }) => {
		const c = document.createElement("canvas");
		const gl = c.getContext("webgl2") as WebGL2RenderingContext;
		if (!gl) return { error: "no webgl2" };
		gl.getExtension("EXT_color_buffer_float");
		const vsSrc = `#version 300 es
in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;
		const compile = (type: number, src: string) => {
			const s = gl.createShader(type) as WebGLShader;
			gl.shaderSource(s, src);
			gl.compileShader(s);
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
				throw new Error(gl.getShaderInfoLog(s) ?? "compile");
			return s;
		};
		const link = (vs: string, fs: string) => {
			const pr = gl.createProgram() as WebGLProgram;
			gl.attachShader(pr, compile(gl.VERTEX_SHADER, vs));
			gl.attachShader(pr, compile(gl.FRAGMENT_SHADER, fs));
			gl.bindAttribLocation(pr, 0, "p");
			gl.linkProgram(pr);
			if (!gl.getProgramParameter(pr, gl.LINK_STATUS))
				throw new Error(gl.getProgramInfoLog(pr) ?? "link");
			return pr;
		};
		const buf = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, buf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
		const t = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, t);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, tex.width, tex.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(tex.data));
		for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
		const rt = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, rt);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, W, H, 0, gl.RGBA, gl.FLOAT, null);
		const fb = gl.createFramebuffer();
		gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, rt, 0);
		gl.viewport(0, 0, W, H);
		const run = (fs: string, on: number) => {
			const pr = link(vsSrc, fs);
			gl.useProgram(pr);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, t);
			gl.uniform1i(gl.getUniformLocation(pr, "tWarp"), 0);
			gl.uniform1f(gl.getUniformLocation(pr, "uScale"), tex.scale);
			gl.uniform1f(gl.getUniformLocation(pr, "uOn"), on);
			gl.uniform2f(gl.getUniformLocation(pr, "uSize"), W, H);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
			const px = new Float32Array(W * H * 4);
			gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, px);
			return Array.from(px);
		};
		const res: Record<string, unknown> = {
			renderer: gl.getParameter(gl.RENDERER),
			three: run(threeFs, 1),
			deck: run(deckFs, 1),
			threeOff: run(threeFs, 0),
			deckOff: run(deckFs, 0),
			plain: run(plainFs, 0),
		};
		if (patchedDeck) {
			try {
				link(patchedDeck.vs.replace("in vec2 positions;", "in vec2 positions;"), patchedDeck.fs);
				res.patchedDeck = "compiled + linked";
			} catch (e) {
				res.patchedDeck = `FAILED: ${(e as Error).message}`;
			}
		}
		return res;
	},
	{ threeFs, deckFs, plainFs, tex: { ...tex, data: Array.from(tex.data) }, W, H, patchedDeck },
);
await browser.close();
if ("error" in out) {
	console.log(out.error);
	process.exit(1);
}
const o = out as unknown as Record<string, number[] | string>;
const three = o.three as number[];
const deck = o.deck as number[];
const plain = o.plain as number[];
let fail = 0;
const report = (name: string, ok: boolean, detail: string) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${detail})`);
	if (!ok) fail++;
};
console.log(`GPU: ${o.renderer}`);
let maxUv = 0;
let maxW = 0;
for (let y = 0; y < H; y++)
	for (let x = 0; x < W; x++) {
		const k = (y * W + x) * 4;
		const u = (x + 0.5) / W;
		const vGL = (y + 0.5) / H;
		const [du, dv] = sampleField(field, u, 1 - vGL);
		maxUv = Math.max(
			maxUv,
			Math.hypot((three[k] - (u + du)) * 1600, (three[k + 1] - (vGL - dv)) * 1200),
		);
		maxW = Math.max(maxW, Math.hypot((three[k + 2] - du) * 1600, (three[k + 3] - dv) * 1200));
	}
report("GPU warpUV vs CPU (vUv + (du, −dv)), px @1600", maxUv < 0.01, `max ${maxUv.toExponential(2)} px, field max ${field.maxAbsPx.toFixed(1)} px`);
report("GPU warpAt vs CPU sampleField, px @1600", maxW < 0.01, `max ${maxW.toExponential(2)} px`);
const same = (a: number[], b: number[]) => a.every((x, i) => Object.is(x, b[i]));
report("three dialect ≡ deck dialect (bitwise, warp on)", same(three, deck), `${W}×${H}`);
const offOk = (a: number[]) => a.every((x, i) => (i % 4 < 2 ? Object.is(x, plain[i]) : true));
report("warpOn = 0 ⇒ uvG ≡ vUv bitwise (three, deck)", offOk(o.threeOff as number[]) && offOk(o.deckOff as number[]), "");
if (o.patchedDeck) report("patched deck composite program", String(o.patchedDeck).startsWith("compiled"), String(o.patchedDeck));
process.exit(fail ? 1 : 0);
