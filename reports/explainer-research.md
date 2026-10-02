# Explainer research: making the Rigi Gipfelbuch pages (formerly the atlas) best-in-class

Date: 2026-10-01. Sources marked (read) were fetched this session. Sources marked (recalled) are cited from prior knowledge and were not re-fetched.

## (a) Principles

1. **Lead with the concrete example, then abstract.** Start from one real photo and one real failure, then generalise. Concrete instances anchor intuition. Source: Victor, Up and Down the Ladder of Abstraction (read) https://worrydream.com/LadderOfAbstraction/
2. **Always offer a step down.** Every abstract diagram should let the reader point at a specific case (a peak, a pixel column). Ladder of Abstraction (read), same URL.
3. **Reading must work without interaction.** Interactivity is a bonus. Every figure needs a static state that carries the claim. Victor, Explorable Explanations (read) https://worrydream.com/ExplorableExplanations/
4. **Show the model, not just the result.** Let the reader see the assumptions (the DEM horizon, the sensor prior) and verify them in place. Explorable Explanations (read), same URL.
5. **Direct manipulation beats play buttons.** Dragging the horizon offset teaches more than an autoplay loop. Ladder of Abstraction (read) and Hohman et al., Communicating with Interactive Articles (read) https://distill.pub/2020/communicating-with-interactive-articles/
6. **Overview first, then details on demand.** Use tooltips and disclosures for depth, so the main path stays short. Hohman et al. (read), same URL.
7. **Animate only state change, causality or uncertainty.** Hohman et al. say animation helps with exactly these. Use it for "prior to solved pose", not for decoration.
8. **Prompt a prediction where cheap.** "Where do you think the skyline will land?" before the reveal. Hohman et al. cite "You Draw It" (read).
9. **Keep the controls to input, algorithm, output.** Red Blob Games builds each diagram as controls to input to algorithm to output to visualisation. Keep one control per figure. Red Blob Games, Diagram structure (read) https://www.redblobgames.com/making-of/diagram-structure/
10. **Do not hijack scroll.** Kosara lists the scrollytelling failures: scroll-jacking, no length cue, hard navigation, and text and graphic competing for attention. Prefer stacked figures with steps, or a stepper. The Scrollytelling Scourge (read) https://eagereyes.org/blog/2016/the-scrollytelling-scourge. This matches the existing Rigi rule of no scroll traps on the landing page.
11. **One idea per figure, and the caption is the claim.** Write "The rendered horizon is 14 px low until refraction is applied", not "Figure 2: horizon". Recalled from NYT/Pudding practice: https://pudding.cool/ and Tufte, Envisioning Information (recalled) https://www.edwardtufte.com/
12. **Annotate in place, not in a legend.** Put labels on the data with a leader line and a direct label. Tufte (recalled), same URL.
13. **Small multiples for comparison.** Same frame repeated across conditions (good case, fail case, each with the same crop) beats one animated toggle. Tufte (recalled).
14. **Show the data: real images.** The proof is the photo. Draw the overlay on it, and keep synthetic diagrams only for what a photo cannot show (e.g. the horizon-curvature cross-section). Tufte (recalled).
15. **Build incrementally, one visible change per step.** Ciechanowski's essays (e.g. mechanical watch, cameras and lenses) add one thing at a time with a manipulable 3D object, in a quiet, uncluttered layout. https://ciechanow.ski/ (recalled). Nicky Case does the same with short, playable steps and a recap at the end. https://ncase.me/ (recalled)

## (b) Figure idioms to borrow

