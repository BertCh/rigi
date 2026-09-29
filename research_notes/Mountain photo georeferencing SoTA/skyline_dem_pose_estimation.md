# Camera Pose Estimation of Mountain Photos Against DEMs via Skyline/Silhouette Matching (classic + learned), and Visual Geo-localization in Natural Terrain — as of Sept 2026

Scope note: "Old" = 1997–2016 classic/hand-crafted era; "mid" = 2017–2022 CNN era (Čadík/Brejcha group, PeakLens, CrossLocate); "recent" = 2023–2026. Some primary PDFs (Baboud CVPR'11, Saurer IJCV'16, Porzi MVA'16) were paywalled or blocked; their numbers are taken from later papers that re-implemented or cited them, and this is flagged where it applies.

---

## Q1. Classic methods (Baboud 2011, Baatz 2012, Saurer 2016, Tzeng 2013, Naval, Chippendale, Porzi, Brejcha & Čadík, PeakLens): accuracies, runtimes, failure modes

### Takeaway
Classic DEM-alignment methods either (a) assume a known position and FOV and search the full rotation SO(3) by correlating image edges with DEM silhouettes (Baboud 2011; Brejcha & Čadík 2018), which gives about 2–3° mean error when they work but is slow and fragile on arbitrary photos, or (b) do large-area retrieval with horizon "contourlets" (Baatz 2012 / Saurer 2016), which gives 88% of images within 1 km on CH1 but needs clean sky segmentation (often user-corrected). In both cases the main failure modes are bad skyline or edge extraction (haze, clouds, snow, foreground occluders), flat or non-distinctive horizons, and position/FOV error.

### Cited Findings

**Baboud, Čadík, Eisemann, Seidel — CVPR 2011 ("Automatic photo-to-terrain alignment for the annotation of mountain pictures")**
- Registers a photo to a geo-referenced 3D terrain model. It uses silhouette edges as the most reliable features and searches for the best match with silhouette edges rendered from the model, *given only viewpoint and FOV estimates* (position + FOV assumed known). CVPR'11 pp. 41–48, DOI 10.1109/CVPR.2011.5995727 — [ACM DL](https://dl.acm.org/doi/10.1109/CVPR.2011.5995727); [Semantic Scholar](https://www.semanticscholar.org/paper/Automatic-photo-to-terrain-alignment-for-the-of-Baboud-Cad%C3%ADk/7cad03f7c4516ac107f6fa548c977f646628a067)
- Mechanism: the input image is treated as spherical, and the method searches for the rotation on SO(3) that aligns it with a spherical 360° silhouette panorama rendered from the DEM. It uses "vector cross-correlation", where edges are modelled as complex numbers (direction-aware), extracts candidate orientations and then applies a robust matching step — [Fedorov MSc thesis, PoliMi 2013 (arXiv 1508.02959)](https://arxiv.org/pdf/1508.02959)
- Matching score (as re-described in GeoPose3K): for each orientation, the score sums the lengths of query edges that run *parallel* to (within an ε-neighbourhood of) a synthetic silhouette, and penalises edges that *cross* silhouettes (negative parameter m). Edge length is non-linearly weighted (parameter p). It used a thresholded Compass edge detector (τ = 0.7) — [Brejcha & Čadík, GeoPose3K (IVC 2017) PDF, Appendix A](https://cphoto.fit.vutbr.cz/geoPose3K/data/geoPose3K_submission.pdf)
- Runtime: Baatz et al. report that "[Baboud] use a GPU implementation and report 2 minutes for determining rotation alone (assuming that the camera position is already given)" — [Baatz et al. ECCV 2012 PDF](https://www.inf.ethz.ch/personal/pomarc/pubs/BaatzECCV12.pdf)
- Confidence problem: the raw score "does not reflect the confidence of the found camera pose as its absolute value varies". Results "ha[ve] to be visually inspected by a human user" — [GeoPose3K PDF](https://cphoto.fit.vutbr.cz/geoPose3K/data/geoPose3K_submission.pdf)
- Success rate on unconstrained photos is low. On 400 random Alps100K test images, the fraction successfully registered was 2.75% with Baboud's original Compass edges, 6.20% with Canny on a dehazing depth map, 7.25% with a learned silhouette detector (thresholded), and 9.75% with the weighted learned silhouette detector plus weighted metric. The set was random Flickr photos, many probably not registrable, and correctness was checked manually — [GeoPose3K PDF, Table A.2](https://cphoto.fit.vutbr.cz/geoPose3K/data/geoPose3K_submission.pdf)
- On the GeoPose3K test set with known position, edge-only VCC-2011 (Baboud) reached an orientation-error CDF AUC of 0.52 at high resolution and 0.41 at low resolution (random = 0.29) — [Brejcha & Čadík 3DV 2018 PDF](https://cphoto.fit.vutbr.cz/semantic-orientation/data/semantic_orientation_IEEE.pdf)
- On the Venturi Mountain video dataset, Baboud's full robust metric ("VCC-2011-m3D", high resolution) had a mean orientation error of 2.88° — [Brejcha & Čadík 3DV 2018, Table 2](https://cphoto.fit.vutbr.cz/semantic-orientation/data/semantic_orientation_IEEE.pdf)
- Code: I found no official public code. The FIT/Čadík "Visual Localization in Natural Environments" page links only the paper, supplement and slides — [cadik.posvete.cz/locate](https://cadik.posvete.cz/locate/)

**Baatz, Saurer, Köser, Pollefeys — ECCV 2012 ("Large scale visual geo-localization of images in mountainous terrain")**
- Assumes a small roll and a camera near the ground, and uses a tilt-robust representation. This reduces the problem to 2D position (lat/lon) plus viewing direction. The DEM visible horizon is extracted offline on a regular grid (360° per location) as vector-quantised "contourlets" (contour words), each stored with its absolute viewing angle. The query is matched through an inverted file that votes jointly for location and direction (geometric verification built into the bag-of-words search) — [Baatz ECCV'12 PDF](https://www.inf.ethz.ch/personal/pomarc/pubs/BaatzECCV12.pdf)
- Sky segmentation: unary colour/gradient likelihoods, dehazing-based relative depth, and dynamic programming that picks the highest foreground pixel per column. This assumes no roll and no overhangs — [Baatz ECCV'12 PDF](https://www.inf.ethz.ch/personal/pomarc/pubs/BaatzECCV12.pdf)
- Database: swisstopo DEM (one sample per 2 m², height error 0.5 m to 3–8 m above 2000 m). Grid every 0.001° N-S and 0.0015° E-W (about 111 m × 115 m), camera 1.80 m above ground, cubemap 1024² per face. 3.5 M cubemaps over 40,000 km² — [Baatz ECCV'12 PDF](https://www.inf.ethz.ch/personal/pomarc/pubs/BaatzECCV12.pdf)
- Accuracy: "With probability 88%, the top-ranked candidate is within a radius of 1 km from the ground truth position." 9.9% of images had 7–217 km error. Recognition is "largely unaffected up to 20° tilt" — [Baatz ECCV'12 PDF](https://www.inf.ethz.ch/personal/pomarc/pubs/BaatzECCV12.pdf); ETH project page: "localizes 88% of the query images correctly within 1 km … and estimates the full 3D orientation"; 60%+ recognition at 30° tilt; 70–80% at ±5% FOV error — [ETH CVG Mountain Localization](https://cvg.ethz.ch/research/mountain_res)
- Runtime: after segmentation, about 10 s per image to find position and rotation over 40,000 km² (C/C++ and Matlab) — [Baatz ECCV'12 PDF](https://www.inf.ethz.ch/personal/pomarc/pubs/BaatzECCV12.pdf)
- Human in the loop: 51% of images were segmented fully automatically, 42% needed small user corrections (occlusions) and 7% needed intensive labelling (snow fields, reflections) — [Baatz ECCV'12 PDF](https://www.inf.ethz.ch/personal/pomarc/pubs/BaatzECCV12.pdf)

**Saurer, Baatz, Köser, Ladický, Pollefeys — IJCV 2016 ("Image based geo-localization in the Alps")**
- IJCV 116:213–225. Skyline-based matching that uses contours and consistent orientation constraints together. Validated on all of Switzerland (40,000 km²) with more than 200 ground-truth queries — [Springer](https://link.springer.com/article/10.1007/s11263-015-0830-0); [Semantic Scholar](https://www.semanticscholar.org/paper/Image-Based-Geo-localization-in-the-Alps-Saurer-Baatz/be8b56162a4e9abd090136847afca98c79c1477b)
- Datasets: CH1 (203 images, 226 MB) and CH2 (948 images, 1.2 GB), downloadable from ETH (CH1.tgz, CH2.tgz) — [ETH CVG](https://cvg.ethz.ch/research/mountain_res)
- Human involvement in segmentation fell to about 40% on CH2 in the extended work — [Ahmad, Campr, Čadík, Bebis, arXiv 1805.08105](https://arxiv.org/pdf/1805.08105)
- Independent re-implementation on GeoPose3K (86,000 km² area, public 24 m viewfinderpanoramas DEM rather than 2 m swisstopo) performed "a bit worse than in the original publication". The authors attribute this mainly to the coarser public DEM — [GeoPose3K PDF](https://cphoto.fit.vutbr.cz/geoPose3K/data/geoPose3K_submission.pdf)
- Heading accuracy (first quantitative evaluation, correct candidates within 1 km): median heading error about −0.2° to −1.8°, but mean absolute error 7.9°–36° depending on area and segmenter, with heavy tails (for example, the ALE segmenter's 95th percentile ranged from about 29° to 98° across areas). Authors: "a correctly localized image also implies a correctly estimated heading. However, such an estimated heading is only an approximate estimation, since the usual mean error varies between 0.12° and 11.88°" — [GeoPose3K PDF, Table 1](https://cphoto.fit.vutbr.cz/geoPose3K/data/geoPose3K_submission.pdf)
- Sensitivity to segmentation: with automatic DeepLab sky masks instead of user-refined horizons, HLoc (Saurer) orientation AUC fell to 0.49 (GeoPose3K) and 0.40 (CH1), compared with 0.77/0.84 using synthetic or user-refined horizons. On Venturi the mean error rose from 28.0° to 98.8°. Conclusion: "HLoc … depends on fine-grained horizon line segmentation and it is not suitable for a fully automatic processing" — [Brejcha & Čadík 3DV 2018](https://cphoto.fit.vutbr.cz/semantic-orientation/data/semantic_orientation_IEEE.pdf)
- Code: no official code found. Brejcha & Čadík publish their own HLoc re-implementation (brejcha_hloc.zip) and segmented sky data (segments_hloc.zip) — [semantic-orientation project page](https://cphoto.fit.vutbr.cz/semantic-orientation/)

**Tzeng, Zhai, Clements, Townshend, Zakhor — CVPRW 2013 ("User-driven geolocation of untagged desert imagery using DEMs")**
- No GPS, focal length or FOV needed. The user traces the skyline, which is refined automatically. Concavity-based, scale-invariant skyline features are matched with geometric constraints against a database of DEM skylines. The DEM is sampled every 1000 m over a 10,000 km² desert. The renderer produces more than 250 2000-px-wide skylines per second on a Core i7. Test set of 44 images — [CVF Open Access PDF](https://openaccess.thecvf.com/content_cvpr_workshops_2013/W07/papers/Tzeng_User-Driven_Geolocation_of_2013_CVPR_paper.pdf)
- Results are reported as geolocation area (GA) over ROI: more than 25% of queries have GA/|ROI| < 0.01 and more than 50% have GA/|ROI| < 0.10. Failure modes: images "taken on a slope of mountainous terrain with nearby ridges" are "very sensitive to small changes in location" (database not dense enough). Best cases are distant ridges seen from flat ground — [CVF PDF](https://openaccess.thecvf.com/content_cvpr_workshops_2013/W07/papers/Tzeng_User-Driven_Geolocation_of_2013_CVPR_paper.pdf)

**Naval et al. (1990s) and Chippendale et al.**
- Naval: recovers camera position and orientation from a single mountain image by aligning the image skyline with a synthetic DEM skyline. Needs no initial position or orientation, only a known camera height above ground — [ResearchGate: "Estimating Camera Position and Orientation from Geographical Map and Mountain Image"](https://www.researchgate.net/publication/2475290_Estimating_Camera_Position_and_Orientation_from_Geographical_Map_and_Mountain_Image); [Semantic Scholar: "Camera Pose Estimation by Alignment from a Single Mountain Image"](https://www.semanticscholar.org/paper/Camera-Pose-Estimation-by-Alignment-from-a-Single-Naval/3a1f20a89cce8df6df44848cb71a68ad0b878e3e)
- Chippendale et al. built a 3D synthetic model around the user's location from NASA's global DTM for aligning photos and labelling peaks — [ResearchGate figure/abstract](https://www.researchgate.net/figure/Aligned-photo-with-mountain-peaks-labelled_fig1_224383291)

**Porzi, Rota Bulò, Lanz, Valigi, Ricci — ICDSC 2014 / Machine Vision and Applications 2016–17 (FBK)**
- Smartphone AR. GPS and inertial sensors give a rough position and orientation. A learned contour detector (Random Ferns) extracts mountain profiles, which are aligned to synthetic DEM profiles to refine the orientation — [Springer MVA](https://link.springer.com/article/10.1007/s00138-016-0808-0); [dblp](https://dblp.org/rec/journals/mva/PorziBLVR17.html); [ResearchGate ICDSC 2014](https://www.researchgate.net/publication/272826616_Learning_Contours_for_Automatic_Annotations_of_Mountains_Pictures_on_a_Smartphone)
- On the Venturi Mountain dataset (12 videos), Porzi's RFNh-HOR (sensor-initialised) reached a mean orientation error of 1.23° (std 1.24°), against 9.43° mean for raw device SENSORS. Brejcha & Čadík's sensor-free method achieved 1.92° mean (high resolution) — [Brejcha & Čadík 3DV 2018, Table 2](https://cphoto.fit.vutbr.cz/semantic-orientation/data/semantic_orientation_IEEE.pdf)
- Porzi's approach uses learning-based edge filtering, which lowers computational cost for phone use, and assumes roughly known position and orientation — [Ahmad et al. arXiv 1805.08105](https://arxiv.org/pdf/1805.08105)

**Brejcha & Čadík — GeoPose3K (Image and Vision Computing 2017)**
- More than 3,000 mountain photos with precise camera pose (GPS position, FOV, full orientation), plus rendered depth, normals, illumination and semantic labels (sky, water, forest, glacier, rock). 38 GB tar.gz download — [GeoPose3K project](https://cphoto.fit.vutbr.cz/geoPose3K/); [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0262885617300963)
- Poses were produced semi-automatically with an improved Baboud-style "Weighted Alignment Metric", candidate refinement over 8 positions (500 m and 1000 m squares) × 4 FOVs (±10%), then manual verification: "three weeks on seven computers" plus "one man-month" of manual checking. DEM is 24 m (viewfinderpanoramas) — [GeoPose3K PDF](https://cphoto.fit.vutbr.cz/geoPose3K/data/geoPose3K_submission.pdf)

**Brejcha & Čadík — 3DV 2018 ("Camera orientation estimation in natural scenes using semantic cues")**
- Projects the query onto a sphere and cross-correlates it on SO(3), using the SOFT FFT package, against a 360°×180° panorama of DEM-rendered semantic segments. It is fused ("Confidence Fusion", CF) with Baboud's edge VCC. Position and horizontal FOV are assumed known. No sensors are used — [3DV 2018 PDF](https://cphoto.fit.vutbr.cz/semantic-orientation/data/semantic_orientation_IEEE.pdf); [IEEE Xplore](https://ieeexplore.ieee.org/document/8490971/)
- Results on the GeoPose3K test set (516 images): AUC 0.52 for edges only, 0.70 for segments only and 0.78 for segments + edges. On Venturi, CF combined with Baboud's m3D reached a mean error of 1.92° (vs 2.88° for Baboud alone) at high resolution, and 5.93° vs 21.06° at low resolution — [3DV 2018 PDF](https://cphoto.fit.vutbr.cz/semantic-orientation/data/semantic_orientation_IEEE.pdf)
- Runtime and memory: the low-resolution SO(3) correlation takes about 1.5 s per cross-correlation, up to 30 s per query, using 247 MB. High resolution takes 45 s per correlation and 12 GB. The low-resolution grid is about 3° per bin. Segments degrade less under subsampling than edges do — [3DV 2018 PDF](https://cphoto.fit.vutbr.cz/semantic-orientation/data/semantic_orientation_IEEE.pdf)
- Failure modes identified: horizon ill-defined or non-descriptive (a high viewpoint over flat land), horizon contaminated by foreground trees, and no sky in frame because of camera pitch — [3DV 2018 PDF](https://cphoto.fit.vutbr.cz/semantic-orientation/data/semantic_orientation_IEEE.pdf)

**Brejcha et al. — "Immersive Trip Reports" (UIST 2018)**
- An automated pipeline aligns trip photos with a DTM for fly-through/VR presentations. It uses SfM (OpenMVG) and ICP (libpointmatcher) to align to terrain, and the viewer supports manual correction. The C++ code uses OpenSceneGraph/osgEarth, GDAL and Ceres, and ships with a LICENSE.txt file (I did not verify its terms) — [project page](https://cphoto.fit.vutbr.cz/immersive-trip-reports/); [GitHub brejchajan/itr](https://github.com/brejchajan/itr)

**PeakLens (Politecnico di Milano — Fedorov, Frajberg, Fraternali, Torres)**
- Aligns a virtual panorama, computed from GPS, compass and a DEM, with the mountain skyline extracted by a CNN from the camera view — [ICANN 2017 "CNN for pixel-wise skyline detection" (Springer)](https://link.springer.com/chapter/10.1007/978-3-319-68612-7_2); [PeakLens site](https://www.peaklens.com/)
- The skyline CNN (patch-trained, LeNet-derived, fully convolutional) has reported accuracy of 94.45% in the best conditions and 86.87% in the worst, 9.36 MB average memory and 273 ms on a Nexus 6. These figures come from the search-engine summary of the ICANN 2017 abstract; I did not verify them against the full text — [Springer ICANN 2017](https://link.springer.com/chapter/10.1007/978-3-319-68612-7_2)
- Predecessor (Fedorov MSc thesis 2013) adapts Baboud's VCC but (1) estimates FOV from EXIF, (2) assumes zero tilt, so it searches a cylindrical rather than spherical panorama over heading only, (3) uses an external panorama-rendering service, and (4) adds a step for peak misalignment caused by position error. It matched 64.2% of input geotagged photos — [arXiv 1508.02959](https://arxiv.org/pdf/1508.02959)
- PeakLensVR extends the algorithm to 360° panoramas — [ACM WWW'18 companion](https://dl.acm.org/doi/fullHtml/10.1145/3184558.3191559); [Virtual Reality 2019](https://link.springer.com/article/10.1007/s10055-019-00385-x)
- Code: I found no open-source release. PeakLens is a closed Android app ([Google Play](https://play.google.com/store/apps/details?id=com.peaklens.ar))

**NASA Ames horizon orientation (Bouyssounouse, Nefian et al., ~2016)** — a clean optimisation baseline
- Detected horizon d and rendered horizon r(θ) are stored as per-column row indices. θ = (roll, pitch, yaw) minimises Σ(dᵢ − rᵢ(θ))², skipping all-sky or all-ground columns and normalising by the number of valid columns. It is solved with Gauss–Newton using numerical derivatives and multiple restarts at offsets of −2.5, 0 and +2.5° per axis. Average absolute orientation error was 1.51°, against 2.47° for INS with ±5° noise — [NASA NTRS PDF](https://ntrs.nasa.gov/api/citations/20160011500/downloads/20160011500.pdf)

### Inferences
- For the user's case (known approximate GPS, possibly a compass), the relevant classic family is "known position → orientation search" (Baboud, Porzi, PeakLens, Brejcha 3DV'18, NASA). Large-area retrieval (Baatz/Saurer, Tzeng, CrossLocate) matters only as a fallback for bad or missing GPS.
- Reported accuracies of about 1–3° mean orientation error are achievable when the skyline is clean and position is close. On random internet photos, fully automatic success rates are low (under 10% in GeoPose3K's Baboud experiment), so a production app needs a confidence score and a user-correction step.

### Gaps
- I could not get the Baboud 2011 full text (MPI and TU Delft mirrors returned 403), so its original success rate on its own test set is not quoted here; only third-party re-evaluations are.
- I could not access the full text of Porzi MVA 2016/17 or Saurer IJCV 2016, so exact per-dataset numbers beyond those above are missing.
- The Chippendale et al. paper itself (title, venue, numbers) was not retrieved; only a secondary description.

---

## Q2. Learned methods 2019–2026: skyline/ridge detection, cross-domain image↔DEM matching, CrossLoc/CrossLocate, datasets, transformer/diffusion/neural rendering

### Takeaway
The main learned approach for full 6-DoF plus refinement is **LandscapeAR (ECCV 2020)**. It uses learned cross-domain local descriptors between the photo and textured-DEM renders, then EPnP + RANSAC; code is public. For retrieval, **CrossLocate (WACV 2022)** uses rendered depth, silhouette and semantic modalities; code and data are public. Since 2023 the mountain-specific literature is thin. I found better skyline segmenters (YUNet 2025), cross-modal skyline retrieval (CMLocate 2023), maritime HorizonNet (arXiv Aug 2026), and survey work (Skutsch et al. 2025/26). I found **no** transformer- or diffusion-based mountain photo↔DEM pose paper in 2023–2026.

### Cited Findings

**LandscapeAR — Brejcha, Lukáč, Hold-Geoffroy, Wang, Čadík, ECCV 2020**
- Registers camera images to *textured* DEMs with a learned cross-domain descriptor. Training data comes from SfM reconstructions of internet photos aligned to the terrain. No SfM is needed at test time — [ECCV PDF](https://www.ecva.net/papers/eccv_2020/papers_ECCV/papers/123740290.pdf); [Springer](https://link.springer.com/chapter/10.1007/978-3-030-58526-6_18)
- Motivation: phone compass suffers magnetic variation and deviation, and the accumulated error "results in visible mismatches in places such as the horizon line". DEMs are too coarse for sharp peaks. Photos have unknown intrinsics, seasonal and weather changes, foreground occluders and buildings. "Registration to DEMs only makes sense for images that observe a significant amount of content farther away than ca 100 meters" — [ECCV PDF](https://www.ecva.net/papers/eccv_2020/papers_ECCV/papers/123740290.pdf)
- Pipeline:
  - Render a fan of 12 views (FOV 60°, 30° apart) at the GPS position.
  - Scale the photo by its FOV.
  - Detect SIFT keypoints and describe 64×64 patches with the learned network.
  - Vote for the top-3 renders by mutual nearest neighbours.
  - Unproject render keypoints to 3D using the render depth map.
  - Run EPnP + RANSAC and pick the lowest reprojection error with at least 60 inliers, relaxing to at least 20 (otherwise report failure).
  - Reproject all matches, then re-match and re-run EPnP ("refined pose").

  FOV is taken as known — [ECCV PDF](https://www.ecva.net/papers/eccv_2020/papers_ECCV/papers/123740290.pdf)
- On GeoPose3K (adaptive semi-hard mining), the cumulative fraction of photos within 100/300/500/700/900 m is 0.30/0.54/0.63/0.67/0.70, and within 1/3/5/7/9° rotation error is 0.39/0.60/0.65/0.68/0.69. It beats HardNet++, D2Net and NCNet with original weights — [ECCV PDF, Table 1](https://www.ecva.net/papers/eccv_2020/papers_ECCV/papers/123740290.pdf)
- The network is small enough for iPhone; the authors built an iPhone app that renders from the local DEM and orthophoto textures and runs PnP on-device — [ECCV PDF](https://www.ecva.net/papers/eccv_2020/papers_ECCV/papers/123740290.pdf)
- Code (Python, COLMAP, optional CUDA, Mapbox account for satellite textures), pretrained models, training data (Alps) and test data (Andes Huascarán, Yosemite, Nepal), plus GeoPose3K splits. The repository has a LICENSE.txt whose terms I did not confirm — [GitHub brejchajan/LandscapeAR](https://github.com/brejchajan/LandscapeAR)

**CrossLocate — Tomešek, Čadík, Brejcha, WACV 2022**
- Cross-modal retrieval: real query photos against a database *rendered from a 3D terrain model* as semantic segmentations, silhouette maps and depth maps. Depth maps worked best. About 39% of images from the whole Alps were placed within 1 km — [WACV 2022 CVF](https://openaccess.thecvf.com/content/WACV2022/html/Tomesek_CrossLocate_Cross-Modal_Large-Scale_Visual_Geo-Localization_in_Natural_Environments_Using_Rendered_WACV_2022_paper.html); [project page](https://cphoto.fit.vutbr.cz/crosslocate/)
- Data: "Sparse" set of 37,332 rendered views at 3,111 locations; "Uniform" set of 10.72 M rendered views at 1 M locations plus 12,353 Alps photos. Code in TensorFlow 1.14 / Python 3.6 with pretrained models. No license is stated on the README — [GitHub JanTomesek/CrossLocate](https://github.com/JanTomesek/CrossLocate)
- (Note: "CrossLoc", Yan et al., is a different, drone-oriented cross-modal localization benchmark. I did not research it here.)

**Learned skyline / horizon detection**
- Ahmad, Campr, Čadík, Bebis (IJCNN 2017, arXiv 2018) compared DCSI, ALE (Saurer's segmenter), FCN variants and SegNet on about 2,900 test images covering weather, illumination and season. Pixel accuracy was 0.83–0.94, but mean absolute horizon row error was large (about 30–99 px), because small misclassifications produce big skyline errors — [arXiv 1805.08105](https://arxiv.org/pdf/1805.08105)
- Ahmad, Emami, Čadík, Bebis (IJCNN 2021): shallow-learned filter banks plus shortest-path search, trained on Basalt, Web and CH1 and tested on GeoPose3K. Average absolute error was under 4 px for about 90% of images. Code is available — [arXiv 2107.10997](https://arxiv.org/abs/2107.10997); [GitHub TouqeerAhmad/skyline_detection](https://github.com/TouqeerAhmad/skyline_detection)
- YUNet (Yang et al., arXiv Feb 2025): a YOLOv11-based encoder-neck-decoder sky segmenter, with the skyline taken by Canny on the mask. SkyFinder IoU 0.9858 and Dice 99.25%. On CH1 (trained on GeoPose3K), mean skyline error 1.36 px. Cites MSSDN (Guo et al. 2020) at 1.25 px. Code: [GitHub kuazhangxiaoai/SkylineDet-YOLOv11Seg](https://github.com/kuazhangxiaoai/SkylineDet-YOLOv11Seg.git) — [arXiv 2502.12449](https://arxiv.org/html/2502.12449v1)

**Cross-modal skyline retrieval**
- CMLocate (Liu et al., IET Image Processing, July 2023): renders DEM panoramic skylines into a database, stitches query images into a panorama, extracts the skyline with "LineNet" (a modified DeepLabV3+), and does cross-modal retrieval, without GNSS — [Wiley/IET](https://ietresearch.onlinelibrary.wiley.com/doi/full/10.1049/ipr2.12883). I could not access quantitative results (403).

**Recent (2024–2026) related work**
- HorizonNet for visual terrain navigation (Grelsson, Robinson, Felsberg, Khan; arXiv 2608.30471, 31 Aug 2026). For unmanned surface vessels with 360° cameras:
  - HorizonFinder CNN (ResNet-50) regresses pitch and roll; test error below 0.1°.
  - HorizonSegmenter outputs horizon and waterline row per column.
  - A MOSSE correlation filter registers them against DEM-rendered horizons in the Fourier domain, at more than 40 grid positions per second.
  - Position error 2.47 ± 1.26 m.
  - No code mentioned.

  Earlier version: Grelsson et al., J. Field Robotics 2020 — [arXiv 2608.30471](https://arxiv.org/html/2608.30471); [JFR 2020](https://onlinelibrary.wiley.com/doi/full/10.1002/rob.21929)
- LTM: Large-scale Terrain Model for Landscapes (Fu et al., arXiv 2607.08711, July 2026). Physics-based pixel↔DEM alignment by ray tracing, used to update outdated DEMs and vegetation fuel maps from ground imagery. A mountain-terrain monocular depth model ("TopoDepth") reportedly outperforms UniDepth and DepthPro on mountains. No code link — [arXiv 2607.08711](https://arxiv.org/html/2607.08711v1)
- Skutsch, Hellwich, Fuchs-Kittowski (XR Salento 2025, Springer 2026): a survey of visual geo-localization for outdoor mobile AR. Existing methods rely on street-view imagery or "distinct mountain silhouettes and lack the capability of performing 6D localization" in rural, non-mountainous settings — [Springer](https://link.springer.com/chapter/10.1007/978-3-031-97763-3_27)
- Metadata-free Georegistration of Ground and Airborne Imagery (Bredvik, Richardson, Crispell; WACV 2025 ULTRRA workshop). Registers ground imagery to models built from airborne imagery, satellite imagery and DSMs (including NeRF-style 3D models). No numbers in the abstract and no code — [arXiv 2503.04927](https://arxiv.org/abs/2503.04927)

### Inferences
- Modern dense or detector-free matchers (LoFTR, RoMa, MASt3R-style) are the obvious drop-in replacement for LandscapeAR's 2020 descriptor when matching photos to textured DEM renders. I found no published mountain photo↔DEM benchmark of them, so their benefit here is unproven, though plausible.
- Datasets available for evaluating a pipeline: GeoPose3K (pose + FOV + depth/semantics), CH1/CH2 (position + FOV + sky masks), Venturi Mountain (orientation, video), LandscapeAR test sets, CrossLocate renders.

### Gaps
- I found no 2023–2026 CVPR/ICCV/ECCV/WACV paper specifically on mountain photo↔DEM 6-DoF + intrinsics estimation with transformers, diffusion or neural terrain rendering. This may be a real gap in the literature or a search limitation.
- I did not obtain CMLocate's accuracy numbers or code status.
- There is no reported "Alpine" dataset beyond GeoPose3K, CH1/CH2, Alps100K and CrossLocate.

---

## Q3. Sky / skyline segmentation models suitable for use (SkyFinder, ADE20K/Cityscapes segmenters, SegFormer, Mask2Former, SAM/SAM2, mobile/ONNX), accuracy with haze, clouds, snow

### Takeaway
Sky segmentation is largely solved at the IoU level (above 0.98 on SkyFinder), but *skyline localisation error in pixels* is what matters for pose. Row errors are dominated by haze, snow fields, cloud–mountain confusion and foreground occluders. General CNNs (DeepLab, FCN) are "slightly more successful in ignoring objects not present in the DEM" than classic segmenters. For a web app, a small sky/ADE20K-sky model exported to ONNX, plus per-column or DP skyline extraction, is the practical choice.

### Cited Findings
- SkyFinder: about 90,000 labelled outdoor images from 53 static AMOS webcams, covering a wide range of weather and illumination; "the largest in existence with annotated sky pixels and associated weather data" (Mihail, Workman, Bessinger, Jacobs, WACV 2016) — [SkyFinder (UKY)](http://cs.uky.edu/~jacobs/datasets/skyfinder/); [Zenodo](https://zenodo.org/records/5884485); [Semantic Scholar](https://www.semanticscholar.org/paper/Sky-segmentation-in-the-wild:-An-empirical-study-Mihail-Workman/7552cb9c940062417f55f5443320f3f0994fbad4)
- Caveat: SkyFinder cameras are static webcams, so the IoU numbers (for example YUNet 0.9858) do not transfer directly to handheld mountain photos. YUNet's CH1 skyline error of 1.36 px is the more relevant metric — [arXiv 2502.12449](https://arxiv.org/html/2502.12449v1)
- Ahmad et al. 2018: FCN8s-SiftFlow-s reached 0.9438 pixel accuracy but a 37.9 px mean horizon distance. ALE reached 0.9428 / 44.7 px. Post-processing (removing enclosed sky blobs, taking the first non-sky pixel per column) raised FCN8s-Pascal accuracy to 0.9551 — [arXiv 1805.08105](https://arxiv.org/pdf/1805.08105)
- Brejcha & Čadík 2018: among DeepLab ± CRF, FCN8s and ALE used in the orientation pipeline, DeepLab+CRF was best (AUC 0.71) with the others about 0.70. CNNs are "slightly more successful in ignoring objects not present in the digital terrain model" — [3DV 2018 PDF](https://cphoto.fit.vutbr.cz/semantic-orientation/data/semantic_orientation_IEEE.pdf)
- Baatz 2012 needed dehazing plus a depth cue for sky segmentation, and manual correction for snow fields and reflections in 7% of images — [Baatz ECCV'12](https://www.inf.ethz.ch/personal/pomarc/pubs/BaatzECCV12.pdf)
- NASA: "in the presence of atmosphere, the horizon line can be fuzzy and affected by haze or dust", and colour-based sky segmentation is unreliable, so they use iterative random-forest sky/ground classification — [NASA NTRS](https://ntrs.nasa.gov/api/citations/20160011500/downloads/20160011500.pdf)
- Deployable models:
  - fast-skyseg offers LRASPP-MobileNetV3, Fast-SCNN, BiSeNetV2 and U2Net/U2Net-lite with ONNX export, trained from ADE20K/COCO sky masks. README says MIT license but notes no LICENSE file is present. No accuracy numbers given — [GitHub WEIIEW97/fast-skyseg](https://github.com/WEIIEW97/fast-skyseg)
  - xiongzhu666 Sky-Segmentation-and-Post-processing ships an ONNX sky model (U2Net, 167 MB) and a 2 MB U2NetP demo. About 300 ms on Snapdragon 888. The high-precision model is not public — [GitHub](https://github.com/xiongzhu666/Sky-Segmentation-and-Post-processing); mirror on [Hugging Face JianyuanWang/skyseg](https://huggingface.co/JianyuanWang/skyseg)
  - SegFormer-B0 fine-tuned on ADE20K (which has a sky class) is available on Hugging Face — [nvidia/segformer-b0-finetuned-ade-512-512](https://huggingface.co/nvidia/segformer-b0-finetuned-ade-512-512)
- Shallow-learned skyline extractor (code available): under 4 px for about 90% of images — [GitHub TouqeerAhmad/skyline_detection](https://github.com/TouqeerAhmad/skyline_detection)

### Inferences
- For robustness to clouds sitting on ridges, snow–sky low contrast and haze, using a *soft* sky probability and a semantic (area) cost is safer than a hard binary skyline (Brejcha 3DV'18 shows areas beat boundaries).
- SAM/SAM2 with a "sky" prompt, or Mask2Former/OneFormer ADE20K checkpoints, are plausible higher-accuracy server-side options. I found no mountain-skyline benchmark of them.

### Gaps
- I found no published benchmark of SAM/SAM2, Mask2Former or OneFormer on mountain skyline pixel error (CH1/GeoPose3K) and no haze/cloud/snow-stratified evaluation of modern segmenters.
- I did not verify the SegFormer license (the NVIDIA SegFormer weights may carry a non-commercial license). This needs checking before commercial use.

---

## Q4. Optimisation formulation: pose parameterisation, cost functions, coarse-to-fine yaw search on 360° DEM skyline, unknown focal length, near-field occluders

### Takeaway
Standard practice is a two-stage approach:
1. A global search, either over heading only on a cylindrical 360° panorama (PeakLens / Fedorov, which assume zero tilt) or over full SO(3) by FFT spherical correlation (Baboud, Brejcha).
2. A local refinement: least squares on per-column skyline row differences (Gauss–Newton), or PnP + RANSAC on cross-domain point matches (LandscapeAR), with FOV either taken from EXIF or sampled in a small ±10% band.

Occluders are handled by robust costs (penalise crossings, ignore invalid columns, confidence-weighted edges) and by using semantic areas rather than boundaries.

### Cited Findings
- Parameterisation:
  - Baboud / Brejcha: full rotation (α ∈ [0°, 360°], β ∈ [0°, 180°], γ ∈ [0°, 360°]) on SO(3), searched exhaustively by FFT-based spherical cross-correlation (SOFT). Position λ and horizontal FOV assumed known — [3DV 2018 PDF](https://cphoto.fit.vutbr.cz/semantic-orientation/data/semantic_orientation_IEEE.pdf)
  - Pose (f, a, o, e, α, β, γ) = FOV, lat, lon, elevation, three angles — [GeoPose3K PDF](https://cphoto.fit.vutbr.cz/geoPose3K/data/geoPose3K_submission.pdf)
  - Orientation error metric: e = arccos((tr(R_gtᵀ R_c) − 1)/2) — [3DV 2018 PDF](https://cphoto.fit.vutbr.cz/semantic-orientation/data/semantic_orientation_IEEE.pdf)
- Cost functions:
  - Edge "parallel vs crossing" score (Baboud VCC): parallel edges add their length, crossings are penalised. The weighted version multiplies by edge-strength weights w ∈ [0, 1] — [GeoPose3K PDF](https://cphoto.fit.vutbr.cz/geoPose3K/data/geoPose3K_submission.pdf)
  - Semantic-area cross-correlation per class. A second "complementary" correlation with inverted patterns penalises matches where the surroundings disagree. Blurring segment boundaries (10–20 px) barely changes results (AUC 0.70 → 0.68), so the information is in areas, not boundaries — [3DV 2018 PDF](https://cphoto.fit.vutbr.cz/semantic-orientation/data/semantic_orientation_IEEE.pdf)
  - Per-column horizon SSD: θ = argmin Σ(dᵢ − rᵢ(θ))², with invalid columns dropped and a Gauss–Newton solve with restarts — [NASA NTRS](https://ntrs.nasa.gov/api/citations/20160011500/downloads/20160011500.pdf)
  - Fourier-domain correlation (MOSSE) of per-column horizon heights against DEM-rendered horizons over a position grid — [arXiv 2608.30471](https://arxiv.org/html/2608.30471)
  - Reprojection error of 2D–3D matches (EPnP + RANSAC), with 3D points from rendered depth maps — [LandscapeAR ECCV PDF](https://www.ecva.net/papers/eccv_2020/papers_ECCV/papers/123740290.pdf)
- Coarse-to-fine search:
  - Brejcha low-resolution correlation (128³ output, about 3° bins, 1.5 s) followed by high resolution. Using CF as the initial estimate to shrink Baboud's m3D search improved both accuracy and speed — [3DV 2018 PDF](https://cphoto.fit.vutbr.cz/semantic-orientation/data/semantic_orientation_IEEE.pdf)
  - LandscapeAR: top-3 of 12 rendered 60° views, then PnP, then re-match — [ECCV PDF](https://www.ecva.net/papers/eccv_2020/papers_ECCV/papers/123740290.pdf)
  - Baatz: bag-of-words voting over location × direction bins (3° directional bins; 2.5° and 10° contourlet descriptors) — [GeoPose3K PDF](https://cphoto.fit.vutbr.cz/geoPose3K/data/geoPose3K_submission.pdf)
- Unknown focal length / FOV:
  - Baatz: a wrong FOV can be partly compensated by moving the camera forward or back, and within a "stable range" alignment error and position change smoothly. "If the FoV is completely unknown, one can get a rough estimate by choosing the minimum error and/or looking for a range where the retrieved position is most stable" (swept 11°–70° in one experiment) — [Baatz ECCV'12](https://www.inf.ethz.ch/personal/pomarc/pubs/BaatzECCV12.pdf)
  - GeoPose3K sampled FOV over f ± 10% (4 steps). Most EXIF-derived FOVs were nearly correct (errors about 1–2°) — [GeoPose3K PDF](https://cphoto.fit.vutbr.cz/geoPose3K/data/geoPose3K_submission.pdf)
  - Fedorov/PeakLens estimated FOV from EXIF (focal length plus sensor size) and rescaled the photo to the panorama's angular resolution — [arXiv 1508.02959](https://arxiv.org/pdf/1508.02959)
  - LandscapeAR scales the photo by s = (f·M)/(π·I_w) using a known FOV — [ECCV PDF](https://www.ecva.net/papers/eccv_2020/papers_ECCV/papers/123740290.pdf)
- Near-field occluders (trees, people, buildings):
  - Baatz: occlusion corrections were a major reason for user interaction (42% of images needed small fixes) — [Baatz ECCV'12](https://www.inf.ethz.ch/personal/pomarc/pubs/BaatzECCV12.pdf)
  - Brejcha: horizons contaminated by foreground trees are a key failure mode. CNN segmenters ignore non-DEM objects better — [3DV 2018 PDF](https://cphoto.fit.vutbr.cz/semantic-orientation/data/semantic_orientation_IEEE.pdf)
  - NASA: columns that are all sky or all ground are dropped from the cost — [NASA NTRS](https://ntrs.nasa.gov/api/citations/20160011500/downloads/20160011500.pdf)
- DEM rendering detail:
  - Horizon rendering needs both near high-resolution and far wide-coverage terrain. NASA used 1 m/post over 0.8×0.8 km plus 9 m/post over 10×10 km, with multi-resolution tiles chosen by distance — [NASA NTRS](https://ntrs.nasa.gov/api/citations/20160011500/downloads/20160011500.pdf)
  - GeoPose3K depth accuracy is bounded by the 24 m DEM — [GeoPose3K PDF](https://cphoto.fit.vutbr.cz/geoPose3K/data/geoPose3K_submission.pdf)

### Inferences
- A practical pipeline for the app:
  1. Get FOV from EXIF (iPhone lens metadata), with a small FOV band.
  2. Render a 360° cylindrical skyline (a per-azimuth elevation angle) from the DEM at the GPS position.
  3. Do a 1D circular correlation over yaw of the image skyline's elevation-angle profile, using pitch and roll from EXIF gravity if available, or from a coarse sweep. Seed it with the compass heading if present.
  4. Refine yaw, pitch, roll and FOV (and optionally a small position offset) with robust least squares on the per-column skyline, using a Huber/Tukey loss and masking occluded columns. Optionally add a semantic sky-IoU term.

  This combines Fedorov/PeakLens, NASA and Brejcha, and is not a single published method.
- A distance-transform/chamfer cost on DEM silhouette edges (not only the outer skyline) adds constraint from inner ridges. Baboud's parallel/crossing score is essentially a robust oriented chamfer.

### Gaps
- I found no paper that jointly optimises focal length together with 6-DoF against DEM silhouettes using an explicit differentiable renderer for mountain photos. GeoPose3K and Baatz only sample FOV discretely.

---

## Q5. Effect of GPS error (5–50 m horizontal, poor altitude) and how methods refine position

### Takeaway
For distant skylines (kilometres away), 5–50 m horizontal error barely changes the rendered horizon, so orientation estimation tolerates it. The same insensitivity makes the *position* nearly unobservable from the skyline at that scale. LandscapeAR found it cannot improve on positions already within about 200 m, and helps only when the initial error is about 200–700 m. Nearby ridges and foregrounds are very sensitive to small position shifts, and so are peak-label placements on near summits.

### Cited Findings
- LandscapeAR: "With low baselines … the geometry mismatch to the DEM dominates and the position is difficult to improve on. With baselines over 200 m, we are able to register the photo … the cross-over point where the position no longer improves over reference is around 700 m" — [ECCV PDF](https://www.ecva.net/papers/eccv_2020/papers_ECCV/papers/123740290.pdf)
- LandscapeAR rotation results: 39% of GeoPose3K photos within 1° and 60% within 3° (position initialised at ground truth in experiments) — [ECCV PDF](https://www.ecva.net/papers/eccv_2020/papers_ECCV/papers/123740290.pdf)
- GeoPose3K: GPS tags are sometimes noisy "due to manual geo-tags, bad reception … or … long GPS refresh interval". Refinement sampled positions on 500 m and 1000 m squares around the tag — [GeoPose3K PDF](https://cphoto.fit.vutbr.cz/geoPose3K/data/geoPose3K_submission.pdf)
- Baatz: bad phone GPS tags were detected by DEM-skyline inconsistency and corrected by dense geometric verification on a 111×115 m grid within 10 km. The database grid spacing itself is about 111 m, and camera height is fixed at 1.8 m above the DEM surface — [Baatz ECCV'12](https://www.inf.ethz.ch/personal/pomarc/pubs/BaatzECCV12.pdf)
- Tzeng: distant ridges seen from flat ground are "invariant to small shifts in location". Nearby formations or on-slope images are "very sensitive to small changes in location" — [CVF PDF](https://openaccess.thecvf.com/content_cvpr_workshops_2013/W07/papers/Tzeng_User-Driven_Geolocation_of_2013_CVPR_paper.pdf)
- Fedorov/PeakLens: after heading is estimated, peak alignment "may still present non-negligible errors due to inaccuracies of the estimated position", which is handled by a separate peak-level correction step — [arXiv 1508.02959](https://arxiv.org/pdf/1508.02959)
- Baboud-style orientation search for GeoPose3K found that FOV adjustment and position adjustment are coupled but not equivalent (a FOV change is not the same as moving along the view axis) — [GeoPose3K PDF](https://cphoto.fit.vutbr.cz/geoPose3K/data/geoPose3K_submission.pdf)
- HorizonNet (maritime, 360° imagery, DEM horizon correlation) reaches 2.47 m mean position error. This shows metre-level position *can* be observed when the full 360° horizon with near features is visible — [arXiv 2608.30471](https://arxiv.org/html/2608.30471)
- Camera elevation can be estimated from image content (Čadík et al. BMVC 2015, Alps100K: about 100K images, elevation from GPS + DEM). This matters when EXIF altitude is missing or poor — [arXiv 1607.03305](https://arxiv.org/pdf/1607.03305)

### Inferences
- For a single narrow-FOV iPhone photo, treat horizontal GPS (5–50 m) as a prior and optimise mainly orientation plus FOV. Allow only a small, regularised position/altitude update, which mainly matters when near terrain (under about 1–2 km) is in frame.
- Altitude matters more than horizontal error for close ridges. Snap the camera to DEM ground plus about 1.5–1.8 m (as Baatz does) when EXIF altitude is poor.

### Gaps
- I found no study that quantifies orientation error as a function of 5–50 m GPS error for mountain skyline alignment; published sweeps (LandscapeAR) start at a hundred to hundreds of metres.

---

## Q6. Open-source code availability and licenses

### Takeaway
Public, reusable code exists for LandscapeAR (full 6-DoF pipeline), CrossLocate (retrieval), Immersive Trip Reports (SfM + ICP to terrain), the Brejcha HLoc re-implementation, and several skyline/sky segmenters. No official code was found for Baboud 2011, Baatz/Saurer, Tzeng, Porzi or PeakLens. Licenses are mostly unstated or only in a LICENSE file whose terms I did not read.

### Cited Findings
- LandscapeAR (ECCV 2020): [github.com/brejchajan/LandscapeAR](https://github.com/brejchajan/LandscapeAR). Includes code, pretrained models, datasets and GeoPose3K splits. License in LICENSE.txt (terms not confirmed). Needs COLMAP and a Mapbox account.
- CrossLocate (WACV 2022): [github.com/JanTomesek/CrossLocate](https://github.com/JanTomesek/CrossLocate). TensorFlow 1.14, datasets and models included, no license stated on the README.
- Immersive Trip Reports (UIST 2018): [github.com/brejchajan/itr](https://github.com/brejchajan/itr). C++ with OSG/osgEarth, OpenMVG, libpointmatcher and Ceres. LICENSE.txt present (terms not confirmed).
- Brejcha & Čadík 3DV 2018: HLoc re-implementation (brejcha_hloc.zip) and segmented sky data on the [project page](https://cphoto.fit.vutbr.cz/semantic-orientation/). The CF method's own code is referenced as available there; license not specified.
- GeoPose3K dataset: [cphoto.fit.vutbr.cz/geoPose3K](https://cphoto.fit.vutbr.cz/geoPose3K/). 38 GB, license not stated on the page.
- CH1/CH2 datasets: [ETH CVG](https://cvg.ethz.ch/research/mountain_res), with links to cvg-data.ethz.ch/mountain-localization/CH1.tgz and CH2.tgz. No code.
- Skyline detection (IJCNN 2021): [github.com/TouqeerAhmad/skyline_detection](https://github.com/TouqeerAhmad/skyline_detection)
- YUNet skyline (2025): [github.com/kuazhangxiaoai/SkylineDet-YOLOv11Seg](https://github.com/kuazhangxiaoai/SkylineDet-YOLOv11Seg.git). Built on YOLOv11, so likely subject to Ultralytics AGPL-3.0 terms; I did not verify this.
- Sky segmentation: [fast-skyseg](https://github.com/WEIIEW97/fast-skyseg) (MIT per README, ONNX export). [xiongzhu666 Sky-Segmentation-and-Post-processing](https://github.com/xiongzhu666/Sky-Segmentation-and-Post-processing) (ONNX model). [SegFormer-B0 ADE20K on Hugging Face](https://huggingface.co/nvidia/segformer-b0-finetuned-ade-512-512).
- No public code found: Baboud 2011 ([locate page lists only paper and slides](https://cadik.posvete.cz/locate/)); Baatz 2012 / Saurer 2016 ([ETH page](https://cvg.ethz.ch/research/mountain_res) gives data only); PeakLens (closed app, [peaklens.com](https://www.peaklens.com/)); HorizonNet 2026 ([arXiv](https://arxiv.org/html/2608.30471), no code mentioned); LTM 2026 ([arXiv](https://arxiv.org/html/2607.08711v1), no code link).

### Inferences
- For a web app, the most reusable pieces are: a sky/skyline segmenter (ONNX), a custom DEM panorama/skyline renderer, and a 1D/3D skyline-correlation plus robust least-squares refiner. That last part is simple enough to implement from the formulations above and does not depend on unlicensed research code. LandscapeAR's pipeline is the reference if textured-DEM feature matching is added later.

### Gaps
- I did not read the exact license terms of the LandscapeAR and ITR LICENSE.txt files, the GeoPose3K data terms, or the CrossLocate data terms. Check these before commercial use.
