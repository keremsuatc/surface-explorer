/* Surface Explorer: in-app languages (no external translation service; translations are local files in web/i18n/<lang>/).
   Keys are the English sentences themselves, written as whole sentences with {placeholders} (never assembled from word pieces).
   English is the source and the safe fallback for any missing key.
   API (window.I18N): ready(), lang, t(key, vars), tx(data), fmt.*, apply(root), set(lang), picker(box), onChange(fn), LANGS. */
(function () {
  "use strict";
  const LANGS = [
    { code: "en", name: "English" },
    { code: "tr", name: "Türkçe" },
    { code: "fr", name: "Français" },
    { code: "de", name: "Deutsch" },
    { code: "es", name: "Español" },
  ];
  const CODES = LANGS.map((l) => l.code);
  const KEY = "surface-explorer.lang";
  const FILES = ["ui", "data"];
  const V = "68";
  let memory = null;      // used when storage is not available (private mode, blocked storage)
  let lang = "en", dict = {};
  const cache = {};
  const listeners = [];
  const norm = (s) => String(s).replace(/\s+/g, " ").trim();

  function stored() {
    try { const v = window.localStorage.getItem(KEY); if (CODES.includes(v)) return v; } catch (e) { /* no storage */ }
    return CODES.includes(memory) ? memory : null;
  }
  function store(v) {
    memory = v;
    try { window.localStorage.setItem(KEY, v); } catch (e) { /* kept in memory for this visit */ }
  }
  async function load(code) {
    if (code === "en") return {};
    if (cache[code]) return cache[code];
    const parts = await Promise.all(FILES.map((f) => fetch(`i18n/${code}/${f}.json?v=${V}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))));
    const d = {};
    for (const p of parts) for (const [k, v] of Object.entries(p)) if (typeof v === "string" && v) d[norm(k)] = v;
    cache[code] = d;
    return d;
  }
  // t("Next: {step} →", { step }) → the translated whole sentence with the values filled in
  function t(key, vars) {
    const k = norm(key);
    let s = Object.prototype.hasOwnProperty.call(dict, k) ? dict[k] : key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, n) => (n in vars ? String(vars[n]) : m));
    return s;
  }
  // Data files (event texts, Follow the Water texts): every string that has a translation is replaced; ids, paths and numbers stay
  function tx(data) {
    if (lang === "en" || data == null) return data;
    if (typeof data === "string") { const k = norm(data); return Object.prototype.hasOwnProperty.call(dict, k) ? dict[k] : data; }
    if (Array.isArray(data)) return data.map(tx);
    if (typeof data === "object") { const o = {}; for (const [k, v] of Object.entries(data)) o[k] = tx(v); return o; }
    return data;
  }
  // Dates and numbers in the chosen language (ISO dates "2026-07-12"; noon UTC so no time zone moves the day)
  const dt = (iso) => new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  const F = (opts) => new Intl.DateTimeFormat(lang, { timeZone: "UTC", ...opts });
  const fmt = {
    day: (iso, withYear = true) => F({ day: "numeric", month: "long", ...(withYear ? { year: "numeric" } : {}) }).format(dt(iso)),
    short: (iso, withYear = false) => F({ day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) }).format(dt(iso)),
    month: (iso) => F({ month: "long", year: "numeric" }).format(dt(iso)),
    num: (x, max = 2) => Number(x).toLocaleString(lang, { maximumFractionDigits: max }),
    pct: (x, max = 1) => Number(x).toLocaleString(lang, { style: "percent", maximumFractionDigits: max }),
  };
  fmt.pair = (a, b) => (a.slice(0, 4) === b.slice(0, 4) ? `${fmt.day(a, false)} → ${fmt.day(b)}` : `${fmt.day(a)} → ${fmt.day(b)}`);

  // Static page text: elements marked data-i18n (their English content is the key) and data-i18n-attr="aria-label,title,…"
  function apply(root) {
    root = root || document;
    for (const el of root.querySelectorAll("[data-i18n]")) {
      if (el.dataset.i18nSrc === undefined) el.dataset.i18nSrc = el.innerHTML;
      el.innerHTML = lang === "en" ? el.dataset.i18nSrc : t(el.dataset.i18nSrc);
    }
    for (const el of root.querySelectorAll("[data-i18n-attr]")) {
      for (const a of el.dataset.i18nAttr.split(",")) {
        const src = `i18nSrc${a.replace(/(^|-)(\w)/g, (m, d, c) => c.toUpperCase())}`;
        if (el.dataset[src] === undefined) el.dataset[src] = el.getAttribute(a) || "";
        el.setAttribute(a, t(el.dataset[src]));
      }
    }
    document.documentElement.lang = lang;

  }
  async function set(code, opts = {}) {
    if (!CODES.includes(code)) code = "en";
    const d = await load(code);
    lang = code; dict = d;
    if (opts.save !== false) store(code);
    // a language in the address (?lang=…) must follow the choice, or a reload would bring the old one back
    try {
      const u = new URL(location.href);
      if (u.searchParams.has("lang") && u.searchParams.get("lang") !== code) { u.searchParams.set("lang", code); history.replaceState(history.state, "", u.pathname + u.search + u.hash); }
    } catch (e) { /* address unchanged */ }
    apply(document);
    for (const fn of listeners) { try { fn(lang); } catch (e) { if (window.console) console.warn(e); } }
  }
  // v61: one visible language button ("Türkçe ▾"); the other languages appear when it opens (menu button pattern:
  // Enter/Space/↓ open, ↑/↓ move, Enter chooses, Esc or a click elsewhere closes)
  function picker(box) {
    if (!box || box.querySelector(".lang-btn")) return;
    const id = `lang-${Math.random().toString(36).slice(2, 8)}`;
    box.classList.add("lang-pick");
    box.innerHTML = `<button type="button" class="lang-btn" id="${id}" aria-haspopup="true" aria-expanded="false" aria-controls="${id}-m"></button>` +
      `<ul class="lang-menu" id="${id}-m" role="menu" aria-labelledby="${id}" hidden>` +
      LANGS.map((l) => `<li role="none"><button type="button" role="menuitemradio" class="lang-opt" lang="${l.code}" data-lang="${l.code}">${l.name}</button></li>`).join("") + `</ul>`;
    const btn = box.querySelector(".lang-btn"), menu = box.querySelector(".lang-menu");
    const opts = () => [...menu.querySelectorAll(".lang-opt")];
    const sync = () => {
      const cur = LANGS.find((l) => l.code === lang);
      btn.innerHTML = `<span lang="${lang}">${cur.name}</span><span aria-hidden="true">▾</span>`;
      btn.setAttribute("aria-label", `${cur.name} — ${t("Language")}`);
      for (const o of opts()) o.setAttribute("aria-checked", String(o.dataset.lang === lang));
    };
    const close = (focus) => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); if (focus) btn.focus(); };
    const open = (k) => { menu.hidden = false; btn.setAttribute("aria-expanded", "true"); const o = opts(); (k === "last" ? o[o.length - 1] : o.find((x) => x.dataset.lang === lang) || o[0]).focus(); };
    btn.addEventListener("click", () => (menu.hidden ? open() : close()));
    btn.addEventListener("keydown", (e) => { if (e.key === "ArrowDown") { e.preventDefault(); open(); } else if (e.key === "ArrowUp") { e.preventDefault(); open("last"); } });
    menu.addEventListener("keydown", (e) => {
      const o = opts(), k = o.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); o[(k + 1) % o.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); o[(k - 1 + o.length) % o.length].focus(); }
      else if (e.key === "Home") { e.preventDefault(); o[0].focus(); }
      else if (e.key === "End") { e.preventDefault(); o[o.length - 1].focus(); }
      else if (e.key === "Escape") { e.preventDefault(); close(true); }
      else if (e.key === "Tab") close(false);
    });
    menu.addEventListener("click", (e) => { const o = e.target.closest(".lang-opt"); if (!o) return; close(true); if (o.dataset.lang !== lang) set(o.dataset.lang); });
    document.addEventListener("click", (e) => { if (!box.contains(e.target)) close(false); });
    listeners.push(sync);
    sync();
  }
  // First visit: a plain welcome screen with the five languages; one tap saves the choice and goes on to where the person was going
  function chooser() {
    return new Promise((resolve) => {
      const s = document.createElement("section");
      s.className = "lang-screen";
      s.setAttribute("aria-labelledby", "lang-screen-h");
      s.innerHTML = `<div class="ls-box"><h1 id="lang-screen-h" tabindex="-1">Surface Explorer</h1>` +
        `<ul class="ls-list" role="list">` + LANGS.map((l) => `<li><button type="button" class="ls-btn" lang="${l.code}" data-lang="${l.code}">${l.name}</button></li>`).join("") +
        `</ul></div>`;
      document.body.appendChild(s);
      document.body.classList.add("lang-open");
      s.querySelector("h1").focus({ preventScroll: true });
      let busy = false;
      s.addEventListener("click", async (e) => {
        const b = e.target.closest(".ls-btn");
        if (!b || busy) return;
        busy = true;
        b.setAttribute("aria-busy", "true");
        await set(b.dataset.lang);
        s.remove();
        document.body.classList.remove("lang-open");
        resolve(lang);
      });
    });
  }
  let readyP = null;
  // Resolves once a language is known: the saved one, or the one chosen on the welcome screen. ?lang=xx (tests, shared links) wins.
  function ready() {
    if (readyP) return readyP;
    const q = new URLSearchParams(location.search).get("lang");
    const pick = CODES.includes(q) ? q : stored();
    readyP = pick ? set(pick, { save: !!q }).then(() => lang) : chooser();
    return readyP;
  }
  window.I18N = { ready, t, tx, fmt, apply, set, picker, LANGS, onChange: (fn) => listeners.push(fn), get lang() { return lang; }, stored, norm };
})();
