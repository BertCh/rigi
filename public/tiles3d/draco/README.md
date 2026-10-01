# Draco decoder

`draco_decoder.wasm` and `draco_wasm_wrapper.js` are Google's Draco 3D geometry decoder (https://github.com/google/draco), licensed under Apache-2.0 (`LICENSE` in this folder).

They are byte-identical to the default (non-glTF) builds in `three/examples/jsm/libs/draco/` of three.js 0.186.1 (`node_modules/three`), which three.js ships for `DRACOLoader`. The Draco release number is not stated in the files; the three.js folder README says the default build tracks Draco's master branch. They decode the Draco-compressed glTF meshes of the 3D Tiles sources (`src/lib/tiles3d/tiles.ts`).
