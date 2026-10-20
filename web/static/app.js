"use strict";

// ---------------------------------------------------------------- helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
const FINAL = new Set(["hired", "rejected", "no_response", "offer_declined", "withdrawn"]);
const STATUS_LABEL = {
  drafted: "Đã soạn", applied: "Đã nộp", interview: "Phỏng vấn", offer: "Có offer", hired: "Đã nhận việc",
  rejected: "Bị từ chối", no_response: "Không phản hồi", offer_declined: "Từ chối offer", withdrawn: "Đã rút",
};
const normStatus = (s) => (s || "").trim().replace(/ /g, "_").toLowerCase();

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error((data && data.error) || `Lỗi ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

// -------------------------------------------------------------------- tabs
function showView(name) {
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
  if (name === "overview") loadOverview();
  if (name === "scanned") loadJobs();
  if (name === "files") loadFiles();
  if (name === "search") initSearch();
  if (name === "chat") $("#chatInput").focus();
  history.replaceState(null, "", "#" + name);
}
$("#tabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-view]"); if (b) showView(b.dataset.view); });

// Any element with data-chat jumps to the assistant with that text (and sends it when data-send is set).
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-chat]");
  if (!el) return;
  goChat(el.dataset.chat, el.dataset.send === "1");
});

// ---------------------------------------------------------------- overview
let tracker = { rows: [], statuses: [] };

async function loadStatus() {
  const st = await api("/api/status");
  const b = $("#envbadges");
  const items = [["claude", st.tools.claude], ["bun", st.tools.bun], ["LaTeX", st.tools.lualatex && st.tools.xelatex], ["PDF text", st.tools.pypdf || st.tools.pdftotext]];
  b.innerHTML = items.map(([n, ok]) => `<span class="badge ${ok ? "" : "off"}" title="${ok ? "Đã có" : "Chưa có"}">${esc(n)} ${ok ? "✓" : "✕"}</span>`).join("");
  const banners = [];
  if (!st.tools.claude) banners.push(`<div class="banner warn"><span>Không tìm thấy lệnh <b>claude</b> - tab Trợ lý sẽ không chạy được.</span></div>`);
  if (!st.profile.ready) {
    banners.push(`<div class="banner info"><span>Hồ sơ chưa được thiết lập (${st.profile.placeholders ?? "?"} chỗ trống trong CLAUDE.md). Chạy <b>/setup</b> để Claude phỏng vấn và điền hồ sơ - cần làm trước khi /scrape và /apply cho kết quả tốt.</span><button class="btn primary" data-chat="/setup" data-send="1">Chạy /setup</button></div>`);
  }
  $("#banners").innerHTML = banners.join("");
}

async function loadOverview() {
  loadStatus().catch((e) => toast(e.message));
  tracker = await api("/api/tracker");
  renderStats(); renderBoard();
}

function daysUntil(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) return null;
  const d = new Date(iso + "T00:00:00");
  return Math.ceil((d - new Date(new Date().toDateString())) / 86400000);
}

function renderStats() {
  const rows = tracker.rows;
  const open = rows.filter((r) => !FINAL.has(normStatus(r.status)));
  const fits = rows.map((r) => parseInt(r.fit_rating, 10)).filter((n) => !isNaN(n));
  const soon = open.filter((r) => { const d = daysUntil(r.deadline); return d !== null && d >= 0 && d <= 7; }).length;
  const cnt = (...s) => rows.filter((r) => s.includes(normStatus(r.status))).length;
  const cards = [
    [rows.length, "Tổng số đơn"], [open.length, "Đang mở"], [cnt("applied"), "Đã nộp"], [cnt("interview"), "Phỏng vấn"],
    [cnt("offer", "hired"), "Offer / nhận việc"], [fits.length ? Math.round(fits.reduce((a, b) => a + b, 0) / fits.length) : "–", "Fit trung bình"], [soon, "Hết hạn ≤ 7 ngày"],
  ];
  $("#stats").innerHTML = cards.map(([n, l]) => `<div class="stat"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`).join("");
}

function fitClass(n) { return n >= 75 ? "good" : n >= 45 ? "mid" : "low"; }

function renderBoard() {
  const rows = tracker.rows.map((r, i) => ({ r, i }));
  $("#boardEmpty").hidden = rows.length > 0;
  $("#board").hidden = rows.length === 0;
  const cols = tracker.statuses.map((s) => {
    const items = rows.filter(({ r }) => normStatus(r.status) === s);
    const cards = items.map(({ r, i }) => {
      const fit = parseInt(r.fit_rating, 10);
      const dd = daysUntil(r.deadline);
      const pills = [];
      if (!isNaN(fit)) pills.push(`<span class="pill ${fitClass(fit)}">Fit ${fit}</span>`);
      if (dd !== null && !FINAL.has(s)) pills.push(`<span class="pill ${dd <= 7 ? "urgent" : ""}">${dd < 0 ? "Quá hạn" : dd === 0 ? "Hết hạn hôm nay" : "Còn " + dd + " ngày"}</span>`);
      if (r.date) pills.push(`<span class="pill">${esc(r.date)}</span>`);
      return `<div class="app" data-i="${i}" tabindex="0" role="button"><div class="co">${esc(r.company)}</div><div class="ro">${esc(r.role)}</div><div class="meta">${pills.join("")}</div></div>`;
    }).join("");
    return `<div class="col"><h4><span>${esc(STATUS_LABEL[s] || s)}</span><span>${items.length}</span></h4>${cards}</div>`;
  });
  $("#board").innerHTML = cols.join("");
}
$("#board").addEventListener("click", (e) => { const a = e.target.closest(".app"); if (a) openApp(+a.dataset.i); });
$("#board").addEventListener("keydown", (e) => { if (e.key === "Enter") { const a = e.target.closest(".app"); if (a) openApp(+a.dataset.i); } });
$("#addApp").addEventListener("click", () => openApp(null));

// ------------------------------------------------------------------ dialog
const dlg = $("#appDialog"), form = $("#appForm");
let editing = null;

function openApp(index, prefill) {
  editing = index === null ? null : { index, expect: { company: tracker.rows[index].company, role: tracker.rows[index].role } };
  form.reset();
  $("[name=status]", form).innerHTML = (tracker.statuses.length ? tracker.statuses : Object.keys(STATUS_LABEL)).map((s) => `<option value="${esc(s)}">${esc(STATUS_LABEL[s] || s)}</option>`).join("");
  const data = index === null ? { status: "applied", ...(prefill || {}) } : { ...tracker.rows[index], status: normStatus(tracker.rows[index].status) };
  for (const el of form.elements) if (el.name && data[el.name] !== undefined) el.value = data[el.name];
  for (const n of ["company", "role", "source"]) $(`[name=${n}]`, form).readOnly = editing !== null;
  $("#dTitle").textContent = editing ? "Cập nhật đơn ứng tuyển" : "Thêm đơn ứng tuyển";
  $("#dError").hidden = true;
  dlg.showModal();
}

form.addEventListener("submit", async (e) => {
  if (e.submitter && e.submitter.value !== "save") return; // plain close
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(form).entries());
  const btn = $("#dSave"); btn.disabled = true;
  try {
    if (editing) {
      const { company, role, source, ...changes } = fd;
      await api("/api/tracker/update", { ...editing, changes });
    } else {
      await api("/api/tracker/add", fd);
    }
    dlg.close(); toast("Đã lưu vào tracker"); loadOverview();
  } catch (err) {
    $("#dError").textContent = err.message; $("#dError").hidden = false;
  } finally { btn.disabled = false; }
});

// ------------------------------------------------------------------ search
let portals = [];
async function initSearch() {
  if (portals.length) return;
  portals = (await api("/api/portals")).portals;
  const sel = $("#sPortal");
  sel.innerHTML = portals.map((p) => `<option value="${esc(p.id)}" ${p.installed && p.enabled ? "" : "disabled"}>${esc(p.label)}${p.installed ? "" : " (chưa cài)"}${p.enabled ? "" : " (tắt)"}</option>`).join("");
  const first = portals.find((p) => p.installed && p.enabled);
  if (first) sel.value = first.id;
  syncSearchFields();
}
function syncSearchFields() {
  const p = portals.find((x) => x.id === $("#sPortal").value);
  if (!p) return;
  const map = { query: "#sQuery", location: "#sLocationWrap", jobage: "#sJobageWrap", remote: "#sRemoteWrap" };
  $("#sQuery").parentElement.hidden = !p.fields.includes("query");
  for (const f of ["location", "jobage", "remote"]) $(map[f]).hidden = !p.fields.includes(f);
  $("#sLocation").required = p.required.includes("location");
  $("#sLocation").placeholder = p.id === "freehire-search" ? "Mã quốc gia ISO, vd: DE,GB,VN (tùy chọn)" : p.id === "jobdanmark-search" ? "Tên thành phố, vd: København" : "vd: Ho Chi Minh City, Vietnam / Remote";
}
$("#sPortal").addEventListener("change", syncSearchFields);

// ---- fields (job areas): named keyword sets, kept in this browser only
const MAX_KEYWORDS = 6;      // per run - the portals are public pages, keep volume low
const MAX_PER_KEYWORD = 10;
const DEFAULT_FIELDS = [
  { id: "it", name: "IT / Phần mềm", tech: true, keywords: ["software engineer", "data engineer", "devops engineer"] },
  { id: "seo", name: "SEO & Digital Marketing", tech: false, keywords: ["SEO specialist", "SEO executive", "content marketing", "digital marketing"] },
  { id: "logistics", name: "Logistics & Chuỗi cung ứng", tech: false, keywords: ["logistics coordinator", "supply chain", "warehouse manager", "procurement", "xuất nhập khẩu"] },
  { id: "sales", name: "Kinh doanh / Sales", tech: false, keywords: ["sales executive", "business development", "account manager"] },
  { id: "finance", name: "Kế toán / Tài chính", tech: false, keywords: ["accountant", "financial analyst", "kế toán"] },
];
const store = {
  get(k, d) { try { const v = localStorage.getItem("aijs." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("aijs." + k, JSON.stringify(v)); } catch { /* private mode: not persisted */ } },
};
let fields = store.get("fields", null);
if (!Array.isArray(fields) || !fields.length) fields = structuredClone(DEFAULT_FIELDS);
let activeFields = new Set(store.get("activeFields", []));

function renderFieldChips() {
  activeFields = new Set([...activeFields].filter((id) => fields.some((f) => f.id === id)));
  $("#fieldChips").innerHTML = fields.map((f) => `<button type="button" class="chip ${activeFields.has(f.id) ? "on" : ""}" data-field="${esc(f.id)}" aria-pressed="${activeFields.has(f.id)}">${esc(f.name)}</button>`).join("");
  $("#sQuery").placeholder = activeFields.size ? "(tùy chọn) thêm một từ khóa riêng" : "vd: data engineer";
  $("#sGo").textContent = activeFields.size ? `Tìm ${activeFields.size} lĩnh vực` : "Tìm";
}
$("#fieldChips").addEventListener("click", (e) => {
  const c = e.target.closest("[data-field]"); if (!c) return;
  activeFields.has(c.dataset.field) ? activeFields.delete(c.dataset.field) : activeFields.add(c.dataset.field);
  store.set("activeFields", [...activeFields]); renderFieldChips();
});

const fdlg = $("#fieldsDialog");
function fieldRow(f) {
  return `<div class="card field-row" data-id="${esc(f.id)}"><div class="form-grid">
    <label>Tên lĩnh vực<input class="f-name" value="${esc(f.name)}" required></label>
    <label class="check"><input type="checkbox" class="f-tech" ${f.tech ? "checked" : ""}> IT / công nghệ</label>
    <div class="form-actions"><button type="button" class="btn small danger f-del">Xóa</button></div>
    <label class="wide">Từ khóa (mỗi dòng một từ)<textarea class="f-kw" rows="3">${esc(f.keywords.join("\n"))}</textarea></label></div></div>`;
}
function openFields() { $("#fieldRows").innerHTML = fields.map(fieldRow).join(""); fdlg.showModal(); }
$("#fieldsManage").addEventListener("click", openFields);
$("#fieldAdd").addEventListener("click", () => {
  $("#fieldRows").insertAdjacentHTML("beforeend", fieldRow({ id: "f" + Date.now().toString(36), name: "", tech: false, keywords: [] }));
  $("#fieldRows").lastElementChild.querySelector(".f-name").focus();
});
$("#fieldRows").addEventListener("click", (e) => { if (e.target.closest(".f-del")) e.target.closest(".field-row").remove(); });
$("#fieldReset").addEventListener("click", () => { $("#fieldRows").innerHTML = DEFAULT_FIELDS.map(fieldRow).join(""); });
$("#fieldsForm").addEventListener("submit", (e) => {
  if (e.submitter && e.submitter.value !== "save") return;
  const next = $$(".field-row", fdlg).map((row) => ({
    id: row.dataset.id, name: $(".f-name", row).value.trim(), tech: $(".f-tech", row).checked,
    keywords: $(".f-kw", row).value.split("\n").map((k) => k.trim()).filter(Boolean),
  })).filter((f) => f.name);
  fields = next.length ? next : structuredClone(DEFAULT_FIELDS);
  store.set("fields", fields); renderFieldChips();
});

// Hand the chosen fields to the assistant so /scrape searches them too: the scraper reads
// search-queries.md, which /setup --section search rewrites.
$("#fieldsToSetup").addEventListener("click", () => {
  const chosen = fields.filter((f) => activeFields.has(f.id));
  if (!chosen.length) return toast("Hãy chọn ít nhất một lĩnh vực.");
  const lines = chosen.map((f) => `- ${f.name}: ${f.keywords.join(", ")}`).join("\n");
  const loc = $("#sLocation").value.trim();
  goChat(`/setup --section search\n\nMình muốn /scrape tìm việc ở nhiều lĩnh vực, mỗi lĩnh vực là một nhóm ưu tiên riêng trong search-queries.md:\n${lines}${loc ? `\nĐịa điểm: ${loc}` : ""}\n\nHãy cập nhật truy vấn và đánh giá phù hợp (04-job-evaluation.md) cho các lĩnh vực này, giữ nguyên phần còn lại của hồ sơ.`, false);
});

async function searchOnce(portal, keyword, limit) {
  const res = await api("/api/search", {
    portal, query: keyword, location: $("#sLocation").value,
    jobage: $("#sJobage").value, remote: $("#sRemote").value, limit,
  });
  return res.results;
}

$("#searchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#sGo"); btn.disabled = true;
  const status = $("#searchStatus");
  $("#searchResults").innerHTML = "";
  let portal = $("#sPortal").value;
  const limit = String($("#sLimit").value || "20");
  // One job list per (keyword, field); the same posting can match several keywords.
  const jobs = [];
  const seenKeys = new Set();
  const notes = [];
  try {
    const chosen = fields.filter((f) => activeFields.has(f.id));
    const plan = [];
    if (chosen.length) {
      if (portal === "freehire-search") {
        if (chosen.some((f) => !f.tech)) notes.push("freehire thiên về tin IT; lĩnh vực khác vẫn có tin nhưng độ phủ kém hơn LinkedIn.");
        if (!$("#sLocation").value.trim()) notes.push("Chưa nhập mã quốc gia (vd: VN) nên đang tìm toàn cầu - kết quả sẽ rất rộng.");
      }
      // Round-robin across fields so the keyword cap trims every field a little
      // instead of dropping the last field entirely.
      for (let round = 0; plan.length < 100; round++) {
        const before = plan.length;
        for (const f of chosen) if (f.keywords[round]) plan.push({ field: f.name, keyword: f.keywords[round] });
        if (plan.length === before) break;
      }
      const extra = $("#sQuery").value.trim();
      if (extra) plan.push({ field: "", keyword: extra });
    } else {
      plan.push({ field: "", keyword: $("#sQuery").value });
    }
    const capped = plan.slice(0, MAX_KEYWORDS);
    if (plan.length > capped.length) notes.push(`Chỉ chạy ${MAX_KEYWORDS}/${plan.length} từ khóa để giữ lượng truy vấn thấp.`);
    const perKw = chosen.length ? String(Math.min(+limit, MAX_PER_KEYWORD)) : limit;
    // freehire answers in ~1s so a few keywords run side by side; LinkedIn stays one at a time
    // (its public pages are for low-volume personal use).
    const conc = portal === "linkedin-search" ? 1 : 3;
    const label = (portals.find((p) => p.id === portal) || {}).label || portal;
    const results = new Array(capped.length);
    const netErr = (m) => /timed out|timeout|SEARCH_FAILED|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/i.test(m);
    let next = 0, finished = 0, aborted = null;
    const t0 = Date.now();
    const tick = () => { status.textContent = `Đang tìm ${finished}/${capped.length} từ khóa trên ${label}… ${Math.round((Date.now() - t0) / 1000)}s`; };
    tick();
    const timer = setInterval(tick, 1000);
    const worker = async () => {
      while (!aborted) {
        const i = next++;
        if (i >= capped.length) return;
        try { results[i] = await searchOnce(portal, capped[i].keyword, perKw); }
        catch (err) {
          // A network failure will hit every remaining keyword too: stop after the first one
          // instead of making the user wait out the rest.
          if (netErr(err.message)) { aborted = err.message; return; }
          notes.push(`“${capped[i].keyword}”: ${err.message}`);
        }
        finished++;
      }
    };
    try { await Promise.all(Array.from({ length: conc }, worker)); } finally { clearInterval(timer); }
    capped.forEach(({ field }, i) => {
      for (const j of results[i] || []) {
        const key = (j.url || `${j.title}|${j.company}`).toLowerCase();
        if (seenKeys.has(key)) { const prev = jobs.find((x) => (x.url || `${x.title}|${x.company}`).toLowerCase() === key); if (prev && field && !prev.fields.includes(field)) prev.fields.push(field); continue; }
        seenKeys.add(key);
        jobs.push({ ...j, fields: field ? [field] : [] });
      }
    });
    if (aborted) {
      const others = portals.filter((p) => p.id !== portal && p.installed && p.enabled).map((p) => p.label);
      notes.unshift(`${label} không phản hồi nên đã dừng sớm (${aborted.replace(/^CLI lỗi:\s*/, "").slice(0, 120)}). ${others.length ? "Thử nguồn khác: " + others.join(", ") + "." : ""}`);
    }
    const secs = Math.round((Date.now() - t0) / 1000);
    status.innerHTML = `${jobs.length ? `${jobs.length} kết quả` : "Không có kết quả."} <span class="muted small">(${secs}s)</span>${notes.map((n) => `<br><span class="small">${esc(n)}</span>`).join("")}`;
    $("#searchResults").innerHTML = jobs.map((j, i) => jobCard(j, i)).join("");
    $("#searchResults").dataset.json = JSON.stringify(jobs);
  } catch (err) {
    status.textContent = "";
    $("#searchResults").innerHTML = `<div class="note err">${esc(err.message)}</div>`;
  } finally { btn.disabled = false; }
});
$("#sLocation").value = store.get("location", "");
$("#sLocation").addEventListener("change", () => store.set("location", $("#sLocation").value));
renderFieldChips();

function jobCard(j, i) {
  const url = safeUrl(j.url);
  const sub = [j.company, j.location, j.date].filter(Boolean).map(esc).join(" · ");
  const tags = (j.fields || []).map((f) => `<span class="pill good">${esc(f)}</span>`).join(" ");
  const skills = (j.skills || []).slice(0, 6).map((s) => `<span class="pill">${esc(s)}</span>`).join(" ");
  return `<article class="card job" data-i="${i}">
    <div class="t">${esc(j.title || "(không có tiêu đề)")}</div><div class="c">${sub}</div>
    ${j.description ? `<div class="d">${esc(j.description)}</div>` : ""}${tags} ${skills}
    <div class="actions">
      ${url ? `<a class="link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Mở tin ↗</a>` : ""}
      ${url ? `<button class="btn small" data-act="apply">Soạn hồ sơ (/apply)</button>` : ""}
      <button class="btn small" data-act="track">+ Tracker</button>
    </div></article>`;
}
$("#searchResults").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]"); if (!btn) return;
  const card = btn.closest(".job");
  const j = JSON.parse($("#searchResults").dataset.json || "[]")[+card.dataset.i];
  if (!j) return;
  if (btn.dataset.act === "apply") goChat("/apply " + j.url, false);
  if (btn.dataset.act === "track") openFromJob(j);
});
async function openFromJob(j) {
  if (!tracker.statuses.length) tracker = await api("/api/tracker");
  openApp(null, { company: j.company, role: j.title, source: safeUrl(j.url), status: "applied" });
}

// ----------------------------------------------------------- scanned jobs
let seen = [];
async function loadJobs() {
  seen = (await api("/api/jobs")).jobs;
  const statuses = [...new Set(seen.map((j) => j.status).filter(Boolean))].sort();
  const sel = $("#jStatus"), cur = sel.value;
  sel.innerHTML = `<option value="">Mọi trạng thái</option>` + statuses.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
  sel.value = statuses.includes(cur) ? cur : "";
  renderJobs();
}
function renderJobs() {
  const st = $("#jStatus").value, q = $("#jFilter").value.toLowerCase();
  const rows = seen.filter((j) => (!st || j.status === st) && (!q || `${j.title} ${j.company}`.toLowerCase().includes(q)))
    .sort((a, b) => (b.rank_score ?? -1) - (a.rank_score ?? -1));
  $("#jobsEmpty").hidden = seen.length > 0;
  $("#jobsList").innerHTML = rows.map((j) => {
    const url = safeUrl(j.url);
    const score = typeof j.rank_score === "number" ? `<span class="pill ${fitClass(j.rank_score)}">${Math.round(j.rank_score)} · ${esc(j.rank_verdict || "")}</span>` : "";
    const dd = daysUntil(j.deadline);
    const list = (arr, label) => Array.isArray(arr) && arr.length ? `<div class="muted small">${label}</div><ul>${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
    return `<article class="card job"><div class="t">${esc(j.title || j.key)}</div><div class="c">${[j.company, j.location].filter((x) => x && !["PASS", "FAIL", "FLAG"].includes(x)).map(esc).join(" · ")}</div>
      <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">${score}<span class="pill">${esc(j.status || "")}</span>${j.language_gate && j.language_gate !== "PASS" ? `<span class="pill low">Ngôn ngữ: ${esc(j.language_gate)}</span>` : ""}${dd !== null ? `<span class="pill ${dd <= 7 ? "urgent" : ""}">${dd < 0 ? "Quá hạn" : "Còn " + dd + " ngày"}</span>` : ""}</div>
      ${list(j.strengths, "Điểm mạnh")}${list(j.gaps, "Khoảng trống")}
      <div class="actions">${url ? `<a class="link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Mở tin ↗</a><button class="btn small" data-chat="/apply ${esc(url)}">Soạn hồ sơ (/apply)</button>` : ""}</div></article>`;
  }).join("");
}
$("#jStatus").addEventListener("change", renderJobs);
$("#jFilter").addEventListener("input", renderJobs);

