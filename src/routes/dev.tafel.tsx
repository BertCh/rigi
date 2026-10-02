// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { createFileRoute, Link } from "@tanstack/react-router";
import { GB_THEME } from "#/components/gipfelbuch/swiss";
import { TYPE } from "#/components/gipfelbuch/swiss/type";
import { Blattuebersicht, Ledger, Tafel } from "#/components/gipfelbuch/tafel";
import {
	GIPFELBUCH_PHOTO_IDS,
	type GipfelbuchPhotoId,
	useGipfelbuchPhoto,
} from "#/components/gipfelbuch/viz/real";
import { SiteNav } from "#/components/site/SiteNav";
import { GIPFELBUCH_NODES } from "#/lib/gipfelbuch/graph";
import { GROUP_BY_ID } from "#/lib/gipfelbuch/graph-utils";

const SHEET_ID = "skyline";
const SHEET_INDEX = GIPFELBUCH_NODES.findIndex((n) => n.id === SHEET_ID);
const SHEET_NODE = GIPFELBUCH_NODES[SHEET_INDEX];

// Preview of the Tafel (src/components/gipfelbuch/tafel): sheet header, ledger and the hero.
export const Route = createFileRoute("/dev/tafel")({
	ssr: false,
	validateSearch: (s: Record<string, unknown>): { id?: string } => ({
		id: typeof s.id === "string" ? s.id : undefined,
	}),
	head: () => ({ meta: [{ title: "Tafel" }] }),
	component: PreviewGate,
});

function PreviewGate() {
	if (!import.meta.env.DEV) return <p>dev only</p>;
	return <Preview />;
}

function Preview() {
	const { id: raw } = Route.useSearch();
	const navigate = Route.useNavigate();
	const id = (GIPFELBUCH_PHOTO_IDS as readonly string[]).includes(raw ?? "")
		? (raw as GipfelbuchPhotoId)
		: "demo-01";
	const d = useGipfelbuchPhoto(id);
	return (
		<main className={`${GB_THEME} pb-20`}>
			<SiteNav active="gipfelbuch" />
			<section className="mx-auto max-w-6xl overflow-x-clip px-4 pt-10 sm:px-8">
				<header className="grid items-end gap-8 sm:grid-cols-[minmax(0,8fr)_minmax(0,4fr)] sm:gap-12">
					<div>
						<p className={`${TYPE.kicker} flex gap-3.5`}>
							<span className="font-mono" style={{ color: "var(--gb-red)" }}>
								Blatt {String(SHEET_INDEX + 1).padStart(2, "0")} /{" "}
								{GIPFELBUCH_NODES.length}
							</span>
							<span className="gb-secondary">
								{GROUP_BY_ID[SHEET_NODE.group].label}
							</span>
						</p>
						<h1 className={`${TYPE.display} mt-4`}>{SHEET_NODE.title}</h1>
						<p className="gb-secondary mt-3 font-[family-name:var(--gb-font-serif)] text-[20px] italic leading-[24px] sm:text-[24px] sm:leading-[30px]">
							Where the mountain meets the sky.
						</p>
						<p className={`${TYPE.lead} gb-secondary mt-4 max-w-[640px]`}>
							The skyline is the one line a phone photo reliably shows. Rigi
							traces it column by column and says how sure it is of each, so the
							pose search trusts the crests and ignores the glare.
						</p>
					</div>
					{d && (
						<Ledger
							items={[
								{
									value: String(d.skyline.weight.filter((v) => v > 0).length),
									unit: "/ 800",
									label: "columns vote;\nthe rest abstain",
									path: "skyline.weight",
								},
								{
									value: d.residual.solved.median.toFixed(1),
									unit: "px",
									label: "median miss against\nthe terrain, once solved",
									path: "residual.solved.median",
								},
								{
									value: String(d.ms.skyline),
									unit: "ms",
									label: "on a laptop CPU,\n800 px wide",
									path: "ms.skyline",
								},
							]}
							note="re-read from this photo's run"
						/>
					)}
				</header>
				<nav
					className={`${TYPE.micro} mt-8 mb-4 flex flex-wrap gap-x-4 gap-y-1`}
				>
					{GIPFELBUCH_PHOTO_IDS.map((p) => (
						<Link
							key={p}
							to="/dev/tafel"
							search={{ id: p }}
							className={p === id ? "font-semibold underline" : "gb-secondary"}
						>
							{p}
						</Link>
					))}
				</nav>
			</section>
			<div className="overflow-x-clip">
				<Tafel photo={id} />
			</div>
			<section className="mx-auto max-w-6xl px-4 pt-10 sm:px-8">
				<Blattuebersicht
					followed={id}
					onFollow={(next) => navigate({ search: { id: next } })}
				/>
			</section>
		</main>
	);
}
