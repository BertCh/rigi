# Lettering and typefaces on Swiss official maps (Dufour, Siegfried, Landeskarte, swisstopo web maps)

Method note: several facts below were extracted directly from primary files (swisstopo legend PDF font tables, the live basemap style.json, the 2011 Weisungen PDF), not just read from summaries. Those are marked "(verified in file)". Fetches of Imhof's original texts were not possible, so Imhof's rules rest on secondary sources.

## 1. Historical lettering: Dufour map and Siegfried map, and Imhof's rules

### Takeaway
Production technique is well documented (Dufour: copper intaglio, later flat plate; Siegfried: 1:25k copper engraving in 3 colours, 1:50k Alpine sheets lithographed/stone). I found NO source that documents the typefaces on Dufour or Siegfried sheets (Antiqua vs Grotesk, italic for water, spaced capitals); do not assert specifics. Imhof's rules are known from secondary summaries only (italic and blue for water; spaced lettering for areas, not lines; consistency per class; few typefaces, vary form instead).

### Cited Findings
- Siegfried map: 1:25,000 sheets reproduced as copperplate engravings in three colours (black, brown, blue); 1:50,000 Alpine sheets as lithographs; produced 1870-1926; first editions completed 1922 (1:25k, 462 sheets) and 1926 (1:50k, 142 sheets); updates to 1949; contours 10 m (Plateau/Jura) and 30 m (Alps); each atlas accompanied by nomenclature index — [swisstopo Siegfried map](https://www.swisstopo.admin.ch/en/siegfried-map)
- Dufour map: 1:100,000, 25 sheets; published 1845 to Dec 1864; reproduced by intaglio engraving, from 1905 by flat plate impression; relief by hachures; colour additions 1908 and 1938 — [Wikipedia, Dufour Map](https://en.wikipedia.org/wiki/Dufour_Map) (secondary)
- Siegfried-era names were cut by specialist engravers (e.g. copper engraver Heinrich Müllhaupt, 1820-1894, is named as working on the maps) — search snippet via [Cartography of Switzerland / oldmapsonline listing results](https://oldmapsonline.org/maps/af2818ec-fb20-4827-9eb0-b07d54085a5f); weak attribution, treat as unconfirmed.
- Landeskarte origin: 1935 order for a new map to replace Dufour and Siegfried maps; 1:50k from 1938, 1:25k from 1952; first 1:50k originals engraved in copper; by 1949 only a third of planned sheets finished that way — search summary of [plattformj / swisstopo history](https://www.plattformj.ch/artikel/136300/) and [National Maps of Switzerland](https://en.wikipedia.org/wiki/National_Maps_of_Switzerland) (dates only)
- Imhof's essay: "Die Anordnung der Namen in der Karte" (1962), English "Positioning Names on Maps", The American Cartographer 2(2), 1975, pp. 128-144 — [Wikipedia, Typography (cartography)](https://en.wikipedia.org/wiki/Typography_(cartography)); [search result summary](https://gis.unbc.ca/wp-content/uploads/2025/01/lettering2025.pdf)
- Imhof rules as summarised: italic for hydrographic names because its curving form suggests flow; character spacing to spread an area label over the whole area but not for line labels; type size encodes importance; hue matches the labelled symbol — [Wikipedia, Typography (cartography)](https://en.wikipedia.org/wiki/Typography_(cartography)) (secondary, paraphrasing Imhof)
- Course slides (UNBC) distilling Imhof: italics and blue reserved for hydrography; upper case sparingly for major features; label above line with descenders clear; horizontal lettering unless no space or feature non-horizontal; lettering inside areas, spaced evenly but not more than about 4x letter height; serifs useful in spaced names; consistency within a class, higher contrast between classes than within; avoid many typefaces, vary form instead; contour lettering may "point uphill" — [UNBC lettering slides](https://gis.unbc.ca/wp-content/uploads/2025/01/lettering2025.pdf) (teaching notes, not Imhof's text; some items may be the lecturer's gloss)

### Inferences
- The Landeskarte legend (section 2) follows Imhof-style conventions (italic blue for water, upright for communes, slanted for sub-places), consistent with his influence; the link is plausible but I found no source stating it.

### Gaps
- No source found on the actual typefaces, sizes or engraved letter styles of Dufour/Siegfried; no scans were analysed.
- Imhof's 1962/1975 text and "Kartographische Geländedarstellung" lettering chapters were not accessed; his concrete numeric rules (min sizes, spacing, 8 point positions beyond what slides say) are unverified. Imhof's book is mainly about relief; it is not established that it treats lettering in depth.

## 2. Landeskarte typefaces over time (hand engraving, legacy "LK" fonts, Frutiger)

### Takeaway
Old LK sheets (to 2013) used a bespoke in-house family named LKRömisch / LKKursiv with size-coded cuts (A0...F10); the new generation (from 2014, 1:25k) switched to Frutiger (the 2008 legend itself already used Frutiger LT Pro for the legend text). Current digital products use "Frutiger Neue".

### Cited Findings
- Legend "Zeichenerklärung 2008" (InDesign CS3 PDF, Dec 2008) embeds fonts LKRoemisch A0/B2/C4/D6/E8/F10 in Fett, LiegendFett, Mager variants and LKKursiv A0/B2/C4/D6/F10 in Fett/Mager, plus FrutigerLTPro (Light, LightCn, Bold, Black, LightItalic) for legend text — (verified in file with pdffonts) [Zeichenerklärung 2008](https://www.swisstopo.admin.ch/dam/de/sd-web/WxsMJ4yE7xeV/Zeichenerklärung_2008_d.pdf). Reading "Römisch" as upright roman Antiqua, "Kursiv" as italic, "Liegend" as slanted/oblique roman is my interpretation of the names.
- The type samples map to old LK lettering; the 2014 text states the font in use "since 1952" was replaced — [plattformj.ch](https://www.plattformj.ch/artikel/136300/) (search-snippet level; the 1952 start date is only from a summary)
- New LK generation: first 1:25k sheets 2014; new "Frutiger font family" for easily legible text, road grading, red rail, coloured boundaries (municipal, cantonal, national), while keeping Swiss-style relief — [Käuferle, Streit, Forte, swisstopo ICA abstract](https://kartographie.geo.tu-dresden.de/downloads/ica-gen/symposium2015/20151203_ext_abstract_swisstopo.pdf) (verified in file). Data rebuilt in GIS as digital cartographic models (DCM25 from 2013, DCM50 prototype, DCM10 planned 2016).
- Same redesign list in German: "neue serifenlose Schweizer Frutiger-Schrift und Schreibweise gemäss amtlicher Vermessung (tendenziell mehr Namen)"; comparison images Siegfried 1878, LK 1954, LK 2014 — [DGPF Tagungsband 2014](https://dgpf.de/src/tagung/jt2014/proceedings/proceedings/papers/Beitrag163.pdf) (verified in file)
- Critique: a French type-design paper says it is "the first time that a sans-serif typeface appears in Swiss maps" and regrets the choice given Swiss typographic culture; it notes maps-specific fonts like Cisalpin (Felix Arnold, 2004) are rare — [Biniek et al., ICA Proc. 1, 9 (2018)](https://ica-proc.copernicus.org/articles/1/9/2018/ica-proc-1-9-2018.pdf) (verified in file). Caveat: "first time on swisstopo maps" is a claim by non-swisstopo authors and ignores sans elements in other swisstopo products.
- Frutiger = Adrian Frutiger (Swiss designer). "Frutiger Neue" appears in the swisstopo basemap style (section 5).

### Inferences
- The LK fonts were digitised versions of the engraved/stencil lettering style with optical size-coded cuts (A0 largest ... F10 smallest, point sizes visible in the PDF), so the digital era (to 2013) preserved the old look; the break is 2014.
- 2008 legend sizes may be legend sample sizes, not map sizes.

### Gaps
- Whether the 1952-2013 LK letters were hand-engraved, photo-typeset or stencil, and who designed LKRömisch/LKKursiv: not found. 
- Whether the 2014+ print LK uses Frutiger LT Pro, Frutiger Neue or a custom swisstopo cut: not verified for print (digital basemap is verified as "Frutiger Neue"). No custom swisstopo typeface design was found.
- Exact print sizes/weights of the new LK per class: no spec found.

## 3. Name classes and typographic treatment (legacy LK, 2008 legend)

### Takeaway
Typeface style encodes feature class; size encodes importance (settlements by population); colour is black for most, blue for hydrography.

### Cited Findings (all verified in file, with font/pt sizes from PDF font spec; [Zeichenerklärung 2008](https://www.swisstopo.admin.ch/dam/de/sd-web/WxsMJ4yE7xeV/Zeichenerklärung_2008_d.pdf))
- Rule text ("Kartenschriften"): script depends on object type; political communes upright, dependent places/districts/quarters slanted; names of valleys and mountains in normal weight, areas in light ("mager"); importance by size and style; settlement name size follows population.
- Settlement table (1:25k samples): city over 50,000 BERN (LKRömisch B2 Fett, 29 pt, caps); 10-50k LUGANO (F10 Fett, 20 pt, caps); commune 2,000-10,000 e.g. Sumvitg (D6 Fett, 23 pt, mixed case); under 2,000 Cressier (F10 Fett, 18 pt); place/quarter e.g. Cassarate, Bruggen (A0 LiegendFett 18-20 pt), Mürren (E8 LiegendFett, 12 pt); hamlet Le Plan (LKKursiv C4 Fett, 14 pt); single house/hut Triftthütte SAC (Kursiv D6 Fett, 10 pt). At 1:50k and 1:100k the same classes use the size scale shifted (e.g. GENÈVE ZÜRICH, CHUR, SION).
- Regions, forests: Clos du Doubs (Kursiv B2 Mager, 20 pt), Gibelegg wald letter-spaced (Kursiv D6 Mager 14 pt, spaced letters shown as "G i b e l e g g w a l d").
- Valleys: Surselva (Römisch A0 LiegendFett 26 pt), Val Malvaglia (18 pt); small local valley Chummertälli (Kursiv D6 Fett 11 pt).
- Mountains: Jungfrau (Römisch D6 Fett 23 pt, upright), Rosablanche and Poncione di Braga (Kursiv C4 Fett 14-16 pt).
- Passes: Passo del San Gottardo (Kursiv C4 Fett 14), Col de la Croix (12), Fuorcla Surlej (10), black.
- Rivers (blue, rgb about #37A0DF in the PDF): LE RHÔNE in caps (Römisch C4 LiegendFett 18 pt), Limmat (Römisch D6 LiegendFett 18), Verzasca (Kursiv C4 Fett 14), Ova Chamuera (Kursiv D6 Fett 10).
- Lakes (blue): LAGO MAGGIORE caps (Römisch A0 LiegendFett 29 pt), Lac de Morat (23 pt), Lej da Segl (Kursiv C4 Fett 14).
- Glaciers (blue): Aletschgletscher (Kursiv B2 Mager 18 pt), Vadret Pers (D6 Mager 14), Gh. dei Cavagnoli (F10 Mager 12), Gl. de Darbonneire (9 pt); abbreviations (Gl., Gh., Vadret) used.
- Abbreviations are listed in four languages (D/F/I/RM), e.g. A., F. (Firn), Gl., H. (Hütte), P. (Piz), CAS/SAC — same legend.
- Legend colours: map text #231F20 black; hydrography text blue; (brown for contours is not text). Legend symbol text itself in Frutiger.

### Inferences
- Systematic rule: upright/caps for large/important political and hydro features, italics for minor features/physical names; letter-spacing for areas such as forests. Spot-height numerals, borders and field names: not examined here.

### Gaps
- Spot height numeral style (likely italic digits; unverified), Flurname/rock/terrain-name styles, cantonal/national border text and the new-LK per-class table were not found in a primary source. Blue italic for hydrography on the old LK is supported for small rivers/glaciers; large rivers/lakes are slanted roman (LiegendFett) and caps — i.e. not all water is italic.

## 4. Name standards: swissNAMES3D, Weisungen, multilingual

### Takeaway
Local names are written per the Weisungen (1948, replaced by Weisungen 2011) following local pronunciation, with traditional spelling retained for nationally important names; swissNAMES3D is the national name dataset (about 490,000 entries) that feeds maps.

### Cited Findings
- Weisungen 2011 (swisstopo, Aug 2011, in force 1 Aug 2011, replacing the 27 Oct 1948 federal justice department Weisungen), for German-speaking Switzerland only: names collected during cadastral survey with cantonal Nomenklaturkommissionen; spelling follows local pronunciation (Art. 7) with annexed spelling rules (vowels, consonants, compounding, prepositions); names of more than local interest or shared by cantons (ranges, major mountains, rivers, lakes, glaciers, valleys, landscapes, alpine passes) keep the customary spelling (Art. 5), listed in a TLM register; building and facility names and cadastral object terms written in standard German (Art. 6); cantons may deviate if documented; legal basis GeoNV of 21 May 2008 — (verified in file) [Weisungen 2011](https://www.cadastre-manual.admin.ch/dam/it/sd-web/4SE6MyxeDpLv/Weisungen-geografische-Namen-de.pdf)
- swissNAMES3D: over 490,000 georeferenced names for Switzerland and Liechtenstein; replaces the "SwissNames" database updated to 2008; point, line and area names; yearly edition, tied to six-year TLM update cycle; 2026 edition published 29 April 2026 — [swisstopo swissNAMES3D](https://www.swisstopo.admin.ch/en/landscape-model-swissnames3d); [OSM wiki](https://wiki.openstreetmap.org/wiki/EN:Switzerland/swissNAMES3D)
- Four-language legend and abbreviations: see section 3.

### Gaps
- The French/Italian/Romansh equivalents of the Weisungen, the 2010s guidance beyond the 2011 text, bilingual labelling practice (e.g. Biel/Bienne, Fribourg/Freiburg) and swissNAMES3D attribute documentation were not retrieved. Note that earlier summaries calling the 2011 text "Toponymie guidance" are inexact: the document is "Weisungen".

## 5. Style specs, legends, and the web basemap

### Takeaway
swisstopo's vector basemap (style v1.26.0) uses only the Frutiger Neue family, with italic for physical and water names and condensed for settlements, POI and boundaries.

### Cited Findings (verified: downloaded and parsed the style JSON; [basemap style.json](https://vectortiles.geo.admin.ch/styles/ch.swisstopo.basemap.vt/style.json), MapLibre style, glyphs at vectortiles.geo.admin.ch/fonts)
- Fonts used in all 25 text layers: Frutiger Neue Regular, Condensed Regular, Condensed Medium, Medium, Italic. (Italic and Condensed Italic were claimed by one summary; only Italic found in parse.)
- Italic: peaks (peak_rank1/2, peak_lm; colour rgb(27,36,62), letter-spacing 0.025 em), mountain/area point names (area_name_point_label; valleys letter-spaced 0.8 em, else 0.3 or 0.09), glaciers (blue rgb(47,134,188), spacing 0.15-0.3), waterways line labels (blue, spacing 0.1), lake/water names (blue, spacing 0.05-0.1 growing with size rank), contour/spot elevation numerals (contour_line_pt, spacing 0.1; colours brown rgb(171,126,64) on land, blue on water/ice, grey for scree), area_name fields (13-19 px, #202020, 0.02 spacing).
- Condensed Medium: cities (place_city, #202020); Condensed Regular: towns, villages, other places (towns Condensed Medium, spacing 0.025/0.01), POIs (spring labels blue), roads (sizes 11.5-19 px; text rgb(55,43,22); rail names red rgb(183,57,57)).
- Boundaries: Condensed Regular, magenta rgb(195,85,146), spacing 0.2, uppercase for admin levels 2-4; place_country uppercase, spacing 0.12, same magenta.
- Parks: Frutiger Neue Medium, green rgb(70,121,39). Housenumbers Regular rgb(70,70,70).
- Colour vocabulary matches the new LK: violet boundaries (confirmed also in swisstopo prose), red railways, blue water, brown contour numerals — [plattformj.ch](https://www.plattformj.ch/artikel/136300/)
- Style distribution is published as open data on [opendata.swiss](https://ckan.opendata.swiss/dataset/base-map-vector-tile-style); MapTiler documents the "Leichte Basiskarte" schema: [MapTiler](https://docs.maptiler.com/schema/ch-swisstopo-lbm/) (not parsed).

### Inferences
- Web practice (Frutiger Neue family, italic = nature/water, condensed = human features, spaced capitals for admin/country) is the digital continuation of the LK class system, though not identical to the print rule set.

### Gaps
- Print Symbolkatalog / 'Kartographische Gestaltung' style specs for the new LK and a post-2014 Zeichenerklärung were not retrieved; the 2008 legend is the only legend analysed.
- Light base map (Leichte Basiskarte) and winter style fonts not checked (assumed same family).
- Not found: any statement that swisstopo commissioned a custom typeface; "Frutiger Neue" is a Linotype/Monotype commercial family, but licensing/custom-cut question remains open.
