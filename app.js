// NISAR Flood Explorer — shows only pre-built layers and text:
// web/data/events.json, <event>/layers.json (data, unchanged) and <event>/text.en.json (English display text).
// No event content is hard-coded here.
(async function () {
  const fail = (m) => (window.showLoadError ? window.showLoadError(m) : alert(m));
  if (typeof L === "undefined") return fail("The map could not start because Leaflet did not load.");
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const getJson = async (path) => {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  let index;
  try {
    index = await getJson("data/events.json");
  } catch (e) {
    return fail(`The event list (<code>data/events.json</code>) could not be read: ${e.message}. ` +
      "Build the layers with <code>.venv/bin/python pipeline/export/build_web_layers.py &lt;event&gt;</code>.");
  }
  // English text for every event (small files; needed for the event cards)
  const texts = {};
  await Promise.all(index.events.map(async (e) => {
    try { texts[e.id] = await getJson(`data/${e.id}/text.en.json`); } catch (err) {
      texts[e.id] = null;
      fail(`English text (<code>data/${e.id}/text.en.json</code>) could not be read; run <code>python3 pipeline/export/build_text_en.py</code>.`);
    }
  }));
  if ($("map").clientHeight === 0) fail("The map area has zero height; <code>style.css</code> may not have been applied.");

  // --- Dates: day and month for users, full UTC in the details
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const parts = (lb) => { const [y, m, d] = lb.split("-").map(Number); return { y, m, d }; };
  const fmtDay = (lb, withYear = true) => { const p = parts(lb); return `${p.d} ${MONTHS[p.m - 1]}${withYear ? " " + p.y : ""}`; };
  const fmtShort = (lb, withYear = false) => { const p = parts(lb); return `${p.d} ${MONTHS[p.m - 1].slice(0, 3)}${withYear ? " " + p.y : ""}`; };
  const fmtPair = (a, b) => (parts(a).y === parts(b).y ? `${fmtDay(a, false)} → ${fmtDay(b)}` : `${fmtDay(a)} → ${fmtDay(b)}`);
  const fmtUtc = (s) => s.replace("T", " ").replace(/(\.\d+)?Z$/, "") + " UTC";
  const narrow = window.matchMedia("(max-width: 720px)");
  const compact = window.matchMedia("(max-width: 720px), (max-height: 500px)"); // phones, also in landscape
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
      const pad = opts.padding ? L.point(opts.padding) : L.point(0, 0);
      const want = Math.min(map.getBoundsZoom(b, false, pad.multiplyBy(2)), opts.maxZoom ?? Infinity);
      const off = Math.abs(map.getZoom() - want) > 0.6 || !map.getBounds().contains(b.getCenter());
      if (off) { map.stop(); map.fitBounds(b, { ...opts, animate: false }); }
    }, m.duration * 1000 + 500);
  }
  // --- Background maps. Analysis view: OpenStreetMap street map. Satellite view: EOxCloudless 2025 (Sentinel-2 natural-colour
  // composite). EOX terms (cloudless.eox.at/documentation/license, read 2026-11-07): free for non-commercial use under
  // CC BY-NC-SA 4.0; the credit below must be visible in the map interface. Commercial use needs an EOX licence.
  const SAT_YEAR = 2025;
  const SAT_URL = `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${SAT_YEAR}_3857/default/g/{z}/{y}/{x}.jpg`;
  const streetBase = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
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
  const satBase = L.tileLayer(SAT_URL, {
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
  const EsriLayer = L.TileLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement("div"), img = document.createElement("img");
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
  const activeSat = () => (state.satSource === "esri" && esriBase ? esriBase : satBase);
  map.attributionControl.addAttribution("NISAR: NASA/JPL-Caltech, ASF DAAC");
  // Satellite tiles that fail to load: after a few failures with none loaded, Esri falls back to EOxCloudless;
  // EOxCloudless shows an error and offers the street map
  for (const layer of [satBase, esriBase].filter(Boolean)) {
    let loaded = 0, errors = 0;
    layer.on("loading", () => { loaded = 0; errors = 0; }); // counted per loading round (pan/zoom/view change)
    layer.on("tileload", () => { loaded++; $("sat-error").hidden = true; });
    layer.on("tileerror", () => {
      errors++;
      if (state.view !== "satellite" || state.satFallback || errors < 3 || loaded) return;
      if (layer === esriBase && state.satSource === "esri") { state.satSource = "eox"; state.esriFailed = true; render(); }
      else if (layer === satBase) $("sat-error").hidden = false;
    });
  }
  function syncBase() {
    const useSat = state.view === "satellite" && !state.satFallback;
    const want = useSat ? activeSat() : streetBase;
    for (const l of [streetBase, satBase, esriBase]) if (l && l !== want && map.hasLayer(l)) map.removeLayer(l);
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
  const REF_NOTE = "Separate reference observations; dates differ from the selected NISAR comparison";
  const refMismatch = (sp) => isIndep(sp) && !(sp.period[0] === state.before && sp.period[1] === state.after);
  // The divider exists only for a real before–after comparison (grey radar of both dates). Then the pair-derived candidate stays on the
  // "after" side. Without the grey comparison the candidate is shown on one map, labelled as derived from the change between the two dates.
  const anyClipped = () => grayShown();
  const candOneMap = () => !grayShown();
  state.candOpacity = 0.8; // display opacity of the NISAR candidate / intersection (data unchanged)
  state.together = false; // step source layers: one at a time by default
  // Two levels: "simple" (default: the result first, few controls) and "evidence" (the five steps, all layers and methods)
  state.ui = "simple";
  state.simpleShow = true; // Simple view: the result layer (Bangladesh candidate) shown or hidden
  state.simpleLegendOpen = null; // Simple view map legend: null = default (closed on phones, open on wider screens)
  state.simpleClass = null; // Simple view (Mozambique): "decrease" | "increase" | null — one radar-change class at a time
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
  const DATA_V = "32"; // bump when layer PNGs are regenerated (avoids stale cached colours)
  function img(file, pane) {
    const seq = loadSeq;
    pending++;
    setStatus("Loading map layers…");
    const done = () => {
      if (seq !== loadSeq) return; // image from an older event: ignore
      pending = Math.max(0, pending - 1);
      if (!pending) setStatus("");
    };
    return L.imageOverlay(`data/${file}?v=${DATA_V}`, bounds, { pane, opacity: 1, interactive: false, className: "pixelated" })
      .on("load", done)
      .on("error", () => { done(); if (seq === loadSeq) fail(`A layer image could not be loaded: <code>data/${file}</code>`); });
  }
  const pairKey = () => `${state.before}|${state.after}|${state.pol}`;
  const supportById = (id) => meta.support.find((s) => s.id === id);
  // Pair-derived layers (candidate, intersection) need their NISAR pair; independent observations are always available
  const pairMatches = (s) => isIndep(s) || (s.period[0] === state.before && s.period[1] === state.after);
  const layerTitle = (id) => {
    if (id === "change") return "Radar change (single map)";
    if (id === "regions") return "Inspection areas";
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
    $("change-label").hidden = true;
    $("map-legend").innerHTML = "";
    pending = 0;
  }

  // --- Event cards
  function buildCards(activeId) {
    const box = $("event-cards");
    box.innerHTML = "";
    for (const e of index.events) {
      const t = texts[e.id];
      const ev = t ? t.event : { place: e.id, dates: "" };
      const b = document.createElement("button");
      b.type = "button";
      b.className = "card";
      b.setAttribute("aria-pressed", String(e.id === activeId));
      b.setAttribute("aria-label", `${ev.place}, ${ev.dates}, ${e.maturity} product`);
      b.innerHTML = (ev.thumb ? `<img src="data/${esc(ev.thumb)}" alt="${esc(ev.thumb_alt || "")}" loading="lazy">` : "") +
        `<span class="c-text"><span class="c-place">${esc(ev.place)}</span><span class="c-dates">${esc(ev.dates)}</span>` +
        `<span class="c-badge ${e.maturity === "BETA" ? "beta" : ""}">${esc(e.maturity)}</span></span>`;
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
    $("events-toggle").textContent = open ? "Hide events" : "Change event";
  }
  $("events-toggle").addEventListener("click", () => setCardsOpen($("event-cards").hidden));

  // --- Event loading: clear old layers first, fetch, discard stale results, then move the map
  // opts.move === false: the caller (start-screen camera transition) moves the map itself
  async function loadEvent(id, opts = {}) {
    const entry = index.events.find((e) => e.id === id) || index.events[0];
    requestedId = entry.id;
    const seq = ++loadSeq;
    const t = texts[entry.id];
    clearEventLayers();
    meta = null; T = null; // the old event is closed while the new one loads (handlers below check this)
    buildCards(entry.id);
    $("current-event").textContent = t ? t.event.place : entry.id;
    setStatus(`Loading ${t ? t.event.place : entry.id}…`);
    let m;
    try {
      m = await getJson(`data/${entry.layers}`);
    } catch (e) {
      if (seq === loadSeq) { setStatus(""); fail(`Event layers (<code>data/${entry.layers}</code>) could not be read: ${e.message}.`); }
      return;
    }
    if (seq !== loadSeq) return; // a newer event was requested meanwhile
    if (!t) { setStatus(""); return; }
    meta = m;
    T = t;
    bounds = L.latLngBounds(meta.bounds_latlon); // image overlay extent
    // map view target: the study-area polygon when there is one (fills the map), else the image extent
    viewBounds = meta.study_area ? L.geoJSON(meta.study_area.outline).getBounds() : bounds;
    dateByLabel = Object.fromEntries(meta.dates.map((d) => [d.label, d]));
    writeHash();

    // Title, maturity and the single warning badge
    $("title").textContent = T.event.title;
    $("subtitle").textContent = `${T.event.area_name} · ${areaText()} study area`;
    const mb = $("maturity-badge");
    mb.textContent = `${meta.maturity} product`;
    mb.classList.toggle("beta", meta.maturity === "BETA");
    mb.setAttribute("aria-expanded", "false");
    mb.setAttribute("aria-label", `${meta.maturity} product: show explanation`);
    $("maturity-info").hidden = true;
    $("maturity-info").textContent = T.maturity.text;
    $("product-status").textContent = T.maturity.text;
    // Same meaning as before (experimental candidate, no validated flood boundary / no flood area), in plain words
    $("warning-badge").textContent = meta.support.length
      ? "Possible water — flooding not confirmed"
      : "Radar change only — we did not map the flooded area";
    $("event-info").innerHTML = `<p>${esc(T.event.lede)}</p><ul>${T.event.facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` +
      `<p class="small-note">${esc(T.maturity.text)}</p>`;

    // Optional thin study-area outline (the radar images keep their real extent; nothing is drawn outside)
    // Study-area polygon when the event has one (Mozambique city area), otherwise the rectangular trial window; never a flood edge
    const outlineStyle = { pane: "regions", color: "#ffffff", weight: 1, opacity: 0.85, dashArray: "3 4", fill: false, interactive: false };
    outline.addLayer(meta.study_area ? L.geoJSON(meta.study_area.outline, { style: () => outlineStyle, interactive: false, pane: "regions" })
      : L.rectangle(bounds, outlineStyle));

    // Observation pairs (Technical details)
    const labels = meta.dates.map((d) => d.label);
    const pairs = [];
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) pairs.push([labels[i], labels[j]]);
    const candPeriod = meta.support.length ? meta.support[0].period.join("|") : null;
    $("sel-pair").innerHTML = "";
    for (const [a, b] of pairs) {
      const extra = `${a}|${b}` === candPeriod ? " · water candidate available" : "";
      $("sel-pair").add(new Option(`${fmtPair(a, b)}${extra}`, `${a}|${b}`));
    }
    $("sel-pair").disabled = pairs.length < 2;
    $("obs-details").innerHTML = meta.dates.map((d) => `<div class="obs"><b>${fmtDay(d.label)}</b> · ${fmtUtc(d.start_utc)}<br>
        ${esc(d.track_frame)} · ${esc(d.maturity)}<br><code>${esc(d.granule)}</code><br><code>${esc(d.product)}</code></div>`).join("");

    // Move the map: first load jumps (the map needs a view before layers are clipped), later events fly
    map.invalidateSize();
    if (!map._loaded) map.fitBounds(viewBounds, { padding: [12, 12], animate: false });
    else if (opts.move !== false) goTo(viewBounds, { padding: [12, 12] });
    syncOutline();
    buildLayerList();
    buildRegions();
    buildInfo();
    buildStepTabs();
    goStep(0, false, false);
    enterSimple();
  }

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
      t.innerHTML = `<span class="n">Step ${i + 1}</span><span>${esc(s.title)}</span>`;
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
    $("step-title").textContent = s.title;
    $("more-detail").open = false;
    $("step-action").hidden = !s.action;
    $("step-action").textContent = s.action || "";
    $("step-dates").hidden = !s.dates_line;
    $("step-dates").textContent = s.dates_line || "";
    $("step-summary").hidden = !s.summary;
    $("step-summary").innerHTML = s.summary
      ? `<h3>What we found</h3><ul>${s.summary.found.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` +
        `<h3>What we still do not know</h3><ul>${s.summary.unknown.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`
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
    $("step-notes").innerHTML = s.notes.map((n) => `<div class="note" role="note"><b>Note:</b> ${esc(n)}</div>`).join("");
    const last = i === T.steps.length - 1;
    $("not-this").hidden = !last;
    $("not-this").innerHTML = last ? `<strong>What this is not</strong><ul>${T.not_this.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "";
    $("step-sources").textContent = s.sources.length ? `Numbers in this step come from: ${s.sources.join(" · ")}` : "";
    $("step-prev").hidden = i === 0;
    $("step-next").hidden = last;
    if (!last) $("step-next").textContent = narrow.matches ? "Next →" : `Next: ${T.steps[i + 1].title} →`;
    $("step-next").setAttribute("aria-label", last ? "" : `Next step: ${T.steps[i + 1].title}`);
    $("step-prev").textContent = "← Back";
    renderShowMe(s);
    applyStepView();
    if (fit && viewBounds && map._loaded && !map.getBounds().contains(viewBounds)) goTo(viewBounds, { padding: [12, 12] });
    render();
    // On mobile, Previous/Next bring the map back into view (the change is followed on the map)
    if (scroll && narrow.matches) document.querySelector(".map-col").scrollIntoView({ block: "start" });
  }
  $("step-prev").addEventListener("click", () => T && goStep(Math.max(0, state.step - 1)));
  $("to-map").addEventListener("click", () => document.querySelector(".map-col").scrollIntoView({ block: "start" }));
  $("to-text").addEventListener("click", () => (state.ui === "simple" ? $("simple-card") : $("explore")).scrollIntoView({ block: "start" }));
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
        `<button type="button" class="btn btn-small show-me">Show me</button>`;
      const btn = li.querySelector("button");
      btn.setAttribute("aria-label", `Show me the ${regPlain(reg)} on the map`);
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
      if (!ok) reasons.add(`No analysis for this pair: the layer was produced only from the ${fmtPair(...s.period)} comparison.`);
    }
    for (const r of reasons) { const p = document.createElement("p"); p.className = "chip-reason"; p.textContent = r; box.appendChild(p); }
    if (grouped) {
      const lab = document.createElement("label");
      lab.className = "chip-together";
      lab.innerHTML = `<input type="checkbox" ${state.together ? "checked" : ""}> Show together`;
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
        n.textContent = "Layers shown together can cover each other; turn one off to inspect it alone.";
        box.appendChild(n);
      }
    }
  }

  function markCustom() { state.custom = true; render(); }

  function buildLayerList() {
    const items = [
      { id: "radar", title: "Grey radar image: backscatter (before | after)",
        key: [kRamp("gray", "dark: low (smooth surface, can be open water) · bright: high")] },
      { id: "change", title: "Radar change (after − before, single map)", key: [kRamp("div", "blue: decrease · red: increase (±6 dB)")] },
      ...meta.support.map((s) => ({
        id: s.id, title: supTitle(s), period: s.period,
        key: Object.entries(s.classes).filter(([, c]) => c.show_in_legend !== false).map(([code, c]) => kBox(c.color, esc(clsText(s, code).short || code))),
      })),
    ];
    if (meta.regions.some((r) => r.role !== "control")) {
      items.push({ id: "regions", title: "Inspection areas (400 m)", key: [kBox("#ff9800", "inspection area", true)] });
    }
    // Invalid old control area: never shown in the guided steps; only here, labelled as invalid
    if (meta.regions.some((r) => r.role === "control")) {
      items.push({ id: OLD_CONTROL, title: "Old control area — INVALID, cannot be used as a control",
        key: [kBox("#00bcd4", "dashed; the west edge of the box contains a patch of water (click the box on the map for details)", true)] });
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
      poly.bindPopup(`<b>${esc(label)}</b><br>${invalid ? "Cannot be used as a control" : "Chosen for inspection; not an unbiased sample"}` +
        (note ? `<br><small>${esc(note)}</small>` : ""));
      (r.role === "control" ? controlGroup : regionGroup).addLayer(poly);
    }
  }

  function buildInfo() {
    const gs = meta.candidate_geometric_size, sens = meta.candidate_sensitivity;
    const f = (x) => x.toLocaleString("en-GB", { maximumFractionDigits: 2 });
    const p = (x) => `${(x * 100).toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`;
    $("size-note").innerHTML = gs
      ? `Geometric size (inside the study area only): NISAR candidate ${f(gs.nisar_candidate_km2)} km² ` +
        `(${f(gs.nisar_candidate_km2_range_over_sensitivity[0])}–${f(gs.nisar_candidate_km2_range_over_sensitivity[1])} depending on thresholds), ` +
        `candidate supported by more than one source ${f(gs.multi_source_km2)} km². <b>Not a validated flood area; experimental thresholds; accuracy unknown.</b>` +
        (T.fpr ? ` False-positive rate: <b>${esc(T.fpr.value)}</b> (${esc(T.fpr.reason)})` : "") +
        (sens ? ` Threshold sensitivity: candidate share ${p(sens.nisar_candidate_share[0])}–${p(sens.nisar_candidate_share[1])} over ${sens.n_combinations} combinations.` : "")
      : "";
    $("rule-note").textContent = T.candidate_rule ? `Candidate rule: ${T.candidate_rule}` : "";
    $("proj-note").textContent = `${T.projection_note} Change layers: ${T.smoothing}.`;

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
      .concat(meta.reference_maps.map((r, i) => [r, i]).filter(([r]) => r.data_obtained && !hasGfmLayer).map(([r, i]) => refHtml(r, i, " Not shown as a map layer.")))
      .concat(meta.sources.map((s, i) => [s, i]).filter(([s]) => isTerms(s)).map(([s, i]) => srcHtml(s, i)));
    const others = meta.sources.map((s, i) => [s, i]).filter(([s]) => !isTerms(s)).map(([s, i]) => srcHtml(s, i))
      .concat(meta.reference_maps.map((r, i) => [r, i]).filter(([r]) => !r.data_obtained).map(([r, i]) => refHtml(r, i)));
    const group = (title, note, items) => items.length ? `<div class="src-group"><h3>${title}</h3><p class="grp-note">${note}</p>${items.join("")}</div>` : "";
    $("sources").innerHTML =
      group("This project's analysis", "Layers produced in this project from NISAR data.", own) +
      group("Independent / supporting observations", "Different sensors; their dates are not the same as NISAR's. When they are inputs to a rule they do not count as validation.", indep) +
      group("Other organisations' products and reports", "Context only; not validation of this project.", others);
    $("uncertainty").innerHTML = T.uncertainty.map((u) => `<li>${esc(u)}</li>`).join("") +
      (T.candidate_rule ? `<li>Candidate rule: ${esc(T.candidate_rule)}</li>` : "");
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
    for (const p of ["before", "after"]) map.getPane(p).style.opacity = String(state.opacity[state.view]);
    for (const p of ["change", "pairAfter"]) map.getPane(p).style.opacity = "1";
    if (gray) {
      beforeLayer = img(meta.radar[`${state.before}|${state.pol}`].file, "before").addTo(map);
      afterLayer = img(meta.radar[`${state.after}|${state.pol}`].file, "after").addTo(map);
    }
    const single = state.swipe >= 1; // single-date view (step 1)
    const d = narrow.matches ? fmtShort : fmtDay;
    const ch = state.pol === "HH" ? "" : ` · ${state.pol}`; // HH is the default; HV is always labelled
    $("label-before").textContent = single ? `${fmtDay(state.before)}${ch}` : `Before · ${d(state.before)}${ch}`;
    $("label-after").textContent = `After · ${d(state.after)}${ch}`;
    $("label-before").title = fmtUtc(dateByLabel[state.before].start_utc);
    $("label-after").title = fmtUtc(dateByLabel[state.after].start_utc);

    const warn = [];
    // Layers of the previous pair are fully removed on every render
    for (const k of Object.keys(overlays)) { map.removeLayer(overlays[k]); delete overlays[k]; }
    if (changeShown() && changeAvail()) overlays.change = img(meta.change[pairKey()].file, "change").setOpacity(OPACITY).addTo(map);
    const sc = simpleSignal();
    if (sc) overlays.signal = img(sc.file, "change").addTo(map);
    $("change-label").hidden = !overlays.change;
    $("change-label").textContent = `Radar change · ${narrow.matches ? fmtShort(state.before) + " → " + fmtShort(state.after, true) : fmtPair(state.before, state.after)}${state.pol === "HH" ? "" : " · " + state.pol}`;
    // Draw order: support layers below, candidate and intersection on top
    const drawOrder = [...meta.support].sort((x, y) => (x.id.includes("support") ? 0 : 1) - (y.id.includes("support") ? 0 : 1));
    for (const s of drawOrder) {
      const row = list.querySelector(`[data-id="${s.id}"]`);
      const box = row.querySelector("input");
      const match = pairMatches(s);
      const reason = `No analysis for this pair: the layer was produced only from the ${fmtPair(...s.period)} comparison.`;
      row.classList.toggle("disabled", !match);
      box.disabled = !match;
      row.querySelector(".reason").textContent = match ? "" : reason;
      if (!match && state.on.has(s.id)) {
        setLayer(s.id, false);
        warn.push(`“${supTitle(s)}” was turned off. ${reason}`);
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
    if (pairLayer && candOneMap() && !overlays.change) {
      $("change-label").hidden = false;
      $("change-label").textContent = narrow.matches // short on phones (the full sentence is in the result card / legend)
        ? `Possible water · from changes ${fmtShort(pairLayer.period[0])} → ${fmtShort(pairLayer.period[1])}`
        : `Possible water detected from changes between ${fmtDay(pairLayer.period[0], false)} and ${fmtDay(pairLayer.period[1], false)}`;
    }
    $("label-before").hidden = !(gray || (split && !single));
    $("label-after").hidden = !split;
    $("divider").hidden = !split;
    renderViewControls(gray, single);
    renderChips();
    renderLegend();
    renderMapLegend();
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
    if (gray) parts.push(single ? `Grey radar ${state.pol}: ${fmtDay(state.before)}.` : `Grey radar ${state.pol}: left ${fmtShort(state.before, true)} · right ${fmtShort(state.after, true)}.`);
    if (overlays.change) parts.push(`Colour change ${state.pol}: ${fmtShort(state.after, true)} − ${fmtShort(state.before, true)}, one map.`);
    const cand = meta.support.filter((x) => overlays[x.id] && !isIndep(x));
    const indep = meta.support.filter((x) => overlays[x.id] && isIndep(x));
    if (cand.length) parts.push(`${cand.map(supTitle).join("; ")}: ${fmtShort(cand[0].period[0])} → ${fmtShort(cand[0].period[1], true)} NISAR pair, ${candOneMap() ? "one map (derived from the change between the two dates)" : "right (“after”) side only"}.`);
    for (const x of indep) parts.push(`${supTitle(x)}: ${T.layers[x.id].dates}; whole study area.`);
    if (indep.some(refMismatch)) parts.push(`${REF_NOTE} (${fmtShort(state.before)} → ${fmtShort(state.after, true)}).`);
    if (!parts.length) parts.push(`No radar layer in this step${step2 ? "" : ". “Grey radar image” shows the radar picture"}.`);
    if (sat && parts.length && (gray || overlays.change || cand.length || indep.length)) parts.push("Satellite background is not part of the comparison.");
    // Candidate opacity: only when the candidate (or intersection) is shown together with Landsat/GFM
    const showCandOp = cand.length > 0 && indep.length > 0;
    $("cand-opacity-row").hidden = !showCandOp;
    $("cand-opacity").value = Math.round(state.candOpacity * 100);
    $("cand-opacity-val").textContent = `${Math.round(state.candOpacity * 100)}%`;
    parts[0] = "Showing: " + parts[0];
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
    if (!avail.change) reasons.push(`Change map unavailable: no computed change layer for ${fmtPair(state.before, state.after)} (${state.pol}).`);
    if (!avail.compare) reasons.push(`Compare radar unavailable: a grey radar image is missing for this pair (${state.pol}).`);
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
  const areaText = () => (meta && meta.study_area ? `${meta.study_area.area_km2.toFixed(1)} km²` : "5 × 5 km");
  const unobservedLegend = () => (meta && meta.study_area && meta.study_area.valid_both_dates_share < 1
    ? `<div class="ml-simple"><i style="background:rgba(${meta.study_area.unobserved_rgba.slice(0, 3).join(",")},0.63)"></i>Grey: we could not check this place</div>` : "");
  // --- Simple view: the existing result on a satellite map with one short card (no new data; same layers as the evidence view)
  // Simple view (Mozambique): the selected class of the existing ±3 dB descriptive criterion, or null
  const simpleSignal = () => (state.ui === "simple" && T.simple && T.simple.classes && meta.signal_classes && state.simpleClass
    ? meta.signal_classes.classes[state.simpleClass] : null);
  function applySimpleLayers() {
    const sv = T.simple;
    [state.before, state.after] = T.steps[0].view.pair; // the analysed pair
    state.pol = "HH";
    state.swipe = 1;
    state.evidence.satellite = state.evidence.analysis = false; // no grey radar in the Simple view
    const ids = state.simpleShow ? sv.layers : [];
    state.layers.analysis = new Set(ids);
    state.layers.satellite = new Set(ids);
    state.custom = false;
    $("sel-pair").value = `${state.before}|${state.after}`;
    document.querySelectorAll('input[name="pol"]').forEach((r) => { r.checked = r.value === "HH"; });
    list.querySelectorAll(".layer").forEach((row) => { row.querySelector("input").checked = state.on.has(row.dataset.id); });
  }
  function enterSimple() {
    if (!meta || !T || !T.simple) return;
    state.ui = "simple";
    document.body.classList.add("ui-simple");
    state.step = 0;
    focusGroup.clearLayers();
    placeGroup.clearLayers();
    const pl = T.simple.place_label;
    if (pl) placeGroup.addLayer(L.marker([pl.lat, pl.lon], { pane: "regions", keyboard: false, interactive: false,
      icon: L.divIcon({ className: "place-label", html: `<i></i><span>${esc(pl.text)}</span>`, iconSize: [0, 0] }) }));
    const cl = T.simple.classes;
    if (!cl || !meta.signal_classes) state.simpleClass = null;
    else if (!cl.some((c) => c.key === state.simpleClass)) state.simpleClass = T.simple.default_class;
    applySimpleLayers();
    renderSimpleCard();
    render();
  }
  function enterEvidence(step) {
    state.ui = "evidence";
    document.body.classList.remove("ui-simple");
    placeGroup.clearLayers();
    $("simple-card").hidden = true;
    renderSimpleBar();
    goStep(step || 0, false);
    $("to-simple").focus({ preventScroll: true });
  }
  // Bar right above the map (Simple view with display classes): one class at a time + the short date pair
  function renderSimpleBar() {
    const bar = $("simple-bar"), sv = T && T.simple;
    const show = state.ui === "simple" && sv && sv.classes && meta.signal_classes;
    bar.hidden = !show;
    if (!show) { bar.innerHTML = ""; return; }
    const [pa, pb] = meta.signal_classes.pair;
    bar.innerHTML = `<p class="sb-date">Radar change · <time>${esc(fmtShort(pa))} → ${esc(fmtShort(pb, true))}</time></p>` +
      `<div class="sb-classes" role="group" aria-label="Radar change shown on the map (press again to hide)">` + sv.classes.map((c) =>
        `<button type="button" class="btn sc-class" data-key="${esc(c.key)}" aria-pressed="${state.simpleClass === c.key}">` +
        `<i class="sw" style="background:${meta.signal_classes.classes[c.key].color}"></i>${esc(c.label)}</button>`).join("") + `</div>`;
    bar.querySelectorAll(".sc-class").forEach((b) => b.addEventListener("click", () => { // one class at a time; pressing the active one hides it
      state.simpleClass = state.simpleClass === b.dataset.key ? null : b.dataset.key;
      renderSimpleBar();
      render();
      bar.querySelector(`.sc-class[data-key="${b.dataset.key}"]`).focus();
    }));
  }
  function renderSimpleCard() {
    const sv = T.simple, box = $("simple-card");
    box.hidden = state.ui !== "simple";
    renderSimpleBar();
    const sp = sv.toggle ? supportById(sv.toggle.layer) : null;
    const swatch = sp && state.simpleShow ? `<i class="sw" style="background:${(Object.values(sp.classes).find((c) => c.show_in_legend !== false) || {}).color}"></i>` : "";
    box.innerHTML = `<h2 id="simple-title">${swatch}${esc(sv.title)}</h2>` +
      sv.lines.map((l, i) => `<p class="${i === sv.lines.length - 1 ? "sc-uncertain" : ""}">${esc(l)}</p>`).join("") +
      (sv.small ? `<p class="sc-small">${esc(sv.small)}</p>` : "") +
      `<div class="sc-actions">` +
      (sv.toggle ? `<button type="button" class="btn sc-toggle" aria-pressed="${state.simpleShow}">${esc(state.simpleShow ? sv.toggle.hide : sv.toggle.show)}</button>` : "") +
      (sv.focus || []).filter((f) => meta.regions.some((r) => r.id === f.region)).map((f) => `<button type="button" class="btn sc-focus" data-region="${esc(f.region)}">${esc(f.label)}</button>`).join("") +
      sv.evidence.map((e, i) => `<button type="button" class="btn ${i === 0 && !sv.toggle ? "btn-primary" : ""} sc-evidence" data-step="${e.step}">${esc(e.label)} →</button>`).join("") +
      `</div><p class="sc-status">Data status: ${esc(meta.maturity)} — not a final, validated NASA release (details: the ${esc(meta.maturity)} badge above).</p>`;
    const tg = box.querySelector(".sc-toggle");
    if (tg) tg.addEventListener("click", () => { // same data on/off; the map is not moved
      state.simpleShow = !state.simpleShow;
      applySimpleLayers();
      renderSimpleCard();
      render();
      box.querySelector(".sc-toggle").focus();
    });
    box.querySelectorAll(".sc-focus").forEach((b) => b.addEventListener("click", () => {
      const f = sv.focus.find((x) => x.region === b.dataset.region), reg = meta.regions.find((r) => r.id === f.region);
      const ring = reg.corners_lonlat.map(([lo, la]) => [la, lo]);
      focusGroup.clearLayers(); // outline only: an area to inspect, not a water or flood boundary
      focusGroup.addLayer(L.polygon(ring, { pane: "regions", color: "#ff9800", weight: 2.5, fill: false, interactive: false }));
      focusGroup.addLayer(L.marker(L.latLngBounds(ring).getNorthWest(), { pane: "regions", keyboard: false, interactive: false,
        icon: L.divIcon({ className: "place-label", html: `<span>${esc(f.note)}</span>`, iconSize: [0, 0] }) }));
      goTo(L.latLngBounds(ring).pad(1.5), { maxZoom: 16 });
      if (narrow.matches) document.querySelector(".map-col").scrollIntoView({ block: "start" });
    }));
    box.querySelectorAll(".sc-evidence").forEach((b) => b.addEventListener("click", () => enterEvidence(Number(b.dataset.step))));
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
  const wrap = document.querySelector(".map-wrap");
  const divider = $("divider");
  function clip() {
    const size = map.getSize();
    const nw = map.containerPointToLayerPoint([0, 0]);
    const se = map.containerPointToLayerPoint(size);
    const x = nw.x + size.x * state.swipe;
    map.getPane("before").style.clip = `rect(${nw.y}px, ${x}px, ${se.y}px, ${nw.x}px)`;
    map.getPane("after").style.clip = `rect(${nw.y}px, ${se.x}px, ${se.y}px, ${x}px)`;
    map.getPane("pairAfter").style.clip = meta && candOneMap() ? "auto" : map.getPane("after").style.clip;
    divider.style.left = `${size.x * state.swipe}px`;
    divider.setAttribute("aria-valuenow", Math.round(state.swipe * 100));
  }
  const setSwipe = (v) => {
    state.swipe = Math.min(0.999, Math.max(0, v)); // 1 = single-date view; dragging never goes there
    divider.querySelector(".drag-hint")?.remove(); // hint is not needed after first use
    clip();
  };
  divider.addEventListener("pointerdown", (e) => {
    divider.setPointerCapture(e.pointerId);
    const move = (ev) => setSwipe((ev.clientX - wrap.getBoundingClientRect().left) / wrap.clientWidth);
    const up = () => { divider.removeEventListener("pointermove", move); divider.removeEventListener("pointerup", up); };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", up);
    e.preventDefault();
  });
  divider.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === "ArrowLeft") setSwipe(state.swipe - step);
    else if (e.key === "ArrowRight") setSwipe(state.swipe + step);
    else if (e.key === "Home") setSwipe(0);
    else if (e.key === "End") setSwipe(1);
    else return;
    e.preventDefault();
  });
  map.on("move zoom resize", clip);
  window.addEventListener("resize", () => map.invalidateSize());

  // --- Small on-map legend (collapsible). Collapsed: active layer name + short colour key. Expanded: dates and notes.
  // The satellite view's "not necessarily from the event date" warning is shown here only (one place).
  function renderMapLegend() {
    if (!meta || !T) return;
    if (state.ui === "simple" && T.simple) {
      const sv = T.simple, sp = sv.toggle ? supportById(sv.toggle.layer) : null, on = sp && overlays[sp.id];
      const col = sp ? (Object.values(sp.classes).find((c) => c.show_in_legend !== false) || {}).color : "";
      const sat = state.view === "satellite" && !state.satFallback;
      $("map-legend").classList.add("simple");
      $("map-legend").classList.remove("collapsed");
      if (sv.classes && meta.signal_classes) {
        const sc = simpleSignal(), [pa, pb] = meta.signal_classes.pair;
        const open = state.simpleLegendOpen === null ? !compact.matches : state.simpleLegendOpen;
        const key = sc ? `<div class="ml-simple"><i style="background:${sc.color}"></i>${esc(sv.legend_short[state.simpleClass])}</div>`
          : `<div class="ml-dates">No radar layer selected.</div>`;
        $("map-legend").classList.toggle("collapsed", !open);
        $("map-legend").innerHTML = key +
          (open ? `<div class="ml-dates">${esc(fmtPair(pa, pb))} · Radar change, not mapped floodwater.</div>` + unobservedLegend() +
            `<div class="ml-aoi">${$("show-outline").checked ? '<i class="ml-outline"></i>' : ""}Dashed line: the area we studied — not a flood edge.</div>` +
            (sat ? `<div class="ml-bg">Background image — not from the flood date.</div>` : "") : "") +
          `<button type="button" class="ml-more" aria-expanded="${open}">${open ? "Hide map notes ▴" : "Map notes: dates, background ▾"}</button>`;
        $("map-legend").querySelector(".ml-more").addEventListener("click", () => {
          state.simpleLegendOpen = !open; renderMapLegend(); $("map-legend").querySelector(".ml-more").focus();
        });
        return;
      }
      $("map-legend").innerHTML =
        (on ? `<div class="ml-simple"><i style="background:${col}"></i>${esc(sv.legend)}</div>` : "") +
        unobservedLegend() +
        `<div class="ml-aoi">${$("show-outline").checked ? '<i class="ml-outline"></i>' : ""}Dashed line: the area we studied — not a flood edge.</div>` +
        (sat ? `<div class="ml-bg">Background image — not from the flood date.</div>` : "");
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
          .map(([code, c]) => `<span class="ml-chip"><i style="background:${c.color}"></i>${code === "255" ? "we could not check this place" : esc(clsText(sp, code).short || code)}</span>`).join(""),
        detail: isIndep(sp)
          ? `${refMismatch(sp) ? `<b>${REF_NOTE}.</b> ` : ""}${esc(T.layers[sp.id].dates)}. Grey: we could not check this place.`
          : `${esc(sup(sp).plain_detail || T.layers[sp.id].dates || "")}${candOneMap() ? ". Not a water map of either date" : "; right side of the divider only"}. Experimental estimate. This blue is not the blue of the radar change map.` });
    }
    if (overlays.change) {
      const r = meta.change[pairKey()].range_db;
      void r;
      // The change image is a continuous blue–white–red scale (±6 dB, opaque); no grey or other colours are drawn in it
      blocks.push({ title: "Radar signal change",
        key: `<div class="ml-say"><i style="background:#2166ac"></i>Blue: the radar signal became weaker.</div>` +
          `<div class="ml-say"><i style="background:#b2182b"></i>Red: the radar signal became stronger.</div>` +
          `<div class="ml-say"><i class="sw-white" style="background:#f7f7f7"></i>White: little change in the radar signal.</div>` +
          `<div class="ml-note-change">These colours show radar changes, not confirmed floodwater.</div>`,
        detail: `<div class="ramp" style="background:${RAMP.div}"></div><div class="ramp-labels"><span>weaker</span><span>little change</span><span>stronger</span></div>` +
          `${fmtShort(state.before)} → ${fmtShort(state.after, true)}${state.pol === "HH" ? "" : " · " + state.pol}` });
    }
    if (grayShown()) {
      const s = meta.radar[`${state.before}|${state.pol}`].scale_db;
      void s;
      blocks.push({ title: "Radar picture — not a normal photo",
        key: `<div class="ramp" style="background:${RAMP.gray}"></div><div class="ramp-labels"><span>weak signal</span><span>strong signal</span></div>`,
        detail: `${single ? fmtShort(state.before, true) : `Left ${fmtShort(state.before, true)} · right ${fmtShort(state.after, true)}`}${state.pol === "HH" ? "" : " · " + state.pol} · dark can be smooth ground or water` });
    }
    const bg = sat && !state.satFallback
      ? `<div class="ml-bg">Background image — not from the flood date.</div>`
      : sat ? `<div class="ml-bg">Satellite imagery unavailable — street map shown</div>` : "";
    // Short names for the collapsed legend on narrow screens
    const SHORT = { nisar_candidate: "Possible water — not confirmed flooding", landsat_support: "Landsat water", gfm_support: "GFM flood map", multi_source: "Possible water, also seen by 2 others" };
    const order = [...meta.support.filter((sp) => overlays[sp.id]).map((sp) => SHORT[sp.id] || plainTitle(sp)),
                   ...(overlays.change ? ["Radar change"] : []), ...(grayShown() ? ["Radar image"] : [])];
    const title = blocks.length
      ? (narrow.matches && !state.legendOpen ? order[0] : blocks[0].title) + (blocks.length > 1 ? ` +${blocks.length - 1}` : "")
      : sat ? "Study area" : "Study area";
    const open = state.legendOpen;
    let body = "";
    if (open) {
      body = blocks.map((b) => `<div class="ml-block"><strong>${esc(b.title)}</strong>${b.key}<div class="ml-dates">${b.detail}</div></div>`).join("") +
        (blocks.length ? "" : `<div class="ml-dates">No radar layer in this step.</div>`) +
        unobservedLegend() + `<div class="ml-aoi">${$("show-outline").checked ? '<i class="ml-outline"></i>' : ""}Dashed line: the area we studied (${areaText()}).</div>`;
    } else {
      body = blocks.length ? `<div class="ml-block">${blocks[0].key}</div>` : "";
    }
    $("map-legend").innerHTML =
      `<button type="button" class="ml-toggle" aria-expanded="${open}" aria-controls="map-legend" aria-label="${open ? "Hide legend details" : "Show legend details"}">` +
      `<span>${open ? "Legend" : esc(title)}</span><span aria-hidden="true">${open ? "▾ hide" : "▸ show"}</span></button>` + body + bg;
    $("map-legend").classList.toggle("collapsed", !open);
    $("map-legend").querySelector(".ml-toggle").addEventListener("click", () => { state.legendOpen = !state.legendOpen; renderMapLegend(); });
  }

  // Background choice (only when an Esri key is configured): Esri sharper imagery ↔ EOxCloudless Sentinel-2
  const satSwitch = () => (esriBase && state.esriKey === "ok"
    ? `<button type="button" class="btn btn-small sat-switch" data-src="${state.satSource === "esri" ? "eox" : "esri"}">` +
      `${state.satSource === "esri" ? "Use Sentinel-2 background (10 m, 2025)" : "Use sharper Esri background"}</button>` : "");
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
      ? `<div class="legend-block"><strong>Background</strong><div class="small-note">Satellite imagery could not be loaded; the OpenStreetMap street map is shown instead.</div></div>`
      : activeSat() === esriBase
      ? `<div class="legend-block"><strong>Satellite background</strong><div class="small-note">` +
        `Esri World Imagery — ${ESRI_SOURCE}. Powered by Esri; used with a verified ArcGIS API key under Esri's terms of use. ` +
        `Image dates vary by place and none is from the flood dates. Sharper than the radar data: NISAR layers stay at their own resolution. ` +
        `Context only; not part of the analysis.</div>` + satSwitch() + `</div>`
      : `<div class="legend-block"><strong>Satellite background</strong><div class="small-note">` +
        `EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data ${SAT_YEAR}): natural-colour composite of Sentinel-2 images from ${SAT_YEAR}. ` +
        `Licence: <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener">CC BY-NC-SA 4.0</a> (non-commercial use; commercial use needs an EOX licence). ` +
        `Sharpest detail is about 10 m (Sentinel-2); zooming in further enlarges the same pixels. ` +
        (state.esriFailed ? `The sharper Esri imagery could not be loaded, so this background is shown. `
          : state.esriKey === "rejected" ? `The Esri API key was not accepted by Esri, so this background is shown. `
          : state.esriKey === "unreachable" ? `The Esri API key could not be checked (no connection to Esri), so this background is shown. ` : "") +
        `Context only; not part of the analysis (see the note in the map legend).</div>` + satSwitch() + `</div>`;
    let html = satBlock + (grayShown() ? `<div class="legend-block"><strong>Grey radar image — backscatter ${state.pol} (dB)</strong>
      <div class="small-note">${single ? fmtDay(state.before) : fmtPair(state.before, state.after) + "; the same fixed scale on both dates"}. Grey tones are data (dark: low, bright: high). Product: ${meta.maturity}. Opacity ${Math.round(state.opacity[state.view] * 100)}%.</div>
      <div class="ramp" style="background:${RAMP.gray}"></div><div class="ramp-labels"><span>${s[0]}</span><span>${s[1]}</span></div>` +
      (state.pol === "HV" ? `<div class="small-note">HV: no noise correction; low values cannot be read quantitatively.</div>` : "") + `</div>` : "");
    if (overlays.change) {
      const r = meta.change[pairKey()].range_db;
      html += `<div class="legend-block"><strong>Radar change ${state.pol} (dB)</strong>
        <div class="small-note"><b>Single-map change view (${fmtPair(state.before, state.after)}):</b> after − before, shown over the whole map independent of the divider. A decrease can be consistent with open water; it is not evidence of flooding on its own.</div>
        <div class="ramp" style="background:${RAMP.div}"></div>
        <div class="ramp-labels"><span>${r[0]} decrease</span><span>0</span><span>+${r[1]} increase</span></div></div>`;
    }
    let anyObs = false;
    for (const sp of meta.support) {
      if (!overlays[sp.id]) continue;
      if ("255" in sp.classes && sp.classes["255"].show_in_legend !== false) anyObs = true;
      const derived = isIndep(sp)
        ? `${refMismatch(sp) ? `${REF_NOTE} (${fmtPair(state.before, state.after)}). ` : ""}${esc(T.layers[sp.id].dates)}. ${esc(T.layers[sp.id].coverage || "")} Independent observation shown over the whole study area (not split by the divider).`
        : `${esc(T.layers[sp.id].dates || "")}. Change candidate, not an independent single-date water map. ${candOneMap() ? "Shown on one map; with the grey radar comparison it appears only on the right (“after”) side of the divider." : "Shown only on the right (“after”) side of the divider."}`;
      html += `<div class="legend-block"><strong>${esc(supTitle(sp))}</strong><div class="small-note"><b>${derived}</b> ${esc(sup(sp).meaning || "")}</div>` +
        Object.entries(sp.classes).filter(([, c]) => c.show_in_legend !== false)
          .map(([code, c]) => swatch(c.color, (code === "255" ? "<b>Unknown.</b> " : "") + esc(clsText(sp, code).label || code))).join("") +
        `</div>`;
    }
    if (state.on.has("regions") && regionGroup.getLayers().length) {
      html += `<div class="legend-block"><strong>Inspection areas</strong>` +
        swatch("transparent", "inspection area (400 m); chosen where change was strongest, not an unbiased sample", "border:2px solid #ff9800") + `</div>`;
    }
    if (state.on.has(OLD_CONTROL) && controlGroup.getLayers().length) {
      html += `<div class="legend-block"><strong>Old control area</strong>` +
        swatch("transparent", "<b>Invalid</b> — cannot be used as a control (dashed)", "border:2px dashed #00bcd4") + `</div>`;
    }
    html += `<div class="legend-block"><strong>Study area</strong>` +
      swatch("transparent", `Thin dashed line (optional): edge of the ${areaText()} study area${meta.study_area ? " (city unit + contiguous built-up area + Limpopo surroundings; not a flood boundary)" : ""}. There is no analysis outside it.`, "border:1px dashed #888") +
      (meta.support.length && !anyObs ? `<div class="small-note">The “Not observed” (grey) class exists only in the Landsat and GFM support layers.</div>` : "") + `</div>`;
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
  narrow.addEventListener("change", () => { if (meta) render(); });

  const fromHash = (location.hash.match(/(?:event|olay)=([\w-]+)/) || [])[1];
  const viewHash = (location.hash.match(/view=(satellite|analysis)/) || [])[1];
  if (viewHash) state.view = viewHash; // default: satellite view
  syncBase();
  setCardsOpen(false); // cards stay collapsed while an event is selected; "Change event" opens them
  // Start screen (intro.js): the globe only chooses an event; this Leaflet map is created once above and reused
  const intro = window.NFEIntro;
  if (intro) {
    await intro.init({
      events: index.events, texts,
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
  // Direct links (#event=… or the older #olay=…) open the analysis as before; otherwise the start screen is shown
  if (fromHash || !intro) await loadEvent(fromHash || index.events[0].id);
  else intro.show();

  // The address changed in the same tab (a pasted/clicked #event=… link, or Back/Forward): show that event and view.
  // The app's own address updates use replaceState/pushState, which do not fire hashchange.
  window.addEventListener("hashchange", () => {
    const id = eventInHash();
    const v = (location.hash.match(/view=(satellite|analysis)/) || [])[1];
    const introOpen = intro && !$("intro").hidden;
    if (!id) { // address without an event: the start screen (as after "Back to globe")
      if (intro && !introOpen) intro.show();
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
