// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link, useNavigate } from "@tanstack/react-router";
import { byId } from "#/lib/gipfelbuch/graph-utils";
import { TYPE } from "../swiss/type";
import {
	NOTEBOOK_ENTRIES,
	type NotebookEntry,
	type NotebookStep,
	STEP_NUMBER,
} from "./entries";
import {
	HandText,
	PenArrow,
	PenCircle,
	PenLine,
	PenRule,
	StepNumber,
} from "./Ink";
import { noteFor, Term, useNotebookContext } from "./notes";
import { PhotoStrip } from "./PhotoStrip";
import { useNotebookPhoto } from "./useNotebookPhoto";

// The notebook on a concept page: a field-notes strip (this concept's measured note for the photo the
// reader is following) and a hand-drawn trail of the notebook around it, replacing the force graph.

interface Placement {
	entry: NotebookEntry;
	entryNumber: number;
	step: NotebookStep | null;
}

/** Where a concept sits in the notebook: its entry, and its step (null for an entry's hub). */
export function placeConcept(id: string): Placement | null {
	for (const [index, entry] of NOTEBOOK_ENTRIES.entries()) {
		if (entry.hub === id) return { entry, entryNumber: index + 1, step: null };
		const step = entry.steps.find((candidate) => candidate.id === id);
		if (step) return { entry, entryNumber: index + 1, step };
	}
	return null;
}

/** Steps on any page whose `needs` name this concept: where its output goes. */
const feedsOf = (id: string) =>
	NOTEBOOK_ENTRIES.flatMap((entry) =>
		entry.steps.flatMap((step) =>
			(step.needs ?? [])
				.filter((need) => need.id === id)
				.map((need) => ({ id: step.id, what: need.what })),
		),
	);

/** Measured field note for this concept, for the photo followed across the Gipfelbuch. */
export function FieldNotes({
	id,
	strip = true,
	className,
}: {
	id: string;
	/** Show the photo strip; off where the sheet already has a photo picker. */
	strip?: boolean;
	className?: string;
}) {
	const placement = placeConcept(id);
	const context = useNotebookContext();
	const [photoId, setPhotoId] = useNotebookPhoto();
	if (!placement) return null;
	const { entry, entryNumber, step } = placement;
	const steps = step ? [step] : entry.steps;
	return (
		// F3 (Grinnell pair): the raw field note sits in the margin beside the fair-copy lede; inline
		// below lg. It owns grid row 1, columns 9-12 of ConceptPage.
		<aside
			aria-label="Field notes"
			className={
				className ??
				"nb-book my-6 min-w-0 px-4 py-3 lg:col-[margin-start/full-end] lg:row-start-1 lg:my-0"
			}
		>
			<div className="inline-block max-w-full">
				<p className="nb-label text-[11px] leading-[12px] text-[var(--nb-brown)]">
					Feldbuch · p.{entryNumber}
					{step ? ` · step ${STEP_NUMBER.get(step.id)}` : ""}
				</p>
				<div className="mt-1 w-2/5">
					<PenRule
						seed={`fieldnotes-rule-${entryNumber}`}
						color="red"
						opacity={0.7}
						width={1.2}
					/>
				</div>
			</div>
			{strip && (
				<div className="mt-3">
					<PhotoStrip
						small
						index={context.index}
						selected={photoId}
						onSelect={setPhotoId}
					/>
				</div>
			)}
			<ul className="mt-3 space-y-1.5">
				{steps.map((current) => (
					<li
						key={current.id}
						className={`${TYPE.caption} flex items-start gap-1`}
					>
						<span className="-mt-1.5 -ml-1.5 shrink-0">
							<StepNumber
								value={String(STEP_NUMBER.get(current.id))}
								color="red"
							/>
						</span>
						<span>
							{step ? null : (
								<>
									<Term id={current.id}>{current.label}</Term>:{" "}
								</>
							)}
							<span className="gb-ink">{noteFor(current, context)}</span>
						</span>
					</li>
				))}
			</ul>
			<p className="nb-hand mt-3 text-[18px] leading-[24px] text-[var(--nb-pencil)]">
				measured on {photoId}; pick another photo to update
			</p>
		</aside>
	);
}

const TRAIL_WIDTH = 1000;
const ROW_Y = 132;

