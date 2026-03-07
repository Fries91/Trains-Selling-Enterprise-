// ==UserScript==
// @name         T.S.E Headquarters 🏤
// @namespace    fries91-tse-hq
// @version      8.4.5
// @description  T.S.E Headquarters hub overlay. PDA friendly. Companies, trains, HoF search, notes, company keys, settings.
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @connect      trains-selling-enterprise.onrender.com
// @downloadURL  https://raw.githubusercontent.com/Fries91/Trains-Selling-Enterprise-/main/static/tse-headquarters.user.js
// @updateURL    https://raw.githubusercontent.com/Fries91/Trains-Selling-Enterprise-/main/static/tse-headquarters.user.js
// ==/UserScript==

(function () {
  "use strict";

  if (window.__TSE_HQ_LOADED__) return;
  window.__TSE_HQ_LOADED__ = true;

  const oldBadge = document.getElementById("tse_hq_badge");
  const oldPanel = document.getElementById("tse_hq_panel");
  if (oldBadge) oldBadge.remove();
  if (oldPanel) oldPanel.remove();

  const DEFAULT_BASE_URL = "https://trains-selling-enterprise.onrender.com";

  const K_ADMIN = "tse_hq_admin_v1";
  const K_API = "tse_hq_api_v1";
  const K_TOKEN = "tse_hq_token_v1";
  const K_USER = "tse_hq_user_v1";
  const K_UI = "tse_hq_ui_v1";
  const K_NOTES = "tse_hq_notes_v1";

  const uiDefault = {
    open: false,
    tab: "companies",
    badge: { x: 14, y: 165 },
    panel: { x: 10, y: 72 }
  };

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function gmJsonGet(key, fallback) {
    try {
      const raw = GM_getValue(key, "");
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  function gmJsonSet(key, value) {
    GM_setValue(key, JSON.stringify(value));
  }

  function getBaseUrl() {
    return DEFAULT_BASE_URL;
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function shortTime(iso) {
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso || "");
      return d.toLocaleString();
    } catch {
      return String(iso || "");
    }
  }

  function parseCompanyIds(text) {
    const raw = String(text || "")
      .split(/[\s,]+/g)
      .map(x => x.trim())
      .filter(Boolean);

    const out = [];
    for (const x of raw) {
      const s = x.replace(/[^\d]/g, "").trim();
      if (!s) continue;
      if (!out.includes(s)) out.push(s);
    }
    return out;
  }

  function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function statTotal(x) {
    return num(x.manual_labor) + num(x.intelligence) + num(x.endurance);
  }

  function http(method, url, { headers = {}, data = null, timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data,
        timeout,
        onload: (r) => {
          const text = r.responseText || "";
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: r.status, text, json, headers: r.responseHeaders || "" });
        },
        onerror: reject,
        ontimeout: () => reject(new Error("Request timeout")),
      });
    });
  }

  GM_addStyle(`
    :root{
      --tse-bg:#0b1220;
      --tse-card:#0f1b33;
      --tse-text:#eef3ff;
      --tse-muted:#aebddd;
      --tse-line:rgba(255,255,255,.10);
      --tse-gold:#d6b35a;
      --tse-gold2:#f2d487;
      --tse-red:#ff5968;
      --tse-green:#34d57a;
      --tse-shadow:0 18px 60px rgba(0,0,0,.55);
      --tse-font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
    }

    #tse_hq_badge{
      position:fixed;
      z-index:2147483647;
      left:14px;
      top:165px;
      width:46px;
      height:46px;
      border-radius:14px;
      background:
        radial-gradient(120% 120% at 25% 12%, rgba(242,212,135,.38), rgba(214,179,90,.16) 40%, rgba(15,27,51,.96) 75%),
        linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,0));
      border:1px solid rgba(214,179,90,.34);
      box-shadow:0 10px 28px rgba(0,0,0,.55);
      display:flex;
      align-items:center;
      justify-content:center;
      cursor:pointer;
      user-select:none;
      -webkit-user-select:none;
      touch-action:none;
      -webkit-touch-callout:none;
      backdrop-filter:blur(6px);
      font-size:25px;
      line-height:1;
    }
    #tse_hq_badge .emoji{
      pointer-events:none;
      transform:translateY(-1px);
      filter:drop-shadow(0 2px 6px rgba(0,0,0,.45));
    }
    #tse_hq_badge .dot{
      position:absolute;
      right:4px;
      top:4px;
      width:8px;
      height:8px;
      border-radius:99px;
      background:var(--tse-red);
      box-shadow:0 0 0 2px rgba(11,18,32,.95);
      display:none;
      pointer-events:none;
    }
    #tse_hq_badge.hasDot .dot{ display:block; }

    #tse_hq_panel{
      position:fixed;
      z-index:2147483646;
      left:10px;
      top:72px;
      width:min(96vw, 560px);
      max-width:96vw;
      max-height:82vh;
      background:
        radial-gradient(120% 140% at 20% 0%, rgba(214,179,90,.10), rgba(11,18,32,.96) 60%),
        linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,0));
      border:1px solid rgba(214,179,90,.24);
      border-radius:16px;
      box-shadow:var(--tse-shadow);
      overflow:hidden;
      display:none;
      font-family:var(--tse-font);
      color:var(--tse-text);
      backdrop-filter:blur(8px);
    }

    #tse_hq_header{
      display:flex;
      gap:8px;
      align-items:center;
      padding:10px;
      border-bottom:1px solid var(--tse-line);
      background:linear-gradient(180deg, rgba(214,179,90,.12), rgba(0,0,0,0));
      cursor:move;
      user-select:none;
      touch-action:none;
    }

    #tse_hq_title{
      display:flex;
      flex-direction:column;
      gap:2px;
      min-width:0;
      line-height:1.1;
    }
    #tse_hq_title .main{
      font-weight:900;
      font-size:14px;
      letter-spacing:.2px;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }
    #tse_hq_title .sub{
      font-size:10px;
      color:var(--tse-muted);
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }

    #tse_hq_header .spacer{ flex:1; }

    .tse_btn{
      border:1px solid rgba(255,255,255,.12);
      background:rgba(15,27,51,.65);
      color:var(--tse-text);
      padding:6px 9px;
      border-radius:10px;
      cursor:pointer;
      font-weight:800;
      font-size:11px;
      user-select:none;
      flex:0 0 auto;
    }
    .tse_btn.red{ border-color:rgba(255,89,104,.35); }
    .tse_btn.gold{ border-color:rgba(214,179,90,.35); }

    #tse_hq_tabs{
      display:flex;
      gap:6px;
      padding:8px 10px;
      border-bottom:1px solid var(--tse-line);
      overflow:auto;
      -webkit-overflow-scrolling:touch;
      background:rgba(11,18,32,.55);
    }
    .tse_tab{
      flex:0 0 auto;
      padding:7px 9px;
      border-radius:999px;
      border:1px solid rgba(255,255,255,.12);
      background:rgba(15,27,51,.55);
      font-weight:900;
      font-size:11px;
      cursor:pointer;
      user-select:none;
      color:var(--tse-muted);
      white-space:nowrap;
    }
    .tse_tab.active{
      color:var(--tse-text);
      border-color:rgba(214,179,90,.35);
      background:rgba(214,179,90,.12);
    }

    #tse_hq_body{
      padding:10px;
      overflow:auto;
      max-height:calc(82vh - 94px);
      -webkit-overflow-scrolling:touch;
    }

    .tse_card{
      background:rgba(15,27,51,.58);
      border:1px solid rgba(255,255,255,.10);
      border-radius:14px;
      padding:10px;
      margin-bottom:10px;
    }
    .tse_row{
      display:flex;
      gap:8px;
      flex-wrap:wrap;
      align-items:center;
    }
    .tse_field{
      display:flex;
      flex-direction:column;
      gap:6px;
      flex:1 1 140px;
      min-width:140px;
    }
    .tse_field.narrow{
      flex:0 1 260px;
      min-width:220px;
      max-width:260px;
    }
    .tse_label{
      font-size:10px;
      color:var(--tse-muted);
      font-weight:900;
      letter-spacing:.2px;
    }
    .tse_input, .tse_select, .tse_textarea{
      width:100%;
      border-radius:10px;
      border:1px solid rgba(255,255,255,.12);
      background:rgba(11,18,32,.78);
      color:var(--tse-text);
      padding:9px;
      font-size:12px;
      outline:none;
      box-sizing:border-box;
    }
    .tse_textarea{ min-height:120px; resize:vertical; }
    .tse_textarea.small{
      min-height:86px;
      max-height:120px;
    }
    .tse_small{ font-size:11px; color:var(--tse-muted); line-height:1.35; }
    .tse_ok{ color:var(--tse-green); font-weight:900; }
    .tse_err{ color:var(--tse-red); font-weight:900; }
    .tse_hr{ height:1px; background:var(--tse-line); margin:10px 0; }

    .tse_list{ display:flex; flex-direction:column; gap:8px; }
    .tse_item{
      background:rgba(12,23,45,.68);
      border:1px solid rgba(255,255,255,.10);
      border-radius:14px;
      padding:10px;
    }
    .tse_item .top{
      display:flex;
      justify-content:space-between;
      gap:8px;
      align-items:flex-start;
    }
    .tse_item .name{ font-weight:1000; font-size:12px; }
    .tse_item .meta{ font-size:11px; color:var(--tse-muted); margin-top:2px; }
    .tse_item .actions{
      display:flex;
      gap:6px;
      align-items:center;
      flex-wrap:wrap;
      justify-content:flex-end;
    }

    .tse_grid_3{
      display:grid;
      grid-template-columns:repeat(3, minmax(0, 1fr));
      gap:6px;
      margin-top:8px;
    }
    .tse_kpi{
      background:rgba(11,18,32,.70);
      border:1px solid rgba(255,255,255,.10);
      border-radius:10px;
      padding:8px;
    }
    .tse_kpi .k{ font-size:10px; color:var(--tse-muted); font-weight:900; }
    .tse_kpi .v{ font-size:13px; font-weight:1000; margin-top:2px; }

    .tse_key_status{
      display:inline-flex;
      align-items:center;
      gap:6px;
      font-size:11px;
      color:var(--tse-muted);
      margin-top:6px;
    }
    .tse_key_status .dot{
      width:8px;
      height:8px;
      border-radius:99px;
      background:var(--tse-red);
      display:inline-block;
    }
    .tse_key_status.ok .dot{
      background:var(--tse-green);
    }

    .tse_tos{ line-height:1.45; }
    .tse_tos_grid{
      display:grid;
      grid-template-columns:130px 1fr;
      gap:6px 10px;
      margin-top:8px;
    }
    .tse_tos_k{
      color:var(--tse-gold2);
      font-weight:900;
      font-size:11px;
    }
    .tse_tos_v{
      color:var(--tse-text);
      font-size:11px;
    }

    @media (max-width: 720px){
      #tse_hq_panel{
        width:96vw;
        max-width:96vw;
        left:2vw !important;
        top:68px !important;
        max-height:84vh;
      }
      #tse_hq_body{
        max-height:calc(84vh - 94px);
      }
      .tse_grid_3{ grid-template-columns:1fr; }
      .tse_field,
      .tse_field.narrow{
        flex:1 1 100%;
        min-width:100%;
        max-width:100%;
      }
      .tse_item .top{
        flex-direction:column;
      }
      .tse_item .actions{
        width:100%;
        justify-content:flex-start;
      }
      .tse_tos_grid{
        grid-template-columns:1fr;
        gap:3px;
      }
    }
  `);

  const badge = document.createElement("div");
  badge.id = "tse_hq_badge";
  badge.innerHTML = `
    <div class="dot"></div>
    <div class="emoji">🏤</div>
  `;

  const panel = document.createElement("div");
  panel.id = "tse_hq_panel";
  panel.innerHTML = `
    <div id="tse_hq_header">
      <div id="tse_hq_title">
        <div class="main">T.S.E Headquarters</div>
        <div class="sub">made by Fries91</div>
      </div>
      <div class="spacer"></div>
      <button class="tse_btn gold" id="tse_hq_refresh">Refresh</button>
      <button class="tse_btn red" id="tse_hq_close">Close</button>
    </div>
    <div id="tse_hq_tabs"></div>
    <div id="tse_hq_body"></div>
  `;

  function mountUi() {
    if (!document.body) {
      requestAnimationFrame(mountUi);
      return;
    }
    document.body.appendChild(badge);
    document.body.appendChild(panel);
    start();
  }

  function start() {
    const tabsEl = panel.querySelector("#tse_hq_tabs");
    const bodyEl = panel.querySelector("#tse_hq_body");

    const TABS = [
      { id: "companies", label: "Companies" },
      { id: "trains", label: "Trains" },
      { id: "hof", label: "HoF Search" },
      { id: "notes", label: "Notes" },
      { id: "keys", label: "Company Keys" },
      { id: "settings", label: "Settings" },
    ];

    let ui = gmJsonGet(K_UI, clone(uiDefault));
    if (!ui || typeof ui !== "object") ui = clone(uiDefault);
    let activeTab = ui.tab || "companies";

    let state = {
      ok: false,
      user: null,
      companies: [],
      companyKeys: [],
      trains: [],
      serverTime: null,
      hofResults: []
    };

    function saveUI() {
      ui.tab = activeTab;
      gmJsonSet(K_UI, ui);
    }

    function setDot(on) {
      badge.classList.toggle("hasDot", !!on);
    }

    function setStatusLine(msg, ok = true) {
      const sub = panel.querySelector("#tse_hq_title .sub");
      sub.innerHTML = ok
        ? `<span class="tse_ok">${esc(msg)}</span>`
        : `<span class="tse_err">${esc(msg)}</span>`;
    }

    function toast(msg, ok = true) {
      setStatusLine(msg, ok);
      setDot(!ok);
      clearTimeout(toast._t);
      toast._t = setTimeout(() => setDot(false), 3500);
    }

    function applyUIPositions() {
      const isMobile = window.innerWidth <= 720;
      const bw = 46, bh = 46;
      const maxX = window.innerWidth - bw - 6;
      const maxY = window.innerHeight - bh - 6;

      ui.badge = ui.badge || { x: 14, y: 165 };
      ui.panel = ui.panel || { x: 10, y: 72 };

      ui.badge.x = clamp(ui.badge.x ?? 14, 6, Math.max(6, maxX));
      ui.badge.y = clamp(ui.badge.y ?? 165, 6, Math.max(6, maxY));

      badge.style.left = `${ui.badge.x}px`;
      badge.style.top = `${ui.badge.y}px`;

      if (isMobile) {
        ui.panel.x = 10;
        ui.panel.y = 68;
        panel.style.left = `2vw`;
        panel.style.top = `${ui.panel.y}px`;
      } else {
        const r = panel.getBoundingClientRect();
        const pw = Math.max(320, r.width || Math.min(560, window.innerWidth - 86));
        const ph = Math.max(240, r.height || Math.min(window.innerHeight * 0.82, 700));
        const pMaxX = Math.max(6, window.innerWidth - pw - 6);
        const pMaxY = Math.max(6, window.innerHeight - ph - 6);

        ui.panel.x = clamp(ui.panel.x ?? (ui.badge.x + 56), 6, pMaxX);
        ui.panel.y = clamp(ui.panel.y ?? (ui.badge.y - 30), 6, pMaxY);

        panel.style.left = `${ui.panel.x}px`;
        panel.style.top = `${ui.panel.y}px`;
      }

      saveUI();
    }

    function makeDraggable(el, onMove, { ignoreButtons = false } = {}) {
      let dragging = false;
      let moved = false;
      let startX = 0, startY = 0, originX = 0, originY = 0;

      const down = (ev) => {
        if (ignoreButtons && ev.target && ev.target.closest && ev.target.closest("button")) return;
        dragging = true;
        moved = false;
        const p = ev.touches ? ev.touches[0] : ev;
        startX = p.clientX;
        startY = p.clientY;
        const r = el.getBoundingClientRect();
        originX = r.left;
        originY = r.top;
        ev.preventDefault?.();
        ev.stopPropagation?.();
      };

      const move = (ev) => {
        if (!dragging) return;
        const p = ev.touches ? ev.touches[0] : ev;
        const dx = p.clientX - startX;
        const dy = p.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
        onMove(originX + dx, originY + dy);
        ev.preventDefault?.();
      };

      const up = (ev) => {
        if (!dragging) return;
        dragging = false;
        ev.preventDefault?.();
      };

      el.addEventListener("pointerdown", down, { passive: false });
      window.addEventListener("pointermove", move, { passive: false });
      window.addEventListener("pointerup", up, { passive: false });

      el.addEventListener("touchstart", down, { passive: false });
      window.addEventListener("touchmove", move, { passive: false });
      window.addEventListener("touchend", up, { passive: false });

      return {
        wasMoved() { return moved; }
      };
    }

    const badgeDrag = makeDraggable(badge, (x, y) => {
      ui.badge.x = clamp(x, 6, window.innerWidth - 46 - 6);
      ui.badge.y = clamp(y, 6, window.innerHeight - 46 - 6);
      badge.style.left = `${ui.badge.x}px`;
      badge.style.top = `${ui.badge.y}px`;
      saveUI();
    });

    makeDraggable(panel.querySelector("#tse_hq_header"), (x, y) => {
      if (window.innerWidth <= 720) return;
      const r = panel.getBoundingClientRect();
      ui.panel.x = clamp(x, 6, window.innerWidth - r.width - 6);
      ui.panel.y = clamp(y, 6, window.innerHeight - r.height - 6);
      panel.style.left = `${ui.panel.x}px`;
      panel.style.top = `${ui.panel.y}px`;
      saveUI();
    }, { ignoreButtons: true });

    function openPanel() {
      ui.open = true;
      panel.style.display = "block";
      applyUIPositions();
      saveUI();
    }

    function closePanel() {
      ui.open = false;
      panel.style.display = "none";
      saveUI();
    }

    async function openAndRefresh() {
      openPanel();
      try {
        await fetchState();
      } catch {}
      renderBody();
    }

    function togglePanel() {
      if (badgeDrag.wasMoved()) return;
      if (ui.open) closePanel();
      else openAndRefresh();
    }

    badge.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    }, true);

    badge.addEventListener("touchend", (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    }, { passive: false, capture: true });

    panel.querySelector("#tse_hq_close").addEventListener("click", (e) => {
      e.preventDefault();
      closePanel();
    });

    panel.querySelector("#tse_hq_refresh").addEventListener("click", async (e) => {
      e.preventDefault();
      await fetchState();
      renderBody();
    });

    window.addEventListener("resize", applyUIPositions);

    function renderTabs() {
      tabsEl.innerHTML = "";
      for (const t of TABS) {
        const el = document.createElement("div");
        el.className = "tse_tab" + (activeTab === t.id ? " active" : "");
        el.textContent = t.label;
        el.addEventListener("click", async () => {
          activeTab = t.id;
          saveUI();
          if (activeTab === "companies" || activeTab === "trains" || activeTab === "keys") {
            try { await fetchState(); } catch {}
          }
          renderTabs();
          renderBody();
        });
        tabsEl.appendChild(el);
      }
    }

    async function ensureAuth() {
      const base = getBaseUrl();
      const adminKey = (GM_getValue(K_ADMIN, "") || "").trim();
      const apiKey = (GM_getValue(K_API, "") || "").trim();

      if (!adminKey || !apiKey) {
        return { ok: false, error: "Missing Admin Key or API Key (Settings tab)" };
      }

      const existing = (GM_getValue(K_TOKEN, "") || "").trim();
      if (existing) return { ok: true, token: existing };

      const res = await http("POST", `${base}/api/auth`, {
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify({ admin_key: adminKey, api_key: apiKey })
      });

      if (!res.json || res.status >= 400) {
        return { ok: false, error: res.json?.error || res.json?.details || `Auth failed (${res.status})` };
      }

      const token = String(res.json.token || "").trim();
      if (!token) return { ok: false, error: "Auth OK but no token returned" };

      GM_setValue(K_TOKEN, token);
      if (res.json.user) GM_setValue(K_USER, JSON.stringify(res.json.user));
      return { ok: true, token };
    }

    async function fetchState() {
      const base = getBaseUrl();
      const auth = await ensureAuth();

      if (!auth.ok) {
        state = { ok: false, user: null, companies: [], companyKeys: [], trains: [], serverTime: null, hofResults: state.hofResults || [] };
        toast(auth.error, false);
        return;
      }

      const res = await http("GET", `${base}/state`, {
        headers: { "X-Session-Token": auth.token }
      });

      if (!res.json || res.status >= 400) {
        if (res.status === 401) GM_deleteValue(K_TOKEN);
        state = { ok: false, user: null, companies: [], companyKeys: [], trains: [], serverTime: null, hofResults: state.hofResults || [] };
        toast(res.json?.error || res.json?.details || `State failed (${res.status})`, false);
        return;
      }

      state.ok = !!res.json.ok;
      state.user = res.json.user || null;
      state.companies = Array.isArray(res.json.companies) ? res.json.companies : [];
      state.companyKeys = Array.isArray(res.json.company_keys) ? res.json.company_keys : [];
      state.trains = Array.isArray(res.json.trains) ? res.json.trains : [];
      state.serverTime = res.json.server_time || null;

      toast(state.user?.name ? `Logged in: ${state.user.name}` : "Connected", true);
    }

    async function getCompanyIdsFromServer() {
      const base = getBaseUrl();
      const auth = await ensureAuth();
      if (!auth.ok) throw new Error(auth.error);

      const res = await http("GET", `${base}/company_ids`, {
        headers: { "X-Session-Token": auth.token }
      });

      if (!res.json || res.status >= 400) throw new Error(res.json?.error || res.json?.details || `Load company IDs failed (${res.status})`);
      return Array.isArray(res.json.company_ids) ? res.json.company_ids.map(String) : [];
    }

    async function saveCompanyIdsToServer(ids) {
      const base = getBaseUrl();
      const auth = await ensureAuth();
      if (!auth.ok) throw new Error(auth.error);

      const res = await http("POST", `${base}/company_ids`, {
        headers: { "Content-Type": "application/json", "X-Session-Token": auth.token },
        data: JSON.stringify({ company_ids: ids })
      });

      if (!res.json || res.status >= 400) throw new Error(res.json?.error || res.json?.details || `Save company IDs failed (${res.status})`);
      return res.json;
    }

    async function saveCompanyKeyToServer(company_id, api_key) {
      const base = getBaseUrl();
      const auth = await ensureAuth();
      if (!auth.ok) throw new Error(auth.error);

      const res = await http("POST", `${base}/company-keys`, {
        headers: { "Content-Type": "application/json", "X-Session-Token": auth.token },
        data: JSON.stringify({ company_id, api_key })
      });

      if (!res.json || res.status >= 400) throw new Error(res.json?.error || res.json?.details || `Save company key failed (${res.status})`);
      return res.json;
    }

    async function deleteCompanyKeyFromServer(company_id) {
      const base = getBaseUrl();
      const auth = await ensureAuth();
      if (!auth.ok) throw new Error(auth.error);

      const res = await http("DELETE", `${base}/company-keys/${encodeURIComponent(company_id)}`, {
        headers: { "X-Session-Token": auth.token }
      });

      if (!res.json || res.status >= 400) throw new Error(res.json?.error || res.json?.details || `Delete company key failed (${res.status})`);
      return res.json;
    }

    async function addTrain(payload) {
      const base = getBaseUrl();
      const auth = await ensureAuth();
      if (!auth.ok) throw new Error(auth.error);

      const res = await http("POST", `${base}/trains`, {
        headers: { "Content-Type": "application/json", "X-Session-Token": auth.token },
        data: JSON.stringify(payload)
      });

      if (!res.json || res.status >= 400) throw new Error(res.json?.error || res.json?.details || `Add train failed (${res.status})`);
      return res.json;
    }

    async function deleteTrain(id) {
      const base = getBaseUrl();
      const auth = await ensureAuth();
      if (!auth.ok) throw new Error(auth.error);

      const res = await http("DELETE", `${base}/trains/${encodeURIComponent(id)}`, {
        headers: { "X-Session-Token": auth.token }
      });

      if (!res.json || res.status >= 400) throw new Error(res.json?.error || res.json?.details || `Delete train failed (${res.status})`);
      return res.json;
    }

    async function runHofSearch(payload) {
      const base = getBaseUrl();
      const auth = await ensureAuth();
      if (!auth.ok) throw new Error(auth.error);

      const res = await http("POST", `${base}/hof/search`, {
        headers: { "Content-Type": "application/json", "X-Session-Token": auth.token },
        data: JSON.stringify(payload)
      });

      if (!res.json || res.status >= 400) throw new Error(res.json?.error || res.json?.details || `HoF search failed (${res.status})`);
      return Array.isArray(res.json.results) ? res.json.results : [];
    }

    function renderCompanies() {
      const companies = state.companies || [];
      const keyMap = {};
      for (const item of state.companyKeys || []) keyMap[String(item.company_id)] = item;

      bodyEl.innerHTML = `
        <div class="tse_card">
          <div class="tse_row">
            <div class="tse_field" style="flex:1 1 100%;">
              <div class="tse_label">Company dashboard</div>
              <div class="tse_small">All saved company IDs and saved company keys should show here when your backend /state merges them correctly.</div>
            </div>
          </div>
        </div>

        <div class="tse_list">
          ${
            companies.length
              ? companies.map(c => {
                  const employees = Array.isArray(c.employees) ? c.employees : [];
                  const employeeOptions = employees.length
                    ? `
                      <select class="tse_select" data-empdd="${esc(c.id)}">
                        <option value="">Employees (${employees.length})</option>
                        ${employees.map(e => {
                          const total = statTotal(e);
                          return `<option value="${esc(e.id)}">${esc(e.name || "Unknown")} • T:${esc(total)}</option>`;
                        }).join("")}
                      </select>
                    `
                    : `<div class="tse_small">No employees returned.</div>`;

                  const totals = employees.reduce((a, e) => {
                    a.manual += num(e.manual_labor);
                    a.intelligence += num(e.intelligence);
                    a.endurance += num(e.endurance);
                    return a;
                  }, { manual: 0, intelligence: 0, endurance: 0 });

                  const overall = totals.manual + totals.intelligence + totals.endurance;
                  const k = keyMap[String(c.id)];
                  const keyStatus = k && k.has_key
                    ? `<div class="tse_key_status ok"><span class="dot"></span>Company key saved • ${esc(k.masked_key || "")}</div>`
                    : `<div class="tse_key_status"><span class="dot"></span>No company key saved</div>`;

                  return `
                    <div class="tse_item">
                      <div class="top">
                        <div style="min-width:0;">
                          <div class="name">${esc(c.name || `Company #${c.id}`)}</div>
                          <div class="meta">ID: ${esc(c.id)}${c.director ? ` • Director: ${esc(c.director)}` : ""}${c.source ? ` • Source: ${esc(c.source)}` : ""}</div>
                          ${keyStatus}
                        </div>
                        <div class="actions">
                          <button class="tse_btn" data-open-company="${esc(c.id)}">Open</button>
                        </div>
                      </div>
                      <div class="tse_grid_3">
                        <div class="tse_kpi"><div class="k">Manual</div><div class="v">${esc(totals.manual)}</div></div>
                        <div class="tse_kpi"><div class="k">Intelligence</div><div class="v">${esc(totals.intelligence)}</div></div>
                        <div class="tse_kpi"><div class="k">Endurance</div><div class="v">${esc(totals.endurance)}</div></div>
                      </div>
                      <div class="tse_small" style="margin-top:8px;">Combined employee total: <b>${esc(overall)}</b></div>
                      <div class="tse_hr"></div>
                      ${employeeOptions}
                    </div>
                  `;
                }).join("")
              : `<div class="tse_card"><div class="tse_small">No companies loaded yet.</div></div>`
          }
        </div>
      `;

      bodyEl.querySelectorAll("[data-open-company]").forEach(btn => {
        btn.addEventListener("click", () => {
          const id = btn.getAttribute("data-open-company");
          window.open(`https://www.torn.com/companies.php?step=profile&ID=${encodeURIComponent(id)}`, "_blank");
        });
      });

      bodyEl.querySelectorAll("[data-empdd]").forEach(sel => {
        sel.addEventListener("change", () => {
          const id = sel.value;
          if (!id) return;
          window.open(`https://www.torn.com/profiles.php?XID=${encodeURIComponent(id)}`, "_blank");
          sel.value = "";
        });
      });
    }

    function renderTrains() {
      const companies = state.companies || [];
      const trains = state.trains || [];

      bodyEl.innerHTML = `
        <div class="tse_card">
          <div class="tse_row">
            <div class="tse_field">
              <div class="tse_label">Company</div>
              <select class="tse_select" id="tse_train_company">
                <option value="">Select company</option>
                ${companies.map(c => `<option value="${esc(c.id)}">${esc(c.name || c.id)}</option>`).join("")}
              </select>
            </div>
            <div class="tse_field">
              <div class="tse_label">Buyer</div>
              <input class="tse_input" id="tse_train_buyer" placeholder="Buyer name">
            </div>
            <div class="tse_field">
              <div class="tse_label">Amount</div>
              <input class="tse_input" id="tse_train_amount" type="number" min="1" step="1" placeholder="10">
            </div>
          </div>

          <div class="tse_row" style="margin-top:10px;">
            <div class="tse_field" style="flex:1 1 100%;">
              <div class="tse_label">Note</div>
              <input class="tse_input" id="tse_train_note" placeholder="Optional note">
            </div>
          </div>

          <div class="tse_row" style="margin-top:10px;">
            <button class="tse_btn gold" id="tse_train_add">Add Train Record</button>
            <div class="tse_small" id="tse_train_msg"></div>
          </div>
        </div>

        <div class="tse_list">
          ${
            trains.length
              ? trains.map(t => `
                <div class="tse_item">
                  <div class="top">
                    <div style="min-width:0;">
                      <div class="name">${esc(t.buyer || "Unknown")} • ${esc(t.amount || 0)} trains</div>
                      <div class="meta">${esc(t.company_name || t.company_id || "No company")} ${t.created_at ? `• ${esc(shortTime(t.created_at))}` : ""}</div>
                      ${t.note ? `<div class="tse_small" style="margin-top:6px;">${esc(t.note)}</div>` : ""}
                    </div>
                    <div class="actions">
                      <button class="tse_btn red" data-del-train="${esc(t.id)}">Delete</button>
                    </div>
                  </div>
                </div>
              `).join("")
              : `<div class="tse_card"><div class="tse_small">No train records yet.</div></div>`
          }
        </div>
      `;

      const msg = bodyEl.querySelector("#tse_train_msg");

      bodyEl.querySelector("#tse_train_add").addEventListener("click", async () => {
        try {
          const company_id = bodyEl.querySelector("#tse_train_company").value.trim();
          const buyer = bodyEl.querySelector("#tse_train_buyer").value.trim();
          const amount = parseInt(bodyEl.querySelector("#tse_train_amount").value, 10);
          const note = bodyEl.querySelector("#tse_train_note").value.trim();

          if (!amount || amount <= 0) {
            msg.innerHTML = `<span class="tse_err">Amount must be greater than 0</span>`;
            return;
          }

          msg.innerHTML = `<span class="tse_small">Saving…</span>`;
          await addTrain({ company_id, buyer, amount, note });
          await fetchState();
          renderTrains();
          toast("Train record saved", true);
        } catch (e) {
          msg.innerHTML = `<span class="tse_err">${esc(e?.message || String(e))}</span>`;
          toast(e?.message || String(e), false);
        }
      });

      bodyEl.querySelectorAll("[data-del-train]").forEach(btn => {
        btn.addEventListener("click", async () => {
          try {
            await deleteTrain(btn.getAttribute("data-del-train"));
            await fetchState();
            renderTrains();
            toast("Train record deleted", true);
          } catch (e) {
            toast(e?.message || String(e), false);
          }
        });
      });
    }

    function renderHoF() {
      const results = state.hofResults || [];

      bodyEl.innerHTML = `
        <div class="tse_card">
          <div class="tse_row">
            <div class="tse_field">
              <div class="tse_label">Min Total</div>
              <input class="tse_input" id="tse_hof_min_total" type="number" min="0" placeholder="500">
            </div>
            <div class="tse_field">
              <div class="tse_label">Max Total</div>
              <input class="tse_input" id="tse_hof_max_total" type="number" min="0" placeholder="120000">
            </div>
            <div class="tse_field">
              <div class="tse_label">Status</div>
              <select class="tse_select" id="tse_hof_status">
                <option value="any">Any</option>
                <option value="none">No company</option>
                <option value="company">In company</option>
                <option value="cityjob">City job</option>
              </select>
            </div>
          </div>

          <div class="tse_row" style="margin-top:10px;">
            <div class="tse_field">
              <div class="tse_label">Min Manual</div>
              <input class="tse_input" id="tse_hof_min_man" type="number" min="0" placeholder="0">
            </div>
            <div class="tse_field">
              <div class="tse_label">Min Intelligence</div>
              <input class="tse_input" id="tse_hof_min_int" type="number" min="0" placeholder="0">
            </div>
            <div class="tse_field">
              <div class="tse_label">Min Endurance</div>
              <input class="tse_input" id="tse_hof_min_end" type="number" min="0" placeholder="0">
            </div>
          </div>

          <div class="tse_row" style="margin-top:10px;">
            <div class="tse_field">
              <div class="tse_label">Limit</div>
              <input class="tse_input" id="tse_hof_limit" type="number" min="1" max="100" value="50">
            </div>
            <div class="tse_field" style="flex:2 1 320px;">
              <div class="tse_label">Notes</div>
              <div class="tse_small">This searches the server’s worker table.</div>
            </div>
          </div>

          <div class="tse_row" style="margin-top:10px;">
            <button class="tse_btn gold" id="tse_hof_run">Search</button>
            <div class="tse_small" id="tse_hof_msg"></div>
          </div>
        </div>

        <div class="tse_list">
          ${
            results.length
              ? results.map(r => `
                <div class="tse_item">
                  <div class="top">
                    <div style="min-width:0;">
                      <div class="name">${esc(r.name || "Unknown")} [${esc(r.id || "")}]</div>
                      <div class="meta">${esc(r.job_status || "unknown")} ${r.company_name ? `• ${esc(r.company_name)}` : ""}</div>
                    </div>
                    <div class="actions">
                      <button class="tse_btn" data-open-player="${esc(r.id)}">Open</button>
                    </div>
                  </div>
                  <div class="tse_grid_3">
                    <div class="tse_kpi"><div class="k">Manual</div><div class="v">${esc(r.manual_labor || 0)}</div></div>
                    <div class="tse_kpi"><div class="k">Intelligence</div><div class="v">${esc(r.intelligence || 0)}</div></div>
                    <div class="tse_kpi"><div class="k">Endurance</div><div class="v">${esc(r.endurance || 0)}</div></div>
                  </div>
                  <div class="tse_small" style="margin-top:8px;">Total: <b>${esc(r.total || 0)}</b></div>
                </div>
              `).join("")
              : `<div class="tse_card"><div class="tse_small">No HoF results yet.</div></div>`
          }
        </div>
      `;

      const msg = bodyEl.querySelector("#tse_hof_msg");

      bodyEl.querySelector("#tse_hof_run").addEventListener("click", async () => {
        try {
          msg.innerHTML = `<span class="tse_small">Searching…</span>`;
          const maxVal = parseInt(bodyEl.querySelector("#tse_hof_max_total").value || "0", 10);
          const payload = {
            min_total: parseInt(bodyEl.querySelector("#tse_hof_min_total").value || "0", 10),
            max_total: maxVal > 0 ? maxVal : 999999999,
            min_man: parseInt(bodyEl.querySelector("#tse_hof_min_man").value || "0", 10),
            min_int: parseInt(bodyEl.querySelector("#tse_hof_min_int").value || "0", 10),
            min_end: parseInt(bodyEl.querySelector("#tse_hof_min_end").value || "0", 10),
            status: bodyEl.querySelector("#tse_hof_status").value,
            limit: parseInt(bodyEl.querySelector("#tse_hof_limit").value || "50", 10)
          };
          state.hofResults = await runHofSearch(payload);
          renderHoF();
          toast(`Found ${state.hofResults.length} result(s)`, true);
        } catch (e) {
          msg.innerHTML = `<span class="tse_err">${esc(e?.message || String(e))}</span>`;
          toast(e?.message || String(e), false);
        }
      });

      bodyEl.querySelectorAll("[data-open-player]").forEach(btn => {
        btn.addEventListener("click", () => {
          const id = btn.getAttribute("data-open-player");
          window.open(`https://www.torn.com/profiles.php?XID=${encodeURIComponent(id)}`, "_blank");
        });
      });
    }

    function renderNotes() {
      const notes = String(GM_getValue(K_NOTES, "") || "");
      bodyEl.innerHTML = `
        <div class="tse_card">
          <div class="tse_row">
            <div class="tse_field" style="flex:1 1 100%;">
              <div class="tse_label">Notes</div>
              <div class="tse_small">Local only. Saved on your device.</div>
            </div>
          </div>
          <div class="tse_row" style="margin-top:10px;">
            <textarea class="tse_textarea" id="tse_notes_area" placeholder="Write notes here…">${esc(notes)}</textarea>
          </div>
          <div class="tse_row" style="margin-top:10px;">
            <button class="tse_btn gold" id="tse_notes_save">Save</button>
            <button class="tse_btn red" id="tse_notes_clear">Clear</button>
            <div class="tse_small" id="tse_notes_msg"></div>
          </div>
        </div>
      `;
      const area = bodyEl.querySelector("#tse_notes_area");
      const msg = bodyEl.querySelector("#tse_notes_msg");

      const save = () => {
        GM_setValue(K_NOTES, area.value || "");
        msg.innerHTML = `<span class="tse_ok">Saved</span>`;
      };

      bodyEl.querySelector("#tse_notes_save").addEventListener("click", save);
      bodyEl.querySelector("#tse_notes_clear").addEventListener("click", () => {
        area.value = "";
        GM_setValue(K_NOTES, "");
        msg.innerHTML = `<span class="tse_ok">Cleared</span>`;
      });

      let t = null;
      area.addEventListener("input", () => {
        clearTimeout(t);
        t = setTimeout(save, 900);
      });
    }

    function renderKeys() {
      const companyIds = Array.isArray(state.user?.company_ids) ? state.user.company_ids.map(String) : [];
      const companies = Array.isArray(state.companies) ? state.companies : [];
      const keyMap = {};
      for (const item of state.companyKeys || []) keyMap[String(item.company_id)] = item;
      const companyNameMap = {};
      for (const c of companies) companyNameMap[String(c.id)] = c.name || `Company #${c.id}`;

      bodyEl.innerHTML = `
        <div class="tse_card">
          <div class="tse_row">
            <div class="tse_field" style="flex:1 1 100%;">
              <div class="tse_label">Company Keys</div>
              <div class="tse_small">Each company key should stay linked to its own company. If more than one key is saved, your backend must merge saved company IDs and company keys in /state.</div>
            </div>
          </div>
        </div>

        <div class="tse_list">
          ${
            companyIds.length
              ? companyIds.map(cid => {
                  const entry = keyMap[String(cid)];
                  const cname = companyNameMap[String(cid)] || `Company #${cid}`;
                  const hasKey = !!(entry && entry.has_key);
                  return `
                    <div class="tse_item">
                      <div class="top">
                        <div style="min-width:0;">
                          <div class="name">${esc(cname)}</div>
                          <div class="meta">ID: ${esc(cid)}</div>
                          <div class="tse_small" style="margin-top:6px;">
                            ${hasKey ? `Saved key: <b>${esc(entry.masked_key || "")}</b>` : `No key saved yet.`}
                          </div>
                        </div>
                        <div class="actions">
                          <button class="tse_btn" data-open-company-from-key="${esc(cid)}">Open</button>
                          ${hasKey ? `<button class="tse_btn red" data-del-company-key="${esc(cid)}">Delete</button>` : ``}
                        </div>
                      </div>

                      <div class="tse_row" style="margin-top:10px;">
                        <div class="tse_field" style="flex:1 1 100%;">
                          <div class="tse_label">API Key</div>
                          <input class="tse_input" type="password" data-company-key-input="${esc(cid)}" placeholder="${hasKey ? "Enter new key to replace existing one" : "Paste company API key"}" autocomplete="new-password">
                        </div>
                      </div>

                      <div class="tse_row" style="margin-top:10px;">
                        <button class="tse_btn gold" data-save-company-key="${esc(cid)}">${hasKey ? "Replace Key" : "Save Key"}</button>
                        <div class="tse_small" data-company-key-msg="${esc(cid)}"></div>
                      </div>
                    </div>
                  `;
                }).join("")
              : `<div class="tse_card"><div class="tse_small">No company IDs saved yet. Save company IDs first in Settings.</div></div>`
          }
        </div>
      `;

      bodyEl.querySelectorAll("[data-open-company-from-key]").forEach(btn => {
        btn.addEventListener("click", () => {
          const id = btn.getAttribute("data-open-company-from-key");
          if (!id) return;
          window.open(`https://www.torn.com/companies.php?step=profile&ID=${encodeURIComponent(id)}`, "_blank");
        });
      });

      bodyEl.querySelectorAll("[data-save-company-key]").forEach(btn => {
        btn.addEventListener("click", async () => {
          const cid = btn.getAttribute("data-save-company-key");
          const input = bodyEl.querySelector(`[data-company-key-input="${cid}"]`);
          const msg = bodyEl.querySelector(`[data-company-key-msg="${cid}"]`);
          const api_key = String(input?.value || "").trim();

          if (!cid) return;
          if (!api_key) {
            if (msg) msg.innerHTML = `<span class="tse_err">Enter a key first</span>`;
            return;
          }

          try {
            if (msg) msg.innerHTML = `<span class="tse_small">Saving…</span>`;
            await saveCompanyKeyToServer(cid, api_key);
            if (input) input.value = "";
            await fetchState();
            renderKeys();
            toast(`Company key saved for ${cid}`, true);
          } catch (e) {
            if (msg) msg.innerHTML = `<span class="tse_err">${esc(e?.message || String(e))}</span>`;
            toast(e?.message || String(e), false);
          }
        });
      });

      bodyEl.querySelectorAll("[data-del-company-key]").forEach(btn => {
        btn.addEventListener("click", async () => {
          const cid = btn.getAttribute("data-del-company-key");
          if (!cid) return;

          try {
            await deleteCompanyKeyFromServer(cid);
            await fetchState();
            renderKeys();
            toast(`Company key deleted for ${cid}`, true);
          } catch (e) {
            toast(e?.message || String(e), false);
          }
        });
      });
    }

    function renderSettings() {
      const admin = (GM_getValue(K_ADMIN, "") || "").trim();
      const api = (GM_getValue(K_API, "") || "").trim();

      bodyEl.innerHTML = `
        <div class="tse_card">
          <div class="tse_row">
            <div class="tse_field" style="flex:1 1 100%;">
              <div class="tse_label">Connection</div>
              <div class="tse_small">Use your admin key and your own Torn API key.</div>
            </div>
          </div>

          <div class="tse_row" style="margin-top:10px;">
            <div class="tse_field">
              <div class="tse_label">Admin Key</div>
              <input class="tse_input" id="tse_set_admin" value="${esc(admin)}" placeholder="Admin key">
            </div>
            <div class="tse_field">
              <div class="tse_label">Torn API Key</div>
              <input class="tse_input" id="tse_set_api" value="${esc(api)}" placeholder="Your API key">
            </div>
          </div>

          <div class="tse_row" style="margin-top:10px;">
            <button class="tse_btn gold" id="tse_set_save">Save</button>
            <button class="tse_btn gold" id="tse_set_login">Login</button>
            <button class="tse_btn red" id="tse_set_logout">Logout</button>
            <div class="tse_small" id="tse_set_msg"></div>
          </div>
        </div>

        <div class="tse_card">
          <div class="tse_row">
            <div class="tse_field narrow">
              <div class="tse_label">Company IDs</div>
              <textarea class="tse_textarea small" id="tse_company_ids" placeholder="12345, 67890, 112233"></textarea>
              <div class="tse_small">You can save multiple company IDs here. They should all remain saved.</div>
            </div>
          </div>
          <div class="tse_row" style="margin-top:10px;">
            <button class="tse_btn gold" id="tse_cids_load">Load From Server</button>
            <button class="tse_btn gold" id="tse_cids_save">Save To Server</button>
            <div class="tse_small" id="tse_cids_msg"></div>
          </div>
        </div>

        <div class="tse_card">
          <div class="tse_row">
            <div class="tse_field" style="flex:1 1 100%;">
              <div class="tse_label">Terms of Service</div>
              <div class="tse_small tse_tos">
                By using T.S.E Headquarters, you agree that this hub may use the Torn API key you enter to authenticate your account with this service and allow the backend to request Torn data needed for hub features.
              </div>

              <div class="tse_tos_grid">
                <div class="tse_tos_k">Data Storage</div>
                <div class="tse_tos_v">Your entered settings and related service data may be stored locally in the userscript and/or on the connected service as needed for login, saved company IDs, company key mappings, trains, and hub features.</div>

                <div class="tse_tos_k">API Key Use</div>
                <div class="tse_tos_v">Your Torn API key is used for authentication with this service and to let the backend fetch data required for your hub features. After login, the overlay normally uses a session token for most requests instead of repeatedly sending your Torn API key.</div>

                <div class="tse_tos_k">Company Keys</div>
                <div class="tse_tos_v">Any company API key entered in the Company Keys tab is sent to the connected service and stored there for company-related features. Only enter keys you are authorized to use.</div>

                <div class="tse_tos_k">Data Sharing</div>
                <div class="tse_tos_v">This hub is intended to use your data only for the tool’s features and not for public display. Do not use the service unless you trust the service owner and understand your data may be processed remotely by that service.</div>

                <div class="tse_tos_k">Minimum Access</div>
                <div class="tse_tos_v">Use only the lowest-permission Torn API key needed for the features you want. Do not enter credentials you do not want this service to process.</div>

                <div class="tse_tos_k">Your Choice</div>
                <div class="tse_tos_v">By saving or logging in, you confirm that you understand how this overlay uses the keys you provide and that you choose to connect your account to this hub.</div>
              </div>
            </div>
          </div>
        </div>
      `;

      const msg = bodyEl.querySelector("#tse_set_msg");
      const cmsg = bodyEl.querySelector("#tse_cids_msg");
      const area = bodyEl.querySelector("#tse_company_ids");

      const saveLocalSettings = () => {
        GM_setValue(K_ADMIN, bodyEl.querySelector("#tse_set_admin").value.trim());
        GM_setValue(K_API, bodyEl.querySelector("#tse_set_api").value.trim());
        GM_deleteValue(K_TOKEN);
        msg.innerHTML = `<span class="tse_ok">Saved. Login again.</span>`;
      };

      bodyEl.querySelector("#tse_set_save").addEventListener("click", saveLocalSettings);

      bodyEl.querySelector("#tse_set_login").addEventListener("click", async () => {
        try {
          saveLocalSettings();
          const auth = await ensureAuth();
          if (!auth.ok) throw new Error(auth.error);
          await fetchState();
          msg.innerHTML = `<span class="tse_ok">Logged in</span>`;
          toast("Logged in", true);
        } catch (e) {
          msg.innerHTML = `<span class="tse_err">${esc(e?.message || String(e))}</span>`;
          toast(e?.message || String(e), false);
        }
      });

      bodyEl.querySelector("#tse_set_logout").addEventListener("click", () => {
        GM_deleteValue(K_TOKEN);
        state = { ok: false, user: null, companies: [], companyKeys: [], trains: [], serverTime: null, hofResults: [] };
        msg.innerHTML = `<span class="tse_ok">Logged out</span>`;
        toast("Logged out", true);
      });

      bodyEl.querySelector("#tse_cids_load").addEventListener("click", async () => {
        try {
          const ids = await getCompanyIdsFromServer();
          area.value = ids.join(", ");
          cmsg.innerHTML = `<span class="tse_ok">Loaded ${ids.length} ID(s)</span>`;
        } catch (e) {
          cmsg.innerHTML = `<span class="tse_err">${esc(e?.message || String(e))}</span>`;
        }
      });

      bodyEl.querySelector("#tse_cids_save").addEventListener("click", async () => {
        try {
          const ids = parseCompanyIds(area.value);
          await saveCompanyIdsToServer(ids);
          await fetchState();
          cmsg.innerHTML = `<span class="tse_ok">Saved ${ids.length} ID(s)</span>`;
          toast("Company IDs saved", true);
        } catch (e) {
          cmsg.innerHTML = `<span class="tse_err">${esc(e?.message || String(e))}</span>`;
          toast(e?.message || String(e), false);
        }
      });
    }

    function renderBody() {
      renderTabs();
      if (activeTab === "companies") return renderCompanies();
      if (activeTab === "trains") return renderTrains();
      if (activeTab === "hof") return renderHoF();
      if (activeTab === "notes") return renderNotes();
      if (activeTab === "keys") return renderKeys();
      return renderSettings();
    }

    applyUIPositions();
    setStatusLine("made by Fries91", true);
    renderBody();

    if (ui.open) {
      openAndRefresh();
    } else {
      closePanel();
    }
  }

  mountUi();
})();
