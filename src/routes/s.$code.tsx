// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Read-only share view (share-link beta, roadmap L1; src/lib/share). Gated by ?share=on until the
// N2 licence review clears. Decodes the code, loads the bundled demo photo like /photo/$id and
// opens the workspace in shared mode: the shared pose, no auto-align, nothing persisted, watermark.
import { createFileRoute, Link, useRouterState } from "@tanstack/react-router";
import { PhotoWorkspace } from "#/components/PhotoWorkspace";
import { SITE_THEME } from "#/components/site/SiteNav";
import { flagsKey, getFlag } from "#/lib/flags";
import { useFlag } from "#/lib/flags/react";
import { getPhoto, type PhotoMeta } from "#/lib/photos";
import { decodeShare, type SharePayload } from "#/lib/share";

type Loaded =
	| { kind: "gated" }
	| { kind: "invalid" }
	| { kind: "ok"; photo: PhotoMeta; share: SharePayload };

export const Route = createFileRoute("/s/$code")({
	ssr: false,
	loader: async ({ params }): Promise<Loaded> => {
		if (getFlag("share") !== "on") return { kind: "gated" };
		const share = decodeShare(params.code);
		if (!share) return { kind: "invalid" };
		// the sample trip (public/demo): registered with photos.ts on first use
		const demo = await import("#/lib/demo");
		await demo.demoPose(share.photo.id).catch(() => null);
		const photo = getPhoto(share.photo.id);
		return photo ? { kind: "ok", photo, share } : { kind: "invalid" };
	},
	head: () => ({ meta: [{ title: "Shared view · Rigi" }] }),
	component: SharePage,
});

function SharePage() {
	const loaded = Route.useLoaderData();
	const { code } = Route.useParams();
	const share = useFlag("share");
	const flags = useRouterState({
		select: (s) => flagsKey(s.location.searchStr),
	});
	if (share !== "on" || loaded.kind === "gated")
		return <Notice text="Share links are not public yet." />;
	if (loaded.kind === "invalid")
		return <Notice text="This share link is not valid." />;
	return (
		<PhotoWorkspace
			key={`${code}?${flags}`}
			photo={loaded.photo}
			shared={{ pose: loaded.share.pose, state: loaded.share.state }}
		/>
	);
}

function Notice({ text }: { text: string }) {
	return (
		<main
			className={`${SITE_THEME} flex flex-col items-center justify-center gap-4 px-4 text-center`}
			data-share-notice=""
		>
			<p className="text-lg font-semibold">{text}</p>
			<Link
				to="/"
				className="text-sm text-[var(--rigi-glow)] underline-offset-4 hover:underline"
			>
				Go to Rigi
			</Link>
		</main>
	);
}
