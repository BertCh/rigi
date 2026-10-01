# Showcase art direction, motion design and interaction aesthetics of bespoke geospatial / 3D web experiences (2023–2026)

Scope note: about 20 search and fetch calls. Several named exemplars (NYT, Reuters, WaPo, Bloomberg, Guardian, SCMP and Le Monde terrain pieces, plus Active Theory, Lusion, Resn, Locomotive, 14islands and Studio Freight case studies) did not show up as citable primary sources in these searches. Where I could not verify something, it is listed under Gaps and not presented as fact. One Unseen Studio dev write-up returned HTTP 403.

## Exemplars: which 2023–2026 geospatial / 3D web pieces set the bar, and where are they?

### Takeaway
The verifiable top tier splits into three groups:
1. Newsroom terrain explainers, such as National Geographic's "What is the tallest mountain on Earth?". These use real DEM plus imagery, scroll-driven, with a custom animation per concept.
2. Agency and studio "terrain as navigation" sites, such as San Rita and Unseen Studio's Symphony of Vines. These use real heightmaps baked to low-poly meshes and are driven by GSAP and Lenis.
3. Platform styles, such as Mapbox Standard with its dynamic light presets.
Snow Fall (NYT, 2012) is still the archetype that newsrooms cite.

### Cited Findings
- **National Geographic, "What is the tallest mountain on Earth?"** (entry in a 2026 awards programme, category Excellence in Visual Digital Storytelling, Medium Newsroom). It shows six different measurements on 3D-modelled mountains rendered in the browser. It "paired low quality DEM with high quality imagery" and gave each mountain "a custom animation to visually demonstrate the 'how' of each measurement". The stated art direction was to "take the classic style of National Geographic cartography and bring the reader into a world that felt crisp, stunning and technologically new." Story: https://www.nationalgeographic.com/adventure/graphics/what-is-the-tallest-mountain-on-earth. — [Awards entry](https://awards.journalists.org/entries/what-is-the-tallest-mountain-on-earth/). A search surfaced this as a Reuters piece, but the awards page credits **National Geographic**.
- **NYT "Snow Fall: The Avalanche at Tunnel Creek"** (Dec 2012) combined 3D terrain flyovers, animated weather simulations, parallax photography and embedded video within the narrative. It won the 2013 Pulitzer for Feature Writing and became newsroom shorthand for design-driven longform. — [modeldiplomat glossary](https://modeldiplomat.com/learn/glossary/snowfall-story); [Studio Republic on Snowfall design](https://www.studiorepublic.com/blog/snowfall-design/). It is pre-2023 but remains the reference point.
- **Washington Post Everest scale graphic** (2015): the reader starts at the base and **scrolls up** the mountain, inverting the usual scroll direction. — [FlowingData](https://flowingdata.com/2015/04/09/a-tall-graphic-to-show-mt-everest-scale/). Pre-2023, but the move is directly reusable.
- **NYT R&D `three-loader-3dtiles`**: a Three.js loader for OGC 3D Tiles (b3dm and point clouds, built on loaders.gl), made "to create a clean bridge between the 3D Tiles specification and… Three.js" for "massive 3D and Geographical journalism". Its demos cover Google Photorealistic 3D Tiles, LiDAR point clouds via Cesium ion, RealityCapture photogrammetry, OSM overlays and experimental GeoJSON draping on tiles. — [GitHub nytimes/three-loader-3dtiles](https://github.com/nytimes/three-loader-3dtiles/)
- **San Rita (sanrita.ca)**, a Montreal studio portfolio. Projects are hotspots on a navigable 3D mountain landscape built from real GPS heightmaps (Canada, California), converted to Blender topology via an Unreal height-map tool. High-resolution detail is baked onto a lightweight low-poly mesh. The design took about a year of prototyping. — [Abduzeedo](https://abduzeedo.com/node/89189)
- **The Symphony of Vines** by Unseen Studio. It appears on Awwwards as "Terrain formation", "River formation" and "Interactive rivers" elements, built with WebGL, 3D animation, mouse interaction and "luxury" styling. — [Awwwards terrain formation](https://www.awwwards.com/inspiration/terrain-formation-the-symphony-of-vines); [Awwwards interactive rivers](https://www.awwwards.com/inspiration/interactive-rivers-the-symphony-of-vines). Unseen won Awwwards Site of the Month for February 2023 — [Awwwards](https://awwwards.com/unseen-studio-by-unseen-studio-wins-sotm-february-2023.html)
- Other Awwwards terrain elements: "Mountain animation" by Dgrees for Tresmares Capital (WebGL with parallax), and "Maps" by /nk.studio for Veritran. — [Awwwards Tresmares](https://www.awwwards.com/inspiration/mountain-animation-tresmaes-capital); [Awwwards Veritran](https://www.awwwards.com/inspiration/maps-veritran)
- **Mapbox Standard** (public beta Aug 2023) has four lighting presets (Day, Dusk, Dawn, Night) that can follow real-world time, with moving shadows and night "flood lights and entrance lights". It adds 3D landmarks that respond to the lighting and a "smooth transition" between 2D and 3D. — [Geo Week News](https://www.geoweeknews.com/articles/mapbox-standard-core-style-3d-urban-map/); [Mapbox blog summary](https://www.plushcap.com/content/mapbox/blog/mapbox-standard-core-style) (original: mapbox.com/blog/standard-core-style)
- **FATMAP**, the reference ski/climbing 3D map. It built 3D mountain models from tri-stereoscopic satellite imagery at about 2 m elevation grid resolution. Strava acquired it in Jan 2023 and **retired it on 1 Oct 2024**, folding the 3D into Strava. — [Geo Week News](https://geoweeknews.com/news/tech-news-strava-acquires-3d-mapping-platform-fatmap); [TechCrunch](https://techcrunch.com/2024/06/26/strava-to-shutter-3d-mapping-platform-fatmap-18-months-after-acquisition)
- The **Malofiej awards** (the main infographics award for newsroom 3D terrain graphics) were paused in Oct 2021. Per Wikipedia, none were held through 2024, so they are not a usable 2023–2026 source. — [Wikipedia](https://en.wikipedia.org/wiki/Malofiej_Awards)
- After the May 2025 Blatten/Birch Glacier collapse, the strongest freely available 3D treatments were not newsroom graphics. They were a Sketchfab before/after model from drone imagery by Simeon Schmauß, and swisstopo oblique rapid-mapping imagery (rapidmapping.admin.ch). — [Sketchfab](https://sketchfab.com/3d-models/blatten-glacier-collapse-2025-05-30-037bb8933d2444d6b283da885ab77a8d); [AntarcticGlaciers.org](https://www.antarcticglaciers.org/2025/05/birch-glacier-landslide/)

### Inferences
- For Rigi the closest analogues are NatGeo's crisp, classic cartography rendered in WebGL and San Rita's terrain as navigation with points of interest as hotspots. The agency sites show that a real DEM, art-directed, reads as premium. Procedural noise terrain does not.
- FATMAP's shutdown leaves a gap for a premium "mountain-native" 3D aesthetic that a niche app can claim.

### Gaps
- I could not verify specific 2023–2026 3D terrain stories from NYT, Reuters, WaPo, Bloomberg, Guardian, SCMP or Le Monde (URLs or how-we-made write-ups). Searches returned no primary pages. A follow-up should query each outlet's graphics index directly (graphics.reuters.com, nytimes.com/spotlight/graphics, washingtonpost.com/visual-stories).
- I found no citable 2023–2026 case studies here for Active Theory, Lusion, Resn, Locomotive, 14islands, Studio Freight/darkroom, Bruno Simon, Stamen, Felt, Planet, Arc'teryx, Salomon or Patagonia geospatial sites.
- I did not research Google Earth Studio, Arts & Culture, Ventusky, Windy, earth.nullschool, map.geo.admin 3D or Atlas of Switzerland.

## Design moves: camera, reveals, labels, grading, chrome, sound, loading

### Takeaway
The cited, recurring moves are:
- scroll-bound camera fly-throughs, with cameras keyframed in code or an animation timeline rather than exported from Blender
- progressive, staged scene reveals during loading
- cartographic metaphors in the navigation vocabulary
- vintage or "classic cartography" grading
- time-of-day light presets
- one bespoke micro-animation per concept
- inverting scroll direction to match the subject (climbing up)

### Cited Findings
- **Camera choreography.** Unseen aimed for a "cinematic" feel with smooth, clean camera animation. For Symphony of Vines most scenes were built in code rather than as Blender-exported camera paths, because the camera moves through mostly empty space. Text is rendered in WebGL with troika-three-text, and assets use KTX2 textures and DRACO-compressed glTF. — [search summary of Unseen dev insights](https://unread.unseen.co/the-symphony-of-vines-dev-insights-c284cc4e8aa0) (the page itself returned 403, so treat as secondary)
- **Scroll-linked fly-through recipe.** Codrops shows a scroll-driven camera fly-through with Theatre.js, R3F and Drei in about 50 lines. Theatre.js gives a motion-design timeline UI for keyframing camera position and target. — [Codrops](https://tympanus.net/codrops/?p=70449)
- **Staged loading reveal.** San Rita's landscape loads in stages, with vegetation and water appearing progressively to reinforce the exploration metaphor. Project pages drop to lightweight HTML/SVG with custom GLSL shaders on photography. The infinite-scroll project list "simulates a trekking trail". Navigation uses cartographic terms ("road, fishing spot, viewpoint"). — [Abduzeedo](https://abduzeedo.com/node/89189)
- **Grading and texture.** San Rita uses vintage-cartography visuals with aged-paper textures. NatGeo pairs a classic NatGeo cartographic style with a crisp, modern WebGL render. — [Abduzeedo](https://abduzeedo.com/node/89189); [NatGeo awards entry](https://awards.journalists.org/entries/what-is-the-tallest-mountain-on-earth/)
- **Light as mood.** Mapbox Standard's Day/Dusk/Dawn/Night presets, moving shadows and night accent lights make lighting a primary art-direction lever, set by one config. — [Geo Week News](https://www.geoweeknews.com/articles/mapbox-standard-core-style-3d-urban-map/)
- **Concept-specific animation.** Each NatGeo mountain gets its own animation explaining how that measurement works. — [awards entry](https://awards.journalists.org/entries/what-is-the-tallest-mountain-on-earth/)
- **Direction-of-scroll as metaphor.** In WaPo's Everest graphic you scroll up from the base. — [FlowingData](https://flowingdata.com/2015/04/09/a-tall-graphic-to-show-mt-everest-scale/)
- **Hybrid media.** Snow Fall's mix of terrain flyover, parallax photography, video and weather animation woven into the text is still the template. — [modeldiplomat](https://modeldiplomat.com/learn/glossary/snowfall-story)
- **Cartographic "standing relief".** Plan oblique relief (Jenny and Patterson, 2007) makes terrain "stand up" while keeping planimetric accuracy. It draws on Heinrich Berann, Erwin Raisz and Xaver Imfeld, and has been adapted into web map tiles. — [Cartographic Perspectives](https://cartographicperspectives.org/index.php/journal/article/view/cp57-jenny-patterson); [shadedrelief.com](https://shadedrelief.com/planimetric/plan.html)
- **Codrops 2024–25 case-study patterns.** These include a custom paint-reveal shader over a walkable Three.js corridor (Tomasz Szmajda portfolio), a scroll-driven 3D site with seamless scene transitions (Shader Development Studio), and the GSAP ScrollTrigger + Lenis combination as the standard scroll stack. — [Codrops Telegram index](https://t.me/s/codrops/404). This is an aggregator, so verify the individual articles.

### Inferences
- Landing page:
  - Rigi could stage the hero load the way San Rita does: DEM mesh, then hillshade, then photo drape, then labels.
  - Rigi could keyframe camera beats in a timeline tool (Theatre.js) bound to scroll, not ad-hoc tweens. This fits with the existing reveal-animation presets.
- Light presets (dawn, golden hour, blue hour) are a cheap, high-impact mood lever for a mountain app, because photo time-of-day is known.
- A "scroll up to climb" inversion, or a Berann/plan-oblique still frame, could give a distinctive mountain-specific signature.

### Gaps
- I found no cited 2023–2026 examples of sound design, glassmorphism HUDs, variable-font label animation, ink-spread or scan-line transitions, or View Transitions API use in geospatial showcases.
- I did not obtain newsroom write-ups on easing curves or FOV/dolly choices.

## Photo + map fusion exemplars

### Takeaway
Consumer peak-ID tools (PeakVisor) use a simple pattern: a rendered DEM silhouette overlaid on the photo, manual drag and roll alignment, and export modes (hillshade plus silhouettes, silhouettes only, labels only). Apple Look Around beats Street View on transition feel because it uses real intermediate frames and parallax instead of blur.

### Cited Findings
- **PeakVisor photo labelling.**
  - Users drag a central cross to pan the overlay and drag side rotators to fix horizon tilt.
  - They click labels to toggle them and can add a title that is imprinted on the exported image.
  - The View Mode toggles "full panorama (hillshades & silhouettes, silhouettes, labels only)".
  - Label, leader-line and typographic details are not documented.
  — [PeakVisor](https://peakvisor.com/en/news/identify_mountains_in_photos.html)
- PeakVisor's AR mode renders a DEM, labels the surrounding peaks (with elevation and class) and lets the user move the peak outline to align it with the camera image. Its 3D maps are about 30 m resolution. — [PeakVisor home](https://peakvisor.com/); [PeakVisor tutorial](https://peakvisor.com/tutorial_en.html)
- **Apple Look Around vs Google Street View.** Look Around moves are "like a smoothed stop-frame animation" using real intermediate images, with parallax for depth and no quality loss. Street View blurs during moves. — [AppleInsider](https://appleinsider.com/articles/19/06/07/hands-on-with-ios-13-look-around-in-apple-maps); [iPhone in Canada comparison](https://www.iphoneincanada.ca/2019/06/14/apple-maps-look-around-google-street-view/)
- **Photogrammetry reveals.** NYT's 3D Tiles loader demos photogrammetry (RealityCapture) and LiDAR point clouds in Three.js. The Blatten before/after Sketchfab model shows the event-driven before/after 3D pattern. — [GitHub](https://github.com/nytimes/three-loader-3dtiles/); [Sketchfab](https://sketchfab.com/3d-models/blatten-glacier-collapse-2025-05-30-037bb8933d2444d6b283da885ab77a8d)
- **Berann-style panoramas** are the historical model for digital panorama annotation. The plan oblique technique is their computational descendant. — [Cartographic Perspectives](https://cartographicperspectives.org/index.php/journal/article/view/cp57-jenny-patterson)

### Inferences
- PeakVisor's export modes (photo plus hillshade, silhouette-only, labels-only) are table stakes. Rigi can stand out on transition quality: a Look-Around-style parallax transition from photo to 3D DEM, rather than a cut or crossfade, and a photo-to-terrain dissolve driven by the solved camera.
- PeakVisor's manual drag-and-rotate alignment UI is the baseline that Rigi's automatic pose solve beats. Showing the solve as an animated "snap into place" turns that technical win into a visible moment.

### Gaps
- I did not retrieve PeakFinder, PeakLens, Mapillary or then/now slider exemplars, Google Earth's photo-in-3D placement, or detailed label typography from any AR peak app.

## Tooling used

### Takeaway
The current premium stack in the verified case studies is Three.js or R3F with Drei, GSAP (ScrollTrigger), Lenis smooth scroll, and Theatre.js for timeline-authored cameras. It also uses WebGL text (troika), KTX2 and DRACO asset compression, Blender for baking terrain, and Next.js with a headless CMS. Newsrooms add 3D Tiles loaders for photoreal data.

### Cited Findings
- San Rita: R3F, Next.js 16, GSAP, Lenis, DatoCMS, Blender, and custom GLSL on photography. — [Abduzeedo](https://abduzeedo.com/node/89189)
- Symphony of Vines: Three.js, troika-three-text, KTX2, DRACO, and code-authored camera paths. — [Unseen dev insights (secondary via search)](https://unread.unseen.co/the-symphony-of-vines-dev-insights-c284cc4e8aa0)
- Theatre.js, R3F, Drei and Vite for scroll camera fly-throughs. — [Codrops](https://tympanus.net/codrops/?p=70449)
- NYT R&D three-loader-3dtiles (loaders.gl) supports Google Photorealistic 3D Tiles. — [GitHub](https://github.com/nytimes/three-loader-3dtiles/)
- The Pudding's Scrollama.js is the classic newsroom scroll-step trigger. — [Pudding](https://pudding.cool/process/introducing-scrollama/)
- Indie "Everest" scroll demo stack: GSAP, Lenis, Canvas/WebGL and WebAudio in one HTML file. It shows sound is used in scroll pieces. — [GitHub yash262626/Everest-Summit](https://github.com/yash262626/Everest-Summit)

### Inferences
- Rigi already uses deck.gl/luma, so it should take the patterns rather than the libraries: Lenis-style smoothed scroll input, timeline-authored camera keyframes, staged loading, and KTX2-compressed photo textures. These can sit alongside deck.gl. A Theatre.js-style keyframe JSON could drive deck.gl view-state interpolation.

### Gaps
- I did not verify the maintenance status of Theatre.js in 2025–26, or uptake of Rive, Lottie, Motion and the View Transitions API in geospatial showcases.
