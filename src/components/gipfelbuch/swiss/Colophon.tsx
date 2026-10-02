// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { BREZINE } from "#/brand/khipu";
import { MarkerUnderline } from "./hand";
import { paintPolygon } from "./paint";
import { SWISS } from "./palette";
import { TYPE } from "./type";

type InkRole = { role: string; code: keyof typeof BREZINE; hex: string };

// Role, Ascher code and the SWISS value actually used (swiss/palette.ts); paper is a mix, so no code.
const INKS: InkRole[] = [
	{ role: "Text, rock drawing", code: "LK", hex: SWISS.ink },
	{ role: "Contours, rules", code: "NB", hex: SWISS.contour },
	{ role: "Water, links", code: "GL", hex: SWISS.water },
	{ role: "Forest, result", code: "GG", hex: SWISS.forest },
	{ role: "Route red, accent", code: "SR", hex: SWISS.red },
	{ role: "Secondary text", code: "BG", hex: SWISS.secondary },
	{ role: "Pencil", code: "GR", hex: SWISS.pencil },
	{ role: "Peak lettering", code: "PB", hex: SWISS.navy },
	{ role: "Relief, hairlines", code: "BL", hex: SWISS.relief },
	{ role: "Wegweiser, strong", code: "SY", hex: SWISS.sign },
	{ role: "Wegweiser, light", code: "YY", hex: SWISS.signLight },
];

// Hand is the form, print the exception (reports/gipfelbuch.md): four hand
// faces write the book; print survives only for code and equations.
const FACES = [
	{
		name: "GB Hand Body",
		source: "Playpen Sans",
		use: "The written text of every sheet",
		family: "var(--gb-font-body)",
		print: false,
	},
	{
		name: "GB Hand",
		source: "Architects Daughter",
		use: "Lettered titles, headings, field notes",
		family: "var(--gb-font-hand)",
		print: false,
	},
	{
		name: "GB Hand Caps",
		source: "Patrick Hand SC",
		use: "Block capitals: peaks, places, labels",
		family: "var(--gb-font-caps)",
		print: false,
	},
	{
		name: "GB Hand Small",
		source: "Shantell Sans",
		use: "Hand figures, heights, coordinates",
		family: "var(--gb-font-figure)",
		print: false,
	},
	{
		name: "GB Mono",
		source: "Fira Mono",
		use: "Print, only for code",
		family: "var(--gb-font-mono)",
		print: true,
	},
	{
		name: "GB Serif",
		source: "Source Serif 4",
		use: "Print, only for equations",
		family: "var(--gb-font-math)",
		print: true,
	},
	{
		name: "GB Sans",
		source: "Fira Sans",
		use: "Print, the opt-in .gb-print escape",
		family: "var(--gb-font-print)",
		print: true,
	},
];

// Attribution strings exactly as recorded in NOTICE.md and reports/licences.md.
const SOURCES = [
	{
		name: "Mapterhorn terrain tiles",
		credit: "© Mapterhorn",
		note: "mapterhorn.com/attribution. Terrain tiles under the licence of each national source.",
	},
	{
		name: "swisstopo relief shading (swissALTI3D Reliefschattierung)",
		credit: "Relief © swisstopo · Höhen Mapterhorn",
		note: "Swiss open government data. Contours derived from Mapterhorn terrain.",
	},
	{
		name: "swissNAMES3D 2026",
		credit: "© swisstopo",
		note: "Peaks and places. swisstopo open government data (free use, attribution).",
	},
];

/** A painted colour dab, as on a colour-match chart in a field journal (never a crisp square). */
function Dab({ color, seed }: { color: string; seed: string }) {
	return (
		<svg
			width="20"
			height="16"
			viewBox="0 0 20 16"
			aria-hidden="true"
			className="shrink-0"
		>
			<path
				d={paintPolygon(
					[
						[2, 3],
						[10, 1.5],
						[18, 3],
						[18.5, 12],
						[10, 14.5],
						[1.5, 12.5],
					],
					`dab-${seed}`,
					1.1,
				)}
				fill={color}
			/>
		</svg>
	);
}

