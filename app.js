// NISAR Flood Explorer — shows only pre-built layers and text:
// web/data/events.json, <event>/layers.json (data, unchanged) and <event>/text.en.json (English display text).
// No event content is hard-coded here.
(async function () {
  const fail = (m) => (window.showLoadError ? window.showLoadError(m) : alert(m));
  if (typeof L === "undefined") return fail(t("The map could not start because Leaflet did not load."));
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // Languages (i18n.js): t() = whole translated sentence with {placeholders}; txt(id) = the event's text in the chosen language
  // (English text.en.json with every translated string replaced; English stays for anything missing)
  const I = window.I18N;
  const t = (k, v) => I.t(k, v);
  const txCache = {};
  const txt = (id) => { const k = `${I.lang}|${id}`; if (!(k in txCache)) txCache[k] = texts[id] ? (texts[id]._quake ? quakeText(id) : I.tx(texts[id])) : null; return txCache[k]; };
  const getJson = async (path) => {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  let index;
  try {
    index = await getJson("data/events.json");
  } catch (e) {
    return fail(t("The event list ({file}) could not be read: {error}.", { file: "<code>data/events.json</code>", error: e.message }) + " " +
      t("Build the layers with {command}.", { command: "<code>.venv/bin/python pipeline/export/build_web_layers.py &lt;event&gt;</code>" }));
  }
  // English text for every event (small files; needed for the event cards)
  const texts = {};
  // v73: an earthquake event (events.json "hazard": "earthquake") is drawn from its map_layers.json (built from the catalog record);
  // its short texts are written here from that file and the events.json entry, in the chosen language (see quakeText)
  const quakeLayers = {};
  await Promise.all(index.events.map(async (e) => {
    if (e.hazard === "earthquake") {
      try { quakeLayers[e.id] = await getJson(`data/${e.layers}`); } catch (err) {
        fail(t("Event layers ({file}) could not be read: {error}.", { file: `<code>data/${e.layers}</code>`, error: err.message }));
        texts[e.id] = null; return;
      }
      try { texts[e.id] = { ...(await getJson(`data/${e.id}/text.en.json`)), _quake: true }; } catch (err) { texts[e.id] = { _quake: true }; } // optional
      return;
    }
    try { texts[e.id] = await getJson(`data/${e.id}/text.en.json`); } catch (err) {
      texts[e.id] = null;
      fail(t("The event text ({file}) could not be read; run {command}.", { file: `<code>data/${e.id}/text.en.json</code>`, command: "<code>python3 pipeline/export/build_text_en.py</code>" }));
    }
  }));
  if ($("map").clientHeight === 0) fail(t("The map area has zero height; {file} may not have been applied.", { file: "<code>style.css</code>" }));

  // --- Dates: day and month for users, full UTC in the details
  // in the chosen language (Intl): "12 July 2026", "12 Temmuz 2026", "12. Juli 2026" …
  const fmtDay = (lb, withYear = true) => I.fmt.day(lb, withYear);
  const fmtShort = (lb, withYear = false) => I.fmt.short(lb, withYear);
  const fmtPair = (a, b) => I.fmt.pair(a, b);
  const fmtUtc = (s) => s.replace("T", " ").replace(/(\.\d+)?Z$/, "") + " UTC";
  const narrow = window.matchMedia("(max-width: 720px)");
  const compact = window.matchMedia("(max-width: 720px), (max-height: 500px)"); // phones, also in landscape
  // v48: how to move the map, by the device's main pointer (touch: Leaflet's one-finger drag and pinch; mouse/trackpad: drag and
  // the + / − buttons). Measured in emulation; the text promises nothing the map does not do (no trackpad two-finger pan).
  const coarse = window.matchMedia("(pointer: coarse)");
  const mapHintText = () => (coarse.matches ? t("Drag with one finger · Pinch to zoom") : t("Drag to move · Use + or − to zoom"));
  const setMapHint = () => { const h = document.getElementById("map-hint"); if (h) h.textContent = mapHintText(); };
  setMapHint();
  coarse.addEventListener("change", () => { setMapHint(); if (meta && T) renderSimpleBar(); });
  // v48b: the explanation block takes height from the map column. On phones it stays right above the map (the map keeps its
  // own height there); on wider screens it moves to the top of the side panel so the map gets the whole column back.
  const placeMapHead = () => {
    const head = document.getElementById("map-head");
    if (narrow.matches) { const wrap = document.querySelector(".map-col > .map-wrap"); if (head.nextElementSibling !== wrap) wrap.before(head); }
    else { const ev = document.querySelector(".panel > .events"); if (head.previousElementSibling !== ev) ev.after(head); }
    document.body.classList.toggle("head-in-panel", !narrow.matches);
  };
  placeMapHead();
  narrow.addEventListener("change", () => { placeMapHead(); if (meta) map.invalidateSize(); });
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  // Short, smooth map moves; no animation when the user prefers reduced motion or the page is not visible
  // (animations would not advance in a hidden tab and the map would stay where it was)
  const motion = () => (reducedMotion.matches || document.hidden ? { animate: false } : { animate: true, duration: 0.8 });

  // --- Map (created once). Free navigation: no max bounds or minimum zoom.
  const map = L.map("map", { zoomControl: true, attributionControl: true, zoomSnap: 0.25 });
  window.nisarMap = map; // for debugging
  // Moves the map to bounds. If an animated move has not finished in time (e.g. animation frames paused), it jumps there.
  let moveTimer = null;
  function goTo(b, opts = {}) {
    clearTimeout(moveTimer);
    const m = motion();
    if (!m.animate) { map.fitBounds(b, { ...opts, animate: false }); return; }
    map.flyToBounds(b, { ...opts, ...m });
    // Check the real result instead of relying on events (other moves, e.g. invalidateSize, also fire "moveend")
    moveTimer = setTimeout(() => {
      const pad = opts.padding ? L.point(opts.padding).multiplyBy(2)   // v75: also uneven padding (top / bottom kept clear of the map controls)
        : L.point(opts.paddingTopLeft || [0, 0]).add(L.point(opts.paddingBottomRight || [0, 0]));
      const want = Math.min(map.getBoundsZoom(b, false, pad), opts.maxZoom ?? Infinity);
      const off = Math.abs(map.getZoom() - want) > 0.6 || !map.getBounds().contains(b.getCenter());
      if (off) { map.stop(); map.fitBounds(b, { ...opts, animate: false }); }
    }, m.duration * 1000 + 500);
  }
  // --- Background maps. Analysis view: OpenStreetMap street map. Satellite view: EOxCloudless 2025 (Sentinel-2 natural-colour
  // composite). EOX terms (cloudless.eox.at/documentation/license, read 2026-11-07): free for non-commercial use under
  // CC BY-NC-SA 4.0; the credit below must be visible in the map interface. Commercial use needs an EOX licence.
  const SAT_YEAR = 2025;
  const SAT_URL = `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${SAT_YEAR}_3857/default/g/{z}/{y}/{x}.jpg`;
  // While new tiles load after a zoom-in, Leaflet keeps loaded coarser tiles only up to 5 levels up. The globe hand-off is at
  // Leaflet zoom 7 and the study area at 12–14, so those tiles were dropped and the map showed grey until the new ones arrived.
  // Keep them up to 8 levels up (only the outer call sets the limit; Leaflet's own recursion keeps it).
  const KeepCoarse = L.TileLayer.extend({
    // v74: at fractional zoom (zoomSnap 0.25) and on retina screens (128 px tiles) Leaflet scales the tile grid, and the tiles' edges land
    // between screen pixels: hairline gaps open between neighbouring tiles and the map's light grey ground shows through as thin white
    // lines (measured: a grid every 90.5 px at zoom 13.5, 107.5 px at 13.75 and 14.75, outside the satellite images only). Each tile is
    // drawn 1 px larger than its grid cell, so neighbours overlap by one pixel and no gap can open. The image overlays are not tiles.
    _initTile(tile) {
      L.TileLayer.prototype._initTile.call(this, tile);
      const sz = this.getTileSize();
      tile.style.width = `${sz.x + 1}px`;
      tile.style.height = `${sz.y + 1}px`;
      // Leaflet 1.9 draws tiles with mix-blend-mode: plus-lighter (it adds the half-covered edge pixels of neighbours); with the 1 px
      // overlap that addition doubled the overlapping row and column, and bright lines appeared (USGS basemap, Palisades: +80 grey levels).
      // The overlap already closes the gap, so the tiles are drawn normally.
      tile.style.mixBlendMode = "normal";
    },
    _retainParent(x, y, z, minZoom) {
      if (this._inRetain) return L.TileLayer.prototype._retainParent.call(this, x, y, z, minZoom);
      this._inRetain = true;
      try { return L.TileLayer.prototype._retainParent.call(this, x, y, z, Math.min(minZoom, Math.max(0, z - 8))); }
      finally { this._inRetain = false; }
    },
  });
  const streetBase = new KeepCoarse("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  // Tile levels (checked 2026-11-08): EOX's WMTS matrix set "g" lists levels 0–21 and the server answers up to 18, but the
  // image is a 10 m Sentinel-2 composite: from level 15 on, tiles add no detail over an enlarged level 14 (measured at
  // Chókwè and Habiganj). Level 15 (≈4.4 m/px at 24°) is the last level requested; beyond it Leaflet enlarges level 15
  // tiles, so no requests go to levels that only resample. On high-density screens (devicePixelRatio > 1) Leaflet's
  // detectRetina asks for one level more with 128 px tiles, so the native detail shows one zoom step earlier; the cap
  // is lowered by one there so the requested level never exceeds 15. Map maxZoom stays 18 (NISAR pixels are drawn
  // enlarged and pixelated, never interpolated).
  const SAT_URL_MAX = 15;
  const RETINA = L.Browser.retina;
  const satBase = new KeepCoarse(SAT_URL, {
    detectRetina: true,
    maxZoom: RETINA ? 19 : 18, // Leaflet lowers maxZoom by one when detectRetina applies → 18 either way
    maxNativeZoom: RETINA ? SAT_URL_MAX - 1 : SAT_URL_MAX, // + zoomOffset 1 on retina → requested level ≤ 15
    // EOX's required credit text (licence link CC BY-NC-SA 4.0 is in the panel legend)
    attribution: `EOxCloudless <a href="https://cloudless.eox.at">https://cloudless.eox.at</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data ${SAT_YEAR})`,
  });
  window.nisarSat = satBase; // for debugging / error test
  // Optional sharper background: Esri World Imagery (Vantor Vivid and other sources; ~0.3–0.5 m where available).
  // Esri's terms (tou_summary.pdf, updated 21 Apr 2025) require an ArcGIS account when the layer is used outside Esri
  // software, so it is used only with the user's own ArcGIS Location Platform API key (privilege: Basemaps), read from
  // the local, unshipped file web/config.local.js (see web/config.example.js). Endpoint from Esri's Leaflet tutorial
  // "Display multiple basemap layers". Without a key, or if the tiles fail, the EOxCloudless background is used.
  const CFG = window.NFE_CONFIG || {};
  const ESRI_KEY = typeof CFG.esriApiKey === "string" ? CFG.esriApiKey.trim() : "";
  // Credit text = copyrightText of the World_Imagery service (checked 8 Nov 2026)
  const ESRI_SOURCE = "Source: Esri, Vantor, GeoEye, Earthstar Geographics, CNES/Airbus DS, USDA, USGS, AeroGRID, IGN, and the GIS User Community";
  // The imagery endpoint does not check the token (it also answers an invalid one), so a loaded tile proves nothing.
  // The key is therefore checked first on the Static Basemap Tiles service, which does check it and needs the same
  // privilege as Esri's Leaflet tutorial (Location services > Basemaps > Static basemap tiles); metadata requests are free.
  // Esri is used only after this check passes; otherwise the EOxCloudless background stays.
  const ESRI_CHECK_URL = CFG.esriCheckUrl || "https://static-map-tiles-api.arcgis.com/arcgis/rest/services/static-basemap-tiles-service/v1/self";
  const ESRI_URL_MAX = 19; // ≈0.27 m/px at 24°: the finest Vivid imagery here is 0.31–0.5 m (Esri citation layer, 8 Nov 2026)
  // Esri's finest level differs by place (Chókwè has no level-18 tiles: 404; Habiganj does, 8 Nov 2026 check).
  // A missing tile is replaced by the same area from the next coarser level (up to 2 levels), shown enlarged,
  // so the map never falls back to EOX only because the finest level is missing in one place.
  const EsriLayer = KeepCoarse.extend({
    createTile(coords, done) {
      const tile = document.createElement("div"), img = document.createElement("img");
      // Leaflet removes tiles of other zoom levels whose element is not .complete (meant for <img>); without this the loaded
      // tiles of the previous level vanished at every zoom step and the map was grey during a zoom
      Object.defineProperty(tile, "complete", { get: () => img.complete && img.naturalWidth > 0 });
      tile.style.overflow = "hidden";
      img.alt = ""; img.setAttribute("role", "presentation");
      img.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;max-width:none;";
      tile.appendChild(img);
      const urlZ = this._getZoomForUrl();
      let up = 0;
      const load = () => {
        const k = 2 ** up, fx = coords.x & (k - 1), fy = coords.y & (k - 1);
        Object.assign(img.style, { width: `${k * 100}%`, height: `${k * 100}%`, left: `${-fx * 100}%`, top: `${-fy * 100}%` });
        img.src = L.Util.template(this._url, L.extend({}, this.options, { x: coords.x >> up, y: coords.y >> up, z: urlZ - up }));
      };
      img.onload = () => { tile.dataset.esriLevel = urlZ - up; done(null, tile); };
      img.onerror = (e) => { if (up < 2 && urlZ - up > 0) { up++; load(); } else done(e, tile); };
      load();
      return tile;
    },
  });
  const esriBase = ESRI_KEY ? new EsriLayer(
    `${CFG.esriTileUrl || "https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"}?token=${encodeURIComponent(ESRI_KEY)}`, {
      detectRetina: true,
      maxZoom: RETINA ? 19 : 18,
      maxNativeZoom: RETINA ? ESRI_URL_MAX - 1 : 18,
      attribution: `Powered by <a href="https://www.esri.com">Esri</a> | ${ESRI_SOURCE}`,
    }) : null;
  // v69: USGS The National Map orthoimagery (public domain, no key; cached to level 16) for events whose layers.json asks for it ("basemap": "usgs")
  const USGS_SOURCE = "USDA, USGS The National Map: Orthoimagery (data refreshed June 2024)";
  const usgsBase = new KeepCoarse("https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}", {
    detectRetina: true, maxZoom: RETINA ? 19 : 18, maxNativeZoom: RETINA ? 15 : 16,
    attribution: `<a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">${USGS_SOURCE}</a>` });
  const activeSat = () => (meta && meta.basemap === "usgs" ? usgsBase : state.satSource === "esri" && esriBase ? esriBase : satBase);
  // v69: the attribution line names what each credit is for: the background map apart from the dated images and the data layers
  for (const l of [streetBase, satBase, esriBase, usgsBase].filter(Boolean)) {
    const orig = l.options.attribution;
    l._attrOrig = orig;
    l.getAttribution = function () { if (!this._attrText) this._attrText = `${t("Basemap")}: ${orig}`; return this._attrText; };
  }
  const relabelBase = () => { // after a language change: replace the label of the background credit in place
    for (const l of [streetBase, satBase, esriBase, usgsBase].filter(Boolean)) {
      const now = `${t("Basemap")}: ${l._attrOrig}`;
      if (l._attrText && l._attrText !== now && map.hasLayer(l)) { map.attributionControl.removeAttribution(l._attrText); l._attrText = now; map.attributionControl.addAttribution(now); }
      else l._attrText = now;
    }
  };
  // Credits shown only while their data is on the map. Leaflet counts every addAttribution call, so each credit is
  // added once and removed once (v65 fix: repeated adds on every render kept a credit after its layer was gone)
  const credits = new Set();
  const setCredit = (text, on) => {
    if (on && !credits.has(text)) { credits.add(text); map.attributionControl.addAttribution(text); }
    else if (!on && credits.has(text)) { credits.delete(text); map.attributionControl.removeAttribution(text); }
  };
  // Satellite tiles that fail to load: after a few failures with none loaded, Esri falls back to EOxCloudless;
  // EOxCloudless shows an error and offers the street map
  for (const layer of [satBase, esriBase, usgsBase].filter(Boolean)) {
    let loaded = 0, errors = 0;
    layer.on("loading", () => { loaded = 0; errors = 0; }); // counted per loading round (pan/zoom/view change)
    layer.on("tileload", () => { loaded++; $("sat-error").hidden = true; });
    layer.on("tileerror", () => {
      errors++;
      if (state.view !== "satellite" || state.satFallback || errors < 3 || loaded) return;
      if (layer === esriBase && state.satSource === "esri") { state.satSource = "eox"; state.esriFailed = true; render(); }
      else if (layer === satBase || layer === usgsBase) $("sat-error").hidden = false;
    });
  }
  function syncBase() {
    const useSat = state.view === "satellite" && !state.satFallback;
    const want = useSat ? activeSat() : streetBase;
    for (const l of [streetBase, satBase, esriBase, usgsBase]) if (l && l !== want && map.hasLayer(l)) map.removeLayer(l);
    if (!map.hasLayer(want)) want.addTo(map);
    if (!useSat) $("sat-error").hidden = true;
  }
  // Panes: before/after radar (clipped by the divider), single-map change (not clipped),
  // pair-derived candidate and support layers (only on the "after" side, same clip as after)
  // "support": Landsat/GFM (independent observations; whole study area, never clipped). "pairAfter": NISAR-pair-derived layers (after side only)
  for (const [name, z] of [["before", 410], ["after", 411], ["change", 415], ["support", 418], ["pairAfter", 420], ["regions", 430]]) map.createPane(name).style.zIndex = z;

  const OPACITY = 0.8;
  const CAND = "nisar_candidate";
  const OLD_CONTROL = "old_control";
  const GFM_NOTE = "Contains modified Copernicus EMS information 2026";
  const RAMP = {
    gray: "linear-gradient(90deg,#000,#fff)",
    div: "linear-gradient(90deg,#053061,#2166ac,#4393c3,#92c5de,#f7f7f7,#f4a582,#d6604d,#b2182b,#67001f)",
  };
  const keyHtml = (keys) => `<div class="key">${keys.join("")}</div>`;
  const kRamp = (ramp, text) => `<span class="key-item"><span class="key-ramp" style="background:${RAMP[ramp]}"></span>${text}</span>`;
  const kBox = (color, text, outline = false) =>
    `<span class="key-item"><i class="${outline ? "outline" : ""}" style="${outline ? `border-color:${color}` : `background:${color}`}"></i>${text}</span>`;
  const swatch = (bg, html, extra = "") => `<div class="swatch"><i style="background:${bg};${extra}"></i><span>${html}</span></div>`;

  // Event-dependent state: rebuilt on every event change
  let meta = null, T = null, bounds = null, viewBounds = null, dateByLabel = {};
  let beforeLayer = null, afterLayer = null;
  const overlays = {};
  const outline = L.layerGroup().addTo(map);      // optional thin study-area outline
  let regionGroup = L.layerGroup();               // inspection areas
  let controlGroup = L.layerGroup();              // invalid old control area (Technical details only)
  const focusGroup = L.layerGroup().addTo(map);   // numbered "Show me" points in step 1
  // Shared across views: event, map position/zoom (Leaflet), date pair, polarisation, divider position, step.
  // Per view: layer choices (layers.satellite / layers.analysis); satellite view also has its own radar-evidence switch and opacity.
  const state = { before: null, after: null, pol: "HH", swipe: 0.5, step: 0, custom: false,
                  view: "satellite", layers: { satellite: new Set(["radar"]), analysis: new Set(["radar"]) },
                  evidence: { satellite: false, analysis: false }, opacity: { satellite: 0.6, analysis: 1 }, satFallback: false,
                  legendOpen: !window.matchMedia("(max-width: 720px)").matches,
                  satSource: "eox", esriFailed: false, satUserChoice: false,
                  esriKey: ESRI_KEY ? "checking" : "none" }; // none | checking | ok | rejected | unreachable
  if (esriBase) {
    fetch(`${ESRI_CHECK_URL}?f=json&token=${encodeURIComponent(ESRI_KEY)}`)
      .then((r) => r.json().then((j) => r.ok && !j.error && Array.isArray(j.styles)))
      .then((ok) => { state.esriKey = ok ? "ok" : "rejected"; })
      .catch(() => { state.esriKey = "unreachable"; })
      .finally(() => {
        if (state.esriKey === "ok" && !state.satUserChoice) state.satSource = "esri";
        if (meta) render();
      });
  }
  Object.defineProperty(state, "on", { get: () => state.layers[state.view], set: (v) => { state.layers[state.view] = v; } });
  // "Radar evidence" = the grey NISAR backscatter images (helper layer, per view). Change and candidate layers follow the step and chips.
  // Step "What changed?": two mutually exclusive presentations of the same date pair
  //   change  = computed colour change on one map (no divider)   compare = grey radar of both dates with the divider
  state.changeMode = "change";
  // Steps with "mode_hints" (Bangladesh step 2; Mozambique steps 2 and 3) use the Change map / Compare radar switch
  const isChangeStep = () => !!(T && T.steps[state.step] && T.steps[state.step].mode_hints);
  const changeAvail = () => !!(meta && meta.change[pairKey()]);
  const compareAvail = () => !!(meta && meta.radar[`${state.before}|${state.pol}`] && meta.radar[`${state.after}|${state.pol}`]);
  const grayShown = () => (isChangeStep() ? state.changeMode === "compare" && compareAvail() : !!state.evidence[state.view]);
  const changeShown = () => (isChangeStep() ? state.changeMode === "change" && changeAvail() : state.on.has("change"));
  const isIndep = (sp) => !!(T && T.layers[sp.id] && T.layers[sp.id].independent); // Landsat / GFM
  // Landsat/GFM were selected for one NISAR pair (layers.json "period"); for any other selected pair their dates do not match it
  const refNote = () => t("Separate reference observations; dates differ from the selected NISAR comparison");
  const refMismatch = (sp) => isIndep(sp) && !(sp.period[0] === state.before && sp.period[1] === state.after);
  // The divider exists only for a real before–after comparison (grey radar of both dates). Then the pair-derived candidate stays on the
  // "after" side. Without the grey comparison the candidate is shown on one map, labelled as derived from the change between the two dates.
  // highest zoom for the true-colour images: one image pixel ≈ 2 CSS pixels (EPSG:3857 metres per CSS pixel = 156543.03 / 2^z)
  const swirOn = () => !!(state.burnView && optical && optical.variants && optical.variants.swir);
  const opticalPair = () => (swirOn() ? optical.variants.swir.pair : optical.pair);
  // v74: an image pair with its own extent (earthquake: La Guaira) is drawn, split and capped on that extent, not the event frame
  const pairBounds = () => (optical && optical.bounds_latlon ? L.latLngBounds(optical.bounds_latlon) : bounds);
  function opticalMaxZoom(exOver) {
    const ex = exOver || (swirOn() ? optical.variants.swir.export : optical && optical.export);
    const bb = exOver ? bounds : pairBounds();
    if (!ex || !bb) return undefined;
    const w = L.CRS.EPSG3857.project(bb.getNorthEast()).x - L.CRS.EPSG3857.project(bb.getSouthWest()).x;
    return Math.floor(Math.log2(156543.03 * 2 / (w / ex.width)) * 4) / 4;
  }
  // v65: an event without NISAR analysis (layers.json "nisar": false): Before / After, Timeline and the UNOSAT evidence only
  const lite = () => !!(meta && meta.nisar === false);
  const hazardNow = () => ((meta && index && index.events.find((e) => e.id === meta.event_id)) || {}).hazard || "flood"; // v69: event type from events.json
  let evidence = null;      // data/<event>/evidence.json (v65, events without NISAR analysis)
  const vecCache = {};      // GeoJSON layers by file
  // v69: point layers (VIIRS detections): small circles, drawn on canvas so two thousand of them stay light on a phone
  const ptRenderer = L.canvas({ padding: 0.2, pane: "regions" });
  // dot size grows with the zoom but stays well under the 375 m VIIRS pixel, so the dots read as separate detections
  const ptRadius = () => Math.max(1.2, Math.min(3.2, 1.2 + (map.getZoom() - 11) * 0.7));
  function points(file, color) {
    const lay = L.geoJSON(null, { pane: "regions", interactive: false,
      pointToLayer: (f, ll) => L.circleMarker(ll, { renderer: ptRenderer, radius: ptRadius(), weight: 0.6, color: "#2b0a00", fillColor: color, fillOpacity: 0.85, opacity: 0.6 }) });
    lay.on("add", () => { const z = () => lay.eachLayer((m) => m.setRadius(ptRadius())); map.on("zoomend", z); lay.once("remove", () => map.off("zoomend", z)); });
    const fill = (gj) => { lay.clearLayers(); lay.addData(gj); };
    if (vecCache[file]) fill(vecCache[file]);
    else getJson(`data/${file}`).then((gj) => { vecCache[file] = gj; fill(gj); }).catch(() => fail(t("A layer image could not be loaded: {file}", { file: `<code>data/${file}</code>` })));
    return lay;
  }
  function vector(file, style) {
    const lay = L.geoJSON(null, { pane: "regions", interactive: false, style: () => style });
    const fill = (gj) => { lay.clearLayers(); lay.addData(gj); };
    if (vecCache[file]) fill(vecCache[file]);
    else getJson(`data/${file}`).then((gj) => { vecCache[file] = gj; fill(gj); }).catch(() => fail(t("A layer image could not be loaded: {file}", { file: `<code>data/${file}</code>` })));
    return lay;
  }
  const UNOSAT_EXTENT = { color: "#ff8c1a", weight: 2, opacity: 1, fillColor: "#ff8c1a", fillOpacity: 0.18 };
  // v75: data coverage outline (where the product looked); never a flood edge
  const COVERAGE_LINE = { color: "#ffffff", weight: 1.5, opacity: 0.9, dashArray: "5 5", fill: false };
  // v75: the flood map's two views, from data/<event>/views.json (record web.views): "Affected areas" = everything the data cover,
  // "Close look" = the settlement. Shown only where the flood layer is on screen (Nepal: UNOSAT evidence; NISAR events: Explore evidence).
  let views = null;
  const floodView = () => !!(views && meta && (views.applies_to === "unosat" ? state.ui === "simple" && state.mapMode === "unosat" : state.ui === "evidence"));
  function renderAreaSwitch() {
    const box = $("area-switch"), on = floodView();
    box.hidden = !on;
    document.body.classList.toggle("area-switch-on", on);
    document.body.classList.toggle("area-overview", on && state.areaView === "overview");
    if (!on) { box.innerHTML = ""; return; }
    box.setAttribute("aria-label", t("Map area"));
    box.innerHTML = ["overview", "closeup"].map((k) => `<button type="button" data-area="${k}" aria-pressed="${state.areaView === k}">${esc(t(views[k].label))}</button>`).join("");
    box.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => setAreaView(b.dataset.area, true)));
  }
  // the whole area stays clear of the area switch (top) and of the legend (bottom); the close look keeps the usual small margin
  function areaGo() {
    const b = L.latLngBounds(views[state.areaView].bounds);
    if (state.areaView !== "overview") { goTo(b, { padding: [12, 12] }); return; }
    const mr = map.getContainer().getBoundingClientRect(), sw = $("area-switch").getBoundingClientRect(), lg = $("map-legend").getBoundingClientRect();
    const top = sw.height ? Math.max(12, sw.bottom - mr.top + 8) : 12, bottom = lg.height ? Math.max(12, mr.bottom - lg.top + 8) : 12;
    // phones: the key sits under the map (f-below), so only the switch needs room; a key still on the map keeps its own room
    const onMap = $("map-legend").parentElement === map.getContainer().parentElement;
    goTo(b, { paddingTopLeft: [12, top], paddingBottomRight: [12, onMap && top + bottom < mr.height * 0.6 ? bottom : 12] });
  }
  function setAreaView(k, focus) {
    if (!views) return;
    state.areaView = k;
    renderAreaSwitch();
    render();
    areaGo();
    if (focus) { const b = $("area-switch").querySelector(`[data-area="${k}"]`); if (b) b.focus(); }
  }
  // v69: wildfire layers. Perimeter: the official outline (a line with a light fill); detections: small dots, one per VIIRS pixel and pass
  const FIRE_PERIMETER = { color: "#ffd166", weight: 2.5, opacity: 1, fillColor: "#ffd166", fillOpacity: 0.12 };
  const MAP_STYLES = { perimeter: FIRE_PERIMETER };
  const UNOSAT_LAKE = { color: "#1e90ff", weight: 3, opacity: 1, fillColor: "#1e90ff", fillOpacity: 0.45 };
  const UNOSAT_SOURCE = { color: "#ff3b30", weight: 2, opacity: 1, dashArray: "5 4", fillColor: "#ff3b30", fillOpacity: 0.12 };
  let stageFramed = null;   // id of the Timeline stop the map was last framed for
  // v66: the Timeline as one ordered track: the main stops that have a picture and any verified captures between them
  // (stages.json "extra"), by date. state.tpos is the place on that track; a main stop without a picture is shown alone.
  let trackCache = null;
  function track() {
    if (!stages) return [];
    if (trackCache && trackCache.src === stages) return trackCache.items;
    const items = stages.stages.map((st, si) => ({ si, st })).filter((x) => x.st.frame)
      .concat((stages.extra || []).map((st) => ({ si: null, st })));
    items.sort((a, b) => (a.st.frame.label < b.st.frame.label ? -1 : a.st.frame.label > b.st.frame.label ? 1 : 0));
    trackCache = { src: stages, items };
    return items;
  }
  function stageNow() {
    if (!stages) return null;
    if (state.stageMissing != null) return stages.stages[state.stageMissing];
    const it = track()[state.tpos];
    return it ? it.st : null;
  }
  const stageShown = () => (state.ui === "simple" && state.mapMode === "timeline" ? stageNow() : null);
  const opticalShown = () => state.ui === "simple" && state.mapMode === "optical" && !!optical;
  const anyClipped = () => grayShown() || opticalShown();
  const candOneMap = () => !grayShown();
  state.candOpacity = 0.8; // display opacity of the NISAR candidate / intersection (data unchanged)
  state.together = false; // step source layers: one at a time by default
  // Two levels: "simple" (default: the result first, few controls) and "evidence" (the five steps, all layers and methods)
  state.ui = "simple";
  state.simpleShow = true; // Simple view: the result layer (Bangladesh candidate) shown or hidden
  state.simpleLegendOpen = null; // Simple view map notes: null/false = closed (v48: closed by default on every screen), true = open
  state.simpleClass = null; // Simple view (Mozambique): "decrease" | "increase" | null — one radar-change class at a time
  // Map modes: "optical" (Before / After: two dated true-colour satellite images), "timeline" (v63: four flood stages, one
  // dated true-colour image each), and from "Data and science": "analysis" (the result layer on the background map),
  // "radar" (the NISAR radar pair with the divider) and "radartl" (NISAR radar images one at a time).
  state.mapMode = "optical";
  let optical = null;    // data/<event>/optical.json of the open event (null: no suitable pair)
  // (v69: the Copernicus credit carries the year of the images on the map; see render())
  state.tl = 0;          // index of the radar frame shown ("radartl": NISAR radar images one at a time, from Data and science)
  // v63: "timeline" = four stages (before / flood begins / towards the end / after) from data/<event>/stages.json
  state.stage = 0;
  let stages = null;
  let timeline = null;   // data/<event>/timeline.json of the open event
  let playTimer = 0;
  const placeGroup = L.layerGroup().addTo(map); // Simple view: catalogued place label (Mozambique)
  const list = $("layer-list");
  let loadSeq = 0; // increases on every event load; results of older loads are discarded

  // --- Text lookups (English text keyed to layers.json ids)
  const sup = (s) => (T.layers && T.layers[s.id]) || {};
  const supTitle = (s) => sup(s).title || s.id;
  const plainTitle = (s) => sup(s).plain || supTitle(s); // everyday name for the map legend
  const clsText = (s, code) => ((sup(s).classes || {})[code]) || {};
  const regLabel = (r) => (T.regions[r.id] && T.regions[r.id].label) || r.id;
  const regPlain = (r) => (T.regions[r.id] && T.regions[r.id].plain) || regLabel(r);

  // --- Load status for layer images
  let pending = 0, statusTimer = null;
  function setStatus(msg) {
    clearTimeout(statusTimer);
    if (!msg) { $("map-status").hidden = true; return; }
    $("map-status").textContent = msg;
    statusTimer = setTimeout(() => { $("map-status").hidden = false; }, 120); // avoid flicker for cached images
  }
  const DATA_V = "42"; // bump when layer PNGs are regenerated (avoids stale cached colours)
  // cls: "pixelated" for radar and analysis rasters (each pixel stays a visible square); "photo" for the true-colour images
  // (smooth, like a photograph; see opticalMaxZoom for how far they can be enlarged)
  function img(file, pane, cls = "pixelated", b = bounds) { // b: v73 a layer with its own extent (earthquake rasters)
    const seq = loadSeq;
    pending++;
    setStatus(t("Loading map layers…"));
    const done = () => {
      if (seq !== loadSeq) return; // image from an older event: ignore
      pending = Math.max(0, pending - 1);
      if (!pending) setStatus("");
    };
    return L.imageOverlay(`data/${file}?v=${DATA_V}`, b, { pane, opacity: 1, interactive: false, className: cls })
      .on("load", done)
      .on("error", () => { done(); if (seq === loadSeq) fail(t("A layer image could not be loaded: {file}", { file: `<code>data/${file}</code>` })); });
  }
  const pairKey = () => `${state.before}|${state.after}|${state.pol}`;
  const supportById = (id) => meta.support.find((s) => s.id === id);
  // Pair-derived layers (candidate, intersection) need their NISAR pair; independent observations are always available
  const pairMatches = (s) => isIndep(s) || (s.period[0] === state.before && s.period[1] === state.after);
  const layerTitle = (id) => {
    if (id === "change") return t("Radar change (single map)");
    if (id === "regions") return t("Inspection areas");
    const s = supportById(id);
    return s ? supTitle(s) : id;
  };
  function setLayer(id, on) {
    on ? state.on.add(id) : state.on.delete(id);
    const box = list.querySelector(`[data-id="${id}"] input`);
    if (box) box.checked = on;
  }

  // Removes everything that belongs to the current event (called before a new event is fetched)
  function clearEventLayers() {
    if (beforeLayer) map.removeLayer(beforeLayer);
    if (afterLayer) map.removeLayer(afterLayer);
    beforeLayer = afterLayer = null;
    for (const k of Object.keys(overlays)) { map.removeLayer(overlays[k]); delete overlays[k]; }
    map.removeLayer(regionGroup);
    regionGroup = L.layerGroup();
    map.removeLayer(controlGroup);
    controlGroup = L.layerGroup();
    outline.clearLayers();
    focusGroup.clearLayers();
    map.attributionControl.removeAttribution(GFM_NOTE);
    for (const c of QCREDIT) setCredit(c, false); // v73: earthquake layer credits
    $("map-legend").classList.remove("q-legend");
    qPlaceLegend(true);
    $("change-label").hidden = true;
    $("map-legend").innerHTML = "";
    pending = 0;
  }

  // --- Event cards
  function buildCards(activeId) {
    const box = $("event-cards");
    box.innerHTML = "";
    for (const e of index.events) {
      const tt = txt(e.id);
      const ev = tt ? tt.event : { place: e.id, dates: "" };
      const b = document.createElement("button");
      b.type = "button";
      b.className = "card";
      b.setAttribute("aria-pressed", String(e.id === activeId));
      b.setAttribute("aria-label", `${ev.place}, ${ev.dates}`);
      b.innerHTML = (ev.thumb ? `<img src="data/${esc(ev.thumb)}" alt="${esc(ev.thumb_alt || "")}" loading="lazy">` : "") +
        (window.NFEHazard ? window.NFEHazard.emblem(e.hazard, "c-emblem") : "") + // v69: same type emblem as on the globe
        `<span class="c-text"><span class="c-place">${esc(ev.place)}</span><span class="c-dates">${esc(ev.dates)}</span></span>`; // v64: no BETA / PROVISIONAL label here (data status: Sources and method)
      b.addEventListener("click", () => {
        setCardsOpen(false);
        // another event: camera transition through the globe (intro.js); same event: nothing to do
        if (!meta || meta.event_id !== e.id) {
          // new history entry, so the browser's Back button returns to the previous event (handled by the hashchange listener)
          if (eventInHash() !== e.id) history.pushState(null, "", `#event=${e.id}&view=${state.view}`);
          switchEvent(e.id);
        }
        $("step-panel").focus({ preventScroll: true });
      });
      box.appendChild(b);
    }
  }
  let requestedId = null; // last event asked for (set when loading starts; meta is null until it has loaded)
  function eventInHash() { return (location.hash.match(/(?:event|olay)=([\w-]+)/) || [])[1]; }
  // Same path for "Change event", a changed address and Back/Forward: the start-screen camera transition when available
  function switchEvent(id) {
    return window.NFEIntro && window.NFEIntro.travel ? window.NFEIntro.travel(id) : loadEvent(id);
  }
  function setCardsOpen(open) {
    $("event-cards").hidden = !open;
    $("events-toggle").setAttribute("aria-expanded", String(open));
    $("events-toggle").textContent = open ? t("Hide events") : t("Change event");
  }
  $("events-toggle").addEventListener("click", () => setCardsOpen($("event-cards").hidden));

  // --- Event loading: clear old layers first, fetch, discard stale results, then move the map
  // opts.move === false: the caller (start-screen camera transition) moves the map itself
  async function loadEvent(id, opts = {}) {
    const entry = index.events.find((e) => e.id === id) || index.events[0];
    requestedId = entry.id;
    const seq = ++loadSeq;
    const tt = txt(entry.id);
    clearEventLayers();
    meta = null; T = null; // the old event is closed while the new one loads (handlers below check this)
    buildCards(entry.id);
    $("current-event").textContent = tt ? tt.event.place : entry.id;
    setStatus(t("Loading {place}…", { place: tt ? tt.event.place : entry.id }));
    let m;
    try {
      m = await getJson(`data/${entry.layers}`);
    } catch (e) {
      if (seq === loadSeq) { setStatus(""); fail(t("Event layers ({file}) could not be read: {error}.", { file: `<code>data/${entry.layers}</code>`, error: e.message })); }
      return;
    }
    if (seq !== loadSeq) return; // a newer event was requested meanwhile
    if (!tt) { setStatus(""); return; }
    const quake = entry.hazard === "earthquake";
    if (quake) m = quakeMeta(entry, m); // v73: map_layers.json → the image-only ("lite") path with its own layers and timeline
    let tlj = null, opj = null, stj = null, evj = null;
    if (quake) { // only a verified pair adds the comparison: optical.json, or (v74) a before/after image pair listed in map_layers.json
      try { opj = await getJson(`data/${entry.id}/optical.json`); } catch (e) { opj = qOpticalPair(entry.id, m.qlayers); }
      try { m.shaking = await getJson(`data/${entry.id}/shaking.json`); } catch (e) { m.shaking = null; } // v80: USGS ShakeMap of the story's animation
    }
    else {
    if (m.nisar !== false) { try { tlj = await getJson(`data/${entry.id}/timeline.json`); } catch (e) { tlj = null; } } // optional: without it the timeline uses layers.json dates
    try { opj = await getJson(`data/${entry.id}/optical.json`); } catch (e) { opj = null; } // optional: without it Before / After explains why
    try { stj = await getJson(`data/${entry.id}/stages.json`); } catch (e) { stj = null; }   // optional: without it the Timeline explains why
    if (m.nisar === false) { try { evj = await getJson(`data/${entry.id}/evidence.json`); } catch (e) { evj = null; } }
    }
    let vwj = null;
    if (entry.hazard === "flood") { try { vwj = await getJson(`data/${entry.id}/views.json`); } catch (e) { vwj = null; } } // v75: optional overview / close-up (flood events only; v78: no 404 for the others)
    if (seq !== loadSeq) return;
    meta = m;
    T = tt;
    stopPlay();
    timeline = tlj && tlj.event_id === entry.id ? tlj : {
      frames: meta.dates.map((d) => ({ label: d.label, start_utc: d.start_utc, granule: d.granule, maturity: d.maturity, track_frame: d.track_frame,
        sensor: "NISAR L-band SAR (L2 GCOV, HH)", file: meta.radar[`${d.label}|HH`].file })) };
    optical = opj && opj.event_id === entry.id && opj.pair && opj.pair.length === 2 ? opj : null;
    // radar frames (Data and science → radar images one at a time); the Timeline itself uses the four stages
    timeline = { ...timeline, frames: timeline.frames.map((f) => ({ ...f, kind: "radar" })).sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)) };
    stages = stj && stj.event_id === entry.id && Array.isArray(stj.stages) && stj.stages.length ? stj : null;
    state.stage = stages ? Math.max(0, stages.stages.findIndex((x) => x.frame)) : 0;
    state.tpos = 0;
    state.stageMissing = null;
    state.mapMode = quake ? (qDamage().length ? "damage" : qRasters().length ? "motion" : "qtimeline") : optical ? "optical" : "analysis"; // v74: earthquake: buildings first
    state.qTrack = quake ? (qRasters()[0] || {}).id || null : null; // v73: earthquake: the radar track shown, the timeline stop
    state.qStop = 0;
    state.qPrevView = null;
    state.tl = T.steps.length ? Math.max(0, timeline.frames.findIndex((f) => f.label === T.steps[0].view.pair[1])) : 0;
    evidence = evj && evj.event_id === entry.id ? evj : null;
    views = vwj && vwj.event_id === entry.id ? vwj : null;
    state.areaView = "overview";
    renderAreaSwitch();
    stageFramed = null;
    state.helperQ = null;
    bounds = L.latLngBounds(meta.bounds_latlon); // image overlay extent
    // map view target: the study-area polygon when there is one (fills the map), else the image extent
    viewBounds = meta.study_area ? L.geoJSON(meta.study_area.outline).getBounds() : bounds;
    dateByLabel = Object.fromEntries(meta.dates.map((d) => [d.label, d]));
    writeHash();

    $("maturity-info").hidden = true;
    $("maturity-badge").setAttribute("aria-expanded", "false");
    renderHeader();

    // Optional thin study-area outline (the radar images keep their real extent; nothing is drawn outside)
    // Study-area polygon when the event has one (Mozambique city area), otherwise the rectangular trial window; never a flood edge
    const outlineStyle = { pane: "regions", color: "#ffffff", weight: 1, opacity: 0.85, dashArray: "3 4", fill: false, interactive: false };
    if (!lite()) outline.addLayer(meta.study_area ? L.geoJSON(meta.study_area.outline, { style: () => outlineStyle, interactive: false, pane: "regions" })
      : L.rectangle(bounds, outlineStyle)); // v65: no study-area box for an image-only event (the frame is the image itself)

    // Observation pairs (Technical details)
    const labels = meta.dates.map((d) => d.label);
    const pairs = [];
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) pairs.push([labels[i], labels[j]]);
    $("sel-pair").innerHTML = "";
    for (const [a, b] of pairs) $("sel-pair").add(new Option("", `${a}|${b}`));
    $("sel-pair").disabled = pairs.length < 2;
    renderPairText();

    // Move the map: first load jumps (the map needs a view before layers are clipped), later events fly
    map.invalidateSize();
    if (!map._loaded) map.fitBounds(viewBounds, { padding: [12, 12], animate: false });
    else if (opts.move !== false) goTo(viewBounds, { padding: [12, 12] });
    syncOutline();
    if (!lite()) { // the NISAR story steps, layers and inspection areas
      buildLayerList();
      buildRegions();
      buildInfo();
      buildStepTabs();
      goStep(0, false, false);
    }
    enterSimple();
  }

  // Header: title, area, product status and the single warning badge (also rewritten when the language changes)
  // v76: first sentence of a text and the rest ("94.9 km²" and "10 m" are not sentence ends)
  function firstSentence(x) {
    const m = String(x || "").trim().match(/^(.+?[.!?])\s+(\S[\s\S]*)$/);
    return m ? [m[1], m[2]] : [String(x || "").trim(), ""];
  }
  // v76: open "Data and sources" and go to it (optionally to one of its entries)
  function openData(id) {
    $("science").open = true;
    renderScience();
    (($(id) && id) ? $(id) : $("science")).scrollIntoView({ block: "start", behavior: reducedMotion.matches ? "auto" : "smooth" });
  }
  // v76: the event's summary (text.en.json event.lede) is "what happened; the area we looked at": the first part is the one
  // sentence under the place name, the rest (a data limit) goes to the small line with the dates
  function splitLede(s0) {
    const s1 = String(s0 || "").trim(), i = s1.indexOf(";");
    const src = ((texts[meta && meta.event_id] || {}).event || {}).lede || ""; // split only where the English source has the two parts
    if (i < 0 || src.indexOf(";") < 0) return [s1, ""];
    const rest = s1.slice(i + 1).trim();
    return [s1.slice(0, i).trim().replace(/\s+$/, "") + ".", rest ? rest.charAt(0).toLocaleUpperCase(I.lang) + rest.slice(1) : ""];
  }
  function renderHeader() {
    // v76: place name, one short sentence about what happened there, then the area / data limit and the dates (small)
    const ev = T.event, quake = isQuake();
    const h1 = quake ? ev.title : ev.place || ev.title;
    const [lede, limit] = quake ? [ev.lede, ""] : splitLede(ev.lede || ev.area_name);
    // v78: the place after the last " · " is never broken (e.g. "Gyirong–Rasuwa" at its dash)
    const k = h1.lastIndexOf(" · "), h1h = k > 0 ? `${esc(h1.slice(0, k))} · <span class="nowrap">${esc(h1.slice(k + 3))}</span>` : esc(h1);
    $("title").innerHTML = `<span class="t-full">${h1h}</span><span class="t-short" aria-hidden="true">${h1h}</span>`;
    const small = quake ? [ev.area_name, ev.dates] : [ev.dates]; // the area clause of the summary is the first line of "Data and sources"
    void limit;
    $("subtitle").innerHTML = (lede ? `<span class="ev-lede">${esc(lede)}</span>` : "") +
      `<span class="ev-limit">${small.filter(Boolean).map((x, k) => (k === small.filter(Boolean).length - 1 ? `<span class="nowrap">${esc(x)}</span>` : esc(x))).join(" · ")}</span>`;
    renderHeaderRest();
  }
  function renderHeaderRest() { // badges, product status, event facts and the page title
    const mb = $("maturity-badge");
    mb.textContent = t("{maturity} product", { maturity: meta.maturity });
    mb.classList.toggle("beta", meta.maturity === "BETA");
    mb.setAttribute("aria-label", t("{maturity} product: show explanation", { maturity: meta.maturity }));
    $("maturity-info").textContent = T.maturity.text;
    $("product-status").textContent = T.maturity.text; // v64: the data status lives here (no badge by the event name); the text starts with the label
    // Same meaning as before (experimental candidate, no validated flood boundary / no flood area), in plain words
    $("warning-badge").textContent = isQuake() ? t("Preliminary products — not checked on the ground") : meta.support.length
      ? t("Possible water — flooding not confirmed")
      : t("Radar change only — we did not map the flooded area");
    $("event-info").innerHTML = `<p>${esc(T.event.lede)}</p><ul>${T.event.facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` +
      `<p class="small-note">${esc(T.maturity.text)}</p>`;
    document.title = t("{title} — Surface Explorer", { title: T.event.title });
  }
  // Observation pair names and observation details (Technical details)
  function renderPairText() {
    const candPeriod = meta.support.length ? meta.support[0].period.join("|") : null;
    for (const o of $("sel-pair").options) {
      const [a, b] = o.value.split("|");
      o.textContent = o.value === candPeriod ? t("{dates} · water candidate available", { dates: fmtPair(a, b) }) : fmtPair(a, b);
    }
    $("obs-details").innerHTML = meta.dates.map((d) => `<div class="obs"><b>${fmtDay(d.label)}</b> · ${fmtUtc(d.start_utc)}<br>
        ${esc(d.track_frame)} · ${esc(d.maturity)}<br><code>${esc(d.granule)}</code><br><code>${esc(d.product)}</code></div>`).join("");
  }

  // Map tools this page controls (Leaflet zoom buttons), the page title and the language pickers
  function localizeStatic() {
    const zc = map.zoomControl;
    if (zc && zc._zoomInButton) {
      for (const [b, k] of [[zc._zoomInButton, "Zoom in"], [zc._zoomOutButton, "Zoom out"]]) { b.title = t(k); b.setAttribute("aria-label", t(k)); }
    }
    setMapHint();
    if (!meta) document.title = t("Surface Explorer — NISAR flood observations");
    for (const box of document.querySelectorAll(".lang-pick-slot")) I.picker(box);
  }
  // Language changed: the same event, map position, zoom, layers and step stay; only the words are written again
  I.onChange(() => {
    localizeStatic();
    relabelBase();
    for (const c of [...credits]) setCredit(c, false); // credits are written again (with their translated group names) by render()
    setCardsOpen(!$("event-cards").hidden);
    if (!meta) return;
    T = txt(meta.event_id);
    buildCards(meta.event_id);
    $("current-event").textContent = T.event.place;
    renderHeader();
    if (!isQuake()) { // v73: the NISAR flood panels (layer list, inspection areas, sources) are not built for an earthquake
      renderPairText();
      buildLayerList();
      map.removeLayer(regionGroup); map.removeLayer(controlGroup);
      regionGroup = L.layerGroup(); controlGroup = L.layerGroup();
      buildRegions();
      buildInfo();
    }
    if (!lite()) {
      renderStepText(state.step);
      renderShowMe(T.steps[state.step]);
      renderStepLead();
    }
    if (state.ui === "simple") { renderSimpleCard(); }
    renderScience();
    render();
  });

  function syncOutline() {
    $("show-outline").checked ? outline.addTo(map) : map.removeLayer(outline);
  }
  $("show-outline").addEventListener("change", () => { syncOutline(); if (meta) renderMapLegend(); });
  $("return-aoi").addEventListener("click", () => viewBounds && goTo(viewBounds, { padding: [12, 12] }));

  // --- Three-step guided exploration
  function buildStepTabs() {
    const tabs = $("step-tabs");
    tabs.innerHTML = "";
    T.steps.forEach((s, i) => {
      const t = document.createElement("button");
      t.type = "button";
      t.className = "step-tab";
      t.id = `step-tab-${i}`;
      t.setAttribute("role", "tab");
      t.setAttribute("aria-controls", "step-panel");
      t.innerHTML = `<span class="n">${esc(I.t("Step {n}", { n: i + 1 }))}</span><span>${esc(s.title)}</span>`;
      t.addEventListener("click", () => goStep(i, false));
      t.addEventListener("keydown", (e) => {
        const n = T.steps.length;
        let k = null;
        if (e.key === "ArrowRight") k = (i + 1) % n;
        else if (e.key === "ArrowLeft") k = (i - 1 + n) % n;
        else if (e.key === "Home") k = 0;
        else if (e.key === "End") k = n - 1;
        if (k === null) return;
        e.preventDefault();
        goStep(k, false);
        $(`step-tab-${k}`).focus();
      });
      tabs.appendChild(t);
    });
  }

  // Applies the step view: pair, polarisation, divider position and layers come from text.en.json
  function applyStepView() {
    const v = T.steps[state.step].view;
    [state.before, state.after] = v.pair;
    state.pol = v.pol;
    state.swipe = v.swipe;
    if (v.mode) state.changeMode = v.mode; // "Look at two dates" = compare radar, "Spot the change" = change map
    // A step sets its layer defaults in both views (the satellite view's radar-evidence switch and opacity are kept)
    const ids = v.layers.filter((id) => id === "radar" || id === "change" || id === "regions" || supportById(id));
    state.layers.analysis = new Set(ids);
    state.layers.satellite = new Set(ids);
    state.custom = false;
    $("sel-pair").value = `${state.before}|${state.after}`;
    document.querySelectorAll('input[name="pol"]').forEach((r) => { r.checked = r.value === state.pol; });
    list.querySelectorAll(".layer").forEach((row) => { row.querySelector("input").checked = state.on.has(row.dataset.id); });
  }

  // fit: when the user moves between steps, bring the whole study area back into view (not while an event is loading)
  function goStep(i, scroll = true, fit = true) {
    if (!meta || !T) return;
    state.step = i;
    const s = T.steps[i];
    T.steps.forEach((_, k) => {
      const t = $(`step-tab-${k}`);
      t.setAttribute("aria-selected", String(k === i));
      t.tabIndex = k === i ? 0 : -1;
    });
    $("step-panel").setAttribute("aria-labelledby", `step-tab-${i}`);
    $("more-detail").open = false;
    renderStepText(i);
    renderShowMe(s);
    applyStepView();
    if (fit && viewBounds && map._loaded && !map.getBounds().contains(viewBounds)) goTo(viewBounds, { padding: [12, 12] });
    render();
    // On mobile, Previous/Next bring the map back into view (the change is followed on the map)
    if (scroll && narrow.matches) document.querySelector(".map-col").scrollIntoView({ block: "start" });
  }
  // The words of a step (title, text, notes, buttons); no layer or map change here (also used when the language changes)
  function renderStepText(i) {
    const s = T.steps[i];
    T.steps.forEach((st, k) => { const sp = $(`step-tab-${k}`) && $(`step-tab-${k}`).querySelectorAll("span"); if (sp && sp.length > 1) { sp[0].textContent = t("Step {n}", { n: k + 1 }); sp[1].textContent = st.title; } });
    $("step-title").textContent = s.title;
    $("step-action").hidden = !s.action;
    $("step-action").textContent = s.action || "";
    $("step-dates").hidden = !s.dates_line;
    $("step-dates").textContent = s.dates_line || "";
    $("step-summary").hidden = !s.summary;
    $("step-summary").innerHTML = s.summary
      ? `<h3>${esc(t("What we found"))}</h3><ul>${s.summary.found.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` +
        `<h3>${esc(t("What we still do not know"))}</h3><ul>${s.summary.unknown.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`
      : "";
    renderStepLead();
    // Lines starting with "• " are shown as a list
    let html = "", bullets = [];
    const flush = () => { if (bullets.length) { html += `<ul>${bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`; bullets = []; } };
    for (const line of s.body) {
      if (line.startsWith("• ")) bullets.push(line.slice(2));
      else { flush(); html += `<p>${esc(line)}</p>`; }
    }
    flush();
    $("step-body").innerHTML = html;
    $("step-notes").innerHTML = s.notes.map((n) => `<div class="note" role="note"><b>${esc(t("Note:"))}</b> ${esc(n)}</div>`).join("");
    const last = i === T.steps.length - 1;
    $("not-this").hidden = !last;
    $("not-this").innerHTML = last ? `<strong>${esc(t("What this is not"))}</strong><ul>${T.not_this.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "";
    $("step-sources").textContent = s.sources.length ? t("Numbers in this step come from: {sources}", { sources: s.sources.join(" · ") }) : "";
    $("step-prev").hidden = i === 0;
    $("step-next").hidden = last;
    if (!last) $("step-next").textContent = narrow.matches ? t("Next →") : t("Next: {step} →", { step: T.steps[i + 1].title });
    $("step-next").setAttribute("aria-label", last ? "" : t("Next step: {step}", { step: T.steps[i + 1].title }));
    $("step-prev").textContent = t("← Back");
  }
  $("step-prev").addEventListener("click", () => T && goStep(Math.max(0, state.step - 1)));
  $("to-map").addEventListener("click", () => document.querySelector(".map-col").scrollIntoView({ block: "start" }));
  // v76: phones — the map tool goes to "Data and sources" (opened) in the simple view, to the step text in the evidence view
  $("to-text").addEventListener("click", () => (state.ui === "simple" ? openData() : $("explore").scrollIntoView({ block: "start" })));
  $("step-next").addEventListener("click", () => T && goStep(Math.min(T.steps.length - 1, state.step + 1)));
  $("reset-view").addEventListener("click", () => goStep(state.step, false));

  // "Show me" buttons: only inspection areas registered in the catalog; step 1 also numbers them on the map
  function renderShowMe(s) {
    focusGroup.clearLayers();
    const ol = $("step-focus");
    ol.innerHTML = "";
    (s.show_me || []).forEach((rid, k) => {
      const reg = meta.regions.find((r) => r.id === rid);
      if (!reg) return;
      const ring = reg.corners_lonlat.map(([lo, la]) => [la, lo]);
      const n = k + 1;
      if (s.focus) {
        const top = Math.max(...ring.map((c) => c[0]));
        const midLon = ring.reduce((a, c) => a + c[1], 0) / ring.length;
        focusGroup.addLayer(L.polygon(ring, { pane: "regions", color: "#ff9800", weight: 2.5, fill: false, interactive: false }));
        focusGroup.addLayer(L.marker([top, midLon], {
          pane: "regions", keyboard: false, interactive: false,
          icon: L.divIcon({ className: "focus-marker", html: `<span>${n}</span>`, iconSize: [26, 26], iconAnchor: [13, 30] }),
        }));
      }
      const extra = "";
      const li = document.createElement("li");
      li.innerHTML = (s.focus ? `<span class="focus-num" aria-hidden="true">${n}</span>` : "") +
        `<span class="focus-text"><b>${esc(regPlain(reg))}</b>${extra}</span>` +
        `<button type="button" class="btn btn-small show-me">${esc(t("Show me"))}</button>`;
      const btn = li.querySelector("button");
      btn.setAttribute("aria-label", t("Show me the {area} on the map", { area: regPlain(reg) }));
      btn.addEventListener("click", () => {
        goTo(L.latLngBounds(ring).pad(1.2), { maxZoom: 16 });
        if (narrow.matches) document.querySelector(".map-col").scrollIntoView({ block: "start" });
      });
      ol.appendChild(li);
    });
  }

  // Layer buttons inside a step (part of the step view; not a "custom view")
  function renderChips() {
    const box = $("step-offer");
    box.innerHTML = "";
    const offer = T.steps[state.step].offer.filter((id) => (id === "change" && !isChangeStep()) || (id === "regions" && regionGroup.getLayers().length) || supportById(id));
    const reasons = new Set();
    // Source layers (candidate, Landsat, GFM, intersection): one at a time unless "Show together" is on
    const group = offer.filter((id) => supportById(id));
    const grouped = group.length > 1;
    if (grouped && group.filter((id) => state.on.has(id)).length > 1) state.together = true; // e.g. set in Technical details
    box.dataset.single = String(grouped && !state.together);
    for (const id of offer) {
      const s = supportById(id);
      const ok = !s || pairMatches(s);
      const color = s ? (Object.entries(s.classes).find(([, c]) => c.show_in_legend !== false) || [, {}])[1].color : id === "change" ? "#2166ac" : "#ff9800";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.disabled = !ok;
      b.setAttribute("aria-pressed", String(state.on.has(id)));
      b.innerHTML = `<i style="background:${color}"></i>${esc(layerTitle(id))}`;
      b.addEventListener("click", () => {
        const on = !state.on.has(id);
        if (on && grouped && !state.together) for (const g of group) if (g !== id) setLayer(g, false);
        setLayer(id, on);
        render();
      });
      box.appendChild(b);
      if (!ok) reasons.add(t("No analysis for this pair: the layer was produced only from the {dates} comparison.", { dates: fmtPair(...s.period) }));
    }
    for (const r of reasons) { const p = document.createElement("p"); p.className = "chip-reason"; p.textContent = r; box.appendChild(p); }
    if (grouped) {
      const lab = document.createElement("label");
      lab.className = "chip-together";
      lab.innerHTML = `<input type="checkbox" ${state.together ? "checked" : ""}> ${esc(t("Show together"))}`;
      lab.querySelector("input").addEventListener("change", (e) => {
        state.together = e.target.checked;
        if (!state.together) { // back to one source: keep the first active one in the list order
          const keep = group.find((g) => state.on.has(g));
          for (const g of group) if (g !== keep) setLayer(g, false);
        }
        render();
      });
      box.appendChild(lab);
      if (state.together) {
        const n = document.createElement("p");
        n.className = "chip-note";
        n.textContent = t("Layers shown together can cover each other; turn one off to inspect it alone.");
        box.appendChild(n);
      }
    }
  }

  function markCustom() { state.custom = true; render(); }

  function buildLayerList() {
    const items = [
      { id: "radar", title: t("Grey radar image: backscatter (before | after)"),
        key: [kRamp("gray", esc(t("dark: low (smooth surface, can be open water) · bright: high")))] },
      { id: "change", title: t("Radar change (after − before, single map)"), key: [kRamp("div", esc(t("blue: decrease · red: increase (±6 dB)")))] },
      ...meta.support.map((s) => ({
        id: s.id, title: supTitle(s), period: s.period,
        key: Object.entries(s.classes).filter(([, c]) => c.show_in_legend !== false).map(([code, c]) => kBox(c.color, esc(clsText(s, code).short || code))),
      })),
    ];
    if (meta.regions.some((r) => r.role !== "control")) {
      items.push({ id: "regions", title: t("Inspection areas (400 m)"), key: [kBox("#ff9800", esc(t("inspection area")), true)] });
    }
    // Invalid old control area: never shown in the guided steps; only here, labelled as invalid
    if (meta.regions.some((r) => r.role === "control")) {
      items.push({ id: OLD_CONTROL, title: t("Old control area — INVALID, cannot be used as a control"),
        key: [kBox("#00bcd4", esc(t("dashed; the west edge of the box contains a patch of water (click the box on the map for details)")), true)] });
    }
    list.innerHTML = "";
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "layer";
      row.dataset.id = it.id;
      row.innerHTML = `<label><input type="checkbox" autocomplete="off" aria-label="${esc(it.title)}" ${it.fixed ? "disabled" : ""}>
        <span>${esc(it.title)}</span></label>${keyHtml(it.key)}<div class="reason"></div>`;
      row.querySelector("input").checked = state.on.has(it.id);
      row.querySelector("input").addEventListener("change", (e) => {
        if (it.id === "radar") { state.evidence[state.view] = e.target.checked; render(); return; }
        setLayer(it.id, e.target.checked); markCustom();
      });
      list.appendChild(row);
    }
  }

  function buildRegions() {
    for (const r of meta.regions) {
      const invalid = r.status === "not_valid_as_control";
      const label = regLabel(r);
      const note = T.regions[r.id] && T.regions[r.id].note;
      const poly = L.polygon(r.corners_lonlat.map(([lo, la]) => [la, lo]), {
        pane: "regions", color: r.role === "control" ? "#00bcd4" : "#ff9800", weight: 2, fill: false, dashArray: invalid ? "5 4" : null,
      }).bindTooltip(label, { permanent: true, direction: "top", className: "region-label" });
      poly.bindPopup(`<b>${esc(label)}</b><br>${esc(invalid ? t("Cannot be used as a control") : t("Chosen for inspection; not an unbiased sample"))}` +
        (note ? `<br><small>${esc(note)}</small>` : ""));
      (r.role === "control" ? controlGroup : regionGroup).addLayer(poly);
    }
  }

  function buildInfo() {
    const gs = meta.candidate_geometric_size, sens = meta.candidate_sensitivity;
    const f = (x) => I.fmt.num(x, 2);
    const p = (x) => I.fmt.pct(x, 1);
    $("size-note").innerHTML = gs
      ? esc(t("Geometric size (inside the study area only): NISAR candidate {a} km² ({lo}–{hi} depending on thresholds), candidate supported by more than one source {b} km².",
          { a: f(gs.nisar_candidate_km2), lo: f(gs.nisar_candidate_km2_range_over_sensitivity[0]), hi: f(gs.nisar_candidate_km2_range_over_sensitivity[1]), b: f(gs.multi_source_km2) })) +
        ` <b>${esc(t("Not a validated flood area; experimental thresholds; accuracy unknown."))}</b>` +
        (T.fpr ? ` ${t("False-positive rate: {value} ({reason})", { value: `<b>${esc(T.fpr.value)}</b>`, reason: esc(T.fpr.reason) })}` : "") +
        (sens ? ` ${esc(t("Threshold sensitivity: candidate share {lo}–{hi} over {n} combinations.", { lo: p(sens.nisar_candidate_share[0]), hi: p(sens.nisar_candidate_share[1]), n: sens.n_combinations }))}` : "")
      : "";
    $("rule-note").textContent = T.candidate_rule ? t("Candidate rule: {rule}", { rule: T.candidate_rule }) : "";
    $("proj-note").textContent = `${T.projection_note} ${t("Change layers: {smoothing}.", { smoothing: T.smoothing })}`;

    // Sources in three groups: this project's analysis, independent/supporting observations, other organisations' products
    const srcHtml = (s, i) => {
      const e = T.sources[i] || {};
      return `<div class="src">${esc(s.publisher)}: <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(e.kind || s.kind)}</a>` +
        (e.note ? ` <span class="muted">— ${esc(e.note)}</span>` : "") + (e.findings ? `<br><span class="muted">${esc(e.findings)}</span>` : "") + `</div>`;
    };
    const refHtml = (r, i, extra = "") => {
      const e = T.reference_maps[i] || {};
      return `<div class="src"><b>${esc(e.producer || r.producer)}</b>${e.when ? ` · ${esc(e.when)}` : ""}` +
        `<br><span class="muted">${esc(e.note || "")}${extra}</span></div>`;
    };
    const supHtml = (s) => `<div class="src"><b>${esc(supTitle(s))}</b><br>${(sup(s).sources || []).map(esc).join("<br>")}</div>`;
    // layers.json keeps its original (Turkish) kind value "kullanım koşulları"; it is matched here, never displayed
    const isTerms = (s) => /terms|koşul/i.test(s.kind);
    const own = [`<div class="src"><b>NISAR L2 GCOV (${esc(meta.maturity)})</b> · NASA/JPL-Caltech, ASF DAAC<br>` +
      meta.dates.map((d) => `${fmtDay(d.label)} · ${fmtUtc(d.start_utc)} · <code>${esc(d.granule)}</code>`).join("<br>") + `</div>`]
      .concat(meta.support.filter((s) => !s.id.includes("support")).map(supHtml));
    const hasGfmLayer = meta.support.some((s) => s.id === "gfm_support");
    const indep = meta.support.filter((s) => s.id.includes("support")).map(supHtml)
      .concat(meta.reference_maps.map((r, i) => [r, i]).filter(([r]) => r.data_obtained && !hasGfmLayer).map(([r, i]) => refHtml(r, i, " " + esc(t("Not shown as a map layer.")))))
      .concat(meta.sources.map((s, i) => [s, i]).filter(([s]) => isTerms(s)).map(([s, i]) => srcHtml(s, i)));
    const others = meta.sources.map((s, i) => [s, i]).filter(([s]) => !isTerms(s)).map(([s, i]) => srcHtml(s, i))
      .concat(meta.reference_maps.map((r, i) => [r, i]).filter(([r]) => !r.data_obtained).map(([r, i]) => refHtml(r, i)));
    const group = (title, note, items) => items.length ? `<div class="src-group"><h3>${esc(title)}</h3><p class="grp-note">${esc(note)}</p>${items.join("")}</div>` : "";
    $("sources").innerHTML =
      group(t("This project's analysis"), t("Layers produced in this project from NISAR data."), own) +
      group(t("Independent / supporting observations"), t("Different sensors; their dates are not the same as NISAR's. When they are inputs to a rule they do not count as validation."), indep) +
      group(t("Other organisations' products and reports"), t("Context only; not validation of this project."), others);
    $("uncertainty").innerHTML = T.uncertainty.map((u) => `<li>${esc(u)}</li>`).join("") +
      (T.candidate_rule ? `<li>${esc(t("Candidate rule: {rule}", { rule: T.candidate_rule }))}</li>` : "");
  }

  function render() {
    if (!meta || !T) return;
    if (beforeLayer) map.removeLayer(beforeLayer);
    if (afterLayer) map.removeLayer(afterLayer);
    beforeLayer = afterLayer = null;
    pending = 0;
    syncBase();
    ensureMode();
    const gray = grayShown();
    // Grey radar opacity (per view; satellite default 60 % so the background stays visible). Change/candidate use their own fixed opacity.
    for (const p of ["before", "after"]) map.getPane(p).style.opacity = String(state.ui === "simple" ? (state.mapMode === "radar" ? 0.9 : 1) : state.opacity[state.view]);
    for (const p of ["change", "pairAfter"]) map.getPane(p).style.opacity = "1";
    if (gray) {
      beforeLayer = img(meta.radar[`${state.before}|${state.pol}`].file, "before").addTo(map);
      afterLayer = img(meta.radar[`${state.after}|${state.pol}`].file, "after").addTo(map);
    }
    const single = state.swipe >= 1; // single-date view (step 1)
    const d = narrow.matches ? fmtShort : fmtDay;
    const ch = state.pol === "HH" ? "" : ` · ${state.pol}`; // HH is the default; HV is always labelled
    if (!lite()) {
      $("label-before").textContent = single ? `${fmtDay(state.before)}${ch}` : `${t("Before · {date}", { date: d(state.before) })}${ch}`;
      $("label-after").textContent = `${t("After · {date}", { date: d(state.after) })}${ch}`;
      $("label-before").title = fmtUtc(dateByLabel[state.before].start_utc);
      $("label-after").title = fmtUtc(dateByLabel[state.after].start_utc);
    }

    const warn = [];
    // Layers of the previous pair are fully removed on every render
    const keepStage = overlays.stage && stageShown() ? overlays.stage : null; // Timeline: kept for the short cross-fade
    for (const k of Object.keys(overlays)) { if (overlays[k] !== keepStage) map.removeLayer(overlays[k]); delete overlays[k]; }
    if (changeShown() && changeAvail()) overlays.change = img(meta.change[pairKey()].file, "change").setOpacity(OPACITY).addTo(map);
    const sc = simpleSignal();
    // in Before / After the radar-change class is an analysis of the pair: drawn on the "after" side only
    if (sc) overlays.signal = img(sc.file, state.ui === "simple" && state.mapMode === "radar" ? "pairAfter" : "change").addTo(map);
    const tlf = state.ui === "simple" && state.mapMode === "radartl" && timeline ? timeline.frames[state.tl] : null;
    if (tlf) overlays.timeline = img(tlf.file, "before").addTo(map);
    const stf = stageShown();
    const kind = stf && stf.frame ? stf.frame.kind || "image" : null;
    // v65: a published figure (not a map image): shown over the map with its own place, date and credit
    $("stage-figure").hidden = kind !== "figure";
    if (kind === "figure") {
      const fx = I.tx(stf.frame);
      $("stage-figure").innerHTML = `<p class="sf-tag">${esc(stagePlace(fx))} · ${esc(t("Captured {date} · {source}", { date: fmtShort(fx.label, true), source: fx.sensor || fx.publisher }))}</p>` +
        `<img src="data/${esc(fx.file)}?v=${DATA_V}" width="${fx.width}" height="${fx.height}" alt="${esc(fx.sentence)}">` +
        `<p class="sf-credit">${esc(fx.credit)} · ${esc(fx.licence)} · <a href="${esc(fx.url)}" target="_blank" rel="noopener">${esc(fx.publisher)} ↗</a></p>`;
    }
    if (kind === "map" && typeof stf.frame.layers[0] === "string") { // UNOSAT outlines on the background map, framed on the place of this stop
      overlays.stLakes = vector(stf.frame.layers[0], UNOSAT_LAKE).addTo(map);
      overlays.stSource = vector(stf.frame.layers[1], UNOSAT_SOURCE).addTo(map);
    } else if (kind === "map") stf.frame.layers.forEach((L_, i) => { overlays["stMap" + i] = vector(L_.file, MAP_STYLES[L_.style] || UNOSAT_EXTENT).addTo(map); });
    if (stf && stageFramed !== stf.id) {
      if (kind === "map") goTo(L.latLngBounds(stf.frame.bounds), { padding: [16, 16] });
      else if (kind === "image" && stageFramed && stageFramed !== "image") goTo(viewBounds, { padding: [12, 12] });
      stageFramed = kind === "map" ? stf.id : kind === "image" ? "image" : stageFramed;
    }
    if (!stf && stageFramed && stageFramed !== "image") { goTo(viewBounds, { padding: [12, 12] }); stageFramed = null; }
    if (state.ui === "simple" && state.mapMode === "unosat" && evidence) { // evidence: UNOSAT outline over the image of the day after
      overlays.evImage = img(evidence.background, "before", "photo").addTo(map);
      if (evidence.layers) { // v69: listed layers, each can be switched off (wildfire: heat detections and the official perimeter)
        for (const L_ of evidence.layers) {
          if (state.evOff && state.evOff[L_.id]) continue;
          if (L_.kind === "points") overlays.evFirms = points(L_.file, L_.color).addTo(map);
          else overlays.evPerim = vector(L_.file, FIRE_PERIMETER).addTo(map);
        }
      } else overlays.evExtent = vector(evidence.layer.file, UNOSAT_EXTENT).addTo(map);
      if (views && views.overview.coverage && views.overview.coverage.file) overlays.evCover = vector(`${meta.event_id}/${views.overview.coverage.file}`, COVERAGE_LINE).addTo(map);
    }
    if (isQuake()) quakeDraw(); // v73: earthquake layers (radar track or damage) and the epicentres
    if (floodView() && views.overview.coverage && views.overview.coverage.outline === "existing") { // v75: the study outline drawn as the coverage line (legend swatch)
      const st = { ...COVERAGE_LINE, pane: "regions", interactive: false };
      overlays.evCover = (meta.study_area ? L.geoJSON(meta.study_area.outline, { style: () => st, interactive: false, pane: "regions" }) : L.rectangle(bounds, st)).addTo(map);
    }
    if (floodView() && state.areaView === "overview" && views.overview.coverage) { // v75: what the data cover, named on its outline
      const cb = L.latLngBounds(views.overview.bounds);
      if (views.overview.coverage.file) overlays.covLabel = L.marker(views.overview.coverage.label_at || cb.getNorthWest(), { pane: "regions", keyboard: false, interactive: false,
        icon: L.divIcon({ className: "place-label cov-label", html: `<span>${esc(t(views.overview.coverage.label))}</span>`, iconSize: [0, 0] }) }).addTo(map);
      // where "Close look" goes: one named dot (the settlement labels would pile up at this scale and are hidden by CSS)
      if (views.closeup.place) overlays.closeLabel = L.marker(L.latLngBounds(views.closeup.bounds).getCenter(), { pane: "regions", keyboard: false, interactive: false,
        icon: L.divIcon({ className: "place-label close-label", html: `<i></i><span>${esc(t(views.closeup.place))}</span>`, iconSize: [0, 0] }) }).addTo(map);
    }
    if (kind === "image") { // Timeline stage: one dated true-colour image; the previous one stays until the new one has loaded, then a short fade
      const old = keepStage ? keepStage : null, url = `data/${stf.frame.file}?v=${DATA_V}`;
      if (old && old._url === url) overlays.stage = old;
      else {
        const nw = img(stf.frame.file, "before", "photo").addTo(map), el = nw.getElement(), fade = !reducedMotion.matches && !!old;
        if (fade) { el.style.opacity = "0"; el.style.transition = "opacity .25s ease-out"; }
        nw.once("load", () => {
          if (fade) requestAnimationFrame(() => { el.style.opacity = "1"; });
          if (old) setTimeout(() => map.removeLayer(old), fade ? 260 : 0);
        });
        overlays.stage = nw;
      }
    } else if (keepStage) map.removeLayer(keepStage);
    $("stage-empty").hidden = !(stf && !stf.frame);
    if (stf && !stf.frame) $("stage-empty").innerHTML = `<p><b>${esc(t("No clear satellite image was found for this stage."))}</b></p><p>${esc(I.tx(stf.missing))}</p>`;
    document.body.classList.toggle("stage-mode", !!(state.ui === "simple" && state.mapMode === "timeline"));
    renderStageCaption(stf);
    if (opticalShown()) { // Before / After: the two dated true-colour images on the two sides of the divider, same grid and extent
      const pr = opticalPair(); // v69: or the short-wave infrared pair of the same scenes ("Highlight the burn scar")
      overlays.optBefore = img(pr[0].file, "before", "photo", pairBounds()).addTo(map);
      overlays.optAfter = img(pr[1].file, "after", "photo", pairBounds()).addTo(map);
    }
    // 10 m true-colour pixels: the map stops zooming where one image pixel covers about two screen points (no deeper zoom into blur)
    const capZ = (opticalShown() || kind === "image" || overlays.evImage) ? opticalMaxZoom(kind === "image" && stf.frame.export ? stf.frame.export : undefined) : undefined; // v69: each image's own pixel
    if (map.options.maxZoom !== capZ) map.setMaxZoom(capZ);
    // v69: credits in groups — dated images (with the year of the images on the map) and data layers — apart from the background map
    const IMG = t("Dated images"), LAY = t("Layers");
    const NISAR_NOTE = `${IMG}: NISAR: NASA/JPL-Caltech, ASF DAAC`; // only for events with NISAR images
    setCredit(NISAR_NOTE, !lite());
    const landsat = kind === "image" && /^L[CO]0\d/.test(stf.frame.scene || "");
    const copernicus = !!(overlays.optBefore || (kind === "image" && !landsat) || overlays.evImage);
    const yearOn = (overlays.optBefore ? optical.pair[1].label : kind === "image" ? stf.frame.label : overlays.evImage ? evidence.background.match(/\d{4}/)[0] : "2026").slice(0, 4);
    const unosat = !!((kind === "map" && !stf.frame.record) || overlays.evExtent), UNOSAT_NOTE = `${LAY}: UNOSAT (CC BY-SA)`;
    setCredit(UNOSAT_NOTE, unosat);
    for (const y of ["2025", "2026"]) setCredit(`${IMG}: Contains modified Copernicus Sentinel data ${y}`, copernicus && yearOn === y);
    setCredit(`${IMG}: Landsat-9, U.S. Geological Survey`, landsat);
    const fireLayers = !!(overlays.evFirms || overlays.evPerim || (kind === "map" && stf.frame.record));
    setCredit(`${LAY}: NASA FIRMS (VIIRS) · NIFC WFIGS · CAL FIRE`, fireLayers);
    $("change-label").hidden = !overlays.change;
    if (!lite()) $("change-label").textContent = t("Radar change · {dates}", { dates: narrow.matches ? fmtShort(state.before) + " → " + fmtShort(state.after, true) : fmtPair(state.before, state.after) }) + (state.pol === "HH" ? "" : " · " + state.pol);
    // Draw order: support layers below, candidate and intersection on top
    const drawOrder = [...meta.support].sort((x, y) => (x.id.includes("support") ? 0 : 1) - (y.id.includes("support") ? 0 : 1));
    for (const s of drawOrder) {
      const row = list.querySelector(`[data-id="${s.id}"]`);
      const box = row.querySelector("input");
      const match = pairMatches(s);
      const reason = t("No analysis for this pair: the layer was produced only from the {dates} comparison.", { dates: fmtPair(...s.period) });
      row.classList.toggle("disabled", !match);
      box.disabled = !match;
      row.querySelector(".reason").textContent = match ? "" : reason;
      if (!match && state.on.has(s.id)) {
        setLayer(s.id, false);
        warn.push(t("“{layer}” was turned off. {reason}", { layer: supTitle(s), reason }));
      }
      // Pair-derived layers: only for their own pair and only on the "after" side of the divider
      if (match && state.on.has(s.id)) {
        overlays[s.id] = isIndep(s)
          ? img(s.file, "support").setOpacity(OPACITY).addTo(map)
          : img(s.file, "pairAfter").setOpacity(state.candOpacity).addTo(map);
      }
      if (s.id === "gfm_support") {
        overlays[s.id] ? map.attributionControl.addAttribution(GFM_NOTE) : map.attributionControl.removeAttribution(GFM_NOTE);
      }
    }
    state.on.has("regions") ? regionGroup.addTo(map) : map.removeLayer(regionGroup);
    state.on.has(OLD_CONTROL) ? controlGroup.addTo(map) : map.removeLayer(controlGroup);
    $("date-warning").hidden = !warn.length;
    $("date-warning").innerHTML = warn.map(esc).join("<br>");
    // The warning badge is emphasised while the candidate or intersection is visible
    $("warning-badge").classList.toggle("emph", !!(overlays[CAND] || overlays.multi_source));
    $("custom-view").hidden = !state.custom;
    T.steps.forEach((_, k) => $(`step-tab-${k}`).classList.toggle("custom-mark", state.custom && k === state.step));
    // Divider and date tags: only when something is split by the divider (grey images or after-side candidate layers)
    const split = anyClipped() && !single;
    // One-map candidate: say what it is derived from (not a water map of either date)
    const pairLayer = meta.support.find((sp) => overlays[sp.id] && !isIndep(sp));
    if (pairLayer && candOneMap() && !overlays.change && state.ui !== "simple") { // Simple view: the dates are in the block above the map
      $("change-label").hidden = false;
      $("change-label").textContent = narrow.matches // short on phones (the full sentence is in the result card / legend)
        ? t("Possible water · from changes {from} → {to}", { from: fmtShort(pairLayer.period[0]), to: fmtShort(pairLayer.period[1]) })
        : t("Possible water detected from changes between {from} and {to}", { from: fmtDay(pairLayer.period[0], false), to: fmtDay(pairLayer.period[1], false) });
    }
    $("label-before").hidden = !(gray || (split && !single));
    $("label-after").hidden = !split;
    $("divider").hidden = !split;
    if (tlf) { // timeline frame: date, sensor and product status on the map
      $("label-before").hidden = false;
      $("label-before").textContent = t("{date} · NISAR radar · {maturity}", { date: fmtDay(tlf.label), maturity: tlf.maturity });
      $("label-before").title = `${fmtUtc(tlf.start_utc)} · ${tlf.sensor} · ${tlf.granule}`;
    } else if (stf) { // Timeline stage: capture date and source on the image (none for a stage without an image)
      $("label-before").hidden = !stf.frame || kind === "figure";
      $("label-after").hidden = true;
      if (stf.frame && kind !== "figure") {
        // v66: place on every frame; v68: with the part of the valley where there is room (on phones it is in the block above the image)
        const loc = stf.frame.location ? `${narrow.matches ? I.tx(stf.frame.location) : stagePlace(I.tx(stf.frame))} · ` : "";
        $("label-before").textContent = loc + (kind === "map" && stf.frame.record ? t("Incident record {date} · {source}", { date: d(stf.frame.label), source: stf.frame.source_short })
          : kind === "map" ? t("Observed {date} · {source}", { date: d(stf.frame.label), source: stf.frame.sensor ? `UNOSAT · ${stf.frame.sensor}` : "UNOSAT" })
          : t("Captured {date} · {source}", { date: d(stf.frame.label), source: stf.frame.source_short || "Sentinel-2" })); // v68: capture / observation date; v69: incident record, sensor of the frame
        $("label-before").title = stf.frame.datetime_utc ? `${fmtUtc(stf.frame.datetime_utc)} · ${stf.frame.scene}` : "";
      }
    } else if (overlays.evImage) { // evidence (image-only event): what the picture under the outline is
      $("label-before").hidden = false;
      $("label-after").hidden = true;
      $("label-before").textContent = t("{date} · Sentinel-2 · true colour", { date: d(evidence.background.match(/\d{4}-\d{2}-\d{2}/)[0]) });
    } else if (opticalShown() && split) { // capture date and source on both sides of the divider
      const [ob, oa] = opticalPair();
      if (optical.quake) { // v74: full capture dates; on phones the date alone, so both tags fit side by side
        $("label-before").textContent = narrow.matches ? fmtDay(ob.label) : t("Before · {date} · Sentinel-2", { date: fmtDay(ob.label) });
        $("label-after").textContent = narrow.matches ? fmtDay(oa.label) : t("After · {date} · Sentinel-2", { date: fmtDay(oa.label) });
      } else {
      $("label-before").textContent = swirOn() ? t("Before · {date} · Sentinel-2 infrared", { date: d(ob.label) }) : t("Before · {date} · Sentinel-2", { date: d(ob.label) });
      $("label-after").textContent = swirOn() ? t("After · {date} · Sentinel-2 infrared", { date: d(oa.label) }) : t("After · {date} · Sentinel-2", { date: d(oa.label) });
      }
      $("label-before").title = `${fmtUtc(ob.datetime_utc)} · ${ob.scene}`;
      $("label-after").title = `${fmtUtc(oa.datetime_utc)} · ${oa.scene}`;
    } else if (state.ui === "simple" && split) {
      $("label-before").textContent = t("Before · {date} · radar", { date: d(state.before) });
      $("label-after").textContent = t("After · {date} · radar", { date: d(state.after) });
    }
    if (!lite()) { // NISAR view controls, source chips and the layer legend of the evidence steps
      renderViewControls(gray, single);
      renderChips();
      renderLegend();
    }
    renderMapLegend();
    if (state.ui === "simple" && state.helperOpen) renderHelper();
    clip();
    if (!pending) setStatus(""); // nothing to load (e.g. a step with no NISAR layer)
    fitAttribution();
  }
  // Keep the map legend, tools and background note above the attribution line, however many lines it wraps to
  function fitAttribution() {
    const a = document.querySelector(".leaflet-control-attribution");
    if (a) document.querySelector(".map-wrap").style.setProperty("--attr-h", `${a.offsetHeight}px`);
  }
  window.addEventListener("resize", () => setTimeout(fitAttribution, 50));

  // --- View controls and the "what is compared" line (view choice is separate from the before–after divider)
  function renderViewControls(gray, single) {
    document.querySelectorAll('#view-switch button').forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === state.view)));
    const sat = state.view === "satellite";
    const step2 = isChangeStep();
    $("show-evidence").closest("label").hidden = step2; // in steps with the Change map / Compare radar switch, the switch decides
    $("show-evidence").checked = gray;
    // Opacity control only while the grey radar is on
    $("ev-opacity-row").hidden = !gray;
    $("ev-opacity").value = Math.round(state.opacity[state.view] * 100);
    $("ev-opacity-val").textContent = `${Math.round(state.opacity[state.view] * 100)}%`;
    const radarRow = list.querySelector('[data-id="radar"] input');
    if (radarRow) { radarRow.checked = gray; radarRow.disabled = step2; }
    renderModeSwitch();
    const parts = [];
    if (gray) parts.push(single ? t("Grey radar {pol}: {date}.", { pol: state.pol, date: fmtDay(state.before) })
      : t("Grey radar {pol}: left {left} · right {right}.", { pol: state.pol, left: fmtShort(state.before, true), right: fmtShort(state.after, true) }));
    if (overlays.change) parts.push(t("Colour change {pol}: {after} − {before}, one map.", { pol: state.pol, after: fmtShort(state.after, true), before: fmtShort(state.before, true) }));
    const cand = meta.support.filter((x) => overlays[x.id] && !isIndep(x));
    const indep = meta.support.filter((x) => overlays[x.id] && isIndep(x));
    if (cand.length) {
      const v = { layers: cand.map(supTitle).join("; "), from: fmtShort(cand[0].period[0]), to: fmtShort(cand[0].period[1], true) };
      parts.push(candOneMap() ? t("{layers}: {from} → {to} NISAR pair, one map (derived from the change between the two dates).", v)
        : t("{layers}: {from} → {to} NISAR pair, right (“after”) side only.", v));
    }
    for (const x of indep) parts.push(t("{layer}: {dates}; whole study area.", { layer: supTitle(x), dates: T.layers[x.id].dates }));
    if (indep.some(refMismatch)) parts.push(t("{note} ({from} → {to}).", { note: refNote(), from: fmtShort(state.before), to: fmtShort(state.after, true) }));
    if (!parts.length) parts.push(step2 ? t("No radar layer in this step.") : t("No radar layer in this step. “Grey radar image” shows the radar picture."));
    if (sat && parts.length && (gray || overlays.change || cand.length || indep.length)) parts.push(t("Satellite background is not part of the comparison."));
    // Candidate opacity: only when the candidate (or intersection) is shown together with Landsat/GFM
    const showCandOp = cand.length > 0 && indep.length > 0;
    $("cand-opacity-row").hidden = !showCandOp;
    $("cand-opacity").value = Math.round(state.candOpacity * 100);
    $("cand-opacity-val").textContent = `${Math.round(state.candOpacity * 100)}%`;
    parts[0] = t("Showing: {what}", { what: parts[0] });
    $("compare-info").textContent = parts.join(" ");
    writeHash();
  }
  function renderModeSwitch() {
    const show = isChangeStep();
    $("mode-switch").hidden = !show;
    if (!show) { $("mode-reason").hidden = true; return; }
    const avail = { change: changeAvail(), compare: compareAvail() };
    document.querySelectorAll("#mode-switch button").forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset.mode === state.changeMode));
      b.disabled = !avail[b.dataset.mode];
    });
    const reasons = [];
    if (!avail.change) reasons.push(t("Change map unavailable: no computed change layer for {dates} ({pol}).", { dates: fmtPair(state.before, state.after), pol: state.pol }));
    if (!avail.compare) reasons.push(t("Compare radar unavailable: a grey radar image is missing for this pair ({pol}).", { pol: state.pol }));
    $("mode-reason").hidden = !reasons.length;
    $("mode-reason").textContent = reasons.join(" ");
  }
  // If the chosen option has no data for this pair, use the other one (called before anything is drawn)
  function ensureMode() {
    if (!isChangeStep()) return;
    const avail = { change: changeAvail(), compare: compareAvail() };
    const other = state.changeMode === "change" ? "compare" : "change";
    if (!avail[state.changeMode] && avail[other]) { state.changeMode = other; renderStepLead(); }
  }
  function renderStepLead() {
    const s = T.steps[state.step];
    $("step-lead").textContent = s.lead;
    const hint = isChangeStep() && s.mode_hints ? s.mode_hints[state.changeMode] || "" : "";
    $("mode-hint").hidden = !hint;
    $("mode-hint").textContent = hint;
  }
  document.querySelectorAll("#mode-switch button").forEach((b) => b.addEventListener("click", () => {
    if (b.disabled || state.changeMode === b.dataset.mode) return;
    state.changeMode = b.dataset.mode; // event, date pair, map position and zoom are unchanged
    renderStepLead();
    render();
    if (narrow.matches) document.querySelector(".map-col").scrollIntoView({ block: "start" }); // show the map that just changed
  }));
  // Arrow keys move between the two options (radio-group behaviour)
  $("mode-switch").addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const next = [...document.querySelectorAll("#mode-switch button")].find((b) => b.dataset.mode !== state.changeMode && !b.disabled);
    if (next) { next.click(); next.focus(); }
    e.preventDefault();
  });
  const areaText = () => (meta && meta.study_area ? `${I.fmt.num(meta.study_area.area_km2, 1)} km²` : "5 × 5 km");
  const unobservedLegend = () => (meta && meta.study_area && meta.study_area.valid_both_dates_share < 1
    ? `<div class="ml-simple"><i style="background:rgba(${meta.study_area.unobserved_rgba.slice(0, 3).join(",")},0.63)"></i>${esc(t("Grey: we could not check this place"))}</div>` : "");
  // --- Simple view: the existing result on a satellite map with one short card (no new data; same layers as the evidence view)
  // Simple view (Mozambique): the selected class of the existing ±3 dB descriptive criterion, or null
  const simpleSignal = () => (state.ui === "simple" && (state.mapMode === "analysis" || state.mapMode === "radar") && T.simple && T.simple.classes && meta.signal_classes && state.simpleClass
    ? meta.signal_classes.classes[state.simpleClass] : null);
  function applySimpleLayers() {
    const sv = T.simple;
    if (lite()) { // images only: Before / After splits the map, the other modes show one picture
      state.before = state.after = null;
      state.swipe = state.mapMode === "optical" ? 0.5 : 1;
      state.evidence.satellite = state.evidence.analysis = false;
      state.layers.analysis = new Set(); state.layers.satellite = new Set();
      state.custom = false;
      return;
    }
    [state.before, state.after] = T.steps[0].view.pair; // the analysed pair
    state.pol = "HH";
    // v60: Before / After = the grey radar of the analysed pair on both sides of the divider (same scale, same frame);
    // Timeline = one observation over the whole map, no analysis layer
    const m = state.mapMode, radar = m === "radar";
    state.swipe = radar || m === "optical" ? 0.5 : 1;
    state.evidence.satellite = state.evidence.analysis = radar;
    const ids = state.simpleShow && (radar || m === "analysis") ? sv.layers : [];
    state.layers.analysis = new Set(ids);
    state.layers.satellite = new Set(ids);
    state.custom = false;
    $("sel-pair").value = `${state.before}|${state.after}`;
    document.querySelectorAll('input[name="pol"]').forEach((r) => { r.checked = r.value === "HH"; });
    list.querySelectorAll(".layer").forEach((row) => { row.querySelector("input").checked = state.on.has(row.dataset.id); });
  }
  function enterSimple() {
    if (!meta || !T || !T.simple) return;
    stopPlay();
    state.ui = "simple";
    renderAreaSwitch();
    document.body.classList.add("ui-simple");
    state.step = 0;
    focusGroup.clearLayers();
    placeGroup.clearLayers();
    for (const q of T.simple.place_labels || []) placeGroup.addLayer(L.marker([q.lat, q.lon], { pane: "regions", keyboard: false, interactive: false,
      icon: L.divIcon({ className: "place-label", html: `<i></i><span>${esc(q.text)}</span>`, iconSize: [0, 0] }) }));
    const pl = T.simple.place_label;
    if (pl) placeGroup.addLayer(L.marker([pl.lat, pl.lon], { pane: "regions", keyboard: false, interactive: false,
      icon: L.divIcon({ className: "place-label", html: `<i></i><span>${esc(pl.text)}</span>`, iconSize: [0, 0] }) }));
    const cl = T.simple.classes;
    if (!cl || !meta.signal_classes) state.simpleClass = null;
    else if (!cl.some((c) => c.key === state.simpleClass)) state.simpleClass = T.simple.default_class;
    applySimpleLayers();
    renderSimpleCard();
    renderScience();
    render();
  }
  // v64: the event's finding in one sentence (text.en.json simple.finding) and the step whose map shows it
  const finding = () => (T && T.simple && T.simple.finding) || null;
  function renderFinding() {
    const box = $("ev-finding"), f = finding();
    box.hidden = !(meta && f && state.ui === "evidence"); // v76: in the simple view the finding is the sentence above the map
    if (box.hidden) { box.innerHTML = ""; return; }
    box.innerHTML = `<p class="evf-k">${esc(t("Finding"))}</p><p class="evf-t">${esc(f.text)}</p>`;
  }
  function enterEvidence(step) {
    stopPlay();
    if (step === undefined) step = finding() ? finding().step : 0;
    state.ui = "evidence";
    document.body.classList.remove("ui-simple");
    placeGroup.clearLayers();
    $("simple-card").hidden = true;
    renderScience();
    renderSimpleBar();
    goStep(step || 0, false);
    renderFinding();
    renderAreaSwitch();
    if (floodView()) areaGo(); // v75: the area view, after the step's own framing
    $("to-simple").focus({ preventScroll: true });
    if (narrow.matches && finding()) $("ev-finding").scrollIntoView({ block: "start" }); // phones: finding first, the map right under it
  }
  // v48: one active state for the Simple view. The bar above the map, the map legend and the layer buttons all read it,
  // so the colour, its label and the sentence always describe the layer that is really drawn (or say that none is).
  function simpleActive() {
    const sv = T.simple;
    if (sv.classes && meta.signal_classes) { // Mozambique: one display class of the existing descriptive criterion, or none
      const k = state.simpleClass, c = k && sv.classes.find((x) => x.key === k);
      return c ? { on: true, key: k, color: meta.signal_classes.classes[k].color, label: c.label, text: sv.shows[k] } : { on: false, text: sv.shows.off };
    }
    const sp = sv.toggle ? supportById(sv.toggle.layer) : null; // Bangladesh: the experimental candidate on/off
    if (!sp || !state.simpleShow) return { on: false, text: sv.shows.off };
    return { on: true, key: "on", color: (Object.values(sp.classes).find((c) => c.show_in_legend !== false) || {}).color, label: sv.legend, text: sv.shows.on };
  }
  // The observation pair the Simple-view layer is computed from (not the event's whole observation period)
  function simplePair() {
    const sv = T.simple;
    if (sv.classes && meta.signal_classes) return meta.signal_classes.pair;
    const sp = sv.toggle ? supportById(sv.toggle.layer) : null;
    return sp && sp.period ? sp.period : [state.before, state.after];
  }
  // Block right above the map (Simple view): observation pair, what the map shows, the layer buttons
  function renderSimpleBar() {
    renderFinding();
    const bar = $("simple-bar"), sv = T && T.simple;
    $("view-notes").hidden = true; $("view-notes").innerHTML = ""; // v76: filled again by the view that has dates and limits
    const show = state.ui === "simple" && sv && sv.shows;
    bar.hidden = !show;
    if (!show) { bar.innerHTML = ""; $("stage-ctrl").hidden = true; $("stage-ctrl").innerHTML = ""; renderModeBar(); return; }
    const a = simpleActive(), [pa, pb] = simplePair();
    const controls = sv.classes && meta.signal_classes
      ? `<div class="sb-classes" role="group" aria-label="${esc(t("Radar change shown on the map (press again to hide)"))}">` + sv.classes.map((c) =>
        `<button type="button" class="btn sc-class" data-key="${esc(c.key)}" aria-pressed="${state.simpleClass === c.key}">` +
        `<i class="sw" style="background:${meta.signal_classes.classes[c.key].color}"></i>${esc(c.label)}</button>`).join("") + `</div>`
      : sv.toggle ? `<div class="sb-classes"><button type="button" class="btn sc-toggle" aria-pressed="${state.simpleShow}">${esc(state.simpleShow ? sv.toggle.hide : sv.toggle.show)}</button></div>` : "";
    // v58: one short sentence about what the map shows (by the active layer); the layer name, its dates and the uncertainty
    // are in the map key only, so nothing is said twice
    void pa; void pb;
    renderModeBar();
    if (isQuake()) { renderQuakeBar(bar); return; } // v73; v74: also the satellite image comparison
    if (state.mapMode !== "timeline") { $("stage-ctrl").hidden = true; $("stage-ctrl").innerHTML = ""; }
    if (state.mapMode === "radartl") { renderTimelineBar(bar); return; }
    if (state.mapMode === "timeline") { renderStageBar(bar); return; }
    // v76: above the map, one sentence that says what the view shows, the action the reader can take, then the dates and the
    // limits in small type; the longer numbers and methods are under "Data and sources"
    const notes = $("view-notes");
    // phones: the first screen is the place, its one sentence, the action and the picture; the view's own sentence goes under the picture
    let lead = "";
    const say = (txt) => { if (!txt) return ""; if (narrow.matches) { lead = `<p class="sb-text">${esc(txt)}</p>`; return ""; } return `<p class="sb-text" aria-live="polite">${esc(txt)}</p>`; };
    const setNotes = (html) => { notes.innerHTML = lead + (html ? `<p class="sb-limits">${html}</p>` : ""); notes.hidden = !(html || lead); };
    const more = (id) => { const a = notes.querySelector(".sb-more"); if (a) a.addEventListener("click", (e) => { e.preventDefault(); openData(id); }); };
    setNotes("");
    if (state.mapMode === "unosat" && evidence && evidence.layers) { // v69: wildfire evidence — two layers, each with what it is
      const ev = I.tx(evidence), ms = ev.measurement, off = state.evOff || {}, [f1, f2] = firstSentence((finding() || {}).text || "");
      bar.innerHTML = say(f1) +
        `<div class="sb-classes ev-layers" role="group" aria-label="${esc(t("Layers on the map"))}">` + ev.layers.map((L_) =>
          `<button type="button" class="btn sc-evl" data-id="${esc(L_.id)}" aria-pressed="${!off[L_.id]}"><i class="evk evk-${esc(L_.kind)}" style="--c:${esc(L_.color)}"></i>${esc(L_.label)}</button>`).join("") + `</div>` +
        "";
      setNotes(`${f2 ? `${esc(f2)} ` : ""}${esc(t("Each dot is a heat detection at one satellite pass, not a fire front."))} ` +
        `<a href="${esc(ms.record_url)}" target="_blank" rel="noopener">CAL FIRE ↗</a> · <a href="#science" class="sb-more">${esc(t("Data and sources"))} ↓</a>`);
      bar.querySelectorAll(".sc-evl").forEach((b) => b.addEventListener("click", () => {
        state.evOff = { ...(state.evOff || {}), [b.dataset.id]: !(state.evOff || {})[b.dataset.id] };
        renderSimpleBar(); render(); bar.querySelector(`.sc-evl[data-id="${b.dataset.id}"]`).focus();
      }));
      more("sci-fire");
      return;
    }
    if (state.mapMode === "unosat") {
      const ms = evidence && evidence.measurement;
      // v72: the layer, its background image date and what this image frame contains come from the event's files (no event text in the code)
      const evt = I.tx(evidence), bg = optical && optical.pair.find((o) => o.file === evidence.background), f = finding();
      bar.innerHTML = ms && f ? say(f.text) : "";
      if (ms) setNotes(`${esc(t("Orange: {what}, drawn over the Sentinel-2 image of {date}.", { what: (evt.layer && evt.layer.what) || t("area UNOSAT mapped as affected"), date: bg ? fmtDay(bg.label) : "" }))} ${esc(evt.measurement.status || "")} ` +
        `<a href="${esc(ms.data_url)}" target="_blank" rel="noopener">${esc(t("UNOSAT data, {date}", { date: fmtDay(ms.version) }))} ↗</a> · <a href="#science" class="sb-more">${esc(t("Data and sources"))} ↓</a>`);
      more("sci-unosat");
      return;
    }
    if (state.mapMode === "optical") {
      const op = optical ? I.tx(optical) : null, sw = op && op.variants && op.variants.swir, [c1, c2] = firstSentence(op ? op.change : "");
      bar.innerHTML = op
        ? say(c1) +
          `<p class="sb-action"><span aria-hidden="true">↔</span> ${esc(op.hint || t("Drag the line to compare before and after."))}</p>` +
          // v69: the same two scenes in short-wave infrared, switched on by the reader; the data type is said while it is on
          (sw ? `<div class="sb-classes"><button type="button" class="btn sc-burn" aria-pressed="${swirOn()}">${esc(sw.label)}</button></div>` +
            (swirOn() ? `<p class="sb-limits sb-swir"><b>${esc(sw.data_type)}</b> ${esc(sw.note)}</p>` : "") : "")
        : `<p class="sb-text" aria-live="polite">${esc(t("No pair of dated, cloud-free satellite images of this area was found for the flood. The radar and analysis layers are under Data and science."))}</p>`;
      if (op) setNotes(`${c2 ? `${esc(c2)} ` : ""}${esc(t("Right image: {timing}.", { timing: op.after_timing }))} <a href="#science" class="sb-more">${esc(t("Data and sources"))} ↓</a>`);
      more();
      const bb = bar.querySelector(".sc-burn");
      if (bb) bb.addEventListener("click", () => { state.burnView = !state.burnView; renderSimpleBar(); render(); bar.querySelector(".sc-burn").focus(); }); // same view: the map is not moved
      return;
    }
    bar.innerHTML = `<p class="sb-text" aria-live="polite">${esc(a.text)}</p>` +
      (state.mapMode === "radar" ? `<p class="sb-pair">${esc(t("Drag the divider: left {before}, right {after}.", { before: fmtDay(pa), after: fmtDay(pb) }))}</p>` : "") +
      controls.replace(/<\/div>$/, `<span class="sb-hint">${esc(mapHintText())}</span></div>`);
    bar.querySelectorAll(".sc-class").forEach((b) => b.addEventListener("click", () => { // one class at a time; pressing the active one hides it
      state.simpleClass = state.simpleClass === b.dataset.key ? null : b.dataset.key;
      renderSimpleBar();
      render();
      bar.querySelector(`.sc-class[data-key="${b.dataset.key}"]`).focus();
    }));
    const tg = bar.querySelector(".sc-toggle");
    if (tg) tg.addEventListener("click", () => { // same data on/off; the map is not moved
      state.simpleShow = !state.simpleShow;
      applySimpleLayers();
      renderSimpleBar();
      render();
      bar.querySelector(".sc-toggle").focus();
    });
  }
  // v60: the three choices above the map. Before / After and Timeline change this map; Follow the Water opens the
  // illustrative scene of the same event (a separate, labelled animation).
  function renderModeBar() {
    const row = $("mode-bar");
    const show = !!(meta && state.ui === "simple");
    row.hidden = !show;
    if (!show) { row.innerHTML = ""; return; }
    row.classList.toggle("mb-quake", isQuake()); // v73: earthquake labels break only at their own break points
    row.classList.add("mb-q"); // v76: every view is named by what it lets you learn
    row.classList.remove("mb-n4");
    const href = followHref(meta.event_id);
    const b = (mode, label) => `<button type="button" class="mb-btn" data-mode="${mode}" aria-pressed="${state.mapMode === mode}">${esc(label)}</button>`;
    if (isQuake()) { // v73: Before / After only with a verified pair; the earthquake layers and the timeline always
      row.innerHTML = (qDamage().length ? b("damage", t("What was seen in buildings?")) : "") + (qRasters().length ? b("motion", t("How far did the ground move?")) : "") +
        b("qtimeline", t("What happened when?")) + (optical ? b("optical", t("Compare satellite images")) : ""); // v74: only with a verified image pair
      row.classList.toggle("mb-n4", row.children.length === 4); // v74: four choices → 2 × 2 on small phones
      row.querySelectorAll("button.mb-btn[data-mode]").forEach((x) => x.addEventListener("click", () => setMapMode(x.dataset.mode, true)));
      return;
    }
    // v76: the question each view answers, by what it really shows (true-colour pair, dated stages, mapped layers, radar analysis)
    const fire = hazardNow() === "wildfire";
    const evLabel = !lite() ? t("Where did the radar see a change?") : fire ? t("Where did the fire spread?") : t("Which areas did the flood affect?");
    row.innerHTML = b("optical", fire ? t("Where did the fire leave a mark?") : t("What changed in the satellite image?")) +
      b("timeline", fire ? t("How did the fire unfold?") : t("How did the flood unfold?")) +
      (lite() && !evidence ? "" : // v71: an event whose record has no evidence section (evidence.json absent) has no evidence button
      `<button type="button" class="mb-btn mb-evidence"${lite() ? ` data-ev="unosat" aria-pressed="${state.mapMode === "unosat"}"` : ""}><span>${esc(evLabel)}</span>` +
        (lite() ? "" : `<small>${esc(t("step by step"))}</small>`) + `</button>`) +
      (href ? (hazardNow() === "wildfire" // v70: the wildfire scene shows dated observations in 3D (no illustration of the fire itself)
        ? `<a class="mb-btn mb-follow sc-follow" href="${href}" title="${esc(t("Dated satellite images and heat detections of this fire on the 3D terrain."))}"><span>${esc(t("Follow the Fire"))}</span><small>${esc(t("3D observations"))}</small></a>`
        : `<a class="mb-btn mb-follow sc-follow" href="${href}" title="${esc(t("A 3D sketch of how water moves over this land. Illustration, not observed water."))}">` +
        `<span>${esc(t("Follow the Water"))}</span><small>${esc(t("illustration"))}</small></a>`) : "");
    row.classList.toggle("mb-n4", row.children.length === 4); // v76: four choices → 2 × 2 on small phones
    row.querySelectorAll("button.mb-btn[data-mode]").forEach((x) => x.addEventListener("click", () => setMapMode(x.dataset.mode, true)));
    const evb = row.querySelector(".mb-evidence");
    if (evb) evb.addEventListener("click", () => (lite() ? setMapMode("unosat", true) : enterEvidence()));
  }
  function setMapMode(mode, focus) {
    if (!meta || state.mapMode === mode) return;
    stopPlay();
    const from = state.mapMode;
    const go = () => {
      state.mapMode = mode;
      applySimpleLayers();
      renderSimpleBar();
      render();
      renderModeBar();
      renderScience();
    };
    if (isQuake() && mode === "optical") { // v74: the pair covers a small strip of coast: frame it, remember where the reader was
      state.qPrevView = { c: map.getCenter(), z: map.getZoom() };
      go();
      clearTimeout(moveTimer); map.stop(); // no flight in progress may finish (or be corrected) after this jump
      map.fitBounds(pairBounds(), { padding: [16, 16], animate: false });
    } else if (isQuake() && state.qPrevView && from === "optical") {
      const v = state.qPrevView; state.qPrevView = null;
      go();
      clearTimeout(moveTimer); map.stop();
      map.setView(v.c, v.z, { animate: false });
    } else if (isQuake()) qKeepView(go); else go(); // v73: an earthquake layer change keeps the map's centre and zoom
    renderAreaSwitch();
    if (floodView()) areaGo(); // v75
    if (focus) { const x = $("mode-bar").querySelector(`[data-mode="${mode}"]`) || $("mode-bar").querySelector(`[data-ev="${mode}"]`); if (x) x.focus(); }
  }
  // Timeline: the real observations of the event, one at a time; Play steps through them once and stops at the last date
  function renderTimelineBar(bar) {
    const fr = timeline.frames;
    const f = fr[state.tl];
    const pair = simplePair();
    bar.innerHTML = `<p class="sb-text" aria-live="polite">${esc(t("Real NISAR observations, one at a time. Not a film of the flood: nothing was observed between these dates."))}</p>` +
      `<div class="tl-row"><button type="button" class="btn tl-play" aria-pressed="${!!playTimer}">${esc(playTimer ? t("Pause") : t("Play"))}</button>` +
      `<div class="tl-dates" role="group" aria-label="${esc(t("Observation dates"))}">` +
      fr.map((x, i) => `<button type="button" class="btn tl-date${pair.includes(x.label) ? " tl-pair" : ""}" data-i="${i}" aria-pressed="${i === state.tl}"` +
        ` title="${esc(`${fmtUtc(x.start_utc)} · ${x.granule}`)}">${esc(fmtShort(x.label, x.label.slice(0, 4) !== fr[fr.length - 1].label.slice(0, 4) || i === 0))}</button>`).join("") + `</div></div>` +
      `<p class="tl-meta">${esc(t("{date} · {sensor} · {maturity} · {track}", { date: fmtDay(f.label), sensor: f.sensor, maturity: f.maturity, track: f.track_frame }))}</p>`;
    { // keep the chosen date in sight in the sideways-scrolling row (phones)
      const row = bar.querySelector(".tl-dates"), on = row.querySelector('[aria-pressed="true"]');
      if (on && row.scrollWidth > row.clientWidth) {
        const rr = row.getBoundingClientRect(), ro = on.getBoundingClientRect();
        row.scrollLeft += ro.left - rr.left - (rr.width - ro.width) / 2;
      }
    }
    bar.querySelector(".tl-play").addEventListener("click", () => { playTimer ? stopPlay() : startPlay(); renderSimpleBar(); bar.querySelector(".tl-play").focus(); });
    bar.querySelectorAll(".tl-date").forEach((x) => x.addEventListener("click", () => { stopPlay(); showFrame(Number(x.dataset.i)); bar.querySelector(`.tl-date[data-i="${x.dataset.i}"]`).focus(); }));
  }
  // v63: Timeline = four stages. Each stage button shows its image (or says that there is none); Play shows the stages that
  // have an image, in order, and stops at the last one. Images are real captures; nothing is drawn between them.
  // a stage whose end is not confirmed is named by its date, not by the stage
  const stageChip = (x) => (x.frame && x.frame.heading === null ? fmtShort(x.frame.label, true) : x.chip);
  const stageSmall = (x) => (!x.frame ? t("No clear image") : x.frame.heading === null ? t("end not confirmed") : fmtShort(x.frame.label, true));
  // v68: phone-first Timeline. Above the image: date, short title, place (which part of the valley) and one sentence, in a block as tall as
  // the tallest stop, so the image and the controls never move. Under the image: previous / play-pause / next and the slider, then the stops.
  function renderStageBar(bar) {
    const ctrl = $("stage-ctrl");
    if (!stages) {
      bar.innerHTML = `<p class="sb-text" aria-live="polite">${esc(t("No dated satellite images of this area were found for the timeline."))}</p>`;
      ctrl.hidden = true; ctrl.innerHTML = "";
      return;
    }
    const st = I.tx(stages.stages), tr = track();
    bar.innerHTML = `<div class="st-head" aria-live="polite"></div>`;
    ctrl.hidden = false;
    ctrl.innerHTML = `<div class="st-bar">` +
      `<button type="button" class="btn st-step st-prev" aria-label="${esc(t("Previous image"))}" title="${esc(t("Previous image"))}"><span aria-hidden="true">◀</span></button>` +
      `<button type="button" class="btn st-play" aria-pressed="${!!playTimer}">${esc(playTimer ? t("Pause") : t("Play"))}</button>` +
      `<button type="button" class="btn st-step st-next" aria-label="${esc(t("Next image"))}" title="${esc(t("Next image"))}"><span aria-hidden="true">▶</span></button>` +
      `<input type="range" class="st-range" min="0" max="${Math.max(0, tr.length - 1)}" step="1" value="${state.tpos}" aria-label="${esc(t("Timeline: move between the images"))}"${tr.length < 2 ? " disabled" : ""}></div>` +
      `<div class="st-chips st-n${st.length}" role="group" aria-label="${esc(hazardNow() === "wildfire" ? t("Fire stages") : t("Flood stages"))}" style="grid-template-columns:repeat(${st.length},minmax(0,1fr))">` +
      st.map((x, i) => `<button type="button" class="st-chip${x.frame ? "" : " st-none"}" data-i="${i}" aria-pressed="false">` +
        `<span class="st-n">${i + 1}</span><b>${esc(stageChip(x))}</b><small>${esc(stageSmall(x))}</small></button>`).join("") + `</div>`;
    ctrl.querySelector(".st-play").addEventListener("click", () => { playTimer ? stopPlay() : startStagePlay(); syncStageBar(); ctrl.querySelector(".st-play").focus(); });
    ctrl.querySelector(".st-prev").addEventListener("click", () => { stopPlay(); stepTrack(-1); });
    ctrl.querySelector(".st-next").addEventListener("click", () => { stopPlay(); stepTrack(1); });
    ctrl.querySelectorAll(".st-chip").forEach((x) => x.addEventListener("click", () => { stopPlay(); showStage(Number(x.dataset.i)); }));
    // the slider is not rebuilt while it is moved (a touch drag or the keys keep working); only the map, the chips and the texts follow
    ctrl.querySelector(".st-range").addEventListener("input", (e) => { stopPlay(); showTrack(Number(e.target.value)); });
    syncStageBar();
    requestAnimationFrame(sizeStageHead);
  }
  // previous / next picture on the track; from a stop without a picture, the nearest picture before or after it
  function stepTrack(dir) {
    const tr = track();
    if (!tr.length) return;
    if (state.stageMissing != null) {
      const m = state.stageMissing, k = dir > 0 ? tr.findIndex((x) => x.si != null && x.si > m) : tr.map((x) => x.si != null && x.si < m).lastIndexOf(true);
      if (k >= 0) showTrack(k);
      return;
    }
    if (state.tpos + dir >= 0 && state.tpos + dir < tr.length) showTrack(state.tpos + dir);
  }
  // the block above the image: as tall as its tallest stop in this language and width (measured), so nothing under it moves
  function sizeStageHead() {
    const head = document.querySelector("#simple-bar .st-head");
    if (!head || !stages || !head.clientWidth) return;
    const probe = head.cloneNode(false);
    probe.removeAttribute("aria-live");
    probe.style.cssText = `position:absolute;visibility:hidden;left:-10000px;top:0;width:${head.getBoundingClientRect().width}px;min-height:0`;
    head.parentNode.appendChild(probe);
    let mx = 0;
    for (const s0 of stages.stages) { probe.innerHTML = stageHeadHtml(s0); mx = Math.max(mx, probe.getBoundingClientRect().height); }
    probe.remove();
    head.style.minHeight = `${Math.ceil(mx)}px`;
  }
  window.addEventListener("resize", () => { if (document.body.classList.contains("stage-mode")) requestAnimationFrame(sizeStageHead); });
  // chip states, slider position and its spoken text, Play/Pause label: updated in place
  function syncStageBar() {
    const bar = $("stage-ctrl");
    if (!stages || !bar.querySelector(".st-bar")) return;
    const cur = stageNow(), it = track()[state.tpos], si = state.stageMissing != null ? state.stageMissing : it ? it.si : -1;
    bar.querySelectorAll(".st-chip").forEach((c) => c.setAttribute("aria-pressed", String(Number(c.dataset.i) === si)));
    const rg = bar.querySelector(".st-range");
    if (Number(rg.value) !== state.tpos) rg.value = String(state.tpos);
    rg.classList.toggle("st-off", state.stageMissing != null);
    if (cur && cur.frame) {
      const f = I.tx(cur.frame);
      rg.setAttribute("aria-valuetext", [fmtDay(f.label), f.location, frameSource(cur.frame)].filter(Boolean).join(" · "));
    }
    const pl = bar.querySelector(".st-play");
    pl.textContent = playTimer ? t("Pause") : t("Play");
    pl.setAttribute("aria-pressed", String(!!playTimer));
    const tr = track(), m = state.stageMissing;
    bar.querySelector(".st-prev").disabled = m != null ? !tr.some((x) => x.si != null && x.si < m) : state.tpos <= 0;
    bar.querySelector(".st-next").disabled = m != null ? !tr.some((x) => x.si != null && x.si > m) : state.tpos >= tr.length - 1;
  }
  // who made the picture of a frame, in a few words (shown with the date and the place)
  function frameSource(f) {
    const kind = f.kind || "image";
    if (kind === "figure") return t("Landsat-9 · ESA");
    if (kind === "map") return f.record ? f.source_short : "UNOSAT";
    if (f.source_short && f.source_short !== "Sentinel-2") return t("{source} · true colour", { source: f.source_short }); // v69: Landsat-9
    return t("Sentinel-2 · true colour");
  }
  // v68: which part of the valley and which place a stop looks at ("Lower valley · Betrawati–Gerkhu"); updated with every stop
  const stagePlace = (fr) => [fr.area, fr.location].filter(Boolean).join(" · ");
  function stageHeadHtml(stf) {
    const x = I.tx(stf), f = x.frame;
    if (!f) return `<p class="sth-date">${esc(t("No image"))}</p><h3 class="sth-title">${esc(x.title)}</h3>` +
      `<p class="sth-loc"><span class="sth-pin" aria-hidden="true"></span>${esc(stagePlace(I.tx((stages.stages.find((s0) => s0.frame) || { frame: {} }).frame)))}</p>` +
      `<p class="sth-s">${esc(t("No clear satellite image was found for this stage."))}</p>`;
    const title = f.heading === null ? t("Image of {date}", { date: fmtShort(f.label, true) }) + ` <small>(${esc(t("end not confirmed"))})</small>` : esc(f.heading);
    return `<p class="sth-date"><time datetime="${esc(f.datetime_utc || f.label)}"${f.datetime_utc ? ` title="${esc(fmtUtc(f.datetime_utc))}"` : ""}>${esc(fmtDay(f.label))}</time>` +
      (f.record ? ` · <span class="sth-kind">${esc(t("Incident record, not a satellite image"))}</span>` : "") + `</p>` +
      `<h3 class="sth-title">${title}</h3>` +
      `<p class="sth-loc"><span class="sth-pin" aria-hidden="true"></span>${esc(stagePlace(f))}</p>` +
      `<p class="sth-s">${esc(f.sentence)}</p>`;
  }
  // long source information of the stop, folded under the controls (kept open or closed while moving through the stops)
  function renderStageCaption(stf) {
    const head = document.querySelector("#simple-bar .st-head"), box = $("stage-caption");
    if (head && stf) head.innerHTML = stageHeadHtml(stf);
    box.hidden = !stf;
    if (!stf) { box.innerHTML = ""; return; }
    const x = I.tx(stf), f = x.frame;
    const rows = f ? [f.why, f.note,
      f.catalog ? t("Catalogue: {catalog}", { catalog: f.catalog }) + (f.scene || f.product_id ? " · " + t("Product: {id}", { id: f.scene || f.product_id }) : "") : "",
      f.credit ? `${f.credit}${f.licence ? " · " + f.licence : ""}` : ""].filter(Boolean).map((r) => `<p>${esc(r)}</p>`).join("") +
      ((f.sources || []).length || f.link || f.stac ? `<p class="stc-links">${(f.sources || []).map((q) => `<a href="${esc(q.url)}" target="_blank" rel="noopener">${esc(q.short || q.publisher)} ↗</a>`)
        .concat(f.link && !(f.sources || []).length ? [`<a href="${esc(f.link)}" target="_blank" rel="noopener">${esc(f.publisher || t("Source"))} ↗</a>`] : [])
        .concat(f.stac ? [`<a href="${esc(f.stac)}" target="_blank" rel="noopener">STAC ↗</a>`] : []).join(" · ")}</p>` : "")
      : `<p>${esc(x.missing)}</p>`;
    box.innerHTML = `<details class="st-src"${state.srcOpen ? " open" : ""}><summary>${esc(t("Source and capture details"))}</summary>${rows}` +
      `<p class="stc-links"><a href="#science" class="stc-more">${esc(lite() ? t("Sources and method") : t("Data and science"))} ↓</a></p></details>`;
    box.querySelector("details").addEventListener("toggle", (e) => { state.srcOpen = e.target.open; });
  }
  $("stage-caption").addEventListener("click", (e) => { // "Sources and method ↓": open that section and go to it
    const a = e.target.closest(".stc-more");
    if (!a) return;
    e.preventDefault();
    $("science").open = true;
    $("science").scrollIntoView({ block: "start", behavior: reducedMotion.matches ? "auto" : "smooth" });
  });
  function showStage(i) { // a chip: its picture on the track, or the stop alone when it has none
    i = Math.max(0, Math.min(stages.stages.length - 1, i));
    state.stage = i;
    const k = track().findIndex((x) => x.si === i);
    if (k >= 0) { state.tpos = k; state.stageMissing = null; } else state.stageMissing = i;
    syncStageBar();
    render(); // same map frame: the map is not moved
  }
  function showTrack(k) {
    state.tpos = Math.max(0, Math.min(track().length - 1, k));
    state.stageMissing = null;
    const it = track()[state.tpos];
    if (it && it.si != null) state.stage = it.si;
    syncStageBar();
    render();
  }
  function startStagePlay() { // every picture on the track in date order; stops on the last one
    stopPlay();
    const tr = track();
    if (!tr.length) return;
    for (const x of tr) if (x.st.frame.file) { const im = new Image(); im.src = `data/${x.st.frame.file}?v=${DATA_V}`; } // preload
    let k = state.stageMissing != null ? 0 : state.tpos;
    if (k >= tr.length - 1) k = 0; // from the start when the last image is showing
    playTimer = setInterval(() => {
      k += 1;
      if (k >= tr.length) { stopPlay(); syncStageBar(); return; }
      showTrack(k);
      if (k >= tr.length - 1) { stopPlay(); syncStageBar(); } // stops on the last image
    }, 1600);
    showTrack(k);
  }
  function showFrame(i) {
    state.tl = Math.max(0, Math.min(timeline.frames.length - 1, i));
    renderSimpleBar();
    render(); // same map frame: the map is not moved
  }
  function startPlay() {
    stopPlay();
    if (state.tl >= timeline.frames.length - 1) state.tl = 0;
    for (const f of timeline.frames) { const im = new Image(); im.src = `data/${f.file}?v=${DATA_V}`; } // preload, so every step shows at once
    playTimer = setInterval(() => {
      if (state.tl >= timeline.frames.length - 1) { stopPlay(); renderSimpleBar(); return; }
      showFrame(state.tl + 1);
      if (state.tl >= timeline.frames.length - 1) { stopPlay(); renderSimpleBar(); }
    }, 1800);
    showFrame(state.tl);
  }
  function stopPlay() { if (playTimer) { clearInterval(playTimer); playTimer = 0; } }
  // ---------------------------------------------------------------------------------------------------------------
  // v73: earthquake events. Everything is read from <event>/map_layers.json (built from the catalog record by
  // build_event_web.py layers): NISAR line-of-sight displacement rasters (cm, transparent = no data), Copernicus EMS building
  // grading points and graded / not-analysed areas, and layers that are only linked (file null → official_url only).
  // Optional: "shocks" (map_layers.json or the events.json entry), text.en.json, optical.json (a verified Before / After pair).
  // Map modes: "motion" (one radar track at a time), "damage", "qtimeline" (the shocks and the observation windows) and,
  // only with a verified pair, "optical". Changing the mode never moves the map.
  const isQuake = () => !!(meta && meta.quake);
  const qEntry = (id) => (index.events.find((e) => e.id === id) || {});
  function qShocks(id) {
    const ml = quakeLayers[id] || {}, e = qEntry(id);
    return (ml.shocks || e.shocks || []).filter((s) => s && s.time_utc && s.mag != null).slice().sort((a, b) => (a.time_utc < b.time_utc ? -1 : 1));
  }
  const qMag = (s) => `M${Number(s.mag).toLocaleString(I.lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
  const qClock = (iso) => `${iso.slice(11, 19)} UTC`;
  const qGap = (sh) => (sh.length > 1 ? Math.round((Date.parse(sh[1].time_utc) - Date.parse(sh[0].time_utc)) / 1000) : null);
  // the event's short texts (cards, header, start screen) in the chosen language; text.en.json wins where it has a value
  function quakeText(id) {
    const e = qEntry(id), ml = quakeLayers[id] || {}, base = I.tx(texts[id] || {}), bev = base.event || {}, sh = qShocks(id);
    const day = ml.event_date || (sh[0] && sh[0].time_utc.slice(0, 10)) || "";
    const place = bev.place || I.tx(e.place || e.area_name || e.id);
    return {
      ...base, _quake: true,
      event: { ...bev, place, dates: bev.dates || (day ? fmtDay(day) : ""),
        title: bev.title || (sh.length > 1 ? t("Earthquakes in {place}", { place }) : t("Earthquake in {place}", { place })),
        area_name: bev.area_name || I.tx(e.area_name || ""), lede: bev.lede || qLead(sh), facts: bev.facts || [] },
      maturity: base.maturity || { text: t("Published products of other organisations, shown without new analysis by this project. They are preliminary.") },
      steps: [], layers: {}, regions: {}, sources: base.sources || [], reference_maps: base.reference_maps || [], uncertainty: base.uncertainty || [],
      simple: { ...(base.simple || {}), shows: {} },
    };
  }
  // v74: the one sentence a first-time reader starts with (the number of shocks comes from the event's own list)
  const qLead = (sh) => (sh.length === 2 ? t("Two strong earthquakes struck the same area a short time apart.")
    : sh.length > 2 ? t("{n} strong earthquakes struck the same area a short time apart.", { n: sh.length })
    : t("A strong earthquake struck this area."));
  // v74: two "image" layers of map_layers.json with the same "pair" and sides before / after → the existing Before / After slider.
  // Each side keeps its own capture date (observed), scene and STAC link; the pair keeps its own extent (bounds_latlon).
  function qOpticalPair(id, layers) {
    const imgs = (layers || []).filter((L_) => L_.kind === "image" && L_.status === "available" && L_.file && L_.pair && L_.observed);
    for (const b of imgs.filter((L_) => L_.side === "before")) {
      const a = imgs.find((L_) => L_.side === "after" && L_.pair === b.pair);
      if (!a) continue;
      const side = (L_) => ({ side: L_.side, file: L_.file, label: L_.observed[0], datetime_utc: L_.datetime_utc, scene: L_.scene, platform: L_.platform, stac: L_.stac });
      return { event_id: id, quake: true, pair: [side(b), side(a)], bounds_latlon: b.bounds_latlon, export: { width: b.width }, source: b.source };
    }
    return null;
  }
  function quakeMeta(entry, ml) {
    return { event_id: entry.id, quake: true, nisar: false, bounds_latlon: ml.bounds_latlon, event_date: ml.event_date, maturity: null,
      dates: [], radar: {}, change: {}, support: [], regions: [], sources: [], reference_maps: [], qlayers: ml.layers || [], shocks: qShocks(entry.id) };
  }
  const qOn = (L_) => L_.status === "available" && !!L_.file;
  const qRasters = () => (isQuake() ? meta.qlayers.filter((L_) => L_.kind === "raster" && qOn(L_)) : []);
  const qDamage = () => (isQuake() ? meta.qlayers.filter((L_) => L_.group === "damage" && qOn(L_)) : []);
  const qLinked = (grp) => (isQuake() ? meta.qlayers.filter((L_) => !qOn(L_) && L_.official_url && (!grp || L_.group === grp)) : []); // file null: only its official link
  const qById = (id) => meta.qlayers.find((L_) => L_.id === id);
  const qTrackName = (L_) => {
    const g = L_.geometry || {};
    return g.orbit === "ascending" ? t("Ascending track {n}", { n: g.track }) : g.orbit === "descending" ? t("Descending track {n}", { n: g.track }) : L_.id;
  };
  const qShort = (pub) => String(pub || "").split(/ \/ | \(|, /)[0];
  const qSrc = (L_) => (L_.source && L_.source.url ? `<a href="${esc(L_.source.url)}" target="_blank" rel="noopener" title="${esc(L_.source.publisher || "")}">${esc(t("Source: {name}", { name: qShort(L_.source.publisher) }))} ↗</a>` : "");
  const qObs = (L_) => (L_.observed && L_.observed.length === 2 ? fmtPair(L_.observed[0], L_.observed[1]) : L_.observed ? fmtDay(L_.observed[0]) : "");
  const qCls = () => ({ Destroyed: t("Destroyed"), Damaged: t("Damaged"), "Possibly damaged": t("Possibly damaged") });
  const qClsName = (k) => qCls()[k] || k;
  const qNumNeg = (v) => `${v < 0 ? "−" : v > 0 ? "+" : ""}${I.fmt.num(Math.abs(v), 0)}`;
  // the stops of the earthquake timeline: each shock, each radar pair, then the damage grading (images → assessment)
  function qStops() {
    if (!isQuake()) return [];
    const st = meta.shocks.map((s, i) => ({ kind: "shock", i, s, from: s.time_utc.slice(0, 10), to: s.time_utc.slice(0, 10) }));
    const R = qRasters().filter((L_) => L_.observed);
    if (R.length) st.push({ kind: "radar", R, from: R.reduce((m, L_) => (L_.observed[0] < m ? L_.observed[0] : m), R[0].observed[0]),
      to: R.reduce((m, L_) => (L_.observed[1] > m ? L_.observed[1] : m), R[0].observed[1]), both: R.every((L_) => L_.covers_both_shocks) });
    const pts = qDamage().find((L_) => L_.kind === "points");
    if (pts && pts.observed) st.push({ kind: "damage", L: pts, from: pts.observed[0], to: pts.assessed || pts.observed[1] });
    return st;
  }
  // which layer the map shows in each mode (the timeline shows the layer of its stop; a shock keeps the last radar track)
  function qShown() {
    if (!isQuake() || state.ui !== "simple") return { raster: null, damage: false };
    if (state.mapMode === "motion") return { raster: qById(state.qTrack) || qRasters()[0] || null, damage: false };
    if (state.mapMode === "damage") return { raster: null, damage: true };
    if (state.mapMode === "qtimeline") {
      const s = qStops()[state.qStop];
      if (s && s.kind === "damage") return { raster: null, damage: true };
      if (s && s.kind === "radar") return { raster: qById(state.qTrack) || s.R[0], damage: false };
      return { raster: qById(state.qTrack) || qRasters()[0] || null, damage: false };
    }
    return { raster: null, damage: false };
  }
  const QCREDIT = new Set();
  function quakeDraw() {
    const sh = qShown(), LAY = t("Layers"), on = new Set();
    if (sh.raster) {
      overlays.qRaster = img(sh.raster.file, "change", "pixelated", L.latLngBounds(sh.raster.bounds_latlon)).setOpacity(0.85).addTo(map);
      if (sh.raster.source && sh.raster.source.credit) on.add(`${LAY}: ${sh.raster.source.credit}`);
    }
    if (sh.damage) {
      for (const L_ of qDamage()) {
        if (L_.kind === "polygon") overlays.qAreas = qAreasLayer(L_.file).addTo(map);
        else if (L_.kind === "points") overlays.qPoints = qPointsLayer(L_.file, L_.classes || {}).addTo(map);
        if (L_.source && L_.source.credit) on.add(`${LAY}: ${L_.source.credit}`);
      }
    }
    // epicentres: always shown, labelled with the magnitude (the shock chosen in the timeline is highlighted)
    const pick = state.mapMode === "qtimeline" ? qStops()[state.qStop] : null;
    const eg = L.layerGroup();
    meta.shocks.forEach((s, i) => {
      if (s.lat == null || s.lon == null) return;
      const hot = pick && pick.kind === "shock" && pick.i === i;
      eg.addLayer(L.marker([s.lat, s.lon], { pane: "regions", keyboard: false, interactive: false, zIndexOffset: hot ? 1000 : 0,
        icon: L.divIcon({ className: `q-epi${hot ? " on" : ""}${i % 2 ? " q-epi-r" : ""}`, html: `<i></i><span>${esc(qMag(s))}</span>`, iconSize: [0, 0] }) }));
    });
    overlays.qEpi = eg.addTo(map);
    for (const c of on) QCREDIT.add(c);
    for (const c of QCREDIT) setCredit(c, on.has(c));
  }
  function qAreasLayer(file) {
    const style = (f) => (f.properties.status === "not_analysed"
      ? { color: "#3b3f46", weight: 1, opacity: 0.9, dashArray: "2 3", fillColor: "#8a9099", fillOpacity: 0.55 }
      : { color: "#ffffff", weight: 2, opacity: 0.95, dashArray: "6 4", fill: false });
    const lay = L.geoJSON(null, { pane: "regions", interactive: false, style });
    const fill = (gj) => {
      lay.clearLayers();
      // graded outlines first, the parts that could not be analysed on top of them
      lay.addData({ type: "FeatureCollection", features: gj.features.slice().sort((a, b) => (a.properties.status === "not_analysed") - (b.properties.status === "not_analysed")) });
    };
    if (vecCache[file]) fill(vecCache[file]);
    else getJson(`data/${file}`).then((gj) => { vecCache[file] = gj; fill(gj); }).catch(() => fail(t("A layer image could not be loaded: {file}", { file: `<code>data/${file}</code>` })));
    return lay;
  }
  // v74: building marks stay visible at the opening (regional) zoom: at least 2.5 px, up to 4.5 px close in
  const qPtRadius = () => Math.max(2.5, Math.min(4.5, 2.5 + (map.getZoom() - 9) * 0.5));
  function qPointsLayer(file, classes) {
    const lay = L.geoJSON(null, { pane: "regions", interactive: false,
      pointToLayer: (f, ll) => L.circleMarker(ll, { renderer: ptRenderer, radius: qPtRadius(), weight: 0.6, color: "#1b1b1b",
        fillColor: classes[f.properties.damage] || "#cccccc", fillOpacity: 0.95, opacity: 0.7 }) });
    lay.on("add", () => { const z = () => lay.eachLayer((m) => m.setRadius(qPtRadius())); map.on("zoomend", z); lay.once("remove", () => map.off("zoomend", z)); });
    // the most severe class is drawn last (on top)
    const rank = { Destroyed: 2, Damaged: 1 };
    const fill = (gj) => { lay.clearLayers(); lay.addData({ type: "FeatureCollection", features: gj.features.slice().sort((a, b) => (rank[a.properties.damage] || 0) - (rank[b.properties.damage] || 0)) }); };
    if (vecCache[file]) fill(vecCache[file]);
    else getJson(`data/${file}`).then((gj) => { vecCache[file] = gj; fill(gj); }).catch(() => fail(t("A layer image could not be loaded: {file}", { file: `<code>data/${file}</code>` })));
    return lay;
  }
  // v73b: on phones the earthquake key sits right under the map instead of over it, so nothing it says covers the epicentres
  // (M7.2 and M7.5) or the layer; the map keeps its whole area and its usual framing. Wider screens: over the map as before.
  function qPlaceLegend(reset) {
    const lg = $("map-legend"), wrap = document.querySelector(".map-col > .map-wrap");
    const below = !reset && isQuake() && narrow.matches && state.ui === "simple" && state.mapMode !== "optical";
    // v76: the flood map views on phones too — the whole covered area stays visible (at 320 px the key covered the southern valley)
    const fBelow = !reset && !below && narrow.matches && floodView();
    if ((below || fBelow) && lg.parentElement !== wrap.parentElement) wrap.after(lg);
    if (!below && !fBelow && lg.parentElement !== wrap) wrap.appendChild(lg);
    lg.classList.toggle("q-below", below);
    lg.classList.toggle("f-below", fBelow);
  }
  // a layer change keeps the map exactly where it is (centre and zoom), even when the bars above the map change height
  function qKeepView(fn) {
    const c = map.getCenter(), z = map.getZoom();
    fn();
    requestAnimationFrame(() => {
      map.invalidateSize({ pan: false });
      if (!map.getCenter().equals(c, 1e-9) || map.getZoom() !== z) map.setView(c, z, { animate: false });
    });
  }
  // the ±scale bar of a raster: colours from the record, end triangles when the scale is clipped
  function qRamp(L_) {
    const sc = L_.scale || {}, cols = (sc.colors || []).join(", ");
    return `<div class="q-ramp${sc.clipped ? " q-clip" : ""}" style="--lo:${esc((sc.colors || [])[0] || "#000")};--hi:${esc((sc.colors || []).slice(-1)[0] || "#fff")}">` +
      `<span class="q-ramp-bar" style="background:linear-gradient(90deg, ${esc(cols)})"></span></div>` +
      `<div class="q-ticks"><span>${sc.clipped ? "≤ " : ""}${qNumNeg(sc.min)}</span><span>0</span><span>${sc.clipped ? "≥ " : ""}${qNumNeg(sc.max)} ${esc(L_.unit || "")}</span></div>`;
  }
  function qSignLine(L_, short) {
    const g = L_.geometry || {};
    return g.sign_confirmed === true
      ? `<div class="q-sign ok">${esc(t("Positive values: {sign}.", { sign: I.tx(g.sign_published || "") }))}</div>`
      : `<div class="q-sign">${esc(short ? t("Sign direction not confirmed") : t("Sign direction not confirmed: values are shown in cm only, not as a direction of motion."))}</div>`;
  }
  // v74: the key says only what a first-time reader needs to read the colours; everything technical is under "Data and sources"
  function renderQuakeLegend() {
    const box = $("map-legend"), sh = qShown();
    box.classList.add("simple", "q-legend");
    box.classList.remove("collapsed", "ml-hidden");
    let html = "";
    if (sh.raster) {
      const L_ = sh.raster, sc = L_.scale || {}, g = L_.geometry || {};
      html = `<div class="ml-simple q-title">${esc(t("Ground movement ({unit})", { unit: L_.unit || "cm" }))}</div>` + qRamp(L_) +
        `<div class="q-row"><i class="q-nodata"></i><span>${esc(t("No data (transparent)"))}</span></div>` +
        (sc.clipped ? `<div class="q-note">${esc(t("Colours stop at ±{v} {unit}; larger movements get the end colour.", { v: I.fmt.num(sc.max, 0), unit: L_.unit || "cm" }))}</div>` : "") +
        (g.sign_confirmed === true ? `<div class="q-note">${esc(t("Positive values: {sign}.", { sign: I.tx(g.sign_published || "") }))}</div>`
          : `<div class="q-sign">${esc(t("It is not yet confirmed which direction plus and minus values show."))}</div>`) +
        `<div class="q-date">${esc(t("Observed {dates}", { dates: qObs(L_) }))} · ${qSrc(L_)}</div>`;
    } else if (sh.damage) {
      const pts = qDamage().find((L_) => L_.kind === "points"), ar = qDamage().find((L_) => L_.kind === "polygon");
      const cnt = (pts && pts.count) || {}, total = Object.values(cnt).reduce((a, b) => a + b, 0);
      html = `<div class="ml-simple q-title">${esc(t("{n} graded buildings", { n: I.fmt.num(total, 0) }))}</div>` +
        `<div class="q-classes">` + Object.keys((pts && pts.classes) || {}).map((k) =>
          `<div class="q-row"><i class="q-dot" style="background:${esc(pts.classes[k])}"></i><span>${esc(qClsName(k))} · ${esc(I.fmt.num(cnt[k] || 0, 0))}</span></div>`).join("") + `</div>` +
        (ar ? `<div class="q-row"><i class="q-area"></i><span>${esc(t("Dashed line: area examined"))}</span></div>` +
          ((ar.count || {}).not_analysed ? `<div class="q-row"><i class="q-na"></i><span>${esc(t("Grey: could not be examined"))}</span></div>` : "") +
          `<div class="q-note">${esc(t("Outside the lines: not examined. No mark does not mean undamaged."))}</div>` : "") +
        (pts ? `<div class="q-date">${esc(t("Images {dates} · assessed {date}", { dates: qObs(pts), date: fmtShort(pts.assessed || pts.version, true) }))} · ${qSrc(pts)}</div>` : "") +
        qLinked("damage").map((L_) => `<div class="q-date">${esc(t("Another damage estimate, not shown here:"))} <a href="${esc(L_.official_url)}" target="_blank" rel="noopener">${esc(t("Official map"))} ↗</a></div>`).join("");
    } else {
      html = `<div class="ml-simple ml-off">${esc(t("No layer shown"))}</div>`;
    }
    box.innerHTML = html + `<a href="#science" class="q-more">${esc(t("Data and sources"))} ↓</a>`;
    box.querySelector(".q-more").addEventListener("click", (ev) => { ev.preventDefault(); $("science").open = true; renderScience(); $("science").scrollIntoView({ block: "start", behavior: reducedMotion.matches ? "auto" : "smooth" }); });
  }
  const qLinkReason = (L_) => (L_.status === "not_redistributed"
    ? t("{name}: not copied to this map (no reuse licence stated).", { name: qShort((L_.source || {}).publisher) || L_.id })
    : t("{name}: not available on this map.", { name: qShort((L_.source || {}).publisher) || L_.id }));
  // the block above the map: the one lead sentence, then one sentence about the view (and, for ground movement, the radar pair)
  function renderQuakeBar(bar) {
    const ctrl = $("stage-ctrl");
    if (state.mapMode !== "qtimeline") { ctrl.hidden = true; ctrl.innerHTML = ""; }
    const lead = ""; // v76: the lead sentence is in the header, under the event name
    if (state.mapMode === "damage") {
      bar.innerHTML = lead + `<p class="sb-text">${esc(qDamage().length ? t("Coloured marks show buildings examined from satellite images.") : t("No building damage layer is available for this event."))}</p>` +
        (qDamage().length ? `<p class="sb-action"><span aria-hidden="true">＋</span> ${esc(t("Zoom in on the coloured marks to see single buildings."))}</p>` : "");
      return;
    }
    if (state.mapMode === "motion") {
      const R = qRasters(), cur = qShown().raster;
      bar.innerHTML = lead + `<p class="sb-text">${esc(meta.shocks.length > 1 ? t("This map compares radar measurements taken before and after the two earthquakes.")
          : t("This map compares radar measurements taken before and after the earthquake."))}</p>` +
        (R.length > 1 ? `<div class="q-pairs" role="group" aria-label="${esc(t("Radar measurement pair shown on the map"))}"><span class="q-pairs-k">${esc(t("Radar pair"))}</span>` + R.map((L_) =>
          `<button type="button" class="btn q-track" data-id="${esc(L_.id)}" aria-pressed="${cur && cur.id === L_.id}">${esc(L_.observed ? `${fmtShort(L_.observed[0])} → ${fmtShort(L_.observed[1])}` : L_.id)}</button>`).join("") + `</div>` : "");
      bar.querySelectorAll(".q-track").forEach((b) => b.addEventListener("click", () => {
        qKeepView(() => { state.qTrack = b.dataset.id; renderSimpleBar(); render(); });
        const nb = $("simple-bar").querySelector(`.q-track[data-id="${b.dataset.id}"]`); if (nb) nb.focus();
      }));
      return;
    }
    if (state.mapMode === "qtimeline") { renderQuakeTimeline(bar); return; }
    if (state.mapMode === "optical" && optical) { // v74: the image pair, its two capture dates and what it can and cannot show
      const [ob, oa] = optical.pair;
      bar.innerHTML = `<p class="sb-text">${esc(t("The difference in the colour of the slopes is largely seasonal. Damage to single buildings cannot be seen in these images."))}</p>` +
        `<p class="sb-pair">${esc(t("Left: {before} · Right: {after} · Sentinel-2, 10 m", { before: fmtDay(ob.label), after: fmtDay(oa.label) }))}</p>`;
      return;
    }
    bar.innerHTML = "";
  }
  // Timeline: each shock is its own stop (its map mark is highlighted), the radar measurements one dated stop, the building assessment one
  function qStopHead(s) {
    const sh = meta.shocks;
    if (!s) return "";
    if (s.kind === "shock") {
      const gap = s.i > 0 ? Math.round((Date.parse(s.s.time_utc) - Date.parse(sh[0].time_utc)) / 1000) : null;
      return `<p class="sth-date"><time datetime="${esc(s.s.time_utc)}">${esc(fmtDay(s.from))} · ${esc(qClock(s.s.time_utc))}</time></p>` +
        `<h3 class="sth-title">${esc(t("{mag} earthquake", { mag: qMag(s.s) }))}</h3>` +
        (s.s.place ? `<p class="sth-loc"><span class="sth-pin" aria-hidden="true"></span>${esc(I.tx(s.s.place))}</p>` : "") +
        `<p class="sth-s">${esc(gap != null ? t("{s} seconds after the first shock.", { s: gap }) : sh.length > 1 ? t("The first of {n} shocks.", { n: sh.length }) : "")}` +
        `${s.s.url ? ` <a href="${esc(s.s.url)}" target="_blank" rel="noopener">${esc(s.s.source || t("Source"))} ↗</a>` : ""}</p>`;
    }
    if (s.kind === "radar") {
      return `<p class="sth-date">${esc(t("Radar measurements · {dates}", { dates: fmtPair(s.from, s.to) }))}</p>` +
        `<h3 class="sth-title">${esc(t("Satellite radar"))}</h3>` +
        `<p class="sth-s">${esc(s.both && sh.length > 1 ? t("{n} measurement pairs, each taken before and after the earthquakes: every pair covers both earthquakes together and cannot separate them.", { n: s.R.length })
          : t("{n} measurement pairs, each taken before and after the earthquake.", { n: s.R.length }))}</p>`;
    }
    return `<p class="sth-date">${esc(t("Images {dates} · assessed {date}", { dates: qObs(s.L), date: fmtShort(s.L.assessed || s.L.version, true) }))}</p>` +
      `<h3 class="sth-title">${esc(t("Building damage grading"))}</h3>` +
      `<p class="sth-s">${esc(t("Preliminary assessment based on satellite images"))}. ${qSrc(s.L)}</p>`;
  }
  function renderQuakeTimeline(bar) {
    const ctrl = $("stage-ctrl"), stops = qStops();
    if (!stops.length) { bar.innerHTML = `<p class="sb-text">${esc(t("No dated observations of this event are available."))}</p>`; ctrl.hidden = true; ctrl.innerHTML = ""; return; }
    state.qStop = Math.max(0, Math.min(stops.length - 1, state.qStop || 0));
    const day = (iso) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 864e5;
    const d0 = Math.min(...stops.map((s) => day(s.from))) - 0.5, d1 = Math.max(...stops.map((s) => day(s.to))) + 1.5;
    const x = (v) => ((v - d0) / (d1 - d0) * 100).toFixed(2);
    const shockX = meta.shocks.length ? x(Date.parse(meta.shocks[0].time_utc) / 864e5) : null;
    const lab = (s) => s.kind === "shock" ? `<b>${esc(qMag(s.s))}</b><small>${esc(qClock(s.s.time_utc))}</small>`
      : s.kind === "radar" ? `<b>${esc(t("Satellite radar"))}</b><small>${esc(t("{n} measurement pairs", { n: s.R.length }))}</small>`
      : `<b>${esc(t("Buildings"))}</b><small>${esc(t("satellite images"))}</small>`;
    const shockMark = shockX != null ? `<i class="qt-shock" style="left:${shockX}%"></i>` : "";
    const bar1 = (from, to, cls, k, n) => `<i class="qt-bar ${cls}" style="left:${x(day(from) + 0.5)}%;width:${Math.max(0, x(day(to) + 0.5) - x(day(from) + 0.5)).toFixed(2)}%;` +
      `${n > 1 ? `top:${((k + 0.5) / n * 100).toFixed(1)}%;height:${Math.max(3, Math.floor(18 / n))}px` : ""}"></i>`;
    const mark = (s) => s.kind === "shock"
      ? `<i class="qt-pin" style="left:${x(Date.parse(s.s.time_utc) / 864e5)}%"></i>`
      : s.kind === "radar" ? s.R.map((L_, k) => bar1(L_.observed[0], L_.observed[1], "qt-radar", k, s.R.length)).join("") + shockMark
      : bar1(s.from, s.L.observed[1], "qt-damage", 0, 1) + (s.L.assessed ? `<i class="qt-tick" style="left:${x(day(s.L.assessed) + 0.5)}%"></i>` : "") + shockMark;
    const first = stops.reduce((m, s) => (s.from < m ? s.from : m), stops[0].from), last = stops.reduce((m, s) => (s.to > m ? s.to : m), stops[0].to);
    const ticks = [...new Set([first, meta.shocks.length ? meta.shocks[0].time_utc.slice(0, 10) : null, last].filter(Boolean))];
    bar.innerHTML = `<div class="st-head q-head" aria-live="polite">${qStopHead(stops[state.qStop])}</div>`;
    ctrl.hidden = false;
    ctrl.innerHTML = `<div class="qt" role="group" aria-label="${esc(t("Timeline: shocks and observations"))}"><div class="qt-rows">` +
      stops.map((s, i) => `<button type="button" class="qt-row qt-k-${s.kind}" data-i="${i}" aria-pressed="${i === state.qStop}">` +
        `<span class="qt-lab">${lab(s)}</span><span class="qt-track" aria-hidden="true">${mark(s)}</span></button>`).join("") + `</div>` +
      `<div class="qt-axis" aria-hidden="true"><span class="qt-lab"></span><span class="qt-track">` +
        ticks.map((d) => `<span class="qt-t" style="left:${x(day(d) + 0.5)}%">${esc(fmtShort(d))}</span>`).join("") + `</span></div>` +
      (meta.shocks.length > 1 && stops.some((s) => s.kind === "radar" && s.both)
        ? `<p class="qt-note">${esc(t("The two earthquakes were about {s} seconds apart. The radar measurements cover both of them together.", { s: qGap(meta.shocks) }))}</p>` : "") +
      `</div>`;
    ctrl.querySelectorAll(".qt-row").forEach((b) => b.addEventListener("click", () => {
      const i = Number(b.dataset.i);
      qKeepView(() => { state.qStop = i; renderSimpleBar(); render(); });
      const nb = $("stage-ctrl").querySelector(`.qt-row[data-i="${i}"]`); if (nb) nb.focus();
    }));
  }
  // "Sources and method" of an earthquake event: every layer with its dates, geometry, numbers, licence and link
  function renderScienceQuake(box) {
    const pc = (x) => I.fmt.pct(x, 1), cm = (v) => `${qNumNeg(v)} cm`;
    const shocks = meta.shocks.length ? `<dt>${esc(t("Earthquakes"))}</dt><dd><ul class="sci-obs">` + meta.shocks.map((s) =>
      `<li><b>${esc(qMag(s))}</b> · ${esc(fmtDay(s.time_utc.slice(0, 10)))} · ${esc(qClock(s.time_utc))}` +
      (s.place ? ` · ${esc(I.tx(s.place))}` : "") + (s.depth_km != null ? ` · ${esc(t("Depth {d} km.", { d: I.fmt.num(s.depth_km, 0) }))}` : "") +
      (s.url ? ` <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.source || t("Source"))} ↗</a>` : "") + `</li>`).join("") + `</ul></dd>` : "";
    const raster = qRasters().map((L_) => {
      const g = L_.geometry || {}, st = L_.stats || {}, s = L_.source || {};
      return `<dt>${esc(t("Ground motion · {track}", { track: qTrackName(L_) }))}</dt><dd>` +
        `<p>${esc(t("Radar pair {dates}; product version {version}.", { dates: qObs(L_), version: fmtDay(L_.version) }))} ` +
        `${esc(g.look_side === "right" ? t("Frames {frames}; the radar looks to the right, about {deg}° from vertical.", { frames: (g.frames || []).join(", "), deg: g.incidence_deg_approx })
          : t("Frames {frames}; the radar looks to the left, about {deg}° from vertical.", { frames: (g.frames || []).join(", "), deg: g.incidence_deg_approx }))}</p>` +
        `<p>${esc(t("Colours stop at ±{v} {unit}; larger movements get the end colour.", { v: I.fmt.num((L_.scale || {}).max, 0), unit: L_.unit || "cm" }))} ` +
        `${esc(t("Measured pixels: {p} of the image. Values {min} to {max}; {q} lie outside the ±{v} cm colour scale.", { p: pc(st.valid_share || 0), min: cm(st.min), max: cm(st.max), q: pc(st.beyond_scale_share || 0), v: I.fmt.num((L_.scale || {}).max, 0) }))} ` +
        `${esc(t("Transparent pixels: no data (not measured), not zero movement."))}</p>` +
        (g.sign_confirmed === true ? "" : `<p><b>${esc(t("Sign not confirmed."))}</b> ${esc(t("The published description of the sign does not match the values in this area, so the values are shown in cm only, without a direction."))}</p>`) +
        (L_.covers_both_shocks && meta.shocks.length > 1 ? `<p>${esc(t("The pair spans both shocks: the map is their sum (with any aftershock and later motion until the second pass) and cannot separate them."))}</p>` : "") +
        `<p class="sci-note">${esc(s.publisher || "")}${s.product_id ? ` · <code>${esc(s.product_id)}</code>` : ""}${s.licence ? " · " + esc(s.licence) : ""}${s.credit ? " · " + esc(s.credit) : ""} ${qSrc(L_)}</p></dd>`;
    }).join("");
    const pts = qDamage().find((L_) => L_.kind === "points"), ar = qDamage().find((L_) => L_.kind === "polygon");
    const dmg = pts ? (() => {
      const cnt = pts.count || {}, total = Object.values(cnt).reduce((a, b) => a + b, 0), s = pts.source || {}, ac = (ar && ar.count) || {};
      return `<dt>${esc(t("Building damage grading"))}</dt><dd>` +
        `<p><b>${esc(t("{n} graded buildings", { n: I.fmt.num(total, 0) }))}</b> · ${esc(t("Preliminary assessment based on satellite images"))}.</p>` +
        `<ul class="sci-obs">` + Object.keys(pts.classes || cnt).map((k) => `<li>${esc(qClsName(k))}: ${esc(I.fmt.num(cnt[k] || 0, 0))}</li>`).join("") + `</ul>` +
        `<p>${esc(t("Images {dates} · assessed {date}", { dates: qObs(pts), date: fmtDay(pts.assessed || pts.version) }))}.</p>` +
        (ar ? `<p>${esc(t("Graded areas: {a}; parts that could not be analysed: {n}. Outside these areas no buildings were graded.", { a: I.fmt.num(ac.assessed_area || 0, 0), n: I.fmt.num(ac.not_analysed || 0, 0) }))}</p>` : "") +
        `<p>${esc(t("Only marked buildings are drawn. A building without a dot is not shown as undamaged."))}</p>` +
        `<p class="sci-note">${esc(s.publisher || "")}${s.product_id ? ` · <code>${esc(s.product_id)}</code>` : ""}${s.licence ? " · " + esc(s.licence) : ""}${s.credit ? " · " + esc(s.credit) : ""} ${qSrc(pts)}</p></dd>`;
    })() : "";
    const linked = qLinked().length ? `<dt>${esc(t("Not shown on this map"))}</dt><dd><ul class="sci-obs">` + qLinked().map((L_) =>
      `<li>${esc(qLinkReason(L_))} <a href="${esc(L_.official_url)}" target="_blank" rel="noopener">${esc(t("Official map"))} ↗</a></li>`).join("") + `</ul></dd>` : "";
    // v80: the shaking estimate used by the story's "Try the shaking" (USGS ShakeMap): source, version and the product's limits
    const S = meta.shaking, P = (S && S.product) || {}, mg = (x) => `M${Number(x).toLocaleString(I.lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
    const sk = meta.shocks, gap = sk.length > 1 ? Math.round((Date.parse(sk[1].time_utc) - Date.parse(sk[0].time_utc)) / 1000) : null;
    const shake = S ? `<dt>${esc(t("Shaking estimate (USGS ShakeMap)"))}</dt><dd>` +
      `<p>${esc(t("USGS ShakeMap of the {mag} earthquake ({id}), version {v} of {date}, status: {status}.", { mag: mg(S.shock.mag), id: S.shock.usgs_id, v: P.version, date: fmtDay(String(P.process_timestamp || "").slice(0, 10)), status: P.map_status === "automatic" ? t("automatic") : (P.map_status || "") }))} ` +
        `<a href="${esc(P.page)}" target="_blank" rel="noopener">USGS ↗</a></p><ul class="sci-obs">` +
      `<li>${esc(t("Estimates, not recordings: {n} felt reports (“Did You Feel It?”) and {s} seismic stations, with ground-motion models.", { n: I.fmt.num(P.intensity_observations, 0), s: I.fmt.num(P.seismic_stations, 0) }))}</li>` +
      `<li>${esc(gap != null ? t("The {m1} shock came {s} seconds before the {m2}; felt reports cannot separate the two, so this map may include shaking from both.", { m1: mg(sk[0].mag), m2: mg(sk[1].mag), s: gap }) : (S.limits || [])[1] || "")}</li>` +
      `<li>${esc(t("The ground (Vs30) is ShakeMap's estimate for the top 30 m from the slope of the land, not a measurement at the site. No extra soil factor is applied: the values already include the ground."))}</li>` +
      `<li>${esc(t("The map status is automatic (version {v}); USGS may still revise it.", { v: P.version }))}</li>` +
      `<li>${esc(t("The buildings are illustrative: no damage share and no safe or unsafe verdict."))}</li></ul>` +
      `<ul class="sci-obs">` + S.regions.map((r) => `<li><b>${esc(r.name)}</b> · MMI ${esc(I.fmt.num(r.mmi, 1))} · PGA ${esc(I.fmt.num(r.pga_pct_g, 1))} %g · PGV ${esc(I.fmt.num(r.pgv_cm_s, 1))} cm/s</li>`).join("") + `</ul></dd>` : "";
    box.innerHTML = `<dl class="sci-facts"><dt>${esc(t("Data status"))}</dt><dd>${esc(T.maturity.text)}</dd>` + shocks + raster + dmg + shake + linked + `</dl>`;
  }
  // ---------------------------------------------------------------------------------------------------------------
  // v60: "Data and science", right under the map. Every number comes from the event's own files (layers.json, timeline.json);
  // a value the project does not have is named as missing, never computed here.
  const doiOf = (m) => (m === "BETA" ? "10.5067/NIL2GCOV-B1" : "10.5067/NIL2GCOV-P1");
  // v63: what the Timeline stages are made of: event period with sources, and for each stage the capture or why there is none
  function stageFacts() {
    if (!stages) return "";
    const sg = I.tx(stages), pc = (x) => I.fmt.pct(x, 0);
    const per = `<p>${esc(sg.period.summary)}</p><ul class="sci-obs">` + sg.period.sources.map((x) =>
      `<li>${x.date ? `<b>${esc(fmtDay(x.date))}</b> · ` : ""}<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.publisher)}</a>: ${esc(x.says)}</li>`).join("") + `</ul>`;
    const det = (f) => (f.catalog ? `<span class="sci-cat">${esc(t("Catalogue: {catalog}", { catalog: f.catalog }))} · ${esc(t("Product: {id}", { id: f.product_id || f.scene }))} · ` +
      `<a href="${esc(f.link || f.stac || f.url)}" target="_blank" rel="noopener">${esc(t("source"))} ↗</a></span> ` : "");
    const rows = sg.stages.concat(sg.extra || []).map((x, i) => `<li><b>${i + 1}. ${esc(x.title)}</b>: ` + (x.frame ? det(x.frame) : "") + (x.frame && x.frame.kind === "figure"
      ? `${esc(fmtDay(x.frame.label))} · ${esc(x.frame.location)} · ${esc(x.frame.credit)}, ${esc(x.frame.licence)} · <a href="${esc(x.frame.url)}" target="_blank" rel="noopener">${esc(x.frame.publisher)}</a>. ${esc(x.frame.why)}`
      : x.frame && x.frame.kind === "map"
      ? `${esc(fmtDay(x.frame.label))} · ${esc(x.frame.location)} · ${x.frame.sources.map((q) => `<a href="${esc(q.url)}" target="_blank" rel="noopener">${esc(q.publisher)}</a>`).join(", ")}. ${esc(x.frame.why)} ${esc(x.frame.note)}`
      : x.frame
      ? `${esc(fmtUtc(x.frame.datetime_utc))} · <a href="${esc(x.frame.stac)}" target="_blank" rel="noopener">${esc(x.frame.scene)}</a> · ` +
        `${esc(!x.frame.inside_study_area ? t("{p} cloud in the whole scene", { p: pc((x.frame.scene_cloud_cover || 0) / 100) }) // v69: Landsat frame (scene cloud cover only)
          : lite() ? t("{p} clear inside the image", { p: pc(x.frame.inside_study_area.clear_share) }) : t("{p} clear inside the study area", { p: pc(x.frame.inside_study_area.clear_share) }))} · ${esc(lite() ? t("covers the whole image") : t("covers the whole study area"))} · 10 m. ${esc(x.frame.why)}`
      : `${esc(t("No clear satellite image was found for this stage."))} ${esc(x.missing)}`) + `</li>`).join("");
    return `<dt>${esc(t("Event period (sources)"))}</dt><dd>${per}</dd>` +
      `<dt>${esc(t("Timeline stages"))}</dt><dd><ul class="sci-obs sci-stages">${rows}</ul><p class="sci-note">${esc(sg.searched)}. ${esc(sg.rule)}</p>` +
      (sg.extra_note ? `<p class="sci-note">${esc(sg.extra_note)}</p>` : "") + `</dd>`;
  }
  // v66: evidence score from the event record (25 points per criterion); "Assessment incomplete" when information is missing
  function scoreTotal(sc) {
    if (!sc || !sc.criteria || sc.criteria.length !== 4 || sc.criteria.some((c) => c.points == null)) return null;
    return sc.criteria.reduce((a, c) => a + c.points, 0);
  }
  function scoreLine(sc) {
    const tot = scoreTotal(sc);
    return tot == null ? t("Evidence score: assessment incomplete.") : t("Evidence score: {n} / 100 — how well the evidence supports the finding; not a map accuracy percentage.", { n: tot });
  }
  function scoreBlock(sc) {
    if (!sc) return `<dt>${esc(t("Evidence score"))}</dt><dd>${esc(t("Assessment incomplete"))}</dd>`;
    const x = I.tx(sc);
    return `<dt>${esc(t("Evidence score"))}</dt><dd id="sci-score"><p><b>${esc(scoreLine(sc))}</b></p><ul class="sci-obs">` +
      x.criteria.map((c) => `<li><b>${esc(c.name)}: ${c.points == null ? esc(t("Assessment incomplete")) : `${c.points} / ${c.max}`}</b> — ${esc(c.reason)} <span class="sci-note">${esc(c.rule)}</span></li>`).join("") +
      `</ul><p class="sci-note">${esc(t("Each criterion gives up to 25 points (25 / 15 / 5 / 0). Sources:"))} ` +
      x.sources.map((q) => `<a href="${esc(q.url)}" target="_blank" rel="noopener">${esc(q.publisher)}</a>`).join(" · ") + `</p></dd>`;
  }
  function renderScienceLite(box) {
    const ev = evidence ? I.tx(evidence) : null, op = optical ? I.tx(optical) : null, pc = (x) => I.fmt.pct(x, 0);
    const ms = ev && ev.measurement, f1 = (x) => I.fmt.num(x, 1);
    const nf = (x, k = 1) => I.fmt.num(x, k);
    // v69: wildfire evidence: the official perimeter, the incident record's total and the VIIRS detections, each with its source and version
    const fire = ev && ev.layers ? `<dt>${esc(t("Mapped fire perimeter"))}</dt><dd id="sci-fire">` +
        `<p>${esc(t("{source}, version of {date}, mapped by {method}: {acres} GIS acres. Measured here on the same outline: {km2} km² (geodesic, WGS84); {islands} unburned islands are cut out; the whole perimeter lies inside the map.", {
          source: ms.perimeter_source, date: fmtDay(ms.perimeter_version), method: ms.perimeter_map_method, acres: nf(ms.perimeter_gis_acres, 0), km2: nf(ms.perimeter_km2, 2), islands: ms.perimeter_islands }))}
        <a href="${esc(ms.perimeter_url)}" target="_blank" rel="noopener">NIFC WFIGS ↗</a></p></dd>` +
      `<dt>${esc(ms.total_label)}</dt><dd><p>${esc(t("{acres} acres, about {km2} km². This is the number in the incident record, not a measurement of the map.", { acres: nf(ms.total_acres, 0), km2: nf(ms.total_km2) }))}
        <a href="${esc(ms.record_url)}" target="_blank" rel="noopener">CAL FIRE ↗</a></p></dd>` +
      `<dt>${esc(t("Active fire detections"))}</dt><dd><p>${esc(t("{n} detections kept ({snpp} S-NPP, {noaa} NOAA-20), {from} – {to}. {archive}.", {
          n: nf(ms.firms_counts.kept, 0), snpp: nf(ms.firms_by_satellite["S-NPP"], 0), noaa: nf(ms.firms_by_satellite["NOAA-20"], 0), from: fmtDay(ms.firms_days[0]), to: fmtDay(ms.firms_days[1]), archive: ms.firms_archive }))}</p>
        <p>${esc(ms.firms_rule)} ${esc(t("Left out: {before} before the start, {far} farther than 375 m from the perimeter.", { before: nf(ms.firms_counts.before_start, 0), far: nf(ms.firms_counts.farther, 0) }))}
        <a href="${esc(ms.firms_url)}" target="_blank" rel="noopener">NASA FIRMS ↗</a></p></dd>` +
      (op && op.variants && op.variants.swir ? `<dt>${esc(op.variants.swir.label)}</dt><dd><p>${esc(op.variants.swir.data_type)}: ${esc(op.variants.swir.pair[0].bands)}; ${esc(op.variants.swir.pair[0].stretch)}. ${esc(op.variants.swir.note)}</p></dd>` : "") : "";
    box.innerHTML = `<dl class="sci-facts">` +
      `<dt>${esc(t("Data status"))}</dt><dd>${esc(T.maturity.text)}</dd>` + fire +
      (ms && !(ev && ev.layers) ? `<dt>${esc(t("UNOSAT impact data"))}</dt><dd id="sci-unosat">` +
        `<p>${esc(t("Data of {version}, published {published}: {b} km² analysed, {a} km² affected (UNOSAT's values). Imagery: {imagery}.", { version: fmtDay(ms.version), published: fmtDay(ms.published), b: f1(ms.analysed_km2), a: f1(ms.affected_km2), imagery: ms.imagery }))}</p>` +
        `<p>${esc(t("Check: the same polygons measured here give {b} km² and {a} km²; all of the affected area lies inside the analysed area.", { b: f1(ms.check.analysed_km2), a: f1(ms.check.affected_km2) }))}</p>` +
        `<p>${esc(ms.scope)}</p><p><b>${esc(ms.status)}</b></p>` +
        `<p class="sci-note">${esc(ms.source)} · ${esc(t("Licence: {licence}.", { licence: ms.licence }))} ` +
        `<a href="${esc(ms.data_url)}" target="_blank" rel="noopener">${esc(t("UNOSAT data on HDX"))} ↗</a> · <a href="${esc(ms.source_url)}" target="_blank" rel="noopener">${esc(t("Geodatabase"))} ↗</a></p></dd>` +
        `<dt>${esc(t("Earlier version"))}</dt><dd><ul class="sci-obs">` + ev.history.map((h) => `<li><b>${esc(fmtDay(h.version))}</b> · ${esc(h.what)} <a href="${esc(h.url)}" target="_blank" rel="noopener">↗</a></li>`).join("") + `</ul></dd>` +
        scoreBlock(evidence.score) : "") +
      (op ? `<dt>${esc(t("True-colour images"))}</dt><dd><ul class="sci-obs">` + op.pair.map((o) => `<li><b>${esc(fmtDay(o.label))}</b> · Sentinel-${esc((o.platform || "").slice(9).toUpperCase())} · ` +
        `${esc(t("{p} clear inside the image", { p: pc(o.inside_study_area.clear_share) }))} · <a href="${esc(o.stac)}" target="_blank" rel="noopener">${esc(o.scene)}</a></li>`).join("") + `</ul>` +
        `<p class="sci-note">${esc(hazardNow() === "wildfire" ? t("Copernicus Sentinel-2 L2A, 10 m, the same frame for every image. Checked: {checked}.", { checked: op.checked })
          : t("Copernicus Sentinel-2 L2A, 10 m, the same frame as the Copernicus image of the day. Checked: {checked}.", { checked: op.checked }))}</p></dd>` : "") +
      stageFacts() +
      (ev ? `<dt>${esc(t("Sources"))}</dt><dd><ul class="sci-links">` + ev.sources.map((q) => `<li><a href="${esc(q.url)}" target="_blank" rel="noopener">${esc(q.publisher)}</a></li>`).join("") + `</ul></dd>` : "") +
      `</dl>`;
  }
  // v76: "Data and sources" starts with the area the analysis covers (the second part of the event summary, when there is one)
  function renderScience() {
    renderScienceBody();
    const box = $("science-body");
    if (!box || $("science").hidden || isQuake()) return;
    const rest = splitLede(T.event.lede || "")[1];
    if (rest) box.insertAdjacentHTML("afterbegin", `<p class="sci-area">${esc(rest)}</p>`);
  }
  function renderScienceBody() {
    const sec = $("science"), box = $("science-body");
    if (!sec || !box) return;
    sec.hidden = !(meta && T && state.ui === "simple");
    $("science-h").textContent = t("Data and sources"); // v76: one name for the technical details of every event
    if (sec.hidden) return;
    if (lite()) { isQuake() ? renderScienceQuake(box) : renderScienceLite(box); return; }
    const tl0 = timeline || { frames: [] }, tl = { ...tl0, frames: tl0.frames.filter((x) => x.kind !== "optical") };
    const ed = I.tx(tl.event_dates || null), pair = simplePair(), op = optical ? I.tx(optical) : null;
    const f = (x, k = 2) => I.fmt.num(x, k), pc = (x) => I.fmt.pct(x, 2);
    // dates: observations (what NISAR saw) and the event itself (what a cited source says), kept apart
    const obs = tl.frames.map((x) => `<li${pair.includes(x.label) ? ' class="sc-pairdate"' : ""}><b>${esc(fmtDay(x.label))}</b> · ${esc(x.maturity)}` +
      (pair.includes(x.label) ? ` · ${esc(t("analysed pair"))}` : "") + `</li>`).join("");
    const evStart = ed && ed.start
      ? `${esc(fmtDay(ed.start))} — ${esc(ed.start_what)} (<a href="${esc(ed.start_url)}" target="_blank" rel="noopener">${esc(ed.start_source)}</a>)`
      : esc(t("Not available in the sources used."));
    const evEnd = ed && ed.end ? esc(fmtDay(ed.end)) : esc(t("Not available in the sources used."));
    // one readable chart per event, from the stored values only
    let chart = "", summary = "";
    const gs = meta.candidate_geometric_size, sc = meta.signal_classes;
    if (gs) {
      const v = gs.nisar_candidate_km2, [lo, hi] = gs.nisar_candidate_km2_range_over_sensitivity, max = Math.ceil(hi + 0.5), x = (k) => (k / max * 100).toFixed(2);
      summary = t("The experimental NISAR candidate marks about {a} km² of possible water inside the {b} km² view, from the change between {from} and {to}. It is not a validated flood area and not an increase in water between two dates.",
        { a: f(v), b: f(gs.trial_aoi_valid_km2, 1), from: fmtDay(pair[0]), to: fmtDay(pair[1]) });
      chart = `<figure class="chart" id="sci-chart"><figcaption>${esc(t("Possible-water candidate (km²)"))}</figcaption>` +
        `<div class="ch-range" role="img" aria-label="${esc(t("Candidate {a} km²; {lo}–{hi} km² when other thresholds are tried", { a: f(v), lo: f(lo), hi: f(hi) }))}">` +
        `<span class="ch-band" style="left:${x(lo)}%;width:${(x(hi) - x(lo)).toFixed(2)}%"></span><span class="ch-dot" style="left:${x(v)}%"></span></div>` +
        `<div class="ch-axis">${[0, Math.round(max / 2), max].map((k) => `<span style="left:${x(k)}%">${esc(f(k, 0))}</span>`).join("")}</div>` +
        `<ul class="ch-key"><li><i class="k-dot"></i>${esc(t("Candidate: {a} km²", { a: f(v) }))}</li>` +
        `<li><i class="k-band"></i>${esc(t("Results with other thresholds: {lo}–{hi} km²", { lo: f(lo), hi: f(hi) }))}</li></ul></figure>`;
    } else if (sc && meta.study_area) {
      const dec = sc.classes.decrease.share_of_valid, inc = sc.classes.increase.share_of_valid, rest = Math.max(0, 1 - dec - inc);
      summary = t("Across the {a} km² study area, the radar signal got weaker on {dec} and stronger on {inc} of the area between {from} and {to} (change of more than 3 dB). These are shares of radar change, not of water or damage.",
        { a: f(meta.study_area.area_km2), dec: pc(dec), inc: pc(inc), from: fmtDay(sc.pair[0]), to: fmtDay(sc.pair[1]) });
      chart = `<figure class="chart" id="sci-chart"><figcaption>${esc(t("Radar signal change, share of the study area ({from} → {to})", { from: fmtShort(sc.pair[0]), to: fmtShort(sc.pair[1], true) }))}</figcaption>` +
        `<div class="ch-stack" role="img" aria-label="${esc(t("Weaker signal {dec}, stronger signal {inc}, smaller change {rest}", { dec: pc(dec), inc: pc(inc), rest: pc(rest) }))}">` +
        `<span style="width:${(dec * 100).toFixed(2)}%;background:#2166ac"></span><span style="width:${(inc * 100).toFixed(2)}%;background:#b2182b"></span><span style="width:${(rest * 100).toFixed(2)}%;background:#9aa3ad"></span></div>` +
        `<ul class="ch-key"><li><i style="background:#2166ac"></i>${esc(t("Radar signal weaker: {p}", { p: pc(dec) }))}</li>` +
        `<li><i style="background:#b2182b"></i>${esc(t("Radar signal stronger: {p}", { p: pc(inc) }))}</li>` +
        `<li><i style="background:#9aa3ad"></i>${esc(t("Change smaller than 3 dB: {p}", { p: pc(rest) }))}</li></ul>` +
        `<p class="ch-note">${esc(t("Measured: change of the radar signal. Not measured: water area or damage."))}</p></figure>`;
    }
    const srcs = (meta.sources || []).filter((x) => x.url && !/terms|koşul/i.test(x.kind || "")).map((x) => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.publisher)}</a></li>`).join("");
    const sv = T.simple, mb = (mode, label) => `<button type="button" class="btn sci-mode" data-mode="${mode}" aria-pressed="${state.mapMode === mode}">${esc(label)}</button>`;
    const optRow = (o) => `<li><b>${esc(fmtDay(o.label))}</b> · ${esc(o.platform ? `Sentinel-${o.platform.slice(9).toUpperCase()}` : "Sentinel-2")} · ` +
      `${esc(t("{p} clear inside the study area", { p: pc(o.inside_study_area.clear_share) }))} · <a href="${esc(o.stac)}" target="_blank" rel="noopener">${esc(o.scene)}</a></li>`;
    box.innerHTML = `<div class="sci-layers" role="group" aria-labelledby="sci-layers-h"><h3 id="sci-layers-h">${esc(t("Map layers"))}</h3>` +
      mb("analysis", t("Analysis layer on the map")) + mb("radar", t("Radar images before / after")) + mb("radartl", t("Radar images one at a time")) +
      (sv.focus || []).filter((x) => meta.regions.some((r) => r.id === x.region)).map((x) => `<button type="button" class="btn sc-focus" data-region="${esc(x.region)}">${esc(x.label)}</button>`).join("") +
      `</div>` +
      `<p class="sci-sum">${esc(summary)}</p>` + chart +
      `<dl class="sci-facts">` +
      `<dt>${esc(t("NISAR observations"))}</dt><dd><ul class="sci-obs">${obs}</ul></dd>` +
      stageFacts() +
      `<dt>${esc(t("True-colour images"))}</dt><dd>` + (op ? `<ul class="sci-obs">${op.pair.map(optRow).join("")}</ul>` +
        `<p class="sci-note">${esc(t("Copernicus Sentinel-2 L2A, 10 m, placed on the same map grid as the radar images. Checked: {checked}.", { checked: op.checked }))}</p>` +
        `<p class="sci-note">${esc(t("Checked first: {wayback}.", { wayback: op.esri_wayback }))}</p>`
        : esc(t("No pair of dated, cloud-free satellite images of this area was found for the flood."))) + `</dd>` +
      `<dt>${esc(t("Event start (source)"))}</dt><dd>${evStart}</dd>` +
      `<dt>${esc(t("Event end (source)"))}</dt><dd>${evEnd}</dd>` +
      `<dt>${esc(t("Water area before and after"))}</dt><dd>${esc(t("Not measured: there is no water map for either date, so no before–after water area is given."))}</dd>` +
      `<dt>${esc(t("Product status"))}</dt><dd><b>${esc(meta.maturity)}</b> — ${esc(T.maturity.text)}</dd></dl>` +
      `<button type="button" class="btn btn-primary sci-help" aria-expanded="${!!state.helperOpen}" aria-controls="helper">${esc(t("What does this map show?"))}</button>` +
      `<div id="helper" class="helper" ${state.helperOpen ? "" : "hidden"}></div>` +
      `<details class="sci-guide"><summary>${esc(t("How NISAR sees a flood"))}</summary>` +
      `<p>${esc(t("NISAR sends its own microwave (radar) pulses and measures the echo, so it sees the ground through clouds and at night. Its L-band radar has a 24 cm wavelength."))}</p>` +
      `<p>${esc(t("Calm open water reflects the pulse away like a mirror, so it looks dark. When the echo of a place gets weaker between two dates, water may have appeared there; a stronger echo can come from water among buildings or trees, wetter ground or changes in the image itself."))}</p>` +
      `<p>${esc(t("On its own, a signal change cannot confirm a flood, its depth, its exact edge or any damage. Other observations and reports are needed for that."))}</p>` +
      `<ul class="sci-links"><li><a href="https://science.nasa.gov/mission/nisar/" target="_blank" rel="noopener">${esc(t("NASA: NISAR mission"))}</a></li>` +
      `<li><a href="https://nisar.jpl.nasa.gov/" target="_blank" rel="noopener">${esc(t("NASA JPL: NISAR"))}</a></li>` +
      `<li><a href="https://doi.org/${doiOf(meta.maturity)}" target="_blank" rel="noopener">${esc(t("NISAR L2 GCOV data at ASF DAAC ({maturity})", { maturity: meta.maturity }))}</a></li>` + srcs + `</ul></details>`;
    box.querySelector(".sci-help").addEventListener("click", () => { state.helperOpen = !state.helperOpen; renderScience(); box.querySelector(".sci-help").focus(); });
    box.querySelectorAll(".sci-mode").forEach((x) => x.addEventListener("click", () => {
      setMapMode(x.dataset.mode);
      if (narrow.matches) document.querySelector(".map-col").scrollIntoView({ block: "start" });
      const y = box.querySelector(`.sci-mode[data-mode="${x.dataset.mode}"]`); if (y && !narrow.matches) y.focus();
    }));
    box.querySelectorAll(".sc-focus").forEach((b) => b.addEventListener("click", () => focusRegion(b.dataset.region)));
    if (state.helperOpen) renderHelper();
  }
  // Map helper: ready answers with their sources, for the open event, map mode, date and layer. No free chat, no external service.
  function helperAnswer(q) {
    const sv = T.simple, a = simpleActive(), pair = simplePair(), gs = meta.candidate_geometric_size, sc = meta.signal_classes;
    const tlf = state.mapMode === "radartl" && timeline ? timeline.frames[state.tl] : null;
    const src = t("Source: this project's layers from NISAR L2 GCOV ({maturity}).", { maturity: meta.maturity });
    const f = (x, k = 2) => I.fmt.num(x, k), pc = (x) => I.fmt.pct(x, 2);
    const v = { from: fmtDay(pair[0]), to: fmtDay(pair[1]) };
    const stg = stageShown();
    if (stg && q !== "area") {
      const x = I.tx(stg);
      if (!x.frame) return { text: t("No clear satellite image was found for this stage."), src: x.missing, act: "radar", actLabel: t("Compare the radar images") };
      const src2 = t("Source: Copernicus Sentinel-2 L2A, {date}.", { date: fmtDay(x.frame.label) });
      return q === "blue"
        ? { text: t("This is a true-colour satellite image, so there is no blue analysis layer here: water looks brown or dark as in a photo."), src: src2, act: "layer", actLabel: t("Show the analysis layer") }
        : { text: x.frame.sentence, src: src2, act: "radar", actLabel: t("Compare the radar images") };
    }
    if (state.mapMode === "optical" && optical && q !== "area") {
      const op = I.tx(optical);
      return q === "blue"
        ? { text: t("These are true-colour satellite images, so there is no blue analysis layer here: water looks brown or dark as in a photo. The blue analysis layer is under Data and science."), src: t("Source: Copernicus Sentinel-2 L2A, {before} and {after}.", { before: fmtDay(op.pair[0].label), after: fmtDay(op.pair[1].label) }), act: "layer", actLabel: t("Show the analysis layer") }
        : { text: op.change, src: t("Source: Copernicus Sentinel-2 L2A, {before} and {after}.", { before: fmtDay(op.pair[0].label), after: fmtDay(op.pair[1].label) }), act: "radar", actLabel: t("Compare the radar images") };
    }
    if (q === "blue") {
      if (tlf) return { text: t("In the timeline no analysis layer is drawn, so there is no blue: you see the grey radar image of {date}. Dark grey means a weak echo, which smooth ground or open water can give.", { date: fmtDay(tlf.label) }), src, act: "layer", actLabel: t("Show the analysis layer") };
      if (gs) return a.on ? { text: t("Blue marks possible water: places where the NISAR signal dropped between {from} and {to} and stayed low (an experimental rule). Flooding is not confirmed.", v), src, act: "layer", actLabel: t("Show this layer") }
        : { text: t("The blue possible-water layer is switched off now.", v), src, act: "layer", actLabel: t("Show this layer") };
      if (sc) return state.simpleClass === "decrease" ? { text: t("Blue marks places where the radar signal got weaker by more than 3 dB between {from} and {to}. It is a change in the radar signal, not mapped floodwater.", v), src, act: "layer", actLabel: t("Show this layer") }
        : { text: t("Blue (weaker radar signal) is not shown now. Blue marks places where the radar signal got weaker by more than 3 dB between {from} and {to}.", v), src, act: "layer", actLabel: t("Show the blue layer") };
    }
    if (q === "change") {
      if (gs) return { text: t("The left side of the divider shows the radar on {from}, the right side on {to}. Where the right side is darker, less signal came back on {to}; where it also stayed low, the experimental rule marks possible water ({a} km²).", { ...v, a: f(gs.nisar_candidate_km2) }), src, act: "radar", actLabel: t("Compare the radar images") };
      if (sc) return { text: t("Between {from} and {to} the radar signal got weaker on {dec} of the study area and stronger on {inc}. Much of the increase over the town matches a brightening of the whole image on {to}, so it may not be a local change.", { ...v, dec: pc(sc.classes.decrease.share_of_valid), inc: pc(sc.classes.increase.share_of_valid) }), src, act: "chart", actLabel: t("See the chart") };
    }
    if (q === "area") {
      if (gs) return { text: t("The view is the 5 × 5 km study area ({b} km² of valid data). Inside it, the possible-water candidate covers {a} km² ({lo}–{hi} km² with other thresholds). It is not a validated flood area.", { a: f(gs.nisar_candidate_km2), b: f(gs.trial_aoi_valid_km2, 1), lo: f(gs.nisar_candidate_km2_range_over_sensitivity[0]), hi: f(gs.nisar_candidate_km2_range_over_sensitivity[1]) }), src, act: "chart", actLabel: t("See the chart") };
      if (meta.study_area) {
        const P = Object.fromEntries(meta.study_area.parts.map((x) => [x.name, x.area_km2]));
        return { text: t("The study area is {a} km²: the town's administrative unit ({c} km²), the built-up area next to it ({u} km²) and the Limpopo surroundings ({l} km²).", { a: f(meta.study_area.area_km2), c: f(P.city_adm3), u: f(P.urban_contiguous_osm), l: f(P.limpopo_corridor) }), src, act: "chart", actLabel: t("See the chart") };
      }
    }
    return { text: t("Not available in the sources used."), src, act: null };
  }
  function renderHelper() {
    const h = $("helper");
    if (!h) return;
    const qs = [["blue", t("What does blue mean?")], ["change", t("What changed between the two dates?")], ["area", t("How many km² is the area shown?")]];
    const ans = state.helperQ ? helperAnswer(state.helperQ) : null;
    h.innerHTML = `<div class="hp-qs" role="group" aria-label="${esc(t("Questions"))}">` +
      qs.map(([k, l]) => `<button type="button" class="btn hp-q" data-q="${k}" aria-pressed="${state.helperQ === k}">${esc(l)}</button>`).join("") + `</div>` +
      (ans ? `<div class="hp-a" aria-live="polite"><p>${esc(ans.text)}</p><p class="hp-src">${esc(ans.src)}</p>` +
        (ans.act ? `<button type="button" class="btn hp-act" data-act="${ans.act}">${esc(ans.actLabel)}</button>` : "") + `</div>` : "");
    h.querySelectorAll(".hp-q").forEach((b) => b.addEventListener("click", () => { state.helperQ = b.dataset.q; renderHelper(); h.querySelector(`.hp-q[data-q="${b.dataset.q}"]`).focus(); }));
    const act = h.querySelector(".hp-act");
    if (act) act.addEventListener("click", () => {
      const k = act.dataset.act;
      if (k === "chart") { const c = $("sci-chart"); if (c) { c.scrollIntoView({ block: "center" }); c.classList.add("flash"); setTimeout(() => c.classList.remove("flash"), 1200); } return; }
      if (k === "radar") setMapMode("radar");
      if (k === "layer") {
        if (state.mapMode !== "analysis") setMapMode("analysis");
        if (T.simple.classes) state.simpleClass = "decrease"; else state.simpleShow = true;
        applySimpleLayers(); renderSimpleBar(); render();
      }
      document.querySelector(".map-col").scrollIntoView({ block: "start" });
      renderHelper();
    });
  }
  // Card after the map (Simple view): what to do next. The explanation itself is in the block above the map.
  // Events that have data/<event>/follow_water.json. v57: the event is in the query (?event=), not only after #: a new query is always a new
  // page load and a new cache entry, so a scene of one event can never stay on screen (or come from an old cached page) under another event's link.
  // v71: no event list in the code. An event has a 3D scene when its events.json entry carries "scene3d" (written by the build when
  // data/<event>/follow_water.json exists), so a new event needs only its catalog record.
  const followHref = (id) => { const e = index && index.events.find((x) => x.id === id); return e && e.scene3d ? `follow.html?event=${encodeURIComponent(id)}&v=71` : null; };
  // The scene ends on the satellite layer at this map's own framing of the study area: pass the zoom fitBounds gives here (Leaflet zoom),
  // so the last frame of the scene shows the same centre at the same scale as this map.
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a.sc-follow");
    if (!a || !viewBounds) return;
    try {
      const z = Math.floor(map.getBoundsZoom(viewBounds, false, L.point(24, 24)) / 0.25) * 0.25;
      const u = new URL(a.getAttribute("href"), location.href);
      u.searchParams.set("mz", String(z));
      u.searchParams.set("lang", I.lang); // the scene opens in the same language (also without browser storage)
      a.setAttribute("href", u.pathname.split("/").pop() + u.search);
    } catch (err) { /* keep the plain link */ }
  }, true);
  function renderSimpleCard() {
    const sv = T.simple, box = $("simple-card");
    box.hidden = state.ui !== "simple" || isQuake(); // v73: no event images for an earthquake (nothing to show in the card)
    renderSimpleBar();
    box.innerHTML = `<h2 id="simple-title" class="vh">${esc(t("Event images"))}</h2><div id="sc-media" class="sc-media"></div>`;
    renderSimpleMedia(meta.event_id);
  }
  // "Look closer" (Data and science): outline an area to inspect and zoom there
  function focusRegion(region) {
    const sv = T.simple;
    {
      const f = sv.focus.find((x) => x.region === region), reg = meta.regions.find((r) => r.id === f.region);
      const ring = reg.corners_lonlat.map(([lo, la]) => [la, lo]);
      focusGroup.clearLayers(); // outline only: an area to inspect, not a water or flood boundary
      focusGroup.addLayer(L.polygon(ring, { pane: "regions", color: "#ff9800", weight: 2.5, fill: false, interactive: false }));
      focusGroup.addLayer(L.marker(L.latLngBounds(ring).getNorthWest(), { pane: "regions", keyboard: false, interactive: false,
        icon: L.divIcon({ className: "place-label", html: `<span>${esc(f.note)}</span>`, iconSize: [0, 0] }) }));
      goTo(L.latLngBounds(ring).pad(1.5), { maxZoom: 16 });
      if (narrow.matches) document.querySelector(".map-col").scrollIntoView({ block: "start" });
    }
  }
  // v58: event images below the map (the same sourced images as in Follow the Water; nothing new is made here)
  const mediaCache = {};
  function renderSimpleMedia(id) {
    const box = $("sc-media");
    if (!box || !followHref(id)) return;
    const fill = (m0) => {
      const m = I.tx(m0);
      if (!m || !m.items || !m.items.length || !meta || meta.event_id !== id || !$("sc-media")) return;
      $("sc-media").innerHTML = `<h3 class="sm-h">${esc(t("Event images"))}</h3>` + m.items.map((it) => `<figure class="sm-fig">` +
        `<img src="data/${esc(id)}/${esc(it.file)}" width="${it.width}" height="${it.height}" alt="${esc(it.alt)}" loading="lazy" decoding="async">` +
        `<figcaption><b>${esc(it.title)}</b> · ${esc(it.place)}. ${esc(it.what_it_shows)} ` +
        t("Source: {source}.", { source: it.source_url ? `<a href="${esc(it.source_url)}" rel="noopener">${esc(it.source)}</a>` : esc(it.source) }) + `</figcaption></figure>`).join("") +
        (m.links || []).map((l) => `<p class="sm-link"><a href="${esc(l.url)}" rel="noopener">${esc(l.text)}</a> ${esc(l.note)}</p>`).join("");
    };
    if (mediaCache[id]) return fill(mediaCache[id]);
    fetch(`data/${id}/follow_water.json`).then((r) => (r.ok ? r.json() : null)).then((d) => { mediaCache[id] = d && d.media; fill(mediaCache[id]); }).catch(() => {});
  }
  $("to-simple").addEventListener("click", () => { enterSimple(); $("simple-card").querySelector("button")?.focus({ preventScroll: true }); });

  function writeHash() {
    if (meta) history.replaceState(null, "", `#event=${meta.event_id}&view=${state.view}`);
  }
  function setView(v) {
    if (v === state.view) return;
    state.view = v; // map position, zoom, event and date pair are left as they are
    render();
  }
  document.querySelectorAll('#view-switch button').forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  $("show-evidence").addEventListener("change", (e) => { state.evidence[state.view] = e.target.checked; render(); });
  $("ev-opacity").addEventListener("input", (e) => {
    state.opacity[state.view] = Number(e.target.value) / 100;
    $("ev-opacity-val").textContent = `${e.target.value}%`;
    for (const p of ["before", "after"]) map.getPane(p).style.opacity = String(state.opacity[state.view]);
    renderMapLegend();
  });
  $("use-street").addEventListener("click", () => { state.satFallback = true; render(); });
  $("cand-opacity").addEventListener("input", (e) => {
    state.candOpacity = Number(e.target.value) / 100; // display only; the candidate raster and classes are unchanged
    $("cand-opacity-val").textContent = `${e.target.value}%`;
    for (const sp of meta.support) if (overlays[sp.id] && !isIndep(sp)) overlays[sp.id].setOpacity(state.candOpacity);
    renderMapLegend();
  });

  // --- The single before–after control on the map (drag + keyboard)
  // v62/v66: the divider belongs to the compared images and to the visible map. state.swipe is its position across the
  // visible map (0…1): when the map is panned or pinch-zoomed the line stays at the same place on screen (35 % stays 35 %)
  // and both images move together under it. The line, handle and drag strip are drawn only over the rectangle where the two
  // images are on screen (their common extent, cut to the visible map); when that place has no image, the divider waits
  // there hidden. Dragging keeps the line on the images. Measured again on every move, zoom, resize and layout change.
  const wrap = document.querySelector(".map-wrap");
  const divider = $("divider");
  function splitRect() {
    const bb = opticalShown() ? pairBounds() : bounds;
    if (!bb) return null;
    const size = map.getSize();
    const a = map.latLngToContainerPoint(bb.getNorthWest()), b = map.latLngToContainerPoint(bb.getSouthEast());
    const l = Math.max(0, a.x), r = Math.min(size.x, b.x), t = Math.max(0, a.y), btm = Math.min(size.y, b.y);
    return r - l >= 24 && btm - t >= 24 ? { l, r, t, b: btm, w: r - l, h: btm - t } : null;
  }
  function placeTags(r) {
    const lb = $("label-before").style, la = $("label-after").style;
    if (!r) { lb.left = lb.top = la.right = la.top = ""; return; }
    // v74: an image pair narrower than the map (earthquake: La Guaira strip): the dates sit just above it when there is room, so they do not cover it
    const above = opticalShown() && optical && optical.quake && r.t >= 88;
    const W = map.getSize().x, top = `${above ? r.t - 32 : Math.max(r.t + 8, document.body.classList.contains("area-switch-on") ? 94 : 52)}px`, minLeft = narrow.matches ? 50 : 56;
    lb.left = `${Math.max(r.l + 8, minLeft)}px`; lb.top = top;
    la.right = `${Math.max(W - r.r + 8, 10)}px`; la.top = top;
  }
  function clip() {
    const size = map.getSize();
    const nw = map.containerPointToLayerPoint([0, 0]);
    const se = map.containerPointToLayerPoint(size);
    const r = splitRect(), single = state.swipe >= 1;
    let xc = size.x * state.swipe; // divider position in map pixels: a fixed share of the visible map
    // v87: when panning, a window resize or turning the phone moves the images so that this share falls outside them, the cut follows
    // into the images (one handle radius inside) instead of hiding the divider; line, cut and handle stay at one x. state.swipe is
    // kept, so the line returns to the reader's place when the images come back under it.
    if (r && !single) { const m = Math.min(20, r.w / 2); xc = Math.min(Math.max(xc, r.l + m), r.r - m); }
    const x = nw.x + xc;
    map.getPane("before").style.clip = `rect(${nw.y}px, ${x}px, ${se.y}px, ${nw.x}px)`;
    map.getPane("after").style.clip = `rect(${nw.y}px, ${se.x}px, ${se.y}px, ${x}px)`;
    map.getPane("pairAfter").style.clip = meta && candOneMap() ? "auto" : map.getPane("after").style.clip;
    const onImage = !!r; // v87: hidden only while no image is on screen at all
    divider.classList.toggle("off", !onImage);
    if (onImage) { // the 44 px drag strip and the round handle stay inside the images, also at both ends; the line marks the exact position
      const sw = Math.min(44, r.w), el = Math.min(Math.max(xc - sw / 2, r.l), r.r - sw);
      const hr = Math.min(20, sw / 2), hx = Math.min(Math.max(xc, r.l + hr), r.r - hr);
      divider.style.left = `${el}px`;
      divider.style.width = `${sw}px`;
      divider.style.top = `${r.t}px`;
      divider.style.height = `${r.h}px`;
      divider.style.setProperty("--lx", `${xc - el}px`);
      divider.style.setProperty("--hx", `${hx - el}px`);
      // v74: the round handle sits at the middle of the visible map (not of the image rectangle), so it does not glide up and down
      // while the map is panned or zoomed; it is only kept inside the images
      const hy = Math.min(Math.max(size.y / 2, r.t + 24), r.b - 24);
      divider.style.setProperty("--hy", `${hy - r.t}px`);
    }
    placeTags(r);
    const pct = Math.round(state.swipe * 100);
    divider.setAttribute("aria-valuenow", pct);
    divider.setAttribute("aria-valuetext", t("{p}% before, {q}% after", { p: pct, q: 100 - pct }));
  }
  const setSwipe = (v) => {
    const r = splitRect(), W = map.getSize().x;
    if (r && W) { const m = Math.min(20, r.w / 2); v = Math.min(Math.max(v, (r.l + m) / W), (r.r - m) / W); } // the line stays on the images (v87: one handle radius inside, as clip())
    state.swipe = Math.min(0.999, Math.max(0, v)); // 1 = single-date view; dragging never goes there
    divider.querySelector(".drag-hint")?.remove(); // hint is not needed after first use
    clip();
  };
  // Dragging starts only on the divider (which lies on the images); outside the images the line stops at their edge
  divider.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button > 0) return;
    const r0 = splitRect();
    if (!r0) return;
    divider.setPointerCapture(e.pointerId);
    divider.classList.add("dragging");
    // v74: a second finger means a pinch, not a comparison: the drag is cancelled and the line goes back to where this gesture began
    // (a first finger that happens to land on or near the handle must not move the line while the map is pinch-zoomed)
    const id = e.pointerId, start = state.swipe;
    const move = (ev) => {
      if (ev.pointerId !== id) return;
      setSwipe((ev.clientX - map.getContainer().getBoundingClientRect().left) / map.getSize().x);
    };
    const up = () => {
      divider.classList.remove("dragging");
      for (const [k, f] of [["pointermove", move], ["pointerup", up], ["pointercancel", up], ["lostpointercapture", up]]) divider.removeEventListener(k, f);
      window.removeEventListener("pointerdown", second, true);
      window.removeEventListener("touchstart", secondTouch, true);
    };
    const cancel = () => {
      up();
      try { divider.releasePointerCapture(id); } catch (err) { /* already released */ }
      if (state.swipe !== start) { state.swipe = start; clip(); }
    };
    const second = (ev) => { if (ev.pointerId !== id) cancel(); };
    const secondTouch = (ev) => { if (ev.touches && ev.touches.length > 1) cancel(); };
    window.addEventListener("pointerdown", second, true);
    window.addEventListener("touchstart", secondTouch, { capture: true, passive: true });
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", up);
    divider.addEventListener("pointercancel", up);
    divider.addEventListener("lostpointercapture", up);
    e.preventDefault();
    e.stopPropagation(); // the map does not pan while the divider is dragged
  });
  divider.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") setSwipe(state.swipe - step);
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") setSwipe(state.swipe + step);
    else if (e.key === "PageDown") setSwipe(state.swipe - 0.1);
    else if (e.key === "PageUp") setSwipe(state.swipe + 0.1);
    else if (e.key === "Home") setSwipe(0);   // left edge of the images
    else if (e.key === "End") setSwipe(1);    // right edge of the images
    else return;
    e.preventDefault();
  });
  map.on("move zoom resize viewreset", clip);
  // during an animated zoom the images scale smoothly; the divider waits and is placed again when the zoom ends
  map.on("zoomanim", () => divider.classList.add("zooming"));
  map.on("zoomend", () => { divider.classList.remove("zooming"); clip(); });
  window.addEventListener("resize", () => map.invalidateSize());
  if (window.ResizeObserver) new ResizeObserver(() => { map.invalidateSize(); clip(); }).observe(map.getContainer());

  // --- Small on-map legend (collapsible). Collapsed: active layer name + short colour key. Expanded: dates and notes.
  // The satellite view's "not necessarily from the event date" warning is shown here only (one place).
  function renderMapLegend() {
    if (!meta || !T) return;
    qPlaceLegend();
    $("map-legend").classList.toggle("q-legend", isQuake() && state.ui === "simple" && state.mapMode !== "optical");
    if (isQuake() && state.ui === "simple" && state.mapMode !== "optical") { renderQuakeLegend(); return; } // v73
    if (state.ui === "simple" && T.simple && T.simple.shows) {
      // v48: short key (same active state as the block above the map); the context sits under "Map notes"
      const sv = T.simple, a = simpleActive(), sat = state.view === "satellite" && !state.satFallback;
      const radar = sv.classes && meta.signal_classes;
      const open = state.simpleLegendOpen === true; // short by default on every screen; the notes open on request
      const [pa, pb] = simplePair(), kn = sv.key_note && a.on ? sv.key_note[a.key] : "";
      const tlf = state.mapMode === "radartl" && timeline ? timeline.frames[state.tl] : null;
      // three kinds of picture, named apart: radar image (data), analysis layer (derived), background (context, not the flood date)
      const stg = stageShown();
      const stMap = stg && stg.frame && stg.frame.kind === "map";
      $("map-legend").classList.toggle("ml-hidden", !!stg && !stMap); // Timeline: date and source are on the image and in the caption under it
      if (stMap) { // outlines on an undated background map: what each outline is, and that the background is not from this date
        $("map-legend").classList.add("simple", "collapsed");
        $("map-legend").innerHTML = stg.frame.record
          ? `<div class="ml-simple"><i class="k-perim"></i><span>${esc(t("Official fire perimeter (NIFC, {date})", { date: fmtShort("2025-01-21", true) }))}</span></div><div class="ml-bg">${esc(t("Background map: not from this date."))}</div>`
          : `<div class="ml-simple"><i class="k-lake"></i><span>${esc(t("barrier lake"))}</span></div>` +
          `<div class="ml-simple"><i class="k-src"></i><span>${esc(t("collapse area"))}</span></div><div class="ml-bg">${esc(t("Background map: not from this date."))}</div>`;
        return;
      }
      if (stg) { $("map-legend").innerHTML = ""; return; }
      if (state.mapMode === "unosat" && evidence && evidence.layers) { // v69: one key line per layer that is on
        const ev = I.tx(evidence), off = state.evOff || {};
        $("map-legend").classList.add("simple", "collapsed");
        $("map-legend").innerHTML = ev.layers.filter((L_) => !off[L_.id]).map((L_) => `<div class="ml-simple"><i class="evk evk-${esc(L_.kind)}" style="--c:${esc(L_.color)}"></i><span>${esc(L_.legend)}</span></div>`).join("") ||
          `<div class="ml-simple"><span>${esc(t("All layers are switched off."))}</span></div>`;
        return;
      }
      if (state.mapMode === "unosat") {
        $("map-legend").classList.add("simple", "collapsed");
        $("map-legend").innerHTML = views && views.legend // v75: what the orange shows, then the analysed area's outline
          ? `<div class="ml-simple"><i style="background:rgba(255,140,26,.35);border:2px solid #ff8c1a"></i><span>${esc(t(views.legend))} · ${esc(t("UNOSAT, data of {date} (preliminary)", { date: fmtShort(evidence.measurement.version, true) }))}</span></div>` +
            (views.overview.coverage && views.overview.coverage.file ? `<div class="ml-simple"><i class="ml-cover"></i><span>${esc(t(views.overview.coverage.label))}</span></div>` : "")
          : `<div class="ml-simple"><i style="background:rgba(255,140,26,.35);border:2px solid #ff8c1a"></i><span>${esc(t("UNOSAT affected area · data of {date} (preliminary)", { date: fmtShort(evidence.measurement.version, true) }))}</span></div>`;
        return;
      }
      if (opticalShown()) { // true-colour pair: what each side is, where it comes from; no colour key (a photo-like image)
        const [ob, oa] = opticalPair();
        const open = state.simpleLegendOpen === true;
        $("map-legend").classList.add("simple");
        $("map-legend").classList.toggle("collapsed", !open);
        $("map-legend").innerHTML = (swirOn()
            ? `<div class="ml-simple"><i class="ml-photo ml-swir"></i><span>${esc(t("Short-wave infrared: left {before}, right {after}", { before: fmtShort(ob.label, true), after: fmtShort(oa.label, true) }))}</span></div>`
            : `<div class="ml-simple"><i class="ml-photo"></i><span>${esc(t("True colour: left {before}, right {after}", { before: fmtShort(ob.label, true), after: fmtShort(oa.label, true) }))}</span></div>`) +
          (open ? `<div class="ml-notes"><div class="ml-dates">${esc(swirOn() ? t("Copernicus Sentinel-2 · 20 m · false colour") : t("Copernicus Sentinel-2 · 10 m"))}</div>` +
            `<div class="ml-dates">${esc(swirOn() ? t("Each image pixel is 20 m on the ground; the map stops zooming before the pixels are enlarged into blur.") : t("Each image pixel is 10 m on the ground; the map stops zooming before the pixels are enlarged into blur."))}</div>` +
            `<div class="ml-bg">${esc(t("Outside the images: background map, not from these dates."))}</div></div>` : "") +
          `<button type="button" class="ml-more" aria-expanded="${open}">${esc(open ? t("Hide map notes ▴") : t("Map notes ▾"))}</button>`;
        $("map-legend").querySelector(".ml-more").addEventListener("click", () => {
          state.simpleLegendOpen = !open; renderMapLegend(); $("map-legend").querySelector(".ml-more").focus();
        });
        return;
      }
      const radarKey = tlf && tlf.kind === "optical"
        ? `<div class="ml-simple"><i class="ml-photo"></i><span>${esc(t("True colour: {date} · Sentinel-2", { date: fmtShort(tlf.label, true) }))}</span></div>`
        : tlf ? `<div class="ml-simple"><i class="ml-radar"></i><span>${esc(t("Radar image: {date}", { date: fmtShort(tlf.label, true) }))}</span></div>`
        : `<div class="ml-simple"><i class="ml-radar"></i><span>${esc(t("Radar images: left {before}, right {after}", { before: fmtShort(pa, true), after: fmtShort(pb, true) }))}</span></div>`;
      const key = radarKey + (tlf ? `<div class="ml-simple ml-off">${esc(t("Analysis layer: not shown in the timeline"))}</div>`
        : a.on ? `<div class="ml-simple"><i style="background:${a.color}"></i><span>${esc(t("Analysis: {layer} · {from} → {to}", { layer: a.label, from: fmtShort(pa), to: fmtShort(pb, true) }))}` +
        `${kn ? ` · ${esc(kn)}` : ""}</span></div>` : `<div class="ml-simple ml-off">${esc(t("No layer shown"))}</div>`);
      $("map-legend").classList.add("simple");
      $("map-legend").classList.toggle("collapsed", !open);
      $("map-legend").innerHTML = key +
        (open ? `<div class="ml-notes">` +
          (radar && a.on && sv.notes && sv.notes[a.key] ? `<div class="ml-dates">${esc(sv.notes[a.key])}</div>` : "") +
          (sv.small ? `<div class="ml-dates">${esc(sv.small)}</div>` : "") + unobservedLegend() +
          `<div class="ml-aoi">${$("show-outline").checked ? '<i class="ml-outline"></i>' : ""}${esc(t("Dashed line: the area we studied — not a flood edge."))}</div>` +
          (sat ? `<div class="ml-bg">${esc(t("Background image — not from the flood date."))}</div>` : "") + `</div>` : "") +
        `<button type="button" class="ml-more" aria-expanded="${open}">${esc(open ? t("Hide map notes ▴") : t("Map notes ▾"))}</button>`;
      $("map-legend").querySelector(".ml-more").addEventListener("click", () => {
        state.simpleLegendOpen = !open; renderMapLegend(); $("map-legend").querySelector(".ml-more").focus();
      });
      return;
    }
    $("map-legend").classList.remove("simple");
    const single = state.swipe >= 1;
    const sat = state.view === "satellite";
    const blocks = []; // {title, key (always), detail (expanded only)}
    for (const sp of meta.support) {
      if (!overlays[sp.id]) continue;
      blocks.push({ title: plainTitle(sp),
        key: Object.entries(sp.classes).filter(([, c]) => c.show_in_legend !== false)
          .map(([code, c]) => `<span class="ml-chip"><i style="background:${c.color}"></i>${code === "255" ? esc(t("we could not check this place")) : esc(clsText(sp, code).short || code)}</span>`).join(""),
        detail: isIndep(sp)
          ? `${refMismatch(sp) ? `<b>${esc(refNote())}.</b> ` : ""}${esc(T.layers[sp.id].dates)}. ${esc(t("Grey: we could not check this place."))}`
          : `${esc(sup(sp).plain_detail || T.layers[sp.id].dates || "")}. ${esc(candOneMap() ? t("Not a water map of either date.") : t("Right side of the divider only."))} ${esc(t("Experimental estimate. This blue is not the blue of the radar change map."))}` });
    }
    if (overlays.change) {
      const r = meta.change[pairKey()].range_db;
      void r;
      // The change image is a continuous blue–white–red scale (±6 dB, opaque); no grey or other colours are drawn in it
      blocks.push({ title: t("Radar signal change"),
        key: `<div class="ml-say"><i style="background:#2166ac"></i>${esc(t("Blue: the radar signal became weaker."))}</div>` +
          `<div class="ml-say"><i style="background:#b2182b"></i>${esc(t("Red: the radar signal became stronger."))}</div>` +
          `<div class="ml-say"><i class="sw-white" style="background:#f7f7f7"></i>${esc(t("White: little change in the radar signal."))}</div>` +
          `<div class="ml-note-change">${esc(t("These colours show radar changes, not confirmed floodwater."))}</div>`,
        detail: `<div class="ramp" style="background:${RAMP.div}"></div><div class="ramp-labels"><span>${esc(t("weaker"))}</span><span>${esc(t("little change"))}</span><span>${esc(t("stronger"))}</span></div>` +
          `${fmtShort(state.before)} → ${fmtShort(state.after, true)}${state.pol === "HH" ? "" : " · " + state.pol}` });
    }
    if (grayShown()) {
      const s = meta.radar[`${state.before}|${state.pol}`].scale_db;
      void s;
      blocks.push({ title: t("Radar picture — not a normal photo"),
        key: `<div class="ramp" style="background:${RAMP.gray}"></div><div class="ramp-labels"><span>${esc(t("weak signal"))}</span><span>${esc(t("strong signal"))}</span></div>`,
        detail: `${single ? fmtShort(state.before, true) : esc(t("Left {left} · right {right}", { left: fmtShort(state.before, true), right: fmtShort(state.after, true) }))}${state.pol === "HH" ? "" : " · " + state.pol} · ${esc(t("dark can be smooth ground or water"))}` });
    }
    const bg = sat && !state.satFallback
      ? `<div class="ml-bg">${esc(t("Background image — not from the flood date."))}</div>`
      : sat ? `<div class="ml-bg">${esc(t("Satellite imagery unavailable — street map shown"))}</div>` : "";
    // v75: in the flood map views the dashed study outline is what the satellite data cover (no wider data: nothing outside it is "dry")
    const cov = floodView() && views.overview.coverage ? `<div class="ml-cov"><i class="ml-cover"></i><span>${esc(t(views.overview.coverage.label))}</span></div>` : "";
    // Short names for the collapsed legend on narrow screens
    const SHORT = { nisar_candidate: t("Possible water — not confirmed flooding"), landsat_support: t("Landsat water"), gfm_support: t("GFM flood map"), multi_source: t("Possible water, also seen by 2 others") };
    const order = [...meta.support.filter((sp) => overlays[sp.id]).map((sp) => SHORT[sp.id] || plainTitle(sp)),
                   ...(overlays.change ? [t("Radar change")] : []), ...(grayShown() ? [t("Radar image")] : [])];
    const title = blocks.length
      ? (narrow.matches && !state.legendOpen ? order[0] : blocks[0].title) + (blocks.length > 1 ? ` +${blocks.length - 1}` : "")
      : t("Study area");
    const open = state.legendOpen;
    let body = "";
    if (open) {
      body = blocks.map((b) => `<div class="ml-block"><strong>${esc(b.title)}</strong>${b.key}<div class="ml-dates">${b.detail}</div></div>`).join("") +
        (blocks.length ? "" : `<div class="ml-dates">${esc(t("No radar layer in this step."))}</div>`) +
        unobservedLegend() + `<div class="ml-aoi">${$("show-outline").checked ? '<i class="ml-outline"></i>' : ""}${esc(t("Dashed line: the area we studied ({size}).", { size: areaText() }))}</div>`;
    } else {
      body = blocks.length ? `<div class="ml-block">${blocks[0].key}</div>` : "";
    }
    $("map-legend").innerHTML =
      `<button type="button" class="ml-toggle" aria-expanded="${open}" aria-controls="map-legend" aria-label="${esc(open ? t("Hide legend details") : t("Show legend details"))}">` +
      `<span>${esc(open ? t("Legend") : title)}</span><span aria-hidden="true">${esc(open ? t("▾ hide") : t("▸ show"))}</span></button>` + body + cov + bg;
    $("map-legend").classList.toggle("collapsed", !open);
    $("map-legend").querySelector(".ml-toggle").addEventListener("click", () => { state.legendOpen = !state.legendOpen; renderMapLegend(); });
  }

  // Background choice (only when an Esri key is configured): Esri sharper imagery ↔ EOxCloudless Sentinel-2
  const satSwitch = () => (esriBase && state.esriKey === "ok"
    ? `<button type="button" class="btn btn-small sat-switch" data-src="${state.satSource === "esri" ? "eox" : "esri"}">` +
      `${esc(state.satSource === "esri" ? t("Use Sentinel-2 background (10 m, 2025)") : t("Use sharper Esri background"))}</button>` : "");
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".sat-switch");
    if (!b) return;
    state.satSource = b.dataset.src;
    state.satUserChoice = true;
    if (state.satSource === "esri") state.esriFailed = false;
    render();
  });
  // --- Panel legend: meaning and colours of the selected layers only
  function renderLegend() {
    const s = meta.radar[`${state.before}|${state.pol}`].scale_db;
    const single = state.swipe >= 1;
    const satBlock = state.view !== "satellite" ? ""
      : state.satFallback
      ? `<div class="legend-block"><strong>${esc(t("Background"))}</strong><div class="small-note">${esc(t("Satellite imagery could not be loaded; the OpenStreetMap street map is shown instead."))}</div></div>`
      : activeSat() === esriBase
      ? `<div class="legend-block"><strong>${esc(t("Satellite background"))}</strong><div class="small-note">` +
        // provider credit as Esri requires it (not translated); the explanation around it is translated
        `Esri World Imagery — ${ESRI_SOURCE}. Powered by Esri. ` + esc(t("Used with a verified ArcGIS API key under Esri's terms of use.")) + " " +
        esc(t("Image dates vary by place and none is from the flood dates. Sharper than the radar data: NISAR layers stay at their own resolution.")) + " " +
        esc(t("Context only; not part of the analysis.")) + `</div>` + satSwitch() + `</div>`
      : `<div class="legend-block"><strong>${esc(t("Satellite background"))}</strong><div class="small-note">` +
        `EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data ${SAT_YEAR}): ` + esc(t("natural-colour composite of Sentinel-2 images from {year}.", { year: SAT_YEAR })) + " " +
        t("Licence: {licence} (non-commercial use; commercial use needs an EOX licence).", { licence: `<a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener">CC BY-NC-SA 4.0</a>` }) + " " +
        esc(t("Sharpest detail is about 10 m (Sentinel-2); zooming in further enlarges the same pixels.")) + " " +
        (state.esriFailed ? esc(t("The sharper Esri imagery could not be loaded, so this background is shown.")) + " "
          : state.esriKey === "rejected" ? esc(t("The Esri API key was not accepted by Esri, so this background is shown.")) + " "
          : state.esriKey === "unreachable" ? esc(t("The Esri API key could not be checked (no connection to Esri), so this background is shown.")) + " " : "") +
        esc(t("Context only; not part of the analysis (see the note in the map legend).")) + `</div>` + satSwitch() + `</div>`;
    let html = satBlock + (grayShown() ? `<div class="legend-block"><strong>${esc(t("Grey radar image — backscatter {pol} (dB)", { pol: state.pol }))}</strong>
      <div class="small-note">${esc(single ? fmtDay(state.before) + "." : t("{dates}; the same fixed scale on both dates.", { dates: fmtPair(state.before, state.after) }))} ${esc(t("Grey tones are data (dark: low, bright: high). Product: {maturity}. Opacity {opacity}.", { maturity: meta.maturity, opacity: I.fmt.pct(state.opacity[state.view], 0) }))}</div>
      <div class="ramp" style="background:${RAMP.gray}"></div><div class="ramp-labels"><span>${s[0]}</span><span>${s[1]}</span></div>` +
      (state.pol === "HV" ? `<div class="small-note">${esc(t("HV: no noise correction; low values cannot be read quantitatively."))}</div>` : "") + `</div>` : "");
    if (overlays.change) {
      const r = meta.change[pairKey()].range_db;
      html += `<div class="legend-block"><strong>${esc(t("Radar change {pol} (dB)", { pol: state.pol }))}</strong>
        <div class="small-note"><b>${esc(t("Single-map change view ({dates}):", { dates: fmtPair(state.before, state.after) }))}</b> ${esc(t("after − before, shown over the whole map independent of the divider. A decrease can be consistent with open water; it is not evidence of flooding on its own."))}</div>
        <div class="ramp" style="background:${RAMP.div}"></div>
        <div class="ramp-labels"><span>${esc(t("{value} decrease", { value: r[0] }))}</span><span>0</span><span>${esc(t("{value} increase", { value: "+" + r[1] }))}</span></div></div>`;
    }
    let anyObs = false;
    for (const sp of meta.support) {
      if (!overlays[sp.id]) continue;
      if ("255" in sp.classes && sp.classes["255"].show_in_legend !== false) anyObs = true;
      const derived = isIndep(sp)
        ? `${refMismatch(sp) ? `${esc(refNote())} (${fmtPair(state.before, state.after)}). ` : ""}${esc(T.layers[sp.id].dates)}. ${esc(T.layers[sp.id].coverage || "")} ${esc(t("Independent observation shown over the whole study area (not split by the divider)."))}`
        : `${esc(T.layers[sp.id].dates || "")}. ${esc(t("Change candidate, not an independent single-date water map."))} ${esc(candOneMap() ? t("Shown on one map; with the grey radar comparison it appears only on the right (“after”) side of the divider.") : t("Shown only on the right (“after”) side of the divider."))}`;
      html += `<div class="legend-block"><strong>${esc(supTitle(sp))}</strong><div class="small-note"><b>${derived}</b> ${esc(sup(sp).meaning || "")}</div>` +
        Object.entries(sp.classes).filter(([, c]) => c.show_in_legend !== false)
          .map(([code, c]) => swatch(c.color, (code === "255" ? `<b>${esc(t("Unknown."))}</b> ` : "") + esc(clsText(sp, code).label || code))).join("") +
        `</div>`;
    }
    if (state.on.has("regions") && regionGroup.getLayers().length) {
      html += `<div class="legend-block"><strong>${esc(t("Inspection areas"))}</strong>` +
        swatch("transparent", esc(t("inspection area (400 m); chosen where change was strongest, not an unbiased sample")), "border:2px solid #ff9800") + `</div>`;
    }
    if (state.on.has(OLD_CONTROL) && controlGroup.getLayers().length) {
      html += `<div class="legend-block"><strong>${esc(t("Old control area"))}</strong>` +
        swatch("transparent", esc(t("Invalid — cannot be used as a control (dashed)")), "border:2px dashed #00bcd4") + `</div>`;
    }
    html += `<div class="legend-block"><strong>${esc(t("Study area"))}</strong>` +
      swatch("transparent", esc(meta.study_area
        ? t("Thin dashed line (optional): edge of the {size} study area (city unit + contiguous built-up area + Limpopo surroundings; not a flood boundary). There is no analysis outside it.", { size: areaText() })
        : t("Thin dashed line (optional): edge of the {size} study area. There is no analysis outside it.", { size: areaText() })), "border:1px dashed #888") +
      (meta.support.length && !anyObs ? `<div class="small-note">${esc(t("The “Not observed” (grey) class exists only in the Landsat and GFM support layers."))}</div>` : "") + `</div>`;
    $("legend").innerHTML = html;
  }

  // --- Controls (Technical details)
  $("maturity-badge").addEventListener("click", (e) => {
    const open = $("maturity-info").hidden;
    $("maturity-info").hidden = !open;
    e.currentTarget.setAttribute("aria-expanded", String(open));
  });
  $("sel-pair").addEventListener("change", (e) => {
    if (!meta) return;
    [state.before, state.after] = e.target.value.split("|");
    if (state.swipe >= 1) state.swipe = 0.5; // choosing a pair switches to the comparison view
    markCustom();
  });
  document.querySelectorAll('input[name="pol"]').forEach((r) => r.addEventListener("change", (e) => { state.pol = e.target.value; markCustom(); }));
  // On mobile the panel legend starts collapsed (the on-map legend stays visible)
  narrow.addEventListener("change", () => { if (meta) { if (state.ui === "simple") renderSimpleBar(); render(); } });

  const fromHash = (location.hash.match(/(?:event|olay)=([\w-]+)/) || [])[1];
  const viewHash = (location.hash.match(/view=(satellite|analysis)/) || [])[1];
  if (viewHash) state.view = viewHash; // default: satellite view
  syncBase();
  setCardsOpen(false); // cards stay collapsed while an event is selected; "Change event" opens them
  // Start screen (intro.js): the globe only chooses an event; this Leaflet map is created once above and reused
  const intro = window.NFEIntro;
  if (intro) {
    await intro.init({
      events: index.events, texts, text: (id) => txt(id),
      getLayers: (id) => getJson(`data/${index.events.find((e) => e.id === id).layers}`),
      openEvent: (id, opts) => { setCardsOpen(false); return loadEvent(id, opts); }, // clears old layers, fits the study area (unless move: false), opens step 1
      currentEvent: () => (meta ? meta.event_id : null),
      // Leaflet camera access for the start-screen transitions (the analysis map itself is unchanged)
      leaflet: {
        map,
        rect: () => $("map").getBoundingClientRect(),
        areaBounds: () => viewBounds,
        // Stops a running flight without starting a new zoom animation (Leaflet's stop() snaps the zoom with an animated
        // setZoom, which would later move the map back after a jump)
        stop: () => { clearTimeout(moveTimer); map._stop ? map._stop() : map.stop(); },
        fitArea: (animate, duration) => {
          clearTimeout(moveTimer);
          const go = () => (animate
            ? map.flyToBounds(viewBounds, { padding: [12, 12], animate: true, duration, easeLinearity: 0.25 })
            : map.fitBounds(viewBounds, { padding: [12, 12], animate: false }));
          if (map._animatingZoom) map.once("zoomend", go); else go(); // a zoom animation in progress would undo the jump
        },
        satTilesLoaded: () => new Promise((res) => {
          const base = state.view === "satellite" && !state.satFallback ? activeSat() : streetBase;
          if (!base._loading) return res(true);
          base.once("load", () => res(true));
          setTimeout(() => res(false), 2500); // do not wait forever for background tiles
        }),
      },
    });
  }
  // Language first (saved, or chosen now on the welcome screen); a direct link keeps its target and opens in that language
  await I.ready();
  localizeStatic();
  // Direct links (#event=… or the older #olay=…) open the analysis as before; otherwise the start screen is shown
  if (fromHash || !intro) await loadEvent(fromHash || index.events[0].id);
  else intro.route(); // v75: start menu, globe (#map) or stories (#stories, #story=…) from the address

  // The address changed in the same tab (a pasted/clicked #event=… link, or Back/Forward): show that event and view.
  // The app's own address updates use replaceState/pushState, which do not fire hashchange.
  window.addEventListener("hashchange", () => {
    const id = eventInHash();
    const v = (location.hash.match(/view=(satellite|analysis)/) || [])[1];
    const introOpen = intro && !$("intro").hidden;
    if (!id) { // address without an event: start menu, globe (#map) or stories, by the address (v75)
      if (intro) intro.route();
      return;
    }
    if (!index.events.some((e) => e.id === id)) return; // unknown event id: keep what is shown
    if (id !== requestedId || introOpen) { // requestedId: also covers an event that is still loading
      if (v) state.view = v; // the new event opens in the requested view
      setCardsOpen(false);
      switchEvent(id);
    } else if (v && v !== state.view) {
      setView(v);
    }
  });
})();
