// Decodes HEIC/HEIF off the main thread with libheif (LGPL-3.0, see ./licenses.ts). libheif is
// NOT bundled into this worker: the page passes the URL of the unmodified libheif-js bundle
// (emitted by Vite as its own file via `?url`) and it is loaded with a dynamic import, so it
// stays a separately replaceable file and one copy serves both the worker and the fallback.
// The transferred RGBA buffer is display-oriented: libheif applies irot/imir.

type HeifImage = {
	get_width(): number;
	get_height(): number;
	display(
		target: { data: Uint8ClampedArray; width: number; height: number },
		cb: (r: unknown) => void,
	): void;
	free?: () => void;
};
type LibHeif = {
	HeifDecoder: new () => { decode(b: Uint8Array): HeifImage[] };
};

let lib: Promise<LibHeif> | null = null;

// Built at runtime on purpose: Vite's dev transform rewrites a visible non-literal import() to
// pull /@vite/client into this worker, and that client's HMR handler touches `document` (throws
// in a worker on every CSS update). A future CSP would need 'unsafe-eval' (the app sets none).
const dynamicImport = new Function("u", "return import(u)") as (
	u: string,
) => Promise<{ default: unknown }>;

self.onmessage = async (
	ev: MessageEvent<{ id: number; buf: ArrayBuffer; libUrl: string }>,
) => {
	const { id, buf, libUrl } = ev.data;
	try {
		lib ??= dynamicImport(libUrl).then((m) => (m.default as () => LibHeif)());
		lib.catch(() => {
			lib = null;
		});
		const images = new (await lib).HeifDecoder().decode(new Uint8Array(buf));
		if (!images.length) throw new Error("no image in HEIC container");
		const im = images[0];
		const width = im.get_width();
		const height = im.get_height();
		const data = new Uint8ClampedArray(width * height * 4);
		const ok = await new Promise<boolean>((res) =>
			im.display({ data, width, height }, (r) => res(!!r)),
		);
		for (const i of images) i.free?.();
		if (!ok) throw new Error("libheif could not decode this image");
		(self as unknown as Worker).postMessage({ id, width, height, data }, [
			data.buffer,
		]);
	} catch (e) {
		(self as unknown as Worker).postMessage({
			id,
			error: (e as Error).message ?? String(e),
		});
	}
};
