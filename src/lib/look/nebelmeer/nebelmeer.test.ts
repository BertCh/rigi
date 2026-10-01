// Synthetic check for the Nebelmeer: the analytic transmittance vs numeric quadrature, the off
// state as identity, and the style → values path.
// Run: npx tsx src/lib/look/nebelmeer/nebelmeer.test.ts   (exits 1 on failure)
import { CLASSIC } from "../../style/defaults";
import { mergeStyle } from "../../style/schema";
import { atmosphereValues, nebelTransmittance } from "../atmosphere";
import { nebelRayTransmittance } from "./index";

let bad = 0;
const check = (name: string, ok: boolean, info?: unknown) => {
	if (!ok) bad++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}`, ok ? "" : info);
};

// numeric ∫ρ ds with ρ = d below top, d·exp(-(h-top)k) above
function quad(
	L: number,
	h0: number,
	h1: number,
	d: number,
	top: number,
	k: number,
) {
	const n = 20000;
	let tau = 0;
	for (let i = 0; i < n; i++) {
		const h = h0 + ((h1 - h0) * (i + 0.5)) / n;
		tau += d * (h <= top ? 1 : Math.exp(-(h - top) * k)) * (L / n);
	}
	return Math.exp(-tau);
}

for (const [L, h0, h1] of [
	[3000, 900, 1000],
	[3000, 2400, 2600],
	[5000, 600, 2800],
	[5000, 2800, 600],
	[4000, 1900, 1900],
]) {
	const a = nebelRayTransmittance(L, h0, h1, 0.003, 1400, 0.01);
	const b = quad(L, h0, h1, 0.003, 1400, 0.01);
	check(`integral L=${L} ${h0}->${h1}`, Math.abs(a - b) < 1e-3, { a, b });
}

const phys = mergeStyle(CLASSIC, {
	terrain: { atmosphere: { mode: "physical" } },
});
const off = atmosphereValues(phys, "world", [0, 0, 1], [0, 0, 1500]);
check("off: nebel density 0", off.nebel?.[1] === 0);
check(
	"off: transmittance 1",
	nebelTransmittance(off, [0, 0, 1500], [4000, 0, 800]) === 1,
);
const cls = atmosphereValues(CLASSIC, "world", [0, 0, 1], [0, 0, 0]);
check("classic: nebel off", cls.nebel?.[1] === 0);

const on = atmosphereValues(
	mergeStyle(CLASSIC, {
		terrain: {
			atmosphere: { mode: "physical", nebelmeer: { density: 0.004 } },
		},
	}),
	"world",
	[0, 0, 1],
	[0, 0, 2000],
);
check(
	"on: values",
	on.nebel?.join() === "1400,0.004,0.01" && on.nebelColor?.length === 3,
	on.nebel,
);
const t = nebelTransmittance(on, [0, 0, 2000], [3000, 0, 900]);
check("on: attenuates", t > 0 && t < 0.5, t);

process.exit(bad ? 1 : 0);
