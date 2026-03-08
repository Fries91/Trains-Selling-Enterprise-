// ==UserScript==
// @name         T.S.E Headquarters 🏤
// @namespace    fries91-tse-hq
// @version      8.5.3
// @description  T.S.E Headquarters. Restores icon + overlay + click toggle + on-top icon + live HoF total search.
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

  try {
    if (window.__TSE_HQ_LOADED__) return;
    window.__TSE_HQ_LOADED__ = true;

    const DEFAULT_BASE_URL = "https://trains-selling-enterprise.onrender.com";

    const K_ADMIN = "tse_hq_admin_v1";
    const K_API = "tse_hq_api_v1";
    const K_TOKEN = "tse_hq_token_v1";
    const K_UI = "tse_hq_ui_v1";
    const K_NOTES = "tse_hq_notes_v1";
    const K_HOF_FILTERS = "tse_hq_hof_filters_v1";

    const uiDefault = {
      open: false,
      tab: "companies",
      badge: { x: 14, y: 165 },
      panel: { x: 10, y: 72 }
    };

    const hofDefault = {
      min_total: "",
      max_total: "",
      limit: "50"
    };

    let started = false;
    let observer = null;
    let remountTimer = null;
    let badge = null;
    let panel = null;

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

    function num(v, fallback = 0) {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
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
            resolve({ status: r.status, text, json });
          },
          onerror: (e) => reject(e),
          ontimeout: () => reject(new Error("Request timeout"))
        });
      });
    }

    GM_addStyle(`
      #tse_hq_badge{
        position:fixed !important;
        z-index:2147483647 !important;
        left:14px;
        top:165px;
        width:48px;
        height:48px;
        border-radius:14px;
        display:flex !important;
        align-items:center;
        justify-content:center;
        background:linear-gradient(180deg, rgba(214,179,90,.25), rgba(15,27,51,.96));
        border:1px solid rgba(214,179,90,.45);
        box-shadow:0 10px 30px rgba(0,0,0,.5);
        font-size:26px;
        cursor:pointer;
        user-select:none;
        -webkit-user-select:none;
        touch-action:none;
      }
      #tse_hq_badge .emoji{ pointer-events:none; }
      #tse_hq_badge .dot{
        position:absolute;
        right:4px;
        top:4px;
        width:8px;
        height:8px;
        border-radius:999px;
        background:#ff5968;
        display:none;
      }
      #tse_hq_badge.hasDot .dot{ display:block; }

      #tse_hq_panel{
        position:fixed !important;
        z-index:2147483646 !important;
        left:10px;
        top:72px;
        width:min(96vw,560px);
        max-width:96vw;
        max-height:82vh;
        display:none;
        overflow:hidden;
        border-radius:16px;
        background:#0f1b33;
        border:1px solid rgba(214,179,90,.30);
        box-shadow:0 18px 60px rgba(0,0,0,.55);
        color:#eef3ff;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
      }

      #tse_hq_panel.tse_open{
        display:block !important;
        visibility:visible !important;
        opacity:1 !important;
      }

      #tse_hq_header{
        display:flex;
        align-items:center;
        gap:8px;
        padding:10px;
        border-bottom:1px solid rgba(255,255,255,.10);
        background:linear-gradient(180deg, rgba(214,179,90,.10), rgba(0,0,0,0));
        cursor:move;
        user-select:none;
        touch-action:none;
      }
      #tse_hq_title{ display:flex; flex-direction:column; gap:2px; min-width:0; }
      #tse_hq_title .main{ font-size:14px; font-weight:900; }
      #tse_hq_title .sub{ font-size:10px; color:#aebddd; }
      #tse_hq_header .spacer{ flex:1; }

      .tse_btn{
        border:1px solid rgba(255,255,255,.12);
        background:rgba(15,27,51,.80);
        color:#eef3ff;
        padding:6px 9px;
        border-radius:10px;
        cursor:pointer;
        font-size:11px;
        font-weight:800;
      }
      .tse_btn.red{ border-color:rgba(255,89,104,.35); }
      .tse_btn.gold{ border-color:rgba(214,179,90,.35); }

      #tse_hq_tabs{
        display:flex;
        gap:6px;
        padding:8px 10px;
        overflow:auto;
        border-bottom:1px solid rgba(255,255,255,.10);
        background:rgba(11,18,32,.55);
      }
      .tse_tab{
        flex:0 0 auto;
        padding:7px 9px;
        border-radius:999px;
        border:1px solid rgba(255,255,255,.12);
        background:rgba(15,27,51,.55);
        color:#aebddd;
        font-size:11px;
        font-weight:900;
        cursor:pointer;
        white-space:nowrap;
      }
      .tse_tab.active{
        color:#eef3ff;
        border-color:rgba(214,179,90,.35);
        background:rgba(214,179,90,.12);
      }

      #tse_hq_body{
        padding:10px;
        overflow:auto;
        max-height:calc(82vh - 94px);
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
      .tse_label{
        font-size:10px;
        color:#aebddd;
        font-weight:900;
      }
      .tse_input,.tse_select,.tse_textarea{
        width:100%;
        box-sizing:border-box;
        padding:9px;
        border-radius:10px;
        border:1px solid rgba(255,255,255,.12);
        background:rgba(11,18,32,.78);
        color:#eef3ff;
        font-size:12px;
      }
      .tse_textarea{ min-height:120px; resize:vertical; }
      .tse_textarea.small{ min-height:86px; max-height:120px; }
      .tse_small{ font-size:11px; color:#aebddd; line-height:1.35; }
      .tse_ok{ color:#34d57a; font-weight:900; }
      .tse_err{ color:#ff5968; font-weight:900; }
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
      .tse_item .name{ font-size:12px; font-weight:1000; }
      .tse_item .meta{ font-size:11px; color:#aebddd; margin-top:2px; }
      .tse_item .actions{
        display:flex;
        gap:6px;
        flex-wrap:wrap;
      }
      .tse_grid_3{
        display:grid;
        grid-template-columns:repeat(3,minmax(0,1fr));
        gap:6px;
        margin-top:8px;
      }
      .tse_kpi{
        background:rgba(11,18,32,.70);
        border:1px solid rgba(255,255,255,.10);
        border-radius:10px;
        padding:8px;
      }
      .tse_kpi .k{ font-size:10px; color:#aebddd; font-weight:900; }
      .tse_kpi .v{ font-size:13px; font-weight:1000; margin-top:2px; }

      @media (max-width:720px){
        #tse_hq_panel{
          width:96vw !important;
          max-width:96vw !important;
          left:2vw !important;
          top:68px !important;
          max-height:84vh !important;
        }
        #tse_hq_body{ max-height:calc(84vh - 94px); }
        .tse_grid_3{ grid-template-columns:1fr; }
        .tse_field{ flex:1 1 100%; min-width:100%; }
        .tse_item .top{ flex-direction:column; }
      }
    `);

    function buildBadge() {
      const old = document.getElementById("tse_hq_badge");
      if (old) old.remove();

      const el = document.createElement("div");
      el.id = "tse_hq_badge";
      el.innerHTML = `<div class="dot"></div><div class="emoji">🏤</div>`;
      return el;
    }

    function buildPanel() {
      const old = document.getElementById("tse_hq_panel");
      if (old) old.remove();

      const el = document.createElement("div");
      el.id = "tse_hq_panel";
      el.innerHTML = `
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
      return el;
    }

    function ensureOnTop() {
      if (badge) badge.style.zIndex = "2147483647";
      if (panel) panel.style.zIndex = "2147483646";
    }

    function ensureMounted() {
      if (!document.body) return false;

      if (!document.getElementById("tse_hq_badge")) {
        badge = buildBadge();
        document.body.appendChild(badge);
        started = false;
      } else {
        badge = document.getElementById("tse_hq_badge");
      }

      if (!document.getElementById("tse_hq_panel")) {
        panel = buildPanel();
        document.body.appendChild(panel);
        started = false;
      } else {
        panel = document.getElementById("tse_hq_panel");
      }

      ensureOnTop();

      if (!started) start();
      return true;
    }

    function scheduleEnsureMounted() {
      clearTimeout(remountTimer);
      remountTimer = setTimeout(() => {
        try { ensureMounted(); } catch {}
      }, 150);
    }

    function safeMount() {
      if (!document.body) {
        setTimeout(safeMount, 300);
        return;
      }

      ensureMounted();

      if (!observer) {
        observer = new MutationObserver(() => {
          if (!document.getElementById("tse_hq_badge") || !document.getElementById("tse_hq_panel")) {
            scheduleEnsureMounted();
          } else {
            ensureOnTop();
          }
        });
        observer.observe(document.documentElement || document.body, {
          childList: true,
          subtree: true
        });
      }

      setInterval(() => {
        try {
          ensureMounted();
          ensureOnTop();
        } catch {}
      }, 3000);
    }

    function start() {
      const tabsEl = panel.querySelector("#tse_hq_tabs");
      const bodyEl = panel.querySelector("#tse_hq_body");
      if (!tabsEl || !bodyEl) return;

      started = true;

      const TABS = [
        { id: "companies", label: "Companies" },
        { id: "trains", label: "Trains" },
        { id: "hof", label: "HoF Search" },
        { id: "notes", label: "Notes" },
        { id: "keys", label: "Company Keys" },
        { id: "settings", label: "Settings" }
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
        if (!sub) return;
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
        const bw = 48, bh = 48;
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
          panel.style.left = "2vw";
          panel.style.top = `${ui.panel.y}px`;
        } else {
          const pw = Math.min(560, window.innerWidth - 20);
          const ph = Math.min(window.innerHeight * 0.82, 700);
          ui.panel.x = clamp(ui.panel.x ?? (ui.badge.x + 56), 6, Math.max(6, window.innerWidth - pw - 6));
          ui.panel.y = clamp(ui.panel.y ?? (ui.badge.y - 30), 6, Math.max(6, window.innerHeight - ph - 6));
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
        ui.badge.x = clamp(x, 6, window.innerWidth - 48 - 6);
        ui.badge.y = clamp(y, 6, window.innerHeight - 48 - 6);
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
        panel.classList.add("tse_open");
        panel.style.display = "block";
        panel.style.visibility = "visible";
        panel.style.opacity = "1";
        ensureOnTop();
        applyUIPositions();
        saveUI();
      }

      function closePanel() {
        ui.open = false;
        panel.classList.remove("tse_open");
        panel.style.display = "none";
        saveUI();
      }

      async function openAndRefresh() {
        openPanel();
        try { await fetchState(); } catch {}
        renderBody();
        openPanel();
      }

      function togglePanel() {
        if (badgeDrag.wasMoved()) return;
        if (ui.open) closePanel();
        else openAndRefresh();
      }

      badge.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        togglePanel();
      };

      badge.addEventListener("touchend", (e) => {
        e.preventDefault();
        e.stopPropagation();
        togglePanel();
      }, { passive: false });

      const closeBtn = panel.querySelector("#tse_hq_close");
      const refreshBtn = panel.querySelector("#tse_hq_refresh");

      if (closeBtn) {
        closeBtn.onclick = (e) => {
          e.preventDefault();
          closePanel();
        };
      }

      if (refreshBtn) {
        refreshBtn.onclick = async (e) => {
          e.preventDefault();
          await fetchState();
          renderBody();
          if (ui.open) openPanel();
        };
      }

      window.addEventListener("resize", applyUIPositions);

      function renderTabs() {
        tabsEl.innerHTML = "";
        for (const t of TABS) {
          const el = document.createElement("div");
          el.className = "tse_tab" + (activeTab === t.id ? " active" : "");
          el.textContent = t.label;
          el.onclick = async () => {
            activeTab = t.id;
            saveUI();
            if (activeTab === "companies" || activeTab === "trains" || activeTab === "keys") {
              try { await fetchState(); } catch {}
            }
            renderTabs();
            renderBody();
            if (ui.open) openPanel();
          };
          tabsEl.appendChild(el);
        }
      }

      async function ensureAuth() {
        const adminKey = (GM_getValue(K_ADMIN, "") || "").trim();
        const apiKey = (GM_getValue(K_API, "") || "").trim();

        if (!adminKey || !apiKey) {
          return { ok: false, error: "Missing Admin Key or API Key (Settings tab)" };
        }

        const existing = (GM_getValue(K_TOKEN, "") || "").trim();
        if (existing) return { ok: true, token: existing };

        const res = await http("POST", `${DEFAULT_BASE_URL}/api/auth`, {
          headers: { "Content-Type": "application/json" },
          data: JSON.stringify({ admin_key: adminKey, api_key: apiKey })
        });

        if (!res.json || res.status >= 400) {
          return { ok: false, error: res.json?.error || res.json?.details || `Auth failed (${res.status})` };
        }

        const token = String(res.json.token || "").trim();
        if (!token) return { ok: false, error: "Auth OK but no token returned" };

        GM_setValue(K_TOKEN, token);
        return { ok: true, token };
      }

      async function fetchState() {
        const auth = await ensureAuth();

        if (!auth.ok) {
          state = { ok: false, user: null, companies: [], companyKeys: [], trains: [], serverTime: null, hofResults: state.hofResults || [] };
          toast(auth.error, false);
          return;
        }

        const res = await http("GET", `${DEFAULT_BASE_URL}/state`, {
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
        const auth = await ensureAuth();
        if (!auth.ok) throw new Error(auth.error);

        const res = await http("GET", `${DEFAULT_BASE_URL}/company_ids`, {
          headers: { "X-Session-Token": auth.token }
        });

        if (!res.json || res.status >= 400) throw new Error(res.json?.error || res.json?.details || `Load company IDs failed (${res.status})`);
        return Array.isArray(res.json.company_ids) ? res.json.company_ids.map(String) : [];
      }

      async function saveCompanyIdsToServer(ids) {
        const auth = await ensureAuth();
        if (!auth.ok) throw new Error(auth.error);

        const res = await http("POST", `${DEFAULT_BASE_URL}/company_ids`, {
          headers: { "Content-Type": "application/json", "X-Session-Token": auth.token },
          data: JSON.stringify({ company_ids: ids })
        });

        if (!res.json || res.status >= 400) throw new Error(res.json?.error || res.json?.details || `Save company IDs failed (${res.status})`);
        return res.json;
      }

      async function saveCompanyKeyToServer(company_id, api_key) {
        const auth = await ensureAuth();
        if (!auth.ok) throw new Error(auth.error);

        const res = await http("POST", `${DEFAULT_BASE_URL}/company-keys`, {
          headers: { "Content-Type": "application/json", "X-Session-Token": auth.token },
          data: JSON.stringify({ company_id, api_key })
        });

        if (!res.json || res.status >= 400) throw new Error(res.json?.error || res.json?.details || `Save company key failed (${res.status})`);
        return res.json;
      }

      async function deleteCompanyKeyFromServer(company_id) {
        const auth = await ensureAuth();
        if (!auth.ok) throw new Error(auth.error);

        const res = await http("DELETE", `${DEFAULT_BASE_URL}/company-keys/${encodeURIComponent(company_id)}`, {
          headers: { "X-Session-Token": auth.token }
        });

        if (!res.json || res.status >= 400) throw new Error(res.json?.error || res.json?.details || `Delete company key failed (${res.status})`);
        return res.json;
      }

      async function addTrain(payload) {
        const auth = await ensureAuth();
        if (!auth.ok) throw new Error(auth.error);

        const res = await http("POST", `${DEFAULT_BASE_URL}/trains`, {
          headers: { "Content-Type": "application/json", "X-Session-Token": auth.token },
          data: JSON.stringify(payload)
        });

        if (!res.json || res.status >= 400) throw new Error(res.json?.error || res.json?.details || `Add train failed (${res.status})`);
        return res.json;
      }

      async function deleteTrain(id) {
        const auth = await ensureAuth();
        if (!auth.ok) throw new Error(auth.error);

        const res = await http("DELETE", `${DEFAULT_BASE_URL}/trains/${encodeURIComponent(id)}`, {
          headers: { "X-Session-Token": auth.token }
        });

        if (!res.json || res.status >= 400) throw new Error(res.json?.error || res.json?.details || `Delete train failed (${res.status})`);
        return res.json;
      }

      async function runHofSearch(payload) {
        const auth = await ensureAuth();
        if (!auth.ok) throw new Error(auth.error);

        const res = await http("POST", `${DEFAULT_BASE_URL}/hof/search`, {
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
            <div class="tse_small">All saved company IDs and saved company keys should show here.</div>
          </div>
          <div class="tse_list">
            ${
              companies.length
                ? companies.map(c => {
                    const employees = Array.isArray(c.employees) ? c.employees : [];
                    const totals = employees.reduce((a, e) => {
                      a.manual += num(e.manual_labor);
                      a.intelligence += num(e.intelligence);
                      a.endurance += num(e.endurance);
                      return a;
                    }, { manual: 0, intelligence: 0, endurance: 0 });
                    const overall = totals.manual + totals.intelligence + totals.endurance;
                    const k = keyMap[String(c.id)];
                    return `
                      <div class="tse_item">
                        <div class="top">
                          <div>
                            <div class="name">${esc(c.name || `Company #${c.id}`)}</div>
                            <div class="meta">ID: ${esc(c.id)}${c.director ? ` • Director: ${esc(c.director)}` : ""}${c.source ? ` • Source: ${esc(c.source)}` : ""}</div>
                            <div class="meta">${k && k.has_key ? `Company key saved • ${esc(k.masked_key || "")}` : `No company key saved`}</div>
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
                      </div>
                    `;
                  }).join("")
                : `<div class="tse_card"><div class="tse_small">No companies loaded yet.</div></div>`
            }
          </div>
        `;

        bodyEl.querySelectorAll("[data-open-company]").forEach(btn => {
          btn.onclick = () => {
            const id = btn.getAttribute("data-open-company");
            window.open(`https://www.torn.com/companies.php?step=profile&ID=${encodeURIComponent(id)}`, "_blank");
          };
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
                      <div>
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

        bodyEl.querySelector("#tse_train_add").onclick = async () => {
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
            openPanel();
            toast("Train record saved", true);
          } catch (e) {
            msg.innerHTML = `<span class="tse_err">${esc(e?.message || String(e))}</span>`;
            toast(e?.message || String(e), false);
          }
        };

        bodyEl.querySelectorAll("[data-del-train]").forEach(btn => {
          btn.onclick = async () => {
            try {
              await deleteTrain(btn.getAttribute("data-del-train"));
              await fetchState();
              renderTrains();
              openPanel();
              toast("Train record deleted", true);
            } catch (e) {
              toast(e?.message || String(e), false);
            }
          };
        });
      }

      function renderHoF() {
        const results = state.hofResults || [];
        const filters = gmJsonGet(K_HOF_FILTERS, clone(hofDefault)) || clone(hofDefault);

        bodyEl.innerHTML = `
          <div class="tse_card">
            <div class="tse_row">
              <div class="tse_field">
                <div class="tse_label">Min Total</div>
                <input class="tse_input" id="tse_hof_min_total" type="number" min="0" placeholder="500" value="${esc(filters.min_total || "")}">
              </div>
              <div class="tse_field">
                <div class="tse_label">Max Total</div>
                <input class="tse_input" id="tse_hof_max_total" type="number" min="0" placeholder="120000" value="${esc(filters.max_total || "")}">
              </div>
              <div class="tse_field">
                <div class="tse_label">Limit</div>
                <input class="tse_input" id="tse_hof_limit" type="number" min="1" max="100" value="${esc(filters.limit || "50")}">
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
                      <div>
                        <div class="name">${esc(r.name || "Unknown")} ${r.id ? `[${esc(r.id)}]` : ""}</div>
                        <div class="meta">Rank: ${esc(r.rank || "-")} • Total: ${esc(r.total || 0)}</div>
                      </div>
                      <div class="actions">
                        ${r.id ? `<button class="tse_btn" data-open-player="${esc(r.id)}">Open</button>` : ``}
                      </div>
                    </div>
                  </div>
                `).join("")
                : `<div class="tse_card"><div class="tse_small">No HoF results yet.</div></div>`
            }
          </div>
        `;

        const msg = bodyEl.querySelector("#tse_hof_msg");

        bodyEl.querySelector("#tse_hof_run").onclick = async () => {
          try {
            msg.innerHTML = `<span class="tse_small">Searching…</span>`;

            const min_total = String(bodyEl.querySelector("#tse_hof_min_total").value || "").trim();
            const max_total = String(bodyEl.querySelector("#tse_hof_max_total").value || "").trim();
            const limit = String(bodyEl.querySelector("#tse_hof_limit").value || "50").trim();

            gmJsonSet(K_HOF_FILTERS, { min_total, max_total, limit });

            const maxVal = parseInt(max_total || "0", 10);

            state.hofResults = await runHofSearch({
              min_total: parseInt(min_total || "0", 10),
              max_total: maxVal > 0 ? maxVal : 0,
              limit: parseInt(limit || "50", 10)
            });

            renderHoF();
            openPanel();
            toast(`Found ${state.hofResults.length} result(s)`, true);
          } catch (e) {
            msg.innerHTML = `<span class="tse_err">${esc(e?.message || String(e))}</span>`;
            toast(e?.message || String(e), false);
          }
        };

        bodyEl.querySelectorAll("[data-open-player]").forEach(btn => {
          btn.onclick = () => {
            const id = btn.getAttribute("data-open-player");
            if (!id) return;
            window.open(`https://www.torn.com/profiles.php?XID=${encodeURIComponent(id)}`, "_blank");
          };
        });
      }

      function renderNotes() {
        const notes = String(GM_getValue(K_NOTES, "") || "");
        bodyEl.innerHTML = `
          <div class="tse_card">
            <div class="tse_field">
              <div class="tse_label">Notes</div>
              <div class="tse_small">Local only. Saved on your device.</div>
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

        bodyEl.querySelector("#tse_notes_save").onclick = save;
        bodyEl.querySelector("#tse_notes_clear").onclick = () => {
          area.value = "";
          GM_setValue(K_NOTES, "");
          msg.innerHTML = `<span class="tse_ok">Cleared</span>`;
        };
      }

      function renderKeys() {
        const companyIds = Array.isArray(state.user?.company_ids) ? state.user.company_ids.map(String) : [];
        const companies = Array.isArray(state.companies) ? state.companies : [];
        const keyMap = {};
        for (const item of state.companyKeys || []) keyMap[String(item.company_id)] = item;
        const companyNameMap = {};
        for (const c of companies) companyNameMap[String(c.id)] = c.name || `Company #${c.id}`;

        bodyEl.innerHTML = `
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
                          <div>
                            <div class="name">${esc(cname)}</div>
                            <div class="meta">ID: ${esc(cid)}</div>
                            <div class="tse_small" style="margin-top:6px;">${hasKey ? `Saved key: <b>${esc(entry.masked_key || "")}</b>` : `No key saved yet.`}</div>
                          </div>
                          <div class="actions">
                            <button class="tse_btn" data-open-company-from-key="${esc(cid)}">Open</button>
                            ${hasKey ? `<button class="tse_btn red" data-del-company-key="${esc(cid)}">Delete</button>` : ``}
                          </div>
                        </div>
                        <div class="tse_row" style="margin-top:10px;">
                          <div class="tse_field" style="flex:1 1 100%;">
                            <div class="tse_label">API Key</div>
                            <input class="tse_input" type="password" data-company-key-input="${esc(cid)}" placeholder="${hasKey ? "Enter new key to replace existing one" : "Paste company API key"}">
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
          btn.onclick = () => {
            const id = btn.getAttribute("data-open-company-from-key");
            if (!id) return;
            window.open(`https://www.torn.com/companies.php?step=profile&ID=${encodeURIComponent(id)}`, "_blank");
          };
        });

        bodyEl.querySelectorAll("[data-save-company-key]").forEach(btn => {
          btn.onclick = async () => {
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
              openPanel();
              toast(`Company key saved for ${cid}`, true);
            } catch (e) {
              if (msg) msg.innerHTML = `<span class="tse_err">${esc(e?.message || String(e))}</span>`;
              toast(e?.message || String(e), false);
            }
          };
        });

        bodyEl.querySelectorAll("[data-del-company-key]").forEach(btn => {
          btn.onclick = async () => {
            const cid = btn.getAttribute("data-del-company-key");
            if (!cid) return;

            try {
              await deleteCompanyKeyFromServer(cid);
              await fetchState();
              renderKeys();
              openPanel();
              toast(`Company key deleted for ${cid}`, true);
            } catch (e) {
              toast(e?.message || String(e), false);
            }
          };
        });
      }

      function renderSettings() {
        const admin = (GM_getValue(K_ADMIN, "") || "").trim();
        const api = (GM_getValue(K_API, "") || "").trim();

        bodyEl.innerHTML = `
          <div class="tse_card">
            <div class="tse_row">
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
            <div class="tse_field">
              <div class="tse_label">Company IDs</div>
              <textarea class="tse_textarea small" id="tse_company_ids" placeholder="12345, 67890, 112233"></textarea>
              <div class="tse_small">New IDs merge with existing saved IDs.</div>
            </div>
            <div class="tse_row" style="margin-top:10px;">
              <button class="tse_btn gold" id="tse_cids_load">Load From Server</button>
              <button class="tse_btn gold" id="tse_cids_save">Save To Server</button>
              <div class="tse_small" id="tse_cids_msg"></div>
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

        bodyEl.querySelector("#tse_set_save").onclick = saveLocalSettings;

        bodyEl.querySelector("#tse_set_login").onclick = async () => {
          try {
            saveLocalSettings();
            const auth = await ensureAuth();
            if (!auth.ok) throw new Error(auth.error);
            await fetchState();
            msg.innerHTML = `<span class="tse_ok">Logged in</span>`;
            openPanel();
            toast("Logged in", true);
          } catch (e) {
            msg.innerHTML = `<span class="tse_err">${esc(e?.message || String(e))}</span>`;
            toast(e?.message || String(e), false);
          }
        };

        bodyEl.querySelector("#tse_set_logout").onclick = () => {
          GM_deleteValue(K_TOKEN);
          state = { ok: false, user: null, companies: [], companyKeys: [], trains: [], serverTime: null, hofResults: [] };
          msg.innerHTML = `<span class="tse_ok">Logged out</span>`;
          toast("Logged out", true);
        };

        bodyEl.querySelector("#tse_cids_load").onclick = async () => {
          try {
            const ids = await getCompanyIdsFromServer();
            area.value = ids.join(", ");
            cmsg.innerHTML = `<span class="tse_ok">Loaded ${ids.length} ID(s)</span>`;
          } catch (e) {
            cmsg.innerHTML = `<span class="tse_err">${esc(e?.message || String(e))}</span>`;
          }
        };

        bodyEl.querySelector("#tse_cids_save").onclick = async () => {
          try {
            const existingIds = await getCompanyIdsFromServer();
            const newIds = parseCompanyIds(area.value);

            const merged = [];
            for (const id of existingIds) {
              const s = String(id || "").trim();
              if (s && !merged.includes(s)) merged.push(s);
            }
            for (const id of newIds) {
              const s = String(id || "").trim();
              if (s && !merged.includes(s)) merged.push(s);
            }

            await saveCompanyIdsToServer(merged);
            area.value = merged.join(", ");
            await fetchState();
            cmsg.innerHTML = `<span class="tse_ok">Saved ${merged.length} ID(s)</span>`;
            openPanel();
            toast("Company IDs saved", true);
          } catch (e) {
            cmsg.innerHTML = `<span class="tse_err">${esc(e?.message || String(e))}</span>`;
            toast(e?.message || String(e), false);
          }
        };
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

      if (ui.open) openPanel();
      else closePanel();
    }

    safeMount();
  } catch (e) {
    console.error("TSE HQ fatal error:", e);
  }
})();
