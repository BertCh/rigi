import { createFileRoute, notFound } from "@tanstack/react-router";
import { PhotoWorkspace } from "#/components/PhotoWorkspace";
import { getPhoto } from "#/lib/photos";

export const Route = createFileRoute("/photo/$id")({
	ssr: false,
	loader: async ({ params }) => {
		let photo = getPhoto(params.id);
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
		return photo;
	},
	head: ({ params }) => ({ meta: [{ title: `${params.id} · Summit Lens` }] }),
	component: PhotoPage,
});

function PhotoPage() {
	const photo = Route.useLoaderData();
	// key: fresh engine per photo
	return <PhotoWorkspace key={photo.id} photo={photo} />;
}
