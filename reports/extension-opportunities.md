# Rigi: where the mountain app goes next

*2026-09-30. A review of how Rigi can extend across art, science, sport, adventure, tourism, and transport and modalities. Researched in four web passes. Mirrors the shared doc at https://claude.ai/code/artifact/ab6bf954-3d00-4e41-9e27-7a73d8c6c054. If they disagree, the shared doc is newer. Figures marked "snippet" come from search results, not opened pages. Sequencing here is advisory; [roadmap.md](roadmap.md) remains the plan of record.*

Rigi turns an ordinary mountain photo into a calibrated camera on real terrain. That one asset extends into art, science, sport, adventure, tourism and transport, because each domain only needs different data drawn through the same camera.

The review found no shipping product that does automatic photo-to-DEM registration in any of these six domains. Incumbents either draw on maps (onX, Komoot, Strava), align by hand (PeakVisor, WSL Monoplotting, Smapshot), or rely on compass and GPS (Window Seat Pro, train AR apps).

The five strongest bets:

1. **Webcam pose watchdog and calibration API** for Panomax, Roundshot and feratel networks. The buyers are named, the viewpoints are fixed, and it is the roadmap's planned pose API.
2. **Archive registration for glacier and heritage collections** (DEFOGGING, ETH Bildarchiv, Smapshot), with a museum then-vs-now embed.
3. **Vector layers in the photo**: GPX, IGC, climbing topos, slope angle, rail and lift lines. One build serves sport, adventure and transport.
4. **Summit boards, posters and Berann prints** from registered photos. This is mostly export work on top of existing styles.
5. **Fixed-route window modes** for scenic trains, then drones (where DJI yaw errors match Rigi's solver exactly).

Safety features (rescue location, avalanche slope overlays) and painting viewpoint finding are high value but high risk. They wait for calibrated uncertainty.

## What Rigi already owns

Rigi's core asset is geometric truth: a verified camera pose for an ordinary photo, tied to a real elevation model. Every extension below reuses that one camera; the domains differ only in which data gets drawn through it.

| Capability in the repo | Where | What it unlocks for new domains |
| --- | --- | --- |
| Automatic pose from iPhone EXIF + DEM skyline, with a confidence gate (12/14 within 1°, 0 false accepts on the app set; ~20% auto-accept on wild photos) | `src/lib/geo`, `refine`, matcher service | Any photo becomes a measuring instrument, not just a picture |
| Unknown-pose path (360° yaw search, free tilt, focal seeds) and tap-a-peak picker | `integration/unknown-pose`, `picker` | Archive, scanned and historical photos with no metadata |
| Overlay: contours, peaks, SAC trails, distance tint, per-pixel lat/lon/elevation/distance | `look`, `style`, `osm` | Any vector layer can be drawn into a photo: routes, rail lines, hazard zones |
| Blend: satellite, topo, relief and bands from the same viewpoint | both renderers | Then-vs-now, map-vs-reality, art styles |
| In-map drape with occlusion shadow map; fly into the photo | `deck`, `engine.ts` | Photos as 3D content; monoplotting for science |
| Camera rolls: a day of photos on one map, spot panoramas, pose propagation | `src/lib/roll` | Trip stories, sport recaps, condition reports |
| Step Inside near-field splats, Google/swisstopo 3D Tiles | `nearfield`, `tiles3d` | Villages, huts, stations and cable-car terminals in 3D |
| Style presets incl. berann, topo-ink, swiss, night | `src/lib/style` | Art prints and panorama-painting output |
| Exports: pose JSON, XMP, COLMAP, KML/KMZ, GeoJSON footprints | `src/lib/export` | Interop with GIS, photogrammetry and photo libraries |
| WebGPU compute core | `src/lib/gpu` | On-device speed for live AR and video |

Two product rules from the roadmap shape every idea here. First, precision beats recall: a HIGH must be right, and everything else is a suggestion. Second, generated pixels are display-only. Recall is still the bottleneck, so ideas that tolerate a human tap, or that start from a known viewpoint, ship sooner.

## Art: from the Berann tradition to your own wall

The Alps have a 150-year visual culture of panorama painting, rephotography and posters. Rigi already ships a berann and a topo-ink style, so the art market is mostly export and print work on top of the existing pose.

| Opportunity | Who does it today | What Rigi adds | Feature idea | Risk |
| --- | --- | --- | --- | --- |
| Own-summit posters | [Unique Maps](https://uniquemaps.co.uk/products/custom-ski-resort-piste-map), [Artisans.coop](https://artisans.coop/products/colorado-14ers), Etsy relief and wood maps | All are made by hand or from templates; none starts from the buyer's photo | Labelled poster export (heights, distances, date, caption) in topo-ink or Berann style, plus print-on-demand | Low |
| Berann panoramas on demand | [Real-Time Panorama Maps](https://giv.cpsc.ucalgary.ca/publication/c62/) (research, no product); James Niehues paints by hand, about $2,400–15,000 a map (snippet) | A registered photo bridges to a stylised render with print aspect and labels | "Panorama commission": pick a viewpoint or upload a photo, get a high-resolution tiled render with bleed | Medium |
| Photographer's planner on a real frame | [PhotoPills](https://mwm.ai/apps/photopills/596026805), [TPE 3D](https://apps.apple.com/app/id1152829925) (about 30 m terrain) | Both plan from a map point; Rigi knows the exact frame | "Rerun this shot": the next dates the sun or moon lands in a chosen notch, with alpenglow and terrain-shadow previews | Low |
| Painter's viewpoint finding | Done by hand: Christian Helmle [retraced Hodler's views](https://www.swissinfo.ch/eng/hodler-s-landscapes-receive-a-contemporary-touch/3490304) for a 2004 exhibition | Fit a painting to terrain with free focal and a vertical-exaggeration term | 4–8 landmark taps return a most-likely vantage polygon and a side-by-side view for catalogues | High: artists compress and exaggerate |
| Museum time-machine embed | [Smapshot](https://geoawesome.com/smapshot-a-participatory-time-machine-for-switzerland) globe comparisons | Slider, drape and Step Inside views from one pose | An embeddable compare widget for ETH Bildarchiv or a Hodler or Segantini show | Medium |
| Geometry-conditioned generative art | Research only: [LPGen](https://arxiv.org/pdf/2407.17229), [Earthbender](https://cgvr.cs.uni-bremen.de/papers/mig2025/earthbender-paper.pdf) | Pixel-registered depth, skyline mask and label map keep the mountain the right mountain | Export geometry buffers; optional ControlNet pass with a skyline check afterwards | High: cost, licences; display-only per roadmap rule 3 |

Posters and the shot planner are the quickest revenue. The museum embed is the best brand move, because it pairs naturally with the archive work in Science.

## Science: one-click monoplotting

Mountain science still registers oblique photos by hand:
- The WSL Monoplotting Tool needs at least 5 ground control points.
- Smapshot relies on volunteer clicks.
- The Mountain Legacy Project georeferences semi-manually.

The one automatic exception, [Portenier et al. 2020](https://tc.copernicus.org/articles/14/1409/2020/), registers webcams from silhouettes at 23.7 m RMSE. Rigi's confidence-gated solve could turn each of these into a batch job.

| Opportunity | Current actors | Feature idea | Hard requirement |
| --- | --- | --- | --- |
| Archive registration for glacier history | [DEFOGGING](https://www.wsl.ch/de/projekte/discovering-forgotten-glacier-images-in-a-new-glance-defogging/) (50,000+ glacier images), [Hundred years of Swiss glacier changes](https://www.slf.ch/fr/projets/hundred-years-of-swiss-glacier-changes-from-historical-terrestrial-images/), ETH Bildarchiv, GLAMOS | Batch "archive mode" over a folder or IIIF manifest: pose, confidence, overlay; low confidence goes to a human queue | Free focal and distortion; fit to stable ridgelines, never the glacier |
| Webcam snow cover and snow line | Portenier et al. (fixed webcams) | Snow-covered fraction per elevation band as GeoJSON or raster; daily re-solve to absorb mount drift | A snow classifier; validation on snowy skylines |
| Hazard footprints | WSL Monoplotting; SLF [White Risk reporting](https://www.slf.ch/en/news/new-to-white-risk-avalanche-reporting-made-easy/) (a pin plus photos) | Release area, track and deposit as a footprint polygon from each report photo; fuse several photos | Post-event terrain differs from the DEM; flag the mismatch |
| Permafrost and rockfall time series | UNIL Valais permafrost webcams, PermaSense on the Matterhorn | Batch re-solve of a time-lapse stack, change polygons draped on swissSURFACE3D | Metre-scale scars at km range need per-pixel uncertainty |
| Phenology and treeline | [SwissPhenoCam](https://essd.copernicus.org/preprints/essd-2026-435/) (34 sites, up to 15 years) | Regions of interest stored as geographic objects with elevation and aspect, re-aligned when the camera shifts | Viewing distance limits per-tree work |
| Citizen rephotography | [ACC + MLP challenge](https://alpineclubofcanada.ca/acc-mlp-repeat-photography-challenge), Mountain Legacy Project | "Go stand here" card, a ghost overlay in the live camera, then an automatic pose-delta score | Needs the historical pose first |
| Event retrospectives | [Birch Glacier 1946–2025](https://meetingorganizer.copernicus.org/EGU26/EGU26-22072.html) (aerial, EGU 2026) | An event page that registers tourist photos before and after on the same terrain | Pre- and post-event DEMs |

Scientists will not adopt the tool without three things, and Rigi has each only in part:
1. Pose uncertainty, with per-pixel ground uncertainty.
2. The DEM vintage in every export.
3. Validation on winter scenes.

GA1's Laplace covariance is the natural starting point for the uncertainty. It is currently about 2.5× over-confident.

## Sport: lines, angles and tracks drawn into your own photo

Sport apps all draw on a map or a 3D globe. None draws the route, the slope angle or the GPS track into the photo the athlete actually took. Rigi's solved camera turns that into a projection instead of hand-drawing.

| Opportunity | Players today | Gap Rigi fills | Feature idea |
| --- | --- | --- | --- |
| Climbing topos that stay registered | [The Topo](https://help.thetopo.com/articles/2800000-27-crags-is-now-the-topo) (ex-27 Crags, 5,000 verified topos), theCrag, Mountain Project, Rockfax | A hand-drawn line lives on one image; a 3D line can be re-projected onto every registered photo of the face | Draw a route once, see it on any visitor's photo, in 3D and on the roll map, with approach and descent |
| Ski-touring slope angle on the photo | [onX Backcountry](https://onxmaps.com/backcountry/blog/fatmap-alternative), [PeakVisor](https://peakvisor.com/en/news/FATMAP-replacement.html), [White Risk](https://powderguide.com/en/magazine/equipment/tour-planning-with-white-risk-experience-report) (SLF), Skitourenguru | All are map views; none shows ATES or slope classes on the slope you photographed | A slope, aspect and elevation-band overlay on the photo for tour briefings, with a clear data-source label and disclaimer |
| FATMAP orphans | Strava closed FATMAP on 1 Oct 2024; onX and PeakVisor court its users | The photo-on-terrain experience vanished with it | GPX/KML import with the track over the photo and in the drape |
| Paragliding and hang gliding | XContest, FlyXC ([APPI FlightLog](https://flyappi.org/news/62/)), [Gaggle](https://apps.apple.com/app/id1556694314), XCTrack | Replays show a track on terrain, never from the pilot's own photo | IGC track and thermals on a launch panorama; landing-zone briefing sheets |
| Trail running, hiking, MTB | Strava, [Komoot Trail View](https://www.bike-magazin.de/en/bike-computer/trail-view-komoot-shows-photos-of-paths-and-trails-on-the-map/), AllTrails, Trailforks, Garmin, Suunto | Their photos are pins; Rigi answers which ridge and how far for every pixel | "Your track, 2 km ahead" on the photo; auto-captions; grade flags on steep sections |
| Peak-bagging proof | Peakbagger, ListsOfJohn, PeakVisor | Nobody verifies that a summit photo was taken from that summit | A "verified summit" badge and a label sheet of every peak visible from the top |

The climbing and ski-touring ideas rely most on what is unique to Rigi, an exact camera. Both carry safety weight, so they need the confidence gate and should start as annotation tools, not decision aids.

## Adventure: plan, survive, tell the story

Camera rolls are already an adventure product in disguise: a day of photos, each with a solved viewpoint, on one 3D map. Five extensions would turn them into planning, safety and storytelling tools.

- **Pose-driven recap films.** [Relive](https://travesiapirenaica.com/en/relive-app/) (22M users, snippet figure) pops photos up as flat thumbnails along a track. Rigi can fly the camera from photo viewpoint to photo viewpoint along the GPX, with the route and labels drawn on every frame. Output is an MP4 or a share link.
- **Auto-built trip reports.** Reports on hikr.org, camptocamp and Gipfelbuch are photos plus prose with no geometry. One click turns a roll into labelled photos, the route line and a mini 3D map, embeddable in those sites.
- **Registered condition reports.** A registered photo makes the snow line a number ("snow from 2,350 m on the NE face"). Many users' photos of the same face become a time slider. That could feed SLF and [avalanche.report](https://avalanche.report/bulletins/2025-02-01/2025-02-01_IT-32-BZ_en.xml) observation formats.
- **Reconnaissance view.** Pick a col, bivouac or camp and render the expected panorama with the planned route drawn on it. Replace it with a real photo once someone has been there.
- **"Where is this photo?" for rescue.** The [Rega app](https://www.rega.ch/en/our-missions/this-is-how-we-help-you/rega-app/regas-emergency-app) sends GPS on alarm; it has nothing for a friend holding only a photo. Rigi can return coordinates, altitude, bearing and an uncertainty ellipse. This is high-stakes: offer it only above the HIGH confidence bar, and never as the sole location source.

Expeditions beyond the Alps (Himalaya, Andes) need global DEM and OSM coverage. Mapterhorn already gives Rigi that reach, so the limit is the quality of trail and hut data outside Europe.

## Tourism: known viewpoints, paying buyers

Tourism is the easiest sale because the viewpoints are fixed and known. A summit station or webcam needs one good registration, not a wild-photo solve, which sidesteps Rigi's recall problem.

- **Webcam pose watchdog.** [Panomax](https://www.panomax.com/funktionen/berggipfel_en.html) already labels peaks on its 360° cameras. [Roundshot](https://www.roundshot.com/public/upload/assets/2720/Roundshot-Livecam-2024-CH-english.pdf?fp=1) and [feratel](https://www.feratel.at/en/our-service/news/mediacam-5-the-best-long-distance-view-in-the-industry) sell similar long-range panoramas. Cameras drift with wind and re-levelling, and the labels go wrong silently. An API would re-solve each camera daily, alert on drift and calibrate new cameras with no survey. That is the existing pose-API plan, now with named buyers.
- **Panorama board generator.** Summit boards at Gornergrat, Pilatus or Titlis are drawn once and go stale. From one registered photo or a DEM render, generate print-ready boards in 6+ languages. Each board carries a QR code that opens a live labelled view and today's webcam blend.
- **"My Summit Moment" for DMOs.** A white-label widget registers visitor photos, adds labels and "you were here", and builds a gallery. Photos below the confidence bar fall back to the tap-a-peak picker.
- **Verified view for hotels and listings.** From a photo, or a coordinate plus floor height, report three things as an embeddable badge: the visible named peaks, the unobstructed share of the horizon and the sunrise azimuth. Willingness to pay is untested.
- **Audio guide on tap.** Tap a peak in a registered photo and hear its story in the visitor's language, using existing label data and text-to-speech.

Rigi is named after a mountain whose railway, opened in 1871, was Europe's first mountain railway. The Rigi Bahnen, Pilatus and Jungfrau operators are the obvious first pilot list.

## Transport and modalities: wherever there is a window or a lens

Every moving vehicle in the Alps has a known track and a known window side. That gives a strong pose prior, so Rigi can predict the view and use a photo only to confirm it.

**Transport**

| Mode | Today | Feature idea |
| --- | --- | --- |
| Scenic trains (Bernina, Glacier Express, GoldenPass) | The Bernina Express [Web AR Live Map](https://www.passengera.com/en/news/the-bernina-express-web-ar-experience-a-new-dimension-in-railway-exploration-8/) (Passengera) is a 3D map, not a window view | "Window panorama": train position and side predict the labelled view; snap a photo for an exact fit; runs inside the on-board web app |
| Cable cars and PostBus passes | [Panomax](https://new.panomax.com/en/webcam-cable-cars) webcams for lifts | A line-and-station overlay: draw the lift, rack railway or pass road into any registered photo ("your route, from this summit") |
| Flights | [Window Seat Pro](https://apps.apple.com/us/app/window-seat-pro/id1560582386), wheresTHAT, [FlightPlus](https://apps.apple.com/sg/app/flightplus/id6749645650) use GPS, compass or AI captions | Upload a window photo with flight number and time; the ADS-B track is the prior, the skyline the fit. Untested at 10 km altitude |
| Drones | DJI writes GPS and gimbal angles to XMP, but some models log gimbal yaw [40–55° off](https://support.pix4d.com/hc/incorrectly-oriented-reconstructions-in-pix4dcloud-or-pix4dmatic) | Trust the position, treat yaw as a prior, refine by skyline: exactly Rigi's solver. Swiss [U-space Zurich](https://www.bazl.admin.ch/en/u-space-zrh) is due end of 2026 |

**Modalities**

- **Live phone AR.** The natural next input. Register one frame, then track with the gyro. The WebGPU compute core is the path to doing this on device. It fixes the ±3° compass error that incumbents live with.
- **Glasses and headsets.** [Meta Ray-Ban Display](https://timewell.jp/en/columns/meta-rayban-display) and [Snap Specs](https://www.techradar.com/computing/virtual-reality-augmented-reality/goodbye-spectacles-reimagined-snap-specs-now-set-to-launch-in-2026-with-a-ton-of-new-features-and-openai-and-gemini-integration) (2026) target urban navigation. The phone registers once and the glasses draw labels from that pose. Research track only.
- **Watch and voice.** "What's the peak at my 2 o'clock?" from the last registered pose and the watch heading. A spin-off, not a product.
- **Broadcast weather.** [Chyron Weather Panorama](https://help.chyron.com/hc/en-us/articles/52621148490644-Weather-Panorama-Cinematic-3D-Visualization) builds simulated 3D shots. A newsroom API fits Rigi's existing newsroom target: it registers a webcam still and blends it into a render, satellite imagery or snow-line graphics.
- **360 cameras, dashcams and video.** Batch-register frames along a pass road into a "peaks along your route" timeline. Concept only; nothing was researched here.

## Platform moves that serve every domain

Thirty-odd ideas reduce to six reusable building blocks. Once these exist, most domain features become configuration.

1. **Vector layer import into the photo.** GPX, IGC, KML, GeoJSON and climbing topos drawn in 3D and projected into the photo with occlusion. Serves sport, adventure, transport (rail and lift lines) and science (hazard polygons).
2. **Batch and API mode.** Takes a folder, IIIF manifest or webcam URL; returns pose, confidence and overlay. Serves archives, webcams, drones and newsrooms. This is the roadmap's pose API.
3. **Uncertainty as a first-class output.** Pose covariance, per-pixel ground uncertainty and DEM vintage in every export. Science requires it; rescue and safety features depend on it.
4. **Fixed-viewpoint mode.** A known station (summit, webcam, train window) solved once, then re-checked. Avoids the wild-photo recall problem. Serves tourism and transport.
5. **Time as an axis.** Then-vs-now sliders, sun and moon ephemeris on a frame, time-lapse stacks. Serves art, rephotography, glaciology and condition reports.
6. **Publishing outputs.** Posters, boards, MP4 recaps, embeddable widgets and share links. This is how art, tourism and adventure get paid.

**Data and partners worth approaching**

| Partner | Why |
| --- | --- |
| swisstopo, ETH Bildarchiv, Smapshot | Archive images, DEM vintages, a ready audience for automatic registration |
| WSL / SLF, GLAMOS, SwissPhenoCam | Science users with published validation needs |
| Panomax, Roundshot, feratel | Webcam networks that need calibration and drift checks |
| Rigi Bahnen, Pilatus, Jungfraubahnen, RhB (Bernina) | Fixed viewpoints, multilingual visitors, budgets |
| The Topo, Skitourenguru, camptocamp | Route and condition content to project into photos |

Licensing gates all of this. Roadmap item N2 (Esri imagery, Overpass limits, model licences) must close before any partner sees a public URL.

## Roadmap: quick wins first, then three pilots

Ship the export-shaped quick wins within the current product. Then pilot three big bets: the webcam API, archive registration and a train window mode. Leave safety and generative work in research until uncertainty is calibrated.

Placement by impact and effort (author's judgement from the research, not a measurement; **bold** = one of the five top bets):

| | Lower effort | Higher effort |
| --- | --- | --- |
| **Higher impact** | *Quick wins:* **posters and Berann prints**, summit board generator, **GPX / IGC / topo overlay**, sun and moon shot planner | *Big bets:* **webcam pose watchdog API**, **archive batch registration**, **train window mode**, live phone AR |
| **Lower impact** | *Fill-ins:* audio guide on tap, peak-bagging badge, verified view badge, trip-report embed | *Research bets:* rescue location from a photo, painting viewpoint fitter, generative art, glasses AR |

1. **Now (0–3 months).** Poster and print export, the summit board generator, GPX and IGC overlay in the photo, and the shot planner. All reuse the existing pose and styles and need no recall gains.
2. **Next (3–9 months).** The webcam pose API with one network pilot, archive batch mode with one archive partner, and a train window pilot on one line. Each needs batch mode and uncertainty outputs.
3. **Later (9–18 months).** Live phone AR on WebGPU, then drone registration, then glasses. Safety features come only after pose uncertainty is calibrated and validated on winter scenes.

**Risks**
- Wild-photo recall (about 20% auto-accept) limits consumer features, so fixed-viewpoint products go first.
- Esri imagery and Overpass licensing block any public partner launch (roadmap N2).
- Safety features carry liability, so they stay annotations, never decision aids.

## Sources

Links sit beside each claim above. Repo context comes from `README.md`, [status.md](status.md), [roadmap.md](roadmap.md) and [Rigi competitive landscape and roadmap.md](<Rigi competitive landscape and roadmap.md>).
