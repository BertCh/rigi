// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { type ReactNode, useEffect, useState } from "react";
import { useInView, useReducedMotion } from "#/components/gipfelbuch/viz/hooks";
import { byId } from "#/lib/gipfelbuch/graph-utils";
import {
	NOTEBOOK_ENTRIES,
	type NotebookEntry,
	type NotebookStep,
	STEP_NUMBER,
	stepAnchor,
} from "./entries";
import {
	DemSketch,
	MissSketch,
	PastedPrint,
	SectionSketch,
	SkylineSketch,
	TallyMarks,
	TallySketch,
} from "./figures";
import { PenArrow, PenRule, SketchDefs, SketchPath, StepNumber } from "./Ink";
import {
	NeedsNote,
	noteFor,
	Struck,
	Term,
	useNotebookContext,
	Value,
} from "./notes";
import { PhotoStrip } from "./PhotoStrip";
import { useNotebookPhoto } from "./useNotebookPhoto";
import "./notebook.css";

// The Gipfelbuch core as a field notebook rather than a node-link diagram: three entries that follow
// one real demo photo through the pipeline. Every number on the page is read from the measured data in
// public/demo/gipfelbuch (scripts/gipfelbuch/build-data.ts and friends); picking another photo
// rewrites them all.

function StepRow({
	step,
	note,
	next,
}: {
	step: NotebookStep;
	note: ReactNode;
	/** A following main step: a short pen arrow runs down to it. */
	next?: boolean;
}) {
	const number = STEP_NUMBER.get(step.id) ?? 0;
	// A refuted approach is struck through with a red hand note beside it.
	const status = byId.get(step.id)?.status;
	const refuted = status === "killed";
	const flagged = status === "flagged";
	return (
		<li
			id={stepAnchor(step.id)}
			className={`relative flex scroll-mt-24 gap-3 ${step.fallback ? "ml-6" : ""}`}
		>
			<StepNumber
				value={String(number)}
				color={step.fallback ? "pencil" : "red"}
			/>
			{next ? (
				<svg
					viewBox="0 0 20 18"
					width={20}
					height={18}
					className="pointer-events-none absolute top-[38px] left-2 overflow-visible"
					aria-hidden="true"
				>
					<PenArrow
						seed={`step-next-${step.id}`}
						from={[10, 1]}
						to={[10, 16]}
						head={5}
						bend={0.15}
						color="pencil"
						width={1.2}
					/>
				</svg>
			) : null}
			<div className="min-w-0 pt-0.5">
				<p className="text-[16px] leading-snug">
					{step.fallback ? (
						<span className="nb-hand mr-1.5 text-[16px] text-[var(--nb-pencil)]">
							if refused →
						</span>
					) : null}
					<Term id={step.id}>
						{refuted ? (
							<Struck plain seed={`killed-${step.id}`}>
								{step.label}
							</Struck>
						) : (
							step.label
						)}
					</Term>
					{refuted || flagged ? (
						<span
							className={`nb-hand ml-2 text-[17px] ${refuted ? "text-[var(--nb-red)]" : "text-[var(--nb-brown)]"}`}
						>
							{refuted ? "killed" : "flagged"}
						</span>
					) : null}
				</p>
				<p className="mt-0.5 text-[13px] leading-relaxed text-[color-mix(in_srgb,var(--nb-ink)_78%,transparent)]">
					{note}
				</p>
				{step.needs?.length ? (
					<div className="mt-1 flex flex-col">
						{step.needs.map((need) => (
							<NeedsNote key={need.id} need={need} />
						))}
					</div>
				) : null}
			</div>
		</li>
	);
}

/** One notebook entry: margin number, hub title, the question in pen, numbered steps and pasted evidence. */
function Entry({
	entry,
	number,
	note,
	figure,
}: {
	entry: NotebookEntry;
	number: number;
	note: (step: NotebookStep) => ReactNode;
	figure: ReactNode;
}) {
	const [ref, inView] = useInView<HTMLElement>();
	const reducedMotion = useReducedMotion();
	const [armed, setArmed] = useState(false);
	useEffect(() => {
		setArmed(!reducedMotion && !navigator.webdriver);
	}, [reducedMotion]);
	const hub = byId.get(entry.hub);
	return (
		<section
			ref={ref}
			aria-labelledby={`nb-entry-${entry.key}`}
			className={`nb-page relative py-10 md:pl-[92px] ${armed ? "nb-armed" : ""} ${inView ? "nb-on" : ""}`}
		>
			{entry.groups.map((group) => (
				<span
					key={group}
					id={`group-${group}`}
					className="absolute top-0 scroll-mt-20"
					aria-hidden
				/>
			))}
			<p
				className="absolute top-7 left-2 hidden items-center md:flex"
				aria-hidden
			>
				<span className="nb-hand text-[22px] leading-none text-[var(--nb-red)]">
					p.
				</span>
				<StepNumber value={String(number)} />
			</p>
			<header className="mb-6 max-w-3xl">
				<h2
					id={`nb-entry-${entry.key}`}
					className="nb-hand text-[36px] leading-[38px] font-normal"
				>
					<Term id={entry.hub}>{entry.title}</Term>
				</h2>
				<div className="mt-1 w-1/3 max-w-[220px]">
					<PenRule
						seed={`entry-rule-${entry.key}`}
						color="red"
						opacity={0.7}
						width={1.3}
					/>
				</div>
				<p className="nb-hand mt-1.5 text-[21px] leading-[26px] text-[var(--nb-pencil)]">
					{entry.question}
				</p>
				{hub?.lede ? (
					<p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-[color-mix(in_srgb,var(--nb-ink)_70%,transparent)]">
						{hub.lede}
					</p>
				) : null}
			</header>
			<div className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
				<ol className="space-y-4">
					{entry.steps.map((step) => (
						<StepRow key={step.id} step={step} note={note(step)} />
					))}
				</ol>
				<div className="min-w-0">{figure}</div>
			</div>
		</section>
	);
}