/** A lettered section heading with a partial marker underline. */
function Heading({ children }: { children: string }) {
	return (
		<div className="relative mt-12 mb-3 inline-block min-w-[8rem]">
			<h2 className={`${TYPE.h2} m-0`}>{children}</h2>
			<MarkerUnderline seed={`colophon-${children}`} />
		</div>
	);
}

/** F2 / P6 colophon page: the edition's faces, inks, paper, imprint roles and data credits. */
export function Colophon({ className }: { className?: string }) {
	return (
		<section
			aria-labelledby="colophon-title"
			className={`gb-colophon max-w-[66ch] ${className ?? ""}`}
		>
			<p className={`${TYPE.kicker} tracking-[0.14em]`}>
				Gipfelbuch · Ausgabe 2026
			</p>
			<div className="relative mt-3 inline-block">
				<h1 id="colophon-title" className={`${TYPE.h1} m-0`}>
					Colophon
				</h1>
				<MarkerUnderline seed="colophon-title" coverage={0.7} />
			</div>
			<p className={`${TYPE.body} mt-6`}>Fonts: SIL Open Font License 1.1.</p>

			<details className="mt-12">
				<summary className="nb-hand cursor-pointer text-[22px] leading-[26px]">
					Für Entwickler
				</summary>
				<Heading>Faces</Heading>
				<ul className="m-0 list-none space-y-3 p-0">
					{FACES.map((f) => (
						<li
							key={f.name}
							className="grid gap-x-6 sm:grid-cols-[12rem_minmax(0,1fr)]"
						>
							<span
								className="text-[20px] leading-[26px]"
								style={{ fontFamily: f.family }}
							>
								{f.name}
							</span>
							<span className={TYPE.caption}>
								{f.source} · {f.use}
								{f.print ? (
									<span className="nb-hand ml-2 text-[17px] text-[var(--gb-red)]">
										(print)
									</span>
								) : null}
							</span>
						</li>
					))}
				</ul>
				<p className={`${TYPE.caption} mt-3`}>
					All faces are SIL Open Font License 1.1.
				</p>

				<Heading>Inks</Heading>
				<ul className="m-0 grid list-none gap-x-6 p-0 sm:grid-cols-2">
					<li className="flex h-6 items-center gap-3">
						<Dab color={SWISS.paper} seed="paper" />
						<span className={TYPE.caption}>Paper</span>
						<span className={`${TYPE.micro} ml-auto`}>{SWISS.paper}</span>
					</li>
					{INKS.map((ink) => (
						<li key={ink.code} className="flex h-6 items-center gap-3">
							<Dab color={ink.hex} seed={ink.code} />
							<span className={TYPE.caption}>{ink.role}</span>
							<span className={`${TYPE.micro} ml-auto`}>
								{ink.code} · {BREZINE[ink.code].name} · {ink.hex}
							</span>
						</li>
					))}
				</ul>
				<p className={`${TYPE.caption} mt-3`}>
					Every ink is a swatch of the Brezine khipu colour chart, named by its
					Ascher code.
				</p>
			</details>

			<Heading>Credits</Heading>
			<p className={`${TYPE.body} mb-3`}>
				Each figure carries a small credit line: Aufnahme, the source photo,
				with its id and date.
			</p>

			<Heading>Data</Heading>
			<dl className="m-0 space-y-3">
				{SOURCES.map((s) => (
					<div key={s.name}>
						<dt className={TYPE.h3}>{s.name}</dt>
						<dd className="m-0">
							<span className="gb-num">{s.credit}</span>
							<span className={`${TYPE.caption} block`}>{s.note}</span>
						</dd>
					</div>
				))}
			</dl>
			<p className={`${TYPE.caption} mt-3`}>
				Full licence record in the repository.
			</p>
		</section>
	);
}