// ------------------------------------------------------------------- files
async function loadFiles() {
  const files = (await api("/api/files")).files;
  const groups = {};
  files.forEach((f) => (groups[f.group] = groups[f.group] || []).push(f));
  const labels = { cv: "CV", cover_letters: "Thư xin việc", "documents/applications": "Hồ sơ đã nộp", upskill: "Báo cáo upskill", reports: "Báo cáo HTML" };
  $("#fileList").innerHTML = Object.keys(groups).length ? Object.entries(groups).map(([g, fs]) =>
    `<h5>${esc(labels[g] || g)}</h5>` + fs.map((f) => `<button class="fitem" data-path="${esc(f.path)}">${esc(f.name)}<small>${esc(f.path)} · ${(f.size / 1024).toFixed(0)} KB · ${new Date(f.mtime * 1000).toLocaleDateString("vi-VN")}</small></button>`).join("")).join("")
    : `<p class="muted" style="padding:8px">Chưa có tệp nào. Chạy /apply để tạo CV và thư xin việc.</p>`;
}
$("#fileList").addEventListener("click", (e) => {
  const b = e.target.closest(".fitem"); if (!b) return;
  $$(".fitem").forEach((x) => x.classList.toggle("active", x === b));
  const url = "/file?p=" + encodeURIComponent(b.dataset.path);
  $("#previewHead").innerHTML = `${esc(b.dataset.path)} · <a href="${url}" target="_blank" rel="noopener">Mở tab mới ↗</a>`;
  const fr = $("#previewFrame"); fr.hidden = false; fr.src = url;
});

