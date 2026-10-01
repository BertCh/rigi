import { createFileRoute } from "@tanstack/react-router";
import { HowItWorksScene } from "#/components/site/how/HowItWorksScene";
import { SITE_THEME, SiteNav } from "#/components/site/SiteNav";

// Preview of the "how it works" scene on its own (src/components/site/how). ?t=12 freezes it at
// that second, for screenshots.
export const Route = createFileRoute("/dev/how-scene")({
	ssr: false,
	validateSearch: (s: Record<string, unknown>): { t?: number } => ({
		t: s.t === undefined ? undefined : Number(s.t),
	}),
	head: () => ({ meta: [{ title: "How Rigi works" }] }),
	component: Preview,
});

function Preview() {
	const { t } = Route.useSearch();
	return (
		<main className={`${SITE_THEME} pb-20`}>
			<SiteNav />
			<section className="mx-auto max-w-6xl px-4 pt-12 sm:px-8">
				<p className="mb-3 font-mono text-[11px] tracking-[0.18em] text-[var(--rigi-glow)] uppercase">
					How it works
				</p>
				<h1 className="mb-8 max-w-3xl text-[2rem] leading-[1.08] font-semibold tracking-[-0.02em] sm:text-[2.6rem]">
					From a compass guess to a camera that fits the mountains.
				</h1>
				<HowItWorksScene at={Number.isFinite(t) ? t : undefined} />
			</section>
		</main>
	);
}
