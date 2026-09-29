# Consumer peak-identification, AR and photo-annotation apps (state as of Sept 2026)

Scope: consumer products that identify peaks or overlay terrain/map data on a live camera view or an existing photo. The comparison point is Rigi, a browser app that automatically aligns a DEM skyline to an iPhone photo using EXIF GPS, compass and gravity priors. Rigi then overlays contours, peaks and trails, blends satellite or topo renders into the photo, or projects the photo onto 3D terrain.

Research date: 2026-09-26. About 35 search and fetch calls were made. Several app-store and aggregator pages (Google Play, AppBrain, ResearchGate, ACM, Springer, Wikiloc help) blocked or truncated fetches. As a result some download counts and paper accuracy figures are missing and are listed as gaps.

---

## Q1. Competitor profiles: what each product does, post-hoc vs live, alignment method, platforms, pricing, scale, ownership, recent news

### Takeaway
The market has two main dedicated players, PeakFinder and PeakVisor. Both mostly use compass and GPS alignment in live AR. Both can import existing photos, but you align the photo by hand by dragging the rendered panorama. PeakLens is the only consumer app with published image-based skyline matching. It is Android-only, live-camera only, and comes from a Politecnico di Milano research project. The big outdoor platforms either have compass-only AR (Outdooractive Skyline, Bergfex, Wikiloc) or none at all (Gaia GPS, AllTrails, Komoot as far as found). FATMAP, the main consumer 3D-terrain product, was shut down on 1 Oct 2024. A wave of new 2025–26 iOS "Mountain Identifier" AI apps identifies peaks from photos with generic image AI, not with DEM geometry.

### Cited Findings