/** The Gipfelbuch core, as a field notebook following one measured photo through the pipeline. */
export function NotebookMap({ className }: { className?: string }) {
	const [photoId, setPhotoId] = useNotebookPhoto();
	const context = useNotebookContext();
	const { data, index } = context;
	const accepted = index?.photos.filter((photo) => photo.accepted) ?? [];
	const refused = index?.photos.filter((photo) => !photo.accepted) ?? [];
	const refined = accepted.filter((photo) => photo.stage !== "solve");

	const note = (step: NotebookStep) => noteFor(step, context);

	const [infer, terrainEntry, app] = NOTEBOOK_ENTRIES;
	return (
		<div className={className} data-testid="gipfelbuch-notebook">
			<SketchDefs />
			<article className="nb-book mx-auto max-w-[1180px] px-4 pt-6 pb-10 sm:px-8">
				<header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5 pb-4 md:pl-[92px]">
					<div>
						<p className="nb-label text-[11px] text-[var(--nb-brown)]">
							Feldbuch · {index?.place ?? "Niederhorn above Lake Thun"}
						</p>
						<p className="mt-1.5 max-w-xl text-[13px] leading-relaxed">
							One photo, followed from phone to terrain and back. Pick another
							photo and every number updates.
						</p>
					</div>
					<PhotoStrip index={index} selected={photoId} onSelect={setPhotoId} />
				</header>

				<Entry
					entry={infer}
					number={1}
					note={note}
					figure={
						data ? (
							<div className="space-y-7">
								<PastedPrint
									seed={`print-${data.id}`}
									caption={`${data.id} · skyline band`}
								>
									<SkylineSketch data={data} />
								</PastedPrint>
								<Legend refused={!data.solved.accepted} />
								<div>
									<p className="nb-hand text-[16px] leading-tight">
										median miss, before → after the solve
									</p>
									<MissSketch data={data} />
								</div>
							</div>
						) : (
							<Placeholder />
						)
					}
				/>

				<Entry
					entry={terrainEntry}
					number={2}
					note={note}
					figure={
						data ? (
							<div className="space-y-8">
								<PastedPrint
									seed={`dem-${data.id}`}
									caption={`relief shading, ±${data.demPatch.halfKm} km, north up`}
									className="mx-auto max-w-[400px]"
								>
									<DemSketch data={data} />
								</PastedPrint>
								<div>
									<p className="nb-hand text-[16px] leading-tight">
										the ground straight ahead
									</p>
									<SectionSketch data={data} />
									<p className="mt-2 text-[13px] leading-relaxed text-[var(--nb-faint)]">
										Brown ticks: ridge crests on this bearing. Red dashes: the
										sight line grazing the farthest one.
									</p>
								</div>
							</div>
						) : (
							<Placeholder />
						)
					}
				/>

				<Entry
					entry={app}
					number={3}
					note={note}
					figure={
						index ? (
							<div className="space-y-3">
								<p className="nb-hand text-[16px] leading-tight">
									compass error for all twelve photos (click one)
								</p>
								<TallySketch
									photos={index.photos}
									selected={photoId}
									onSelect={setPhotoId}
								/>
								<div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
									<span className="flex items-center gap-2">
										<TallyMarks count={accepted.length} seed="tally-ok" />
										<span>
											<Value>{accepted.length}</Value> solved
											{refined.length ? (
												<>
													{" "}
													(<Value>{refined.length}</Value> after refinement)
												</>
											) : null}
										</span>
									</span>
									<span className="flex items-center gap-2">
										<TallyMarks count={refused.length} seed="tally-no" />
										<span>
											<Value>{refused.length}</Value> refused →{" "}
											<Term id="tap-a-peak">tap a peak</Term>
										</span>
									</span>
								</div>
							</div>
						) : (
							<Placeholder />
						)
					}
				/>

				<footer className="mt-4 text-[13px] leading-relaxed text-[var(--nb-faint)] md:pl-[92px]">
					Measured data; only the pen marks are hand-drawn.
				</footer>
			</article>
		</div>
	);
}

function Legend({ refused }: { refused: boolean }) {
	const items: {
		label: string;
		stroke: string;
		dash?: string;
		width: number;
	}[] = [
		{ label: "skyline in photo", stroke: "var(--nb-pencil)", width: 2.4 },
		{
			label: "horizon at phone's guess",
			stroke: "var(--nb-blue)",
			dash: "7 5",
			width: 2.2,
		},
		{
			label: refused ? "horizon at refused pose" : "horizon at solved pose",
			stroke: "var(--nb-red)",
			width: 1.8,
		},
	];
	return (
		<ul className="flex flex-wrap gap-x-5 gap-y-1">
			{items.map((item) => (
				<li
					key={item.label}
					className="nb-hand flex items-center gap-2 text-[16px]"
				>
					<svg width="34" height="8" aria-hidden="true">
						<SketchPath
							d="M1 4L33 4"
							seed={`legend-${item.label}`}
							color={item.stroke}
							width={item.width}
							dash={item.dash}
							passes={1}
							data
						/>
					</svg>
					{item.label}
				</li>
			))}
		</ul>
	);
}

function Placeholder() {
	return (
		<p className="nb-hand py-16 text-center text-[18px] text-[var(--nb-faint)]">
			opening the notebook…
		</p>
	);
}
