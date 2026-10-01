// Rigi's brand palette, drawn from the Brezine Color Chart: Marcia Ascher's khipu cord
// colour codes as encoded by Carrie Brezine in the Harvard Khipu Database, with the hex
// swatches published by the Khipu Field Guide (khipufieldguide.com/sketchbook/brezine_colors.html).
//
// Every brand colour is a chart swatch, named by its Ascher code. The CSS tokens in
// src/styles.css (--rigi-*) mirror BRAND; keep the two in step.

/** Brezine colour classes (the chart's rows). */
export type KhipuClass =
	| "white"
	| "red"
	| "orange"
	| "yellow"
	| "green"
	| "blue-green"
	| "brown"
	| "olive"
	| "grey"
	| "black";

export interface KhipuColor {
	hex: string;
	name: string;
	cls: KhipuClass;
}

const c = (hex: string, name: string, cls: KhipuClass): KhipuColor => ({
	hex,
	name,
	cls,
});

/** The full chart, keyed by Ascher code, in chart order. */
export const BREZINE = {
	W: c("#f4f4f4", "White", "white"),

	PK: c("#ee9086", "Unknown Urton Color", "red"),
	RM: c("#ab343a", "Moderate Red", "red"),
	VR: c("#4f0014", "Vivid Deep Red", "red"),
	SR: c("#bf2233", "Strong Red", "red"),

	"0R": c("#c34d0a", "Deep Orange", "orange"),
	R: c("#9b2f1f", "Dark Reddish Orange", "orange"),
	R0: c("#b85d43", "Gray Reddish Orange", "orange"),
	SB: c("#b15124", "Brownish Orange", "orange"),

	YY: c("#ffdb8b", "Pale Yellow", "yellow"),
	"0Y": c("#c37629", "Dark Orange Yellow", "yellow"),
	SY: c("#e59e1f", "Strong Yellow", "yellow"),

	PG: c("#8d917a", "Pale Green", "green"),
	GG: c("#575e4e", "Grayish Green", "green"),
	"0D": c("#27261a", "Dark Grayish Olive Green", "green"),
	DG: c("#232c16", "Dark Olive Green", "green"),
	GR: c("#49423d", "Dark Green", "green"),
	VG: c("#16251c", "Vivid Dark Green", "green"),
	YG: c("#313830", "Dark Grayish Green", "green"),

	BL: c("#919192", "Pale Blue", "blue-green"),
	BG: c("#4a545c", "Grayish Blue", "blue-green"),
	LC: c("#2c3337", "Dark Grayish Blue", "blue-green"),
	GL: c("#30626b", "Moderate Greenish Blue", "blue-green"),
	TG: c("#013a33", "Dark Bluish Green", "blue-green"),
	PB: c("#002f55", "Deep Blue", "blue-green"),
	VB: c("#022027", "Vivid Dark Greenish Blue", "blue-green"),

	AB: c("#a86540", "Light Brown", "brown"),
	"0B": c("#64400f", "Moderate Olive Brown", "brown"),
	BB: c("#3f2512", "Dark Yellowish Brown", "brown"),
	BY: c("#b48764", "Light Grayish Yellowish Brown", "brown"),
	B: c("#7d512d", "Moderate Yellowish Brown", "brown"),
	BD: c("#3d2b1f", "Dark Grayish Yellowish Brown", "brown"),
	GB: c("#966a57", "Light Grayish Reddish Brown", "brown"),
	BS: c("#753313", "Strong Brown", "brown"),
	CB: c("#32221a", "Dark Grayish Brown", "brown"),
	RL: c("#aa6651", "Light Reddish Brown", "brown"),
	EB: c("#785840", "Grayish Yellowish Brown", "brown"),
	DB: c("#4d220e", "Deep Brown", "brown"),
	YB: c("#bb8b54", "Light Yellowish Brown", "brown"),
	FR: c("#7f180d", "Strong Reddish Brown", "brown"),
	HB: c("#5a3d30", "Grayish Brown", "brown"),
	LB: c("#593315", "Deep Yellowish Brown", "brown"),
	KB: c("#38170c", "Dark Brown", "brown"),
	MB: c("#673923", "Moderate Brown", "brown"),
	PR: c("#490005", "Deep Reddish Brown", "brown"),
	NB: c("#95500c", "Strong Yellowish Brown", "brown"),
	RD: c("#5e3830", "Grayish Reddish Brown", "brown"),
	RB: c("#712f26", "Moderate Reddish Brown", "brown"),

	"0G": c("#8b734b", "Light Grayish Olive", "olive"),
	G: c("#48442d", "Grayish Olive Green", "olive"),
	"0L": c("#2b2517", "Dark Grayish Olive", "olive"),
	G0: c("#52442c", "Grayish Olive", "olive"),
	D0: c("#362c12", "Dark Olive", "olive"),

	LG: c("#baaf96", "Light Greenish Gray", "grey"),
	LA: c("#7d746d", "Bluish Gray", "grey"),
	GA: c("#503d33", "Brownish Gray", "grey"),
	MG: c("#817066", "Medium Gray", "grey"),
	GY: c("#4d4234", "Olive Gray", "grey"),
	RG: c("#7a7666", "Greenish Gray", "grey"),
	KG: c("#45433b", "Dark Greenish Gray", "grey"),
	LD: c("#464544", "Dark Bluish Gray", "grey"),

	"0K": c("#121910", "Olive Black", "black"),
	FB: c("#140f0b", "Brownish Black", "black"),
	LK: c("#131313", "Black", "black"),
} as const satisfies Record<string, KhipuColor>;

export type AscherCode = keyof typeof BREZINE;

/** Brand roles → Ascher code. Change a role here and in src/styles.css together. */
export const BRAND_CODES = {
	/** page ground */
	ink: "LK",
	/** raised panels, map placeholders */
	slate: "LC",
	/** body text and light strokes */
	paper: "W",
	/** the Rigi accent: selection, active state, the first viewpoint */
	glow: "YB",
	/** strong accent on light grounds */
	ember: "SB",
	/** dark strokes on light grounds */
	umber: "CB",
	/** callout tones */
	lesson: "SY",
	trap: "PK",
	result: "PG",
	negative: "MG",
} as const satisfies Record<string, AscherCode>;

export type BrandRole = keyof typeof BRAND_CODES;

/** Brand roles → hex, for canvas, SVG attributes and anywhere a CSS var can't reach. */
export const BRAND = Object.fromEntries(
	Object.entries(BRAND_CODES).map(([role, code]) => [role, BREZINE[code].hex]),
) as { [R in BrandRole]: string };

/** `rgba()` of a brand role, for translucent canvas fills. */
export function brandAlpha(role: BrandRole, a: number): string {
	const h = BRAND[role];
	const n = Number.parseInt(h.slice(1), 16);
	return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