| Idiom | Where it comes from | Use in Rigi |
|---|---|---|
| Ghost overlay on the photo with a drag-to-align offset | PeakVisor and PeakFinder: users slide the rendered panorama onto the photo until it matches (read) https://peakvisor.com/en/news/identify_mountains_in_photos.html, https://www.peakfinder.com/mobile | The "pose estimate" page: drag the horizon, then snap to the solved pose |
| Detected skyline (one colour) against rendered skyline (another colour) on the same photo | Baatz et al., ECCV 2012: skyline from the image is matched to synthetic skylines from the DEM (read) https://mlanthology.org/eccv/2012/baatz2012eccv-large | Skyline detection and DEM horizon pages. Fix the two colours across all pages |
| Residual strip: a thin plot under the photo showing the per-column vertical gap | Standard in curve-fitting plots (Tufte, recalled) | Shows error as a profile. A mean number alone hides where it fails |
| Confidence as accept/reject outcome, not a probability bar | Rigi's fail-closed accept rule | Show the same photo accepted and rejected with the reason written on the figure |
| Ladder-of-abstraction pair: a photo, then a side-view section | Victor (read) | Curvature and refraction page: photo on top, cross-section below with one drag handle |
| Before/after slider | NYT and Pudding patterns (recalled) | Prior pose versus solved pose. Use only where the images are pixel-aligned |
| Peak pin with a leader line and a number | PeakFinder labels | Tap-a-peak and peak placement pages |

## (c) Page template (300 to 450 words)

1. **Hero figure (real photo, about 40% of the screen).** One overlay, direct labels. Caption is the claim, one sentence with one number.
2. **The idea in one picture (about 40 words).** A single annotated diagram. No legend.
3. **How it works, three steps (about 25 words each).** Each step gets a mini visual: a cropped real photo or a simple SVG, in the same colour code. Steps are numbered and short.
4. **Where it fails (about 60 words).** One real failure photo (haze, cloud on the ridge, wrong viewpoint), the same figure style as the hero, and a caption that states what the system does about it ("rejected: only 31% of columns agree").
5. **Numbers (about 40 words).** Two to four figures, each as a big number plus a label. Include the sample size and say whether it is on held-out photos.
6. **Details for engineers (collapsed).** Function names, parameters, links to reports. Collapsed by default. This is the only place for code identifiers.
7. **Next:** one link to the next concept, with a one-line reason.

Layout notes: the hero figure must be understandable if the reader reads only the caption. Keep one interactive control per figure, with a static default state. Make the page work on a phone at 16px gutters.

## (d) Copy rules, with before and after

1. **Headline is a claim.**
   Before: "Skyline detection".
   After: "The skyline is the one line we can trust."
2. **Sentences of 15 words or fewer, one number per sentence.**
   Before: "The solver evaluates roughly 4,000 candidate poses and accepts a result whose residual is under 2.1 px on 80% of columns."
   After: "We try about 4,000 poses. We keep one only if the lines agree on 80% of columns."
3. **Plain words, active voice.**
   Before: "Orientation is refined via optimisation of the reprojection residual."
   After: "We nudge the camera until the two lines overlap."
4. **No identifiers in main copy.**
   Before: "`solveGrid` runs on the GPU sidecar."
   After: "The search runs on your graphics chip." Put `solveGrid` in Details.
5. **Say what the reader sees.**
   Before: "As shown in Figure 3, the residual decreases."
   After: "The gap closes from 14 px to 2 px." Put the label on the figure.
6. **Name the failure honestly and say what the system does.**
   Before: "May occasionally be inaccurate in adverse conditions."
   After: "In haze the ridge fades. We reject the photo instead of guessing."
7. **Explain the term once, in context, then reuse it.** "Yaw (which way the camera points)". Do not use two words for the same thing (pose and orientation).
8. **Numbers carry units and a denominator.** "92% of 100 photos", not "high accuracy".

## Gaps

- I did not locate a Bostock-authored scrollytelling critique. Kosara's critique is used instead.
- Tufte, Nicky Case, Ciechanowski and Pudding points are recalled and should be spot-checked before they are quoted.
- No page on PeakVisor or PeakFinder publishes a confidence or error visual. They show only the drag-to-align interaction, so the residual strip and the accept/reject figure would be new in this domain.