**PeakFinder (Switzerland, Fabio Soldati, since 2010)**
- Created by Swiss software engineer Fabio Soldati and released in 2010. Die Zeit called it "the Shazam for mountains." — [Wikipedia](https://en.wikipedia.org/wiki/PeakFinder)
- Data comes from NASADEM, SRTM, European LiDAR, OpenStreetMap and GeoNames. It covers more than 1M peaks as of 2026. It has had a public web API for third-party panoramas since 2022. — [Wikipedia](https://en.wikipedia.org/wiki/PeakFinder)
- Business model: a one-time paid app with no ads and free updates. — [Wikipedia](https://en.wikipedia.org/wiki/PeakFinder)
- iOS: $4.99 one-time with no IAP, rated 4.7/5 from 12,000+ ratings. The store page fetched showed v4.8.89 dated 27 Aug 2024. A search summary reported v4.8.99 with a last update of 26 Aug 2026, so the version data conflicts. — [App Store](https://apps.apple.com/us/app/peakfinder/id357421934); [search summary, AppBrain/soft112 listing](https://peakfinder-alps.soft112.com/)
- Fully offline and worldwide, with a 360° panorama. It shows peaks up to 300 km away and sun/moon paths with rise/set times. — [App Store](https://apps.apple.com/us/app/peakfinder/id357421934); [PeakFinder mobile](https://www.peakfinder.com/mobile/)
- **Post-hoc photos:** the "Photos" menu can "import any image from other sources" and export labeled images. — [PeakFinder manual](https://www.peakfinder.com/mobile/manual/)
- **Alignment:** held upright, "the panorama is automatically aligned with the direction of the compass." Fine-tuning is manual: you "drag the panorama display to the desired direction." The manual does not mention reading EXIF location, direction or FOV. — [PeakFinder manual](https://www.peakfinder.com/mobile/manual/)
- Recent updates added fine-tuning controls for silhouette position in the photo editor. — [App Store](https://apps.apple.com/us/app/peakfinder/id357421934)
- Peak count conflict: PeakVisor's comparison page (dated, self-interested) says PeakFinder has "only about 600k" peaks. Mountain Peak AR marketing quotes "650,000." Wikipedia says more than 1M in 2026. — [PeakVisor](https://peakvisor.com/en/news/peakfinder-vs-peakvisor.html); [Wikipedia](https://en.wikipedia.org/wiki/PeakFinder)

**PeakVisor (Routes Software SRL; self-financed)**
- Company: Routes Software SRL, an "independent, self-financed team" working "without investors or advertising." — [PeakVisor pricing update 2025](https://peakvisor.com/en/news/2025-pricing-update.html)
- Pricing from 1 June 2025, the first price change: monthly $9.99 (was $5.99), yearly $39.99 (was $29.99), a new 3-year plan at $100, and a $150 gift/unlimited option on the website. — [PeakVisor pricing update 2025](https://peakvisor.com/en/news/2025-pricing-update.html)
- iOS: free with IAP, rated 4.6/5 from 13,000+ ratings, v5.115 updated about Sept 2026. There is also a one-time "3D Maps & AR" IAP at $159. — [App Store](https://apps.apple.com/us/app/hiking-and-skiing-peakvisor/id1187259191)
- Android: about 1M+ downloads, rated 4.6. This comes from a third-party aggregator (MWM), not verified on Google Play. — [MWM](https://mwm.ai/apps/hiking-maps-peakvisor/1187259191)
- The Pro tier includes real-time peak ID, offline 3D maps, route planning, Garmin Connect integration, flyover videos and a "Karma" score. — [PeakVisor pricing update 2025](https://peakvisor.com/en/news/2025-pricing-update.html)
- More than 1M peaks, plus prominence, range, Wikipedia links, huts and castles. PeakVisor claims a "higher precision landscape model" than PeakFinder in the Alps, Rockies and Dolomites (self-published comparison). — [PeakVisor vs PeakFinder](https://peakvisor.com/en/news/peakfinder-vs-peakvisor.html)
- **Post-hoc photos:** you import any photo and overlay a 3D landscape model with peaks, huts, lakes and castles. The same flow runs on the web ("Mountain Explorer") and on mobile, and it is described as "totally free." — [PeakVisor: identify mountains in photos](https://peakvisor.com/en/news/identify_mountains_in_photos.html); [Mountain Explorer](https://peakvisor.com/panorama.html)
- **Alignment is manual:** you "adjust the rendered 3D terrain panorama to perfectly match horizon in the photo" by dragging a central cross and side rotators for tilt. Embedded photo location is used when present. Otherwise "use a map to properly position the viewpoint." — [PeakVisor](https://peakvisor.com/en/news/identify_mountains_in_photos.html)
- Bellingcat documents PeakVisor ("PhotoFit" style overlay) as an OSINT geolocation tool. There you test candidate locations by adjusting location, orientation and FOV against the photo. — [Bellingcat 2023](https://www.bellingcat.com/resources/2023/07/13/more-than-mountaineering-using-peakvisor-for-geolocation/); [Bellingcat toolkit](https://bellingcat.gitbook.io/toolkit/more/all-tools/peakvisor)
- Live AR: the App Store copy mentions visual stabilization so labels "stay glued to the mountains," with adjustable AR accuracy settings. I found no primary documentation of automatic skyline matching for imported photos. The fetch summary of the store page said "automatic peak identification" on imported photos, but PeakVisor's own tutorial describes manual matching. — [App Store](https://apps.apple.com/us/app/hiking-and-skiing-peakvisor/id1187259191); contradicted by [PeakVisor tutorial](https://peakvisor.com/en/news/identify_mountains_in_photos.html)

**PeakLens (Politecnico di Milano, DEIB)**
- A research result of Politecnico di Milano's Dipartimento di Elettronica, Informazione e Bioingegneria. The app is dedicated to the memory of Alfredo Castro Bernita. — [peaklens.com](https://www.peaklens.com/)
- Android only (Google Play and Huawei AppGallery), live camera, offline map downloads, and peaks from OpenStreetMap. — [peaklens.com](https://www.peaklens.com/)
- It "corrects GPS, compass, magnetometer and gyroscope errors with artificial intelligence." The DEM is SRTM. — [Google Play](https://play.google.com/store/apps/details?id=com.peaklens.ar&hl=en_US) (via search snippet); [PeakLens policy](http://www.peaklens.com/policy.html)
- **Method:** a CNN does pixel-wise skyline detection on camera frames. The result is aligned with a virtual panorama rendered from GPS position, the compass prior and the DEM, which corrects the compass heading. — [CNN for Pixel-Wise Skyline Detection (Springer, 2017)](https://link.springer.com/chapter/10.1007/978-3-319-68612-7_2); [Framework for Outdoor Mobile AR… Mountain Peak Detection (Fedorov, Frajberg, Fraternali, 2016)](https://link.springer.com/chapter/10.1007/978-3-319-40621-3_21)
- Lineage: Roman Fedorov's 2013 PoliMi MSc thesis matched photo edge maps to rendered mountain silhouettes to estimate FOV and heading for user-generated (post-hoc) social-media photos. It proposed peak tagging of social photos. — [arXiv 1508.02959](https://arxiv.org/abs/1508.02959). Related work: the "Snow-Watch" AR framework, and a location-based VR app for augmented panoramic mountain images (Virtual Reality journal, 2019). — [ACM WWW'18 companion](https://dl.acm.org/doi/fullHtml/10.1145/3184558.3191559); [Springer Virtual Reality 2019](https://link.springer.com/article/10.1007/s10055-019-00385-x)
- A review site judges it "genuinely free," Android-only and live-only. It says it cannot zoom or manually correct compass errors and is "less precise for nearby or distant summits." — [Alti-Mag](https://www.alti-mag.com/en/outdoor-activities/best-apps-identify-mountain-peaks)
- Name confusion: there is an unrelated iOS "PeakLens" at peaklens.pro ("Take a photo and let AI identify the mountain instantly") with no developer attribution. There is also "Mountain Identifier: Peak Lens" on iOS (id6752770531). Neither appears to be the PoliMi app. — [peaklens.pro](https://www.peaklens.pro/); [App Store](https://apps.apple.com/us/app/mountain-identifier-peak-lens/id6752770531)

**Other dedicated AR peak apps (compass/GPS only)**
- AR AlpineGuide (iOS/Android): about 1M peaks in a 360° AR view, photo capture with names, and a Google Earth-like 3D mode. It is ad-supported, and the review calls the UI less polished. — [App Store](https://apps.apple.com/us/app/ar-alpineguide/id1080350636); [Alti-Mag](https://www.alti-mag.com/en/outdoor-activities/best-apps-identify-mountain-peaks)
- Mountain Peak AR (The French Software, Android): about 400k peaks, offline. — [Google Play](https://play.google.com/store/apps/details?id=com.thefrenchsoftware.mountainpeakar&hl=en)
- PeakScope Mountain Peak Finder (Android): AR peak ID plus weather and fauna info. — [Google Play](https://play.google.com/store/apps/details?id=com.testa.peakfinder&hl=en)
- SummitPeek (iOS): GPS, compass and gyro AR pins, covering about 70k peaks in the US and Canada only. — [summitpeek.com](https://www.summitpeek.com/)
- PeakID – AR Mountain Camera (ONTRAILS, iOS, released 7 May 2024, free): Japan only, about 17.6k mountains. It says accuracy "depends on your device's GPS and compass precision." — [App Store](https://apps.apple.com/us/app/peakid-ar-mountain-camera/id6766165329)
- I found no distinct products named "Peaks360," "Peak.ar" or "PeakScanner." Searches returned only the similar names above. — [search results incl. Mountain Peak AR, PeakScope](https://play.google.com/store/apps/details?id=com.thefrenchsoftware.mountainpeakar&hl=en-US)

**New wave: generic "AI Mountain Identifier" iOS apps (2025–26)**
- Many near-identical iOS apps launched around 2025. Examples: Mountain Identifier: Peak Lens, PeakSnap, Peaks, Peakr, PeakGuide and Peak Scan. They identify a mountain from a single captured or imported photo using "AI-based image analysis," some with GPS. They return name, elevation, range and trivia, not a registered skyline overlay. — [Peak Lens](https://apps.apple.com/us/app/mountain-identifier-peak-lens/id6752770531); [PeakSnap](https://apps.apple.com/us/app/mountain-identifier-peaksnap/id6751217307); [Peaks](https://apps.apple.com/za/app/mountain-identifier-peaks/id6752865266); [Peakr](https://apps.apple.com/ai/app/mountain-identifier-peakr/id6752787881); [PeakGuide](https://apps.apple.com/us/app/mountain-identifier-peakguide/id6755136139); [Peak Scan](https://apps.apple.com/us/app/mountain-identifier-peak-scan/id6748589225)
- "Peak Identifier" (mountainidentifierapp.com) takes up to four photos and returns an AI-generated ID with name, elevation, prominence and rock type. — [mountainidentifierapp.com](https://www.mountainidentifierapp.com/)

**Outdoor platforms**
- **Outdooractive "Skyline"** (Germany, Pro tier, about €2.50/month billed annually): live-camera AR labels for peaks, towns, lakes, cliffs, ridges, passes and glaciers up to 30 km away, covering about 80% of Earth's land. It relies on "the compass and GPS on the device," states compass accuracy of "plus/minus 3 degrees," and warns about magnetic cases. It works offline with saved maps. On iOS, AR navigation arrows are blended into the camera view. — [Outdooractive knowledge page](https://www.outdooractive.com/en/knowledgepage/identify-peaks-lakes-and-places-with-skyline-augmented-reality/44736566/)
- **Bergfex Tours** (Austria): a "Peak Names" feature showing name, altitude and distance of surrounding peaks. No details were found on whether it uses AR or a panorama sketch. — [Google Play](https://play.google.com/store/apps/details?id=com.bergfex.tour&hl=en_US); [bergfex](https://www.bergfex.com/c/touren-app/)
- **Wikiloc:** has a help article titled "Peak identifier with augmented reality." The page could not be fetched, so tier and method are unknown. — [Wikiloc help](https://help.wikiloc.com/article/2082-peak-identifier-with-augmented-reality)
- **Locus Map** (Asamm, Czech): an open-source AR add-on shows only the user's stored points, not peaks. Peak/horizon naming is an open user feature request. It is limited to 1 minute in the free version. — [GitHub](https://github.com/asamm/locus-addon-augmented-reality); [Locus help desk](https://help.locusmap.eu/topic/find-peaks_2); [Google Play](https://play.google.com/store/apps/details?id=menion.android.locus.addon.ar&hl=en_US)
- **OsmAnd:** no AR peak camera feature found. — [Wikipedia OsmAnd](https://en.wikipedia.org/wiki/OsmAnd) (absence of evidence)
- **Gaia GPS** (owned by Outside): one listicle claims AR peak ID, but Gaia's own materials show none. Treat it as unverified or false. — claim: [thehikingtribe](https://thehikingtribe.com/gaia-vs-alltrails-and-more-best-hiking-apps-of-2025/); no support in [Gaia GPS App Store](https://apps.apple.com/us/app/gaia-gps-mobile-trail-maps/id1201979492) / [Gaia blog new features](https://blog.gaiagps.com/category/new-features/)
- **AllTrails:** 60M+ users. It raised about $150M (investors include Spectrum Equity, Permira and Bryant Stibel). A new "Peak" tier (about $79.99/yr) launched in May 2025 with an AI custom route builder and Trail Conditions (15 environmental factors). No AR peak ID was found. — [AllTrails Wikipedia](https://en.wikipedia.org/wiki/AllTrails); [Popular Science](https://www.popsci.com/gear/alltrails-peak-subscription-hiking-app/); [TechRadar](https://www.techradar.com/health-fitness/fitness-apps/alltrails-is-the-latest-app-with-an-ai-powered-subscription-tier-but-it-looks-way-more-useful-than-the-genai-from-garmin-and-strava)
- **Komoot:** Bending Spoons acquired it in March 2025 for about €300M. Roughly 85% of about 150 staff were laid off, the founders left, and a redesign and price increase followed. No AR peak ID was found. — [DC Rainmaker](https://www.dcrainmaker.com/2025/03/komoot-acquired-history-says-this-wont-end-well.html); [BikeRadar](https://www.bikeradar.com/news/komoot-redesign-2025); [Komoot Wikipedia](https://en.wikipedia.org/wiki/Komoot)
- **FATMAP (discontinued):** Strava acquired it in January 2023. The app and website shut down on 1 Oct 2024. Flyover and 3D satellite maps moved into Strava's paid subscription. Grades, photos, guidebooks, adventures and waypoints were not carried over. — [Strava press](https://press.strava.com/articles/fatmap-is-transitioning-to-strava); [AlternativeTo](https://alternativeto.net/news/2024/6/strava-to-shut-down-fatmap-by-oct-1st-and-integrates-key-features-into-premium-subscription/); [POWDER](https://www.powder.com/gear/strava-is-turning-off-fatmap-what-that-means-for-skiers-); [Whympr](https://get.whympr.com/en/blog-articles/fat-news-fatmap-has-shut-down)

**Swiss / Alps-specific**
- **swisstopo app** (Swiss federal office of topography): free, rated 4.3/5 from only 20 US ratings, v1.25.0 updated in late August. It offers official maps from 1:10k to 1:1M, 180+ years of historical aerial imagery, geology, and aviation/drone layers. It won "Master of Swiss Apps 2021." It has a "panorama mode" with labeled panoramic views and 3D tour visualization. swisstopo tweeted in Dec 2020 that the app now had "Augmented und Virtual Reality." — [App Store](https://apps.apple.com/us/app/swisstopo/id1505986543); [swisstopo on X](https://twitter.com/swisstopo/status/1337095286720786435?lang=de)
- swisstopo also runs separate AR/VR projects, such as a VR app with 8 sites and AR showing trails, underground structures, water depths and names. Agencies ikonaut and iart built these. — [swisstopo AR/VR](https://www.swisstopo.admin.ch/en/augmented-reality-and-virtual-reality); [ikonaut](https://www.ikonaut.ch/portfolio/augmented-reality-swisstopo/); [iart](https://iart.ch/work/swisstopo)
- PeakFinder (Swiss), Bergfex (Austrian), Outdooractive (German) and PeakLens (Italian) are all Alpine-origin players.

**Big-platform built-ins**
- **Apple Visual Look Up** (since iOS 15): identifies "popular landmarks" in Photos. It needs internet access. iOS 18 "Enhanced Visual Search" can find landmarks in the library even without geolocation. It returns identification only, with no geometric overlay. — [Apple Support](https://support.apple.com/guide/iphone/identify-objects-in-your-photos-and-videos-iph21c29a1cf/ios); [MacRumors](https://www.macrumors.com/how-to/use-visual-lookup-photos-ios/); [Apple Enhanced Visual Search](https://support.apple.com/en-us/122033)
- **Google Lens:** landmark recognition that works better with location permission. Accuracy depends on how popular the landmark is. It gives "Hmm, not seeing this clearly yet" when it fails. — [Google Lens](https://lens.google/howlensworks/); [Global Geografia](https://www.globalgeografia.com/en/from-photo-to-place.htm)
- **Snap + Niantic Spatial:** announced at AWE 2025. Niantic Spatial's VPS ("centimeter-level" pose at "millions" of pre-mapped locations, Large Geospatial Model) is coming to Lens Studio and Snap Specs (consumer launch planned for 2026). The target is 400k AR developers and 900M Snapchatters. It is urban and scan-based, not DEM or mountain-skyline based. — [Niantic Spatial blog](https://www.nianticspatial.com/blog/vps-snap-investment); [Snap investor release](https://investor.snap.com/news/news-details/2025/Snap-to-Launch-New-Lightweight-Immersive-Specs-in-2026/default.aspx); [Road to VR](https://roadtovr.com/snapchat-niantic-spatial-partnership-vps/); [Niantic Spatial Wikipedia](https://en.wikipedia.org/wiki/Niantic_Spatial)

### Inferences
- No mass-market consumer product found automatically registers an existing photo to a DEM using EXIF priors plus skyline matching. PeakFinder and PeakVisor both import photos but rely on manual drag alignment. PeakLens does automatic matching only on the live camera, and only on Android. This is Rigi's clearest gap to exploit.
- PeakVisor is the closest functional competitor for post-hoc annotation, because it has photo import, a web version, a 3D model with trails and huts, and a free photo tool. Its subscription price rise in 2025 ($39.99/yr) sets a price ceiling for consumers.
- The Apple, Google and Snap efforts target landmark recognition or urban VPS, not DEM-registered overlays. They are a threat only if they add terrain registration. The cheap "AI Mountain Identifier" apps compete for the "what is that mountain?" query but give no geometric overlay.
- Consolidation (FATMAP shut down, Komoot bought by Bending Spoons) has removed the best consumer 3D-terrain experience. That leaves room for photo-to-3D-terrain projection and satellite blending, which Rigi offers and no surveyed app does.

### Gaps
- Google Play download counts and ratings for PeakFinder, PeakLens and PeakVisor could not be verified (the Play pages were truncated and AppBrain returned 403). PeakVisor's "1M+" comes from a third party.
- PeakFinder revenue and team size, PeakVisor's founding location and team size, and PeakLens monetization and download numbers were not found.
- PeakLens paper figures (skyline CNN accuracy, heading error after correction) were not retrieved because the ACM, ResearchGate and Springer pages were paywalled or blocked.
- Details of the swisstopo app's current AR mode (live camera labels vs a rendered panorama) could not be confirmed.
- The Wikiloc AR method and tier, and whether Bergfex's peak names use AR, are unconfirmed.

---

## Q2. User review themes: complaints and most-loved features

### Takeaway
The dominant complaint across compass-based apps is compass or heading error. Offsets up to 90° are reported, often caused by magnetic phone cases or mounts. Vendors respond with manual drag correction and calibration advice, not automatic fixes. Data size is a secondary complaint (PeakVisor). The most-loved features are offline use, a large peak database, sun/moon planning for photographers, and polished labeled photo exports.

### Cited Findings
- A 2026 review-intelligence report says compass inaccuracy is a "top high-frequency complaint" for PeakFinder, with users reporting 90-degree offsets that make identification useless. This is secondary aggregator content, the page was not directly fetchable, and it came via a search snippet. — [marlvel.ai](https://marlvel.ai/intel-report/travel/peakfinder)
- PeakFinder App Store reviews mention alignment problems with magnetic phone mounts affecting compass calibration. Reviewers praise offline use ("you don't need internet connection") and sun/moon planning ("where do I have to be so the moon rises behind that mountain…", "one of my best purchases ever"). — [App Store](https://apps.apple.com/us/app/peakfinder/id357421934)
- Outdooractive officially states compass accuracy of ±3° and warns that metal objects and magnetic cases interfere. — [Outdooractive](https://www.outdooractive.com/en/knowledgepage/identify-peaks-lakes-and-places-with-skyline-augmented-reality/44736566/)
- PeakVisor reviews complain about large downloads (130MB+ per location) and cellular data use. They praise how easy identification is and the depth of terrain knowledge. — [App Store](https://apps.apple.com/us/app/hiking-and-skiing-peakvisor/id1187259191)
- A French review ranks PeakFinder as "consistently accurate," provided the compass is calibrated. PeakVisor has "reports of crashes on some devices; less consistent accuracy for distant summits." PeakLens lacks zoom and manual compass correction. AR AlpineGuide has intrusive ads. — [Alti-Mag](https://www.alti-mag.com/en/outdoor-activities/best-apps-identify-mountain-peaks)
- PeakVisor's own comparison concedes that PeakFinder has lower battery consumption because it does less. — [PeakVisor](https://peakvisor.com/en/news/peakfinder-vs-peakvisor.html)
- Former FATMAP users lament the loss of the 3D winter map mode and user-generated guidebook beta after the Strava migration. — [POWDER](https://www.powder.com/gear/strava-is-turning-off-fatmap-what-that-means-for-skiers-)
- After the acquisition, Komoot users faced a redesign and price increase. — [BikeRadar](https://www.bikeradar.com/news/komoot-redesign-2025)

### Inferences
- Heading error is the universal pain point, and nobody except PeakLens (live, Android) fixes it automatically. Rigi's skyline refinement of the EXIF compass prior speaks directly to this complaint. Rigi should publish an accuracy number: vendors publish none, apart from Outdooractive's sensor-level ±3°.
- Battery drain and data size mostly come from live AR and 3D-map downloads. A post-hoc browser workflow avoids the battery problem, but it gives up offline use, which users strongly value.

### Gaps
- No direct Reddit threads were retrieved. The ClubTread "PeakFinder vs PeakVisor" thread redirected to a paywall (tollbit) and was not read.
- No quantitative review-sentiment breakdowns from primary sources.

---

## Q3. Which apps do automatic skyline/photo alignment, and how good is it?

### Takeaway
Only PeakLens has documented, peer-reviewed automatic skyline alignment, and it runs on the live camera only. PeakVisor's live AR has "visual stabilization" (tracking so labels stay put), but its photo tool is manual. PeakFinder is compass plus manual. No vendor publishes quantitative accuracy for photo alignment.

### Cited Findings
- PeakLens refines the sensor pose by comparing the CNN-extracted camera skyline with a DEM-rendered skyline, to "overcome the low precision of the compass sensor." — [Fedorov, Frajberg, Fraternali 2016](https://link.springer.com/chapter/10.1007/978-3-319-40621-3_21); [CNN skyline 2017](https://link.springer.com/chapter/10.1007/978-3-319-68612-7_2)
- PeakLens marketing: it "automatically corrects most errors that come from the imprecision of the compass and GPS sensor." No numeric accuracy is given on the site. — [peaklens.com](https://www.peaklens.com/); [Google Play snippet](https://play.google.com/store/apps/details?id=com.peaklens.ar&hl=en_US)
- The independent review rates PeakLens accuracy as "adequate for casual users; limited for precise identification." — [Alti-Mag](https://www.alti-mag.com/en/outdoor-activities/best-apps-identify-mountain-peaks)
- Fedorov's 2013 thesis already did automatic post-hoc matching of photo edge maps to rendered silhouettes to estimate heading and FOV for geotagged social photos, but this never shipped as a consumer photo feature. — [arXiv 1508.02959](https://arxiv.org/abs/1508.02959)
- An academic skyline-matching azimuth-improvement method exists (PFG 2020). The contents were not retrievable. — [PFG 2020](https://link.springer.com/article/10.1007/s41064-020-00093-1)
- PeakVisor photo alignment is manual: drag the cross, rotate for tilt, and reposition on the map if EXIF is missing or wrong. — [PeakVisor](https://peakvisor.com/en/news/identify_mountains_in_photos.html)
- PeakFinder's photo editor has manual fine-tuning controls, and the live view auto-aligns to the compass only. — [PeakFinder manual](https://www.peakfinder.com/mobile/manual/); [App Store](https://apps.apple.com/us/app/peakfinder/id357421934)
- SummitPeek, PeakID and Outdooractive Skyline all state they rely on compass, GPS and gyro. — [SummitPeek](https://www.summitpeek.com/); [PeakID](https://apps.apple.com/us/app/peakid-ar-mountain-camera/id6766165329); [Outdooractive](https://www.outdooractive.com/en/knowledgepage/identify-peaks-lakes-and-places-with-skyline-augmented-reality/44736566/)

### Inferences
- The brief's premise needs correcting: PeakVisor does not appear to do automatic skyline alignment on photos, based on its own documentation. It is manual, and the store copy is ambiguous.
- Rigi's position, automatic skyline alignment on existing photos with EXIF priors, is not shipped by any surveyed consumer product. PeakLens's research lineage is the closest prior art academically.

### Gaps
- There are no published quantitative accuracy results (for example, degrees of heading error) for any consumer app. PeakLens paper numbers were behind blocked pages.
- It is unclear whether PeakLens can process gallery photos after capture. Its site describes real-time use only.

---

## Q4. Does anyone blend map imagery into photos or project photos onto 3D terrain?

### Takeaway
No surveyed consumer app blends satellite or topo renders into a user's photo, or projects a user photo onto 3D terrain. The closest are PeakVisor (3D terrain model overlaid on the photo, mostly as outline and labels, plus separate 3D maps and flyovers) and Outdooractive iOS (AR navigation arrows blended into the live camera). The Strava flyover inherited from FATMAP is 3D terrain but does not use the user's photos.

### Cited Findings
- PeakVisor overlays "a 3D landscape model" on imported photos, highlighting peaks, huts, lakes and castles, and adds a selfie/title imprint. — [PeakVisor](https://peakvisor.com/en/news/identify_mountains_in_photos.html)
- PeakVisor Pro offers offline 3D maps and "cinematic flyover videos." — [PeakVisor pricing update](https://peakvisor.com/en/news/2025-pricing-update.html)
- Outdooractive on iOS blends AR arrows for route navigation into the camera view. — [Outdooractive](https://www.outdooractive.com/en/knowledgepage/identify-peaks-lakes-and-places-with-skyline-augmented-reality/44736566/)
- FATMAP's 3D satellite maps and Flyover were moved into Strava's subscription after the shutdown on 1 Oct 2024. — [AlternativeTo](https://alternativeto.net/news/2024/6/strava-to-shut-down-fatmap-by-oct-1st-and-integrates-key-features-into-premium-subscription/)
- AR AlpineGuide offers a separate 3D map mode. — [Alti-Mag](https://www.alti-mag.com/en/outdoor-activities/best-apps-identify-mountain-peaks)
- PoliMi researchers built a VR application for "augmented panoramic mountain images." Consumer shipping is unconfirmed. — [Springer Virtual Reality 2019](https://link.springer.com/article/10.1007/s10055-019-00385-x)

### Inferences
- Photo-to-terrain draping and satellite/topo blending inside the photo appear to be uncontested features in the consumer space. They are a differentiator for Rigi, especially for photographers and for "where was I / what route did I take" storytelling.

### Gaps
- I did not verify whether PeakVisor's photo overlay can render trails or textured terrain inside the photo, beyond outline and labels. Screenshots were not inspected.
- The research-grade photo-to-DEM projection tools (for example monoplotting, WSL/EPFL) are outside this consumer scope and presumably covered by another researcher.