/** The notebook around this concept, drawn as a pen trail: its entry's chain, with incoming and outgoing notes. */
export function NotebookTrail({ id }: { id: string }) {
	const navigate = useNavigate();
	const placement = placeConcept(id);
	if (!placement) return null;
	const { entry, entryNumber, step } = placement;
	const main = entry.steps.filter((candidate) => !candidate.fallback);
	const fallbacks = entry.steps.filter((candidate) => candidate.fallback);
	const gap = (TRAIL_WIDTH - 140) / Math.max(1, main.length - 1);
	const position = new Map<string, [number, number]>();
	main.forEach((candidate, index) => {
		position.set(candidate.id, [70 + index * gap, ROW_Y]);
	});
	for (const fallback of fallbacks) {
		// A fallback hangs below the step before it in the entry's order.
		const order = entry.steps.indexOf(fallback);
		const before = entry.steps[order - 2] ?? entry.steps[order - 1];
		const [bx] = position.get(before?.id ?? "") ?? [TRAIL_WIDTH / 2, ROW_Y];
		position.set(fallback.id, [bx, ROW_Y + 118]);
	}
	const trailHeight = fallbacks.length ? 320 : 220;
	const needs = step?.needs ?? [];
	const feeds = step ? feedsOf(step.id) : [];
	const here = step ? position.get(step.id) : null;
	const open = (target: string) =>
		navigate({ to: "/gipfelbuch/$concept", params: { concept: target } });

	return (
		<figure className="my-2">
			<svg
				viewBox={`0 0 ${TRAIL_WIDTH} ${trailHeight}`}
				className="block w-full"
				role="img"
				aria-label={`Page ${entryNumber} of the notebook, ${entry.title}: ${entry.steps.map((candidate) => `${STEP_NUMBER.get(candidate.id)} ${candidate.label}`).join(", ")}.`}
			>
				<HandText x={20} y={34} size={24} color="red">
					p.{entryNumber} · {entry.title}
				</HandText>
				{main.slice(0, -1).map((candidate, index) => {
					const from = position.get(candidate.id) as [number, number];
					const to = position.get(main[index + 1].id) as [number, number];
					return (
						<PenArrow
							key={candidate.id}
							seed={`trail-${candidate.id}`}
							from={[from[0] + 26, from[1]]}
							to={[to[0] - 26, to[1]]}
							bend={index % 2 ? 0.08 : -0.08}
							color="pencil"
							width={1.3}
						/>
					);
				})}
				{fallbacks.map((fallback) => {
					const [x, y] = position.get(fallback.id) as [number, number];
					return (
						<g key={fallback.id}>
							<PenArrow
								seed={`trail-fallback-${fallback.id}`}
								from={[x, ROW_Y + 58]}
								to={[x, y - 24]}
								bend={0.12}
								color="pencil"
								width={1.1}
							/>
							<HandText x={x + 14} y={ROW_Y + 82} size={16} color="faint">
								if refused
							</HandText>
						</g>
					);
				})}
				{entry.steps.map((candidate) => {
					const [x, y] = position.get(candidate.id) as [number, number];
					const isHere = candidate.id === id;
					const label = candidate.label;
					return (
						// biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be an <a>
						<g
							key={candidate.id}
							role="link"
							tabIndex={0}
							aria-label={`${STEP_NUMBER.get(candidate.id)} ${label}`}
							aria-current={isHere ? "page" : undefined}
							className="cursor-pointer"
							onClick={() => open(candidate.id)}
							onKeyDown={(event) => {
								if (event.key === "Enter") open(candidate.id);
							}}
						>
							<circle cx={x} cy={y} r={30} fill="transparent" />
							<PenCircle
								seed={`trail-ring-${candidate.id}`}
								center={[x, y]}
								radiusX={isHere ? 24 : 19}
								radiusY={isHere ? 21 : 17}
								color={isHere ? "red" : "ink"}
								width={isHere ? 2.2 : 1.3}
							/>
							<HandText
								x={x}
								y={y + 8}
								anchor="middle"
								size={isHere ? 26 : 21}
								color={isHere ? "red" : "ink"}
							>
								{STEP_NUMBER.get(candidate.id)}
							</HandText>
							<HandText
								x={x}
								y={y + (isHere ? 52 : 46)}
								anchor="middle"
								size={isHere ? 21 : 18}
								color={isHere ? "ink" : "pencil"}
							>
								{label}
							</HandText>
						</g>
					);
				})}
				{here ? (
					<g>
						<HandText
							x={here[0]}
							y={here[1] - 78}
							anchor="middle"
							color="red"
							size={17}
							rotate={-2}
						>
							you are here
						</HandText>
						<PenArrow
							seed={`trail-here-${id}`}
							from={[here[0], here[1] - 70]}
							to={[here[0], here[1] - 29]}
							bend={0.2}
							color="red"
							width={1.4}
							delay={500}
						/>
					</g>
				) : null}
				{here
					? needs.map((need, index) => {
							const textY = here[1] - 56 - index * 24;
							return (
								<g key={`need-${need.id}`}>
									<HandText
										x={here[0] - 64}
										y={textY}
										anchor="end"
										color="blue"
										size={17}
									>
										{need.what} ← ({STEP_NUMBER.get(need.id)}){" "}
										{byId.get(need.id)?.title}
									</HandText>
									<PenArrow
										seed={`trail-need-${need.id}`}
										from={[here[0] - 58, textY - 5]}
										to={[here[0] - 12, here[1] - 24]}
										bend={0.18}
										color="blue"
										width={1.2}
									/>
								</g>
							);
						})
					: null}
				{here
					? feeds.map((feed, index) => {
							const textY = here[1] - 56 - index * 24;
							return (
								<g key={`feed-${feed.id}`}>
									<PenArrow
										seed={`trail-feed-${feed.id}`}
										from={[here[0] + 12, here[1] - 24]}
										to={[here[0] + 58, textY - 5]}
										bend={0.18}
										color="brown"
										width={1.2}
									/>
									<HandText x={here[0] + 64} y={textY} color="brown" size={17}>
										→ ({STEP_NUMBER.get(feed.id)}) {byId.get(feed.id)?.title}:{" "}
										{feed.what}
									</HandText>
								</g>
							);
						})
					: null}
				<PenLine
					seed="trail-rule"
					from={[20, trailHeight - 10]}
					to={[TRAIL_WIDTH - 20, trailHeight - 10]}
					color="faint"
					width={0.8}
				/>
			</svg>
			<figcaption className="mt-1 text-[13px] leading-relaxed text-[color-mix(in_srgb,var(--nb-ink)_65%,transparent)]">
				Where this sits in the notebook. Blue notes come in from other pages,
				brown ones go out.{" "}
				<Link
					to="/gipfelbuch"
					hash={`group-${byId.get(entry.hub)?.group ?? ""}`}
					className="underline underline-offset-2"
				>
					Open the full notebook
				</Link>
				.
			</figcaption>
		</figure>
	);
}
