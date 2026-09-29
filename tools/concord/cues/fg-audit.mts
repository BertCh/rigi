/**
 * WP-C false-cue audit helper: counts kept cues that fall inside foreground-object boxes (people,
 * boat, near rock/fence/trees) drawn BY EYE (agent, not blind) on the GT-pose overview PNGs of 5 dev
 * photos (display px, 800 long side). "amb" = ambiguous region (5495 snow-bank/forest edge).
 *
 *   npx tsx tools/concord/cues/fg-audit.mts [gt|app]
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../../../scripts/lib/node-io.ts";

type Box = [number, number, number, number];
const B: Record<string, { W: number; H: number; fg: Box[]; amb?: Box[] }> = {
	IMG_5495: { W: 600, H: 800, fg: [[410, 305, 535, 450], [310, 440, 600, 800]], amb: [[0, 440, 330, 480]] },
	IMG_6971: { W: 800, H: 600, fg: [[215, 190, 330, 340], [330, 185, 505, 470], [140, 300, 510, 600], [0, 405, 800, 600]] },
	IMG_7018: { W: 800, H: 600, fg: [[140, 170, 240, 300], [45, 280, 310, 600]] },
	IMG_7033: { W: 800, H: 600, fg: [[205, 120, 345, 300], [130, 280, 420, 600], [0, 0, 130, 600], [520, 220, 800, 470]] },
	IMG_7053: { W: 800, H: 600, fg: [[460, 290, 580, 390], [420, 380, 645, 600], [0, 420, 120, 600], [0, 480, 800, 600]] },
};
const pose = process.argv[2] ?? "gt";
let T = 0;
let F = 0;
let A = 0;
for (const [p, b] of Object.entries(B)) {
	const j = JSON.parse(fs.readFileSync(path.join(ROOT, "out", "concord", "cues", pose, `${p}.json`), "utf8"));
	const inB = (c: { u: number; v: number }, bs: Box[]) =>
		bs.some(([x0, y0, x1, y1]) => c.u * b.W >= x0 && c.u * b.W <= x1 && c.v * b.H >= y0 && c.v * b.H <= y1);
	const f = j.cues.filter((c: { u: number; v: number }) => inB(c, b.fg)).length;
	const a = j.cues.filter((c: { u: number; v: number }) => !inB(c, b.fg) && inB(c, b.amb ?? [])).length;
	console.log(p, "cues", j.cues.length, "in fg boxes", f, "ambiguous", a);
	T += j.cues.length;
	F += f;
	A += a;
}
console.log(
	`total ${T}, fg ${F} (${((100 * F) / T).toFixed(1)}%), ambiguous ${A} (${((100 * A) / T).toFixed(1)}%), fg+amb ${((100 * (F + A)) / T).toFixed(1)}%`,
);
