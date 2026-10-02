// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { BREZINE } from "#/brand/khipu";
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

const FACES = [
	{
		name: "GB Serif",
		source: "Source Serif 4",
		use: "Titles, cartouche",
		family: "var(--gb-font-serif)",
	},
	{
		name: "GB Sans",
		source: "Fira Sans",
		use: "Text, captions",
		family: "var(--gb-font-sans)",
	},
	{
		name: "GB Sans Condensed",
		source: "Fira Sans Condensed",
		use: "Caps heads, kickers",
		family: "var(--gb-font-condensed)",
	},
	{
		name: "GB Mono",
		source: "Fira Mono",
		use: "Figures, coordinates",
		family: "var(--gb-font-mono)",
	},
	{
		name: "GB Hand",
		source: "Caveat",
		use: "Field notes",
		family: "var(--gb-font-hand)",
	},
	{
		name: "GB Hand Small",
		source: "Shantell Sans",
		use: "Small hand notes",
		family: "var(--gb-font-hand-small)",
	},
];

const IMPRINT_ROLES = [
	{
		term: "Aufnahme",
		meaning: "Survey: the source photo or DEM tile, with its id and date.",
	},
	{
		term: "Revision",
		meaning: "The pipeline stage that measured it.",
	},
	{
		term: "Stich",
		meaning: "Engraving: the Rigi renderer that drew it.",
	},
];

// Attribution strings exactly as recorded in NOTICE.md and reports/licences.md.
const SOURCES = [
	{
		name: "Mapterhorn terrain tiles",
		credit: "© Mapterhorn",
		note: "mapterhorn.com/attribution. Data under the licence of each underlying national DEM; tile code BSD-3.",
	},
	{
		name: "swisstopo relief shading (swissALTI3D Reliefschattierung)",
		credit: "Relief © swisstopo · DEM Mapterhorn",
		note: "Swiss open government data, baked once; contours derived from the Mapterhorn DEM.",
	},
	{
		name: "swissNAMES3D 2026",
		credit: "© swisstopo",
		note: "Peaks and places, via the Thunersee terroir pack. swisstopo OGD (free use, attribution).",
	},
];

function Heading({ children }: { children: string }) {
	return (
		<h2 className={`${TYPE.kicker} mt-12 mb-3 tracking-[0.18em]`}>
			{children}
		</h2>
	);
}

/** F2 / P6 colophon page: the edition's faces, inks, paper, imprint roles and data credits. */
export function Colophon({ className }: { className?: string }) {
	return (
		<section
			aria-labelledby="colophon-title"
			className={`gb-colophon max-w-[66ch] ${className ?? ""}`}
		>
			<p className={`${TYPE.kicker} tracking-[0.2em]`}>
				Gipfelbuch · Ausgabe 2026
			</p>
			<h1 id="colophon-title" className={`${TYPE.h1} mt-3`}>
				Colophon
			</h1>
			<p className={`${TYPE.body} mt-6`}>
				Set according to{" "}
				<code className="gb-num">reports/gipfelbuch-design-book.md</code>.
			</p>

			<Heading>Faces</Heading>
			<table className="gb-table">
				<tbody>
					{FACES.map((f) => (
						<tr key={f.name} className="h-6">
							<th scope="row" className="py-0 text-left font-normal">
								<span className={TYPE.body} style={{ fontFamily: f.family }}>
									{f.name}
								</span>
							</th>
							<td>{f.source}</td>
							<td className="gb-secondary">{f.use}</td>
						</tr>
					))}
				</tbody>
			</table>
			<p className={`${TYPE.caption} mt-3`}>
				All faces are SIL Open Font License 1.1, self-hosted from
				public/fonts/gipfelbuch (see its LICENSES.md).
			</p>

			<Heading>Inks</Heading>
			<ul className="m-0 grid list-none gap-x-6 p-0 sm:grid-cols-2">
				<li className="flex h-6 items-center gap-3">
					<span
						aria-hidden="true"
						className="inline-block size-4 shrink-0"
						style={{ background: SWISS.paper }}
					/>
					<span className={TYPE.caption}>Paper (W 90 %, YY 10 %)</span>
					<span className={`${TYPE.micro} ml-auto`}>{SWISS.paper}</span>
				</li>
				{INKS.map((ink) => (
					<li key={ink.code} className="flex h-6 items-center gap-3">
						<span
							aria-hidden="true"
							className="inline-block size-4 shrink-0"
							style={{ background: ink.hex }}
						/>
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

			<Heading>Imprint</Heading>
			<p className={`${TYPE.body} mb-3`}>
				After the Siegfried map, each figure credits three roles.
			</p>
			<dl className="m-0 grid grid-cols-[6.5rem_1fr] gap-y-1.5">
				{IMPRINT_ROLES.map((r) => (
					<div key={r.term} className="contents">
						<dt className={`${TYPE.kicker} pt-0.5`}>{r.term}</dt>
						<dd className={`${TYPE.body} m-0`}>{r.meaning}</dd>
					</div>
				))}
			</dl>

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
				Full licence record: NOTICE.md and reports/licences.md.
			</p>
		</section>
	);
}
