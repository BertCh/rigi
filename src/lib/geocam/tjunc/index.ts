// GA3 T-junction eye cue (reports/geometry-first-pose.md G1):
//   layeredHorizon   every visible silhouette crest per azimuth (DEM march, curvature + refraction)
//   predictJunctions far contours ending under near ones, projected at a camera (+ image-space variant
//                    junctionsFromGeomBuffer)
//   measureJunctions near/far contour offsets on the photo edges; pair and differential residuals
//   junctionFactor   core Factor (family "junction"), eye linearised by finite differences, relinearize()
export * from "./factor";
export * from "./junctions";
export * from "./layered";
export * from "./measure";
