import {
	createFileRoute,
	notFound,
	useRouterState,
} from "@tanstack/react-router";
import { PhotoWorkspace } from "#/components/PhotoWorkspace";
import type { Pose } from "#/lib/camera";
import { flagsKey } from "#/lib/flags";
import { getPhoto, type PhotoMeta } from "#/lib/photos";

export const Route = createFileRoute("/photo/$id")({
	ssr: false,
	loader: async ({
		params,
	}): Promise<{ photo: PhotoMeta; bundledPose: Pose | null }> => {
		let photo = getPhoto(params.id);
		let bundledPose: Pose | null = null;
		if (params.id.startsWith("demo-")) {
			// the sample trip (public/demo): registered with photos.ts on first use, with its solved pose
			const demo = await import("#/lib/demo");
			bundledPose = await demo.demoPose(params.id).catch(() => null);
			photo = getPhoto(params.id);
		}
		if (!photo && params.id.startsWith("local-")) {
			// uploaded photos live in IndexedDB; the upload module re-registers them after a reload
			const mods = import.meta.glob<{
				ensureLocalPhotoRegistered?: (id: string) => Promise<unknown | null>;
			}>("../lib/upload/index.ts");
			const load = Object.values(mods)[0];
			const mod = load ? await load() : null;
			if (
				mod?.ensureLocalPhotoRegistered &&
				(await mod.ensureLocalPhotoRegistered(params.id)) != null
			)
				photo = getPhoto(params.id);
		}
		if (!photo) throw notFound();
		return { photo, bundledPose };
	},
	head: ({ params }) => ({ meta: [{ title: `${params.id} · Rigi` }] }),
	component: PhotoPage,
});

function PhotoPage() {
	const { photo, bundledPose } = Route.useLoaderData();
	// key: a fresh engine per photo, and per set of engine-start flags (RESTART_FLAGS); the rest apply live
	const flags = useRouterState({
		select: (s) => flagsKey(s.location.searchStr),
	});
	return (
		<PhotoWorkspace
			key={`${photo.id}?${flags}`}
			photo={photo}
			bundledPose={bundledPose}
		/>
	);
}
