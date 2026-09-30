// Geometry-first camera (GEO phase, reports/geometry-first-pose.md). Subpackages:
//   core       frozen types + GeoState ↔ CameraX
//   map        MAP solver with priors + Laplace covariance (GA1)
//   priors     heading/declination, photo priors (GA0)
//   lakes      lake geometry, levels, eye floor, water factors (GA0/GA4)
//   observe    CRLB / observability gate, held-out family test (GA2)
//   tjunc      occlusion-crossing (T-junction) eye cue (GA3)
//   integrity  solution-separation protection level, viewshed veto (GA5)
// Nothing here moves the app pose; hooks elsewhere are flag-gated (geo*) and default off.
export * from "./core";
