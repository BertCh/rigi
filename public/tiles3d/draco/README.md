# Draco decoder

`draco_decoder.wasm` and `draco_wasm_wrapper.js` are Google's Draco 3D geometry decoder (https://github.com/google/draco), licensed under Apache-2.0 (`LICENSE` in this folder).

They were copied from the default (non-glTF) builds in `three/examples/jsm/libs/draco/` of three.js 0.186.1 (three.js is no longer a dependency). The Draco release number is not stated in the files; that folder's README says the default build tracks Draco's master branch. loaders.gl's Draco worker (`src/lib/tiles3d/draco-options.ts`) loads them to decode the Draco-compressed glTF meshes of the 3D Tiles sources (`src/lib/tiles3d/tiles.ts`).
