# public/tiles3d

- `draco/`: Draco decoder for 3D Tiles (Apache-2.0, see `draco/LICENSE`).
- `google-maps-logo.png` (NOT in the repository): when `?tiles3d=google` is on, `Tiles3DCredit`
  (src/components/nearfield/Tiles3DCredit.tsx) requests this file and shows it before the per-tile
  copyrights, as the Google Map Tiles policies require. Google supplies the official logo assets
  (https://developers.google.com/maps/documentation/tile/policies); download the white variant for dark
  backgrounds, save it here at about 14 px height (2x for retina) and do not alter it. Without the file the
  credit line shows the plain text "Google Maps" instead, which does not satisfy the logo rule: do not
  enable Google tiles in a public deployment until the file is added.
