import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { prefetchPeaksBBox } from "../../harness/lib/geo";
import { renderOverlay } from "../../harness/overlay";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), "pack");
const PERTURB: Record<string, number> = { wc_0003: 3.0, wc_0038: 5.0 };
const manifest = JSON.parse(fs.readFileSync(`${REPO}/tools/bench/data/manifest.json`, "utf8"));
const seed = crypto.randomBytes(8).toString("hex");
let h = crypto.createHash("sha256").update(seed).digest().readUInt32LE(0);
const rand = () => { h = (h + 0x6d2b79f5) >>> 0; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const used = new Set<string>();
const label = () => { for (;;) { const l = "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(rand() * 24)] + (2 + Math.floor(rand() * 8)); if (![...used].some((u) => u[0] === l[0])) { used.add(l); return l; } } };

async function neutralHeader(file: string, text: string) {
  const img = await loadImage(file);
  const c = createCanvas(img.width, img.height); const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const s = img.width / 1600; const header = Math.round(74 * s);
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, img.width, header + 1);
  ctx.fillStyle = "#fff"; ctx.font = `700 ${Math.round(30 * s)}px sans-serif`; ctx.fillText(text, 12 * s, 48 * s);
  fs.writeFileSync(file, await c.encode("jpeg", 90));
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  for (const id of ["wc_0003", "wc_0038"]) { const e = manifest.find((m: { id: string }) => m.id === id);
    for (let a = 0; a < 6; a++) { try { await prefetchPeaksBBox(+(e.lat - 0.9).toFixed(2), +(e.lon - 1.3).toFixed(2), +(e.lat + 0.9).toFixed(2), +(e.lon + 1.3).toFixed(2)); break; } catch (err) { console.error("prefetch retry", String(err)); await new Promise((r) => setTimeout(r, 15000)); } } }
  const key: Record<string, unknown> = { seed, perturbYawDeg: PERTURB, candidates: {} };
  for (const id of ["wc_0003", "wc_0038"]) {
    const rec = JSON.parse(fs.readFileSync(`${REPO}/tools/bench/final/out/B/${id}.json`, "utf8"));
    const e = manifest.find((m: { id: string }) => m.id === id);
    const sign = rand() < 0.5 ? -1 : 1;
    const kinds = [
      { kind: "B", pose: rec.pose },
      { kind: "B-duplicate", pose: rec.pose },
      { kind: "wrong-decoy", pose: { ...rec.pose, yaw: rec.pose.yaw + sign * PERTURB[id] } },
    ].map((k) => ({ k, r: rand() })).sort((a, b) => a.r - b.r).map((x) => x.k);
    const widths = [1360, 1400, 1440].map((w) => ({ w, r: rand() })).sort((a, b) => a.r - b.r).map((x) => x.w);
    const dir = path.join(OUT, id); fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(REPO, "tools/bench/data", e.file), path.join(dir, "photo.jpg"));
    for (let i = 0; i < kinds.length; i++) {
      const L = label(); const file = path.join(dir, `candidate_${L}.jpg`);
      for (let a = 0; ; a++) {
        try {
          const ov = await renderOverlay({ photoFile: path.join(REPO, "tools/bench/data", e.file), lat: e.lat, lon: e.lon, alt: e.altitudeM ?? null,
            eyeLat: rec.eye.lat, eyeLon: rec.eye.lon, eyeH: rec.eye.h, pose: kinds[i].pose, title: "x", method: "x", width: widths[i], out: file });
          await neutralHeader(file, `candidate ${L}`);
          (key.candidates as Record<string, unknown>)[L] = { pid: id, kind: kinds[i].kind, pose: kinds[i].pose, eye: rec.eye, eyeRendered: ov.eye, dem: ov.dem, width: widths[i], labels: ov.labels };
          console.error(id, L, kinds[i].kind, ov.eye, ov.labels.join("|"));
          break;
        } catch (err) { if (a >= 3) throw err; console.error("retry", err); await new Promise((r) => setTimeout(r, 3000)); }
      }
    }
  }
  fs.writeFileSync(path.join(path.dirname(OUT), "key.json"), JSON.stringify(key, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
