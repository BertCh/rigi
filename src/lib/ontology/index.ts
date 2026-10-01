// The Rigi ontology: one vocabulary and one set of semantic primitives for the whole app.
// See README.md here and the generated reports/ontology.md.
//
//   core/quantity     L0 soft-branded units (Deg, Metres, Height<Datum>, Px<Basis>, Norm, Prob), datums, pixel bases
//   core/geometry     L1 Vec3/Mat3, LatLon/GeoPoint, frames, Direction, ImagePoint, BBox (+ order converters)
//   core/provenance   L3 agent · method · evidence · role · status · outcome; the Provenance sidecar
//   core/confidence   L3 scale-aware confidence and comparable levels
//   core/resolution   L3 named policies for choosing among estimates (rollDisplay, rollStateless, evaluation, workspace)
//   core/ids          L4 id schemes for photos, regions, rolls, peaks, lakes, tiles; Ref<C>
//   core/storage      L4 every persistent key / store / file
//   catalogue/        L4 the concept catalogue (definitions, words, parts, realizations)
//   crosswalk/        L4 every app union → canonical axes, exhaustive by construction
//   checks/           compile-time only (never imported by app code)

export * from "./catalogue/concepts";
export * from "./core/confidence";
export * from "./core/geometry";
export * from "./core/ids";
export * from "./core/provenance";
export * from "./core/quantity";
export * from "./core/resolution";
export * from "./core/storage";
export * from "./crosswalk/pose";
export * from "./crosswalk/presentation";
export * from "./crosswalk/world";