// -------------------------------------------------------------------- chat
const chat = { session: null, run: null, running: false };
const log = $("#chatLog");

function goChat(text, send) {
  showView("chat");
  const input = $("#chatInput");
  input.value = text;
  input.focus();
  if (send) sendChat();
}

function md(src) {
  const blocks = [];
  let t = String(src).replace(/```[\w-]*\n([\s\S]*?)```/g, (_, c) => { blocks.push(`<pre><code>${esc(c.replace(/\n$/, ""))}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const lines = t.split("\n"), out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const ph = l.match(/^\u0000(\d+)\u0000$/);
    if (ph) { out.push(blocks[+ph[1]]); continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || "")) {
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      let html = "<table><thead><tr>" + cells(l).map((c) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>";
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) html += "<tr>" + cells(lines[i++]).map((c) => `<td>${c}</td>`).join("") + "</tr>";
      i--; out.push(html + "</tbody></table>"); continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) { out.push(`<p><strong>${inline(h[2])}</strong></p>`); continue; }
    if (/^\s*[-*]\s+/.test(l)) {
      let html = "<ul>";
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) html += `<li>${inline(lines[i++].replace(/^\s*[-*]\s+/, ""))}</li>`;
      i--; out.push(html + "</ul>"); continue;
    }
    if (/^\s*\d+[.)]\s+/.test(l)) {
      let html = "<ol>";
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) html += `<li>${inline(lines[i++].replace(/^\s*\d+[.)]\s+/, ""))}</li>`;
      i--; out.push(html + "</ol>"); continue;
    }
    out.push(l.trim() ? `<p>${inline(l)}</p>` : "");
  }
  return out.join("").replace(/\u0000(\d+)\u0000/g, (_, n) => blocks[+n]);
}

function addMsg(kind, html, isHtml) {
  const d = document.createElement("div");
  d.className = kind === "user" ? "msg user" : kind === "bot" ? "msg bot" : kind;
  if (isHtml) d.innerHTML = html; else d.textContent = html;
  log.appendChild(d); log.scrollTop = log.scrollHeight;
  return d;
}

function toolLine(b) {
  const i = b.input || {};
  const detail = i.command || i.file_path || i.url || i.query || i.pattern || i.description || i.prompt || i.skill || "";
  return `${b.name}${detail ? ": " + String(detail).replace(/\s+/g, " ").slice(0, 160) : ""}`;
}

function handleEvent(ev, state) {
  switch (ev.type) {
    case "run": chat.run = ev.run_id; break;
    case "system": if (ev.session_id) chat.session = ev.session_id; break;
    case "assistant":
      for (const b of (ev.message && ev.message.content) || []) {
        if (b.type === "text" && b.text.trim()) { state.typing && state.typing.remove(); state.typing = null; addMsg("bot", md(b.text), true); }
        else if (b.type === "tool_use") { const d = addMsg("tool", toolLine(b)); d.title = d.textContent; }
      }
      break;
    case "result": {
      if (ev.session_id) chat.session = ev.session_id;
      const denied = ev.permission_denials || [];
      if (denied.length) {
        const names = [...new Set(denied.map((d) => d.tool_name + (d.tool_input && d.tool_input.command ? ` (${String(d.tool_input.command).slice(0, 80)})` : "")))];
        addMsg("note", `Có ${denied.length} thao tác bị từ chối vì chế độ không tương tác: ${names.join("; ")}. Thêm quyền trong .claude/settings.json hoặc chạy bước đó trong terminal.`);
      }
      if (ev.is_error && ev.result) addMsg("note err", String(ev.result).slice(0, 600));
      const secs = ev.duration_ms ? Math.round(ev.duration_ms / 1000) + "s" : "";
      const cost = typeof ev.total_cost_usd === "number" ? "$" + ev.total_cost_usd.toFixed(3) : "";
      if (secs || cost) addMsg("note meta", [secs, cost].filter(Boolean).join(" · "));
      break;
    }
    case "error": addMsg("note err", ev.text || "Lỗi không xác định"); break;
    case "log": break;
  }
}

async function sendChat() {
  const input = $("#chatInput");
  const text = input.value.trim();
  if (!text || chat.running) return;
  input.value = "";
  addMsg("user", text);
  setRunning(true);
  const state = { typing: addMsg("typing", "Claude đang làm việc…") };
  try {
    const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: text, session_id: chat.session }) });
    if (!res.ok) { let m = `Lỗi ${res.status}`; try { m = (await res.json()).error || m; } catch { /* keep */ } throw new Error(m); }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (line) { try { handleEvent(JSON.parse(line), state); } catch (err) { console.error(err, line); } }
      }
    }
  } catch (err) {
    addMsg("note err", err.message);
  } finally {
    state.typing && state.typing.remove();
    chat.run = null; setRunning(false);
    loadStatus().catch(() => {});
  }
}

function setRunning(on) {
  chat.running = on;
  $("#chatSend").disabled = on; $("#chatStop").hidden = !on;
}
$("#chatForm").addEventListener("submit", (e) => { e.preventDefault(); sendChat(); });
$("#chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); } });
$("#chatStop").addEventListener("click", () => { if (chat.run) api("/api/chat/stop", { run_id: chat.run }).catch(() => {}); });
$("#chatNew").addEventListener("click", () => {
  if (chat.running) return toast("Đang chạy - hãy dừng trước.");
  chat.session = null; log.innerHTML = "";
  addMsg("note meta", "Cuộc trò chuyện mới.");
});

// -------------------------------------------------------------------- boot
addMsg("note meta", "Gõ lệnh như /apply <link> hoặc chọn một lệnh nhanh phía trên. Câu trả lời tiếp theo nằm trong cùng một phiên (cần cho /setup).");
showView((location.hash || "#overview").slice(1).replace(/[^a-z]/g, "") || "overview");
if (!$(`#view-${(location.hash || "#overview").slice(1)}`)) showView("overview");
