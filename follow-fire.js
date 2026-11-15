/* v70: Follow the Fire — 3D scene of dated observations (data/<event>/follow_water.json with "kind": "fire"; first used for the Palisades Fire).
   Built from the event's catalog record (catalog/events/<event>.json, web.follow) by pipeline/export/build_event_web.py <event> follow.
   Same player as the route scene (follow-route.js): everything on screen is a function of one slider value t (0..1) and of the perimeter switch;
   the same slider value gives the same picture forwards and backwards. Stops are at observation times. Between stops only the camera moves:
   the data change at their own times — the dated image on the terrain is the latest one taken by then, the VIIRS heat detections are those
   detected by then (pass by pass). The final official perimeter appears only at the last stop (no dated progression perimeters were found)
   and can be switched off there; the camera does not move when it is. No fire front is drawn and the dots are never joined. */
window.FollowFire = function (ctx) {
  "use strict";
  const { raw, I, $, esc, setBack, loadLib, EVENT } = ctx;
  const tr = (k, v) => I.t(k, v);
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const ease = (k) => { k = clamp(k); return k * k * (3 - 2 * k); };
  const mix = (a, b, k) => a + (b - a) * k;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const slider = $("fw-time");
  const LOAD_TIMEOUT_MS = 25000;
  const CENTER_M = 200; // camera centre height (m): about the middle of the slopes in this frame
  const C = { dot: "#ff5a1f", dotLine: "#2b0a00", perim: "#ffd166" };
  let data = null, map = null, ready = false, failed = false, t = 0, anim = 0, pending = 0, showPerim = true;
  let cams = null, lastCam = "", lastCount = -1, lastImg = "", lastVis = "", stageBtns = [], labels = [];
  const paint = new Map();
  const S = raw.stops, W = S.map((s) => s.t), IM = raw.images.map((x) => ({ ...x, ms: Date.parse(x.time) }));
  const ST = S.map((s) => Date.parse(s.time));
  let passMs = []; // sorted detection times (ms), filled when the detections are loaded

  // ---- where the slider is, and the time it stands for ----
  function phase(v) {
    for (let i = 0; i < S.length; i++) {
      if (v <= W[i][1] + 1e-9) return v >= W[i][0] - 1e-9 ? { hold: true, i } : { hold: false, i: i - 1, k: (v - W[i - 1][1]) / Math.max(1e-9, W[i][0] - W[i - 1][1]) };
    }
    return { hold: true, i: S.length - 1 };
  }
  const nowMs = (v) => { const ph = phase(v); return ph.hold ? ST[ph.i] : mix(ST[ph.i], ST[ph.i + 1], ph.k); };
  const imageAt = (ms) => IM.reduce((a, x) => (x.ms <= ms ? x : a), IM[0]);
  const countAt = (ms) => { let lo = 0, hi = passMs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (passMs[m] <= ms) lo = m + 1; else hi = m; } return lo; };
  const perimOn = (v) => { const ph = phase(v); return ph.hold && S[ph.i].perimeter ? showPerim : false; };

  // ---- camera: from the slider value only (jumpTo); between two stops the view eases from one framing to the next ----
  function lerpCam(a, b, k) {
    const db = ((b.bearing - a.bearing) % 360 + 540) % 360 - 180;
    return { center: [mix(a.center[0], b.center[0], k), mix(a.center[1], b.center[1], k)], zoom: mix(a.zoom, b.zoom, k), pitch: mix(a.pitch, b.pitch, k), bearing: (a.bearing + db * k + 360) % 360 };
  }
  function camAt(v) {
    const ph = phase(v);
    if (ph.hold) return cams[ph.i];
    const a = cams[ph.i], b = cams[ph.i + 1];
    if (reduced.matches) return ph.k < 0.5 ? a : b;
    const c = lerpCam(a, b, ease(ph.k));
    c.zoom -= 0.5 * Math.sin(Math.PI * ph.k); // a little higher on the way: the whole area stays in view
    return c;
  }
  function frame() {
    const box = map.getContainer(), narrow = box.clientWidth < 600, h = box.clientHeight;
    const pad = narrow ? { top: Math.round(h * 0.2), bottom: Math.round(h * 0.2), left: 14, right: 14 } : { top: 84, bottom: 70, left: 60, right: 60 };
    cams = S.map((s) => {
      const c = map.cameraForBounds(s.fit_bounds, { bearing: s.bearing, padding: pad });
      return { center: [c.center.lng, c.center.lat], zoom: Math.min(14, c.zoom + (s.pitch > 30 ? 0.2 : 0)), pitch: narrow ? s.pitch - 4 : s.pitch, bearing: s.bearing };
    });
    lastCam = "";
  }
  function setCamera(v) {
    const c = camAt(v);
    const key = [c.center[0].toFixed(6), c.center[1].toFixed(6), c.zoom.toFixed(4), c.pitch.toFixed(2), c.bearing.toFixed(2)].join();
    if (key === lastCam) return;
    lastCam = key;
    map.jumpTo({ ...c, elevation: CENTER_M * raw.exaggeration });
  }
  function setP(id, prop, val) {
    const k = id + "|" + prop, s = typeof val === "number" ? val.toFixed(4) : JSON.stringify(val);
    if (paint.get(k) === s) return false;
    paint.set(k, s);
    map.setPaintProperty(id, prop, val);
    return true;
  }
  const near = (v, w, m = 0.03) => clamp(Math.min((v - (w[0] - m)) / m, ((w[1] + m) - v) / m));
  const shownAt = (v, ids) => Math.max(0, ...S.map((s, i) => (ids.includes(s.id) ? near(v, W[i]) : 0)));
  const fmtTime = (ms) => { const d = new Date(ms); return `${I.fmt.day(d.toISOString().slice(0, 10))}`; };

  function draw() {
    if (!ready) return;
    const v = t, ph = phase(v), ms = nowMs(v), img = imageAt(ms), n = countAt(ms), pOn = perimOn(v);
    let changed = false;
    if (img.file !== lastImg) { // the dated image on the terrain: the latest one taken by now
      lastImg = img.file;
      IM.forEach((x, i) => setP("ff-img" + i, "raster-opacity", x.file === img.file ? 1 : 0));
      changed = true;
    }
    if (n !== lastCount) { // heat detections up to now, pass by pass
      lastCount = n;
      map.setFilter("ff-dots", ["<", ["get", "i"], n]);
      changed = true;
    }
    changed = setP("ff-perim-line", "line-opacity", pOn ? 1 : 0) || changed;
    changed = setP("ff-perim-fill", "fill-opacity", pOn ? 0.14 : 0) || changed;
    setCamera(v);
    if (changed) refreshDrape(); else map.triggerRepaint();
    for (const L_ of labels) {
      const s = shownAt(v, L_.p.stops).toFixed(3);
      if (L_.el.style.opacity !== s) L_.el.style.opacity = s;
    }
    // key: only what is on screen
    const vis = [true, n > 0, pOn].map(Number).join("") + img.file;
    if (vis !== lastVis) {
      lastVis = vis;
      const k = $("fw-stage").querySelector(".fw-key");
      k.querySelector('[data-k="img"] span').textContent = tr("Image of {date} · {source}", { date: I.fmt.short(img.label, true), source: img.source });
      k.querySelector('[data-k="dots"]').hidden = n === 0;
      k.querySelector('[data-k="perim"]').hidden = !pOn;
    }
    // panel on the map: where, then when, then what is shown
    const place = ph.hold ? data.stops[ph.i].place : `${data.stops[ph.i].place} → ${data.stops[ph.i + 1].place}`;
    const cur = ph.hold ? ph.i : (ph.k < 0.5 ? ph.i : ph.i + 1);
    const what = ph.hold && S[ph.i].kind === "record" ? tr("Incident record, not a satellite image") : tr("{n} heat detections so far", { n: I.fmt.num(n, 0) });
    const panel = `<b>${esc(place)}</b><span class="frd-date">${esc(fmtTime(ms))}</span><span class="frd-gap">${esc(what)}</span>`;
    if ($("fr-date").innerHTML !== panel) $("fr-date").innerHTML = panel;
    let text;
    if (ph.hold) { const s = data.stops[ph.i]; text = `<b>${esc(s.place)}</b> · ${esc(I.fmt.short(S[ph.i].time.slice(0, 10)))}<br>${esc(s.sentence)}`; }
    else text = esc(data.texts.travel);
    if ($("fw-caption-text").innerHTML !== text) $("fw-caption-text").innerHTML = text;
    stageBtns.forEach((b, i) => b.setAttribute("aria-pressed", String(i === cur)));
    // the perimeter switch belongs to the last stop: visible there only
    const pb = $("ff-perim-btn"), atFinal = ph.hold && S[ph.i].perimeter;
    if (pb.hidden === atFinal) pb.hidden = !atFinal;
    slider.setAttribute("aria-valuetext", `${data.stops[cur].chip}: ${$("fw-caption-text").textContent}`);
  }
  function refreshDrape() {
    try { const sc = map.terrain && map.terrain.sourceCache; if (sc && sc.freeRtt) sc.freeRtt(); } catch (e) { /* other version */ }
    map.triggerRepaint();
  }
  function setT(v, fromSlider) { t = clamp(v); if (!fromSlider) slider.value = String(Math.round(t * 1000)); draw(); }
  slider.addEventListener("input", () => {
    cancelAnimationFrame(anim);
    t = clamp(Number(slider.value) / 1000);
    if (!pending) pending = requestAnimationFrame(() => { pending = 0; draw(); });
  });
  const target = (i) => (i === 0 ? 0 : i === S.length - 1 ? 1 : (W[i][0] + W[i][1]) / 2);
  function goTo(i) {
    cancelAnimationFrame(anim);
    const from = t, to = target(i);
    if (reduced.matches || Math.abs(to - from) < 1e-4) { setT(to); return; }
    const t0 = performance.now(), dur = Math.min(8000, Math.max(1200, 8000 * Math.abs(to - from)));
    const step = (now) => { const k = clamp((now - t0) / dur); setT(from + (to - from) * k); if (k < 1) anim = requestAnimationFrame(step); };
    anim = requestAnimationFrame(step);
  }
  function setPerim(on) {
    showPerim = !!on;
    const b = $("ff-perim-btn");
    b.setAttribute("aria-pressed", String(showPerim));
    b.textContent = showPerim ? tr("Hide the fire perimeter") : tr("Show the fire perimeter");
    draw();
  }

  // ---- page furniture ----
  function buildControls() {
    const box = $("fw-stages"), ticks = $("fw-ticks");
    box.style.gridTemplateColumns = `repeat(${S.length}, minmax(0, 1fr))`;
    box.innerHTML = data.stops.map((s, i) => `<button type="button" class="fw-btn fw-stage-btn" data-stage="${i}" aria-pressed="false">${esc(s.chip)}</button>`).join("");
    stageBtns = [...box.querySelectorAll(".fw-stage-btn")];
    stageBtns.forEach((b) => b.addEventListener("click", () => { if (ready) goTo(Number(b.dataset.stage)); }));
    ticks.style.gridTemplateColumns = S.map((s, i) => `${(((i + 1 < S.length ? W[i + 1][0] : 1) - W[i][0]) * 100).toFixed(2)}fr`).join(" ");
    ticks.innerHTML = data.stops.map((s) => `<span>${esc(s.chip)}</span>`).join("");
    if (!$("ff-perim-btn")) box.insertAdjacentHTML("afterend", `<button type="button" id="ff-perim-btn" class="fw-btn fr-obs-btn" aria-pressed="true" hidden></button>`);
    $("ff-perim-btn").textContent = showPerim ? tr("Hide the fire perimeter") : tr("Show the fire perimeter");
    $("ff-perim-btn").onclick = () => setPerim(!showPerim);
    if (!$("fr-credit")) $("fw-controls").insertAdjacentHTML("beforeend", `<p id="fr-credit" class="fr-credit" lang="en"></p>`);
  }
  // credits: the background apart from the dated images and the fire data
  const creditText = () => `${tr("Basemap")}: ${raw.background.credit} · ${tr("Dated images")}: Copernicus Sentinel-2 (modified, 2025), Landsat-9 (USGS) · ` +
    `${tr("Layers")}: NASA FIRMS (VIIRS), NIFC WFIGS, CAL FIRE · Elevation: Terrain Tiles (USGS 3DEP) · MapLibre`;
  function buildKey() {
    $("fw-stage").querySelector(".fw-key").innerHTML =
      `<li data-k="img"><i class="fr-k ff-k-img"></i><span></span></li>` +
      `<li data-k="dots"><i class="fr-k ff-k-dots"></i><span>${esc(data.texts.detections_label)}<span class="k-more"> · ${esc(data.texts.detections_note)}</span></span></li>` +
      `<li data-k="perim"><i class="fr-k ff-k-perim"></i><span>${esc(data.texts.perimeter_label)}<span class="k-more"> · ${esc(data.texts.perimeter_note)}</span></span></li>` +
      `<li id="fw-credit" class="fw-credit"></li>`;
    $("fw-credit").textContent = creditText();
    $("fr-credit").textContent = creditText();
    lastVis = "";
  }
  function buildSources() {
    const vals = { x: I.fmt.num(raw.method_values.x, 1) };
    const meth = data.method.map(([h, p]) => `<h3>${esc(h)}</h3><p>${esc(String(p).replace(/\{(\w+)\}/g, (m, k) => (k in vals ? vals[k] : m)))}</p>`).join("");
    const stops = data.stops.map((s, i) => `<li><b>${esc(s.place)}</b> · ${esc(I.fmt.day(S[i].time.slice(0, 10)))} (${esc(S[i].time.slice(11, 16))} UTC): ${esc(s.sentence)} ` +
      s.sources.map((q) => `<a href="${esc(q.url)}" rel="noopener">${esc(q.label)}</a>`).join(" · ") + `</li>`).join("");
    const imgs = raw.images.map((x) => `<li>${esc(I.fmt.day(x.label))} · ${esc(x.source)} · ${esc(x.scene)} · ${esc(tr("{m} m pixels", { m: I.fmt.num(x.gsd_m, 0) }))}</li>`).join("");
    const src = data.sources.map((q) => `<li><a href="${esc(q.url)}" rel="noopener">${esc(q.publisher)}</a>: ${esc(q.what)}</li>`).join("");
    $("fw-sources-body").innerHTML = `${meth}<h3>${esc(tr("Stops and sources"))}</h3><ul>${stops}</ul>
      <h3>${esc(tr("Dated images"))}</h3><ul>${imgs}</ul>
      <h3>${esc(tr("Progression perimeters"))}</h3><p>${esc(data.progression.checked)}</p>
      <h3>${esc(tr("Data"))}</h3><p>${esc(data.background.note)}</p><ul>${src}</ul>
      <p class="fw-attrib" lang="en">Elevation: <a href="https://registry.opendata.aws/terrain-tiles/" rel="noopener">Terrain Tiles</a> (Mapzen/Tilezen on AWS Open Data; USGS 3DEP in the United States).
      Background: ${esc(raw.background.credit)}. Dated images: contains modified Copernicus Sentinel data 2025; Landsat-9 courtesy of the U.S. Geological Survey.
      Detections: NASA FIRMS. Perimeter: NIFC WFIGS. Drawn with MapLibre GL JS.</p>`;
  }
  function localize() {
    data = { stops: I.tx(raw.stops), texts: I.tx(raw.texts), method: I.tx(raw.method), sources: I.tx(raw.sources), background: I.tx(raw.background),
      places: I.tx(raw.places), progression: I.tx(raw.progression) };
  }
  function writeTexts() {
    $("fw-sub").textContent = data.texts.sub;
    document.querySelector(".fw-titles h1").textContent = tr("Follow the Fire");
    document.title = tr("Follow the Fire — {place} — Surface Explorer", { place: data.texts.place_title });
    $("fw-map").setAttribute("aria-label", tr("3D terrain view: {sub}. Dated satellite images, heat detections and, at the end, the mapped fire perimeter.", { sub: data.texts.sub }));
    document.querySelector(".fw-mode").textContent = tr("Dated observations");
    $("fw-badge").innerHTML = `<span>${esc(tr("Dated observations"))}</span>`;
    $("fw-badge").classList.add("obs");
    setBack();
    buildControls();
    buildKey();
    buildSources();
    labels.forEach((L_, i) => { L_.el.textContent = data.places[i].name; });
    lastVis = "";
    if (ready) draw();
  }
  I.onChange(() => { localize(); writeTexts(); });

  function fail(why) {
    if (failed) return;
    failed = true; ready = false;
    cancelAnimationFrame(anim); cancelAnimationFrame(pending);
    $("fw-fallback-why").textContent = why;
    $("fw-fallback").hidden = false;
    $("fw-loading").hidden = true;
    $("fw-controls").setAttribute("aria-disabled", "true");
    slider.disabled = true; stageBtns.forEach((b) => { b.disabled = true; });
    try { map && map.remove(); } catch (e) { /* gone */ }
    map = null;
  }

  function start(maplibregl, dots) {
    const url = (f) => `data/${f.includes("/") ? f : `${EVENT}/${f}`}`;
    const [[s, w], [n, e]] = raw.frame, corners = [[w, n], [e, n], [e, s], [w, s]];
    const dem = { type: "raster-dem", tiles: [raw.elevation.tile_url], encoding: "terrarium", tileSize: 256, maxzoom: raw.elevation.maxzoom };
    const sources = { terrain: dem, shade: dem,
      bg: { type: "raster", tiles: [raw.background.url], tileSize: 256, maxzoom: raw.background.maxzoom },
      dots: { type: "geojson", data: dots }, perim: { type: "geojson", data: url(raw.layers.perimeter) } };
    const layers = [{ id: "bg", type: "background", paint: { "background-color": "#16232e" } },
      { id: "ff-bg", type: "raster", source: "bg", paint: { "raster-opacity": 1, "raster-fade-duration": 0 } }];
    IM.forEach((x, i) => { // each dated image on its own extent (EPSG:3857 grid over the frame), shown when it is the latest
      sources["img" + i] = { type: "image", url: url(x.file), coordinates: corners };
      layers.push({ id: "ff-img" + i, type: "raster", source: "img" + i, paint: { "raster-opacity": 0, "raster-fade-duration": 0, "raster-resampling": "linear" } });
    });
    layers.push(
      { id: "ff-shade", type: "hillshade", source: "shade", paint: { "hillshade-exaggeration": 0.25, "hillshade-shadow-color": "rgba(0,0,0,0.45)", "hillshade-highlight-color": "rgba(255,255,255,0.12)" } },
      { id: "ff-perim-fill", type: "fill", source: "perim", paint: { "fill-color": C.perim, "fill-opacity": 0 } },
      { id: "ff-perim-line", type: "line", source: "perim", paint: { "line-color": C.perim, "line-width": 2.6, "line-opacity": 0 } },
      { id: "ff-dots", type: "circle", source: "dots", filter: ["<", ["get", "i"], 0], paint: {
        "circle-color": C.dot, "circle-opacity": 0.9, "circle-stroke-color": C.dotLine, "circle-stroke-width": 0.6, "circle-stroke-opacity": 0.7,
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 1, 12, 1.5, 14, 2.4], "circle-pitch-alignment": "map" } });
    // centerClampedToGround false + a fixed centre height: MapLibre would otherwise take the camera centre's height from whichever terrain tile is
    // in memory, which depends on how the slider got there (a few pixels of shift). With a fixed height the picture depends on t only.
    map = new maplibregl.Map({ container: "fw-map", interactive: false, attributionControl: false, maxPitch: 70, fadeDuration: 0, pixelRatio: Math.min(window.devicePixelRatio || 1, 2), centerClampedToGround: false,
      style: { version: 8, transition: { duration: 0, delay: 0 }, sources, layers, terrain: { source: "terrain", exaggeration: raw.exaggeration },
        sky: { "sky-color": "#0e1820", "horizon-color": "#1c2b38", "fog-color": "#16232e", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.5, "fog-ground-blend": 0.35 } } });
    const timer = setTimeout(() => { if (!ready) fail(tr("The terrain took too long to load. Check the internet connection and try again.")); }, LOAD_TIMEOUT_MS);
    let demErrors = 0;
    map.on("error", (ev) => {
      if (ready) return;
      if (ev && ev.sourceId === "bg") return;
      if (ev && (/^img\d/.test(ev.sourceId || "") || ev.sourceId === "perim" || ev.sourceId === "dots")) { clearTimeout(timer); fail(tr("The satellite layer could not be loaded.")); return; }
      if (ev && (ev.sourceId === "terrain" || ev.sourceId === "shade")) { if (++demErrors >= 3) { clearTimeout(timer); fail(tr("The elevation data could not be loaded. Check the internet connection and try again.")); } }
    });
    map.on("load", () => {
      // MapLibre 5.6.0 with terrain: a raster tile found only in the cache is put back before it is used as a fallback (as in follow-route.js)
      try {
        for (const sc of Object.values(map.style.sourceCaches || {})) {
          if (!sc || typeof sc._getLoadedTile !== "function" || typeof sc._addTile !== "function") continue;
          const get = sc._getLoadedTile.bind(sc);
          sc._getLoadedTile = (id) => { const tile = get(id); if (tile && !sc._tiles[tile.tileID.key]) { sc._addTile(tile.tileID); return sc._tiles[tile.tileID.key] || null; } return tile; };
        }
      } catch (err) { /* other version */ }
      frame();
      setCamera(t);
      // labels at the ground height measured by the builder: the same slider value puts a label on the same pixel
      const stage = $("fw-stage"), shift = { bottom: "translate(-50%, -100%) translateY(-4px)", top: "translate(-50%, 4px)", left: "translate(6px, -50%)", right: "translate(-100%, -50%) translateX(-6px)" };
      labels = raw.places.map((p, i) => {
        const el = document.createElement("div");
        el.className = "fw-label fw-fixed-label fr-label fr-" + p.kind; el.textContent = data.places[i].name; el.style.opacity = "0";
        stage.appendChild(el);
        return { el, p, ll: new maplibregl.LngLat(p.lonlat[0], p.lonlat[1]), h: (p.ground_m || 0) * raw.exaggeration, shift: shift[p.anchor || "bottom"] };
      });
      const place = () => {
        for (const L_ of labels) {
          let q;
          try { q = map.transform.locationToScreenPoint(L_.ll, { getElevationForLngLatZoom: () => L_.h }); } catch (err) { q = map.project(L_.ll); }
          const tf = `translate(${Math.round(q.x)}px, ${Math.round(q.y)}px) ${L_.shift}`;
          if (L_.el.style.transform !== tf) L_.el.style.transform = tf;
        }
      };
      map.on("render", place);
      let lw = 0;
      map.on("render", () => { if (lw) return; lw = requestAnimationFrame(() => { lw = 0; if (map && ready) $("fr-loading").hidden = map.areTilesLoaded(); }); });
      map.on("idle", () => { if (ready) $("fr-loading").hidden = true; });
      map.once("idle", () => {
        clearTimeout(timer);
        if (failed) return;
        ready = true;
        $("fw-loading").hidden = true;
        lastImg = ""; lastCount = -1;
        draw();
      });
    });
    let rz = 0;
    window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (!map) return; map.resize(); frame(); draw(); }, 120); });
    window.ftw = { get map() { return map; }, get t() { return t; }, get ready() { return ready; }, get showPerim() { return showPerim; },
      phase: () => phase(t), state: () => { const ms = nowMs(t); return { now: new Date(ms).toISOString(), image: imageAt(ms).label, detections: countAt(ms), perimeter: perimOn(t) }; },
      setT, setPerim, goTo, data: raw, EVENT, kind: "fire" };
  }

  // ---- start ----
  document.body.classList.add("fr-route", "ff-fire");
  $("fw-stage").insertAdjacentHTML("beforeend", `<p id="fr-date" class="fr-date" aria-hidden="true"></p><p id="fr-loading" class="fr-loading" role="status" hidden></p>`);
  $("fr-loading").textContent = tr("Loading the terrain…");
  $("fw-media").hidden = true;
  localize();
  writeTexts();
  $("fw-caption-text").textContent = data.texts.travel;
  if (!ctx.webglOk()) { fail(tr("This browser has no WebGL, which the 3D terrain needs.")); return; }
  // detections: numbered in time order, so "detected by now" is one filter on the number (i < count)
  const dotsP = fetch(`data/${EVENT}/${raw.layers.firms}`).then((r) => { if (!r.ok) throw new Error("dots"); return r.json(); }).then((gj) => {
    gj.features.sort((a, b) => Date.parse(a.properties.t) - Date.parse(b.properties.t));
    gj.features.forEach((f, i) => { f.properties.i = i; });
    passMs = gj.features.map((f) => Date.parse(f.properties.t));
    return gj;
  });
  Promise.all([loadLib(), dotsP]).then(([lib, dots]) => start(lib, dots))
    .catch(() => fail(tr("The scene files could not be loaded. Check the internet connection and try again.")));
};
