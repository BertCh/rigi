// libheif-js ships no typings for its self-contained ESM wasm bundle; we use only this surface.
declare module "libheif-js/libheif-wasm/libheif-bundle.mjs" {
	const factory: () => unknown;
	export default factory;
}
