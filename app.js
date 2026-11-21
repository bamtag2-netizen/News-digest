/* الموجز اليومي — الواجهة */
{
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const PAGE = 30;
const LS = { saved: "nd_saved", favs: "nd_favs", theme: "nd_theme", live: "nd_live", tr: "nd_translate" };
const PROXIES = [
  u => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
  u => "https://corsproxy.io/?url=" + encodeURIComponent(u),
];

const state = {
  sources: [], taxonomy: { countries: {}, categories: {} },
  report: null,      // التقرير الحالي من data/news.json
  view: null,        // تقرير محفوظ/مؤرشف قيد العرض (أو null)
  cat: "", shown: PAGE, loading: false,
};

/* ---------- أدوات ---------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = s => String(s || "").toLowerCase()
  .replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { toast("تعذر الحفظ في المتصفح"); return false; } },
};
const rtf = new Intl.RelativeTimeFormat("ar", { numeric: "auto" });
function ago(iso) {
  if (!iso) return "";
  const m = Math.min(0, Math.round((new Date(iso) - Date.now()) / 60000));
  if (m > -1) return "الآن";
  if (Math.abs(m) < 60) return rtf.format(m, "minute");
  if (Math.abs(m) < 1440) return rtf.format(Math.round(m / 60), "hour");
  return rtf.format(Math.round(m / 1440), "day");
}
const fmtDate = (d, o) => new Intl.DateTimeFormat("ar-u-nu-latn", o || { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(d);
let toastT;
function toast(msg, ms = 3200) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms);
}
async function getJSON(url) {
  const r = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

/* ---------- التصنيف (نفس منطق السكربت) ---------- */
function compile(terms) {
  return terms.map(t => /[A-Za-z]/.test(t)
    ? new RegExp("(?<![A-Za-z])" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + (t.length <= 3 ? "(?![A-Za-z])" : ""), t.length > 3 ? "i" : "")
    : new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
let compiled = null;
function tag(it) {
  if (!compiled) compiled = {
    c: Object.entries(state.taxonomy.countries).map(([k, v]) => [k, compile(v)]),
    k: Object.entries(state.taxonomy.categories).map(([k, v]) => [k, compile(v)]),
  };
  const text = it.title + " " + (it.summary || "");
  it.countries = compiled.c.filter(([, ps]) => ps.some(p => p.test(text))).map(([k]) => k);
  let best = ["عام", 0];
  for (const [k, ps] of compiled.k) { const n = ps.filter(p => p.test(text)).length; if (n > best[1]) best = [k, n]; }
  it.category = best[0];
  return it;
}

/* ---------- إعادة التسمية ---------- */
const AR = "\\u0621-\\u064A";
const ISR = new RegExp(`(^|[^${AR}])([وف]?)([لب]?)إسرائيل(?![${AR}])`, "g");
function rename(s) {
  if (!s) return s;
  for (const [a, b] of state.taxonomy.replacements || []) s = s.split(a).join(b);
  if (state.taxonomy.rename_israel !== false)
    s = s.replace(ISR, (m, pre, w, lb) => pre + w + (lb === "ل" ? "للكيان المحتل" : lb === "ب" ? "بالكيان المحتل" : "الكيان المحتل"));
  return s;
}
function prep(it) {
  if (it._p) return it;
  for (const k of ["title", "summary", "title_ar", "summary_ar"]) if (it[k]) it[k] = rename(it[k]);
  if ((it.countries || []).includes("إسرائيل")) it.countries = it.countries.map(c => c === "إسرائيل" ? "الكيان المحتل" : c);
  it._p = 1; return it;
}

/* ---------- الترجمة ---------- */
const isForeign = it => it.lang && it.lang !== "ar";
const trOn = () => store.get(LS.tr, true);
const showAr = it => isForeign(it) && trOn() && !it._orig && it.title_ar;
const T = it => showAr(it) ? it.title_ar : it.title;
const S = it => showAr(it) ? (it.summary_ar || "") : (it.summary || "");
const fullTr = it => `https://translate.google.com/translate?sl=auto&tl=ar&u=${encodeURIComponent(it.link)}`;
async function translateItem(it) {
  const q = it.title + (it.summary ? "\n" + it.summary : "");
  const r = await fetch("https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ar&dt=t&q=" + encodeURIComponent(q.slice(0, 1500)));
  if (!r.ok) throw new Error(r.status);
  const out = (await r.json())[0].map(x => x[0]).join("").split("\n");
  it.title_ar = rename(out[0].trim()); it.summary_ar = rename(out.slice(1).join(" ").trim());
}

/* ---------- التحميل ---------- */
async function boot() {
  $("#today").textContent = fmtDate(new Date());
  $("#year").textContent = new Date().getFullYear();
  applyTheme(store.get(LS.theme, ""));
  try {
    [state.sources, state.taxonomy] = await Promise.all([getJSON("config/sources.json"), getJSON("config/taxonomy.json")]);
  } catch { toast("تعذر تحميل الإعدادات"); }
  $("#country").insertAdjacentHTML("beforeend", Object.keys(state.taxonomy.countries).map(c => `<option>${esc(c)}</option>`).join(""));
  $("#source").insertAdjacentHTML("beforeend", state.sources.filter(s => s.enabled !== false).map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join(""));
  updateBasketCount();
  await loadReport();
  setInterval(() => { if (!state.view && !document.hidden) loadReport(true); }, 15 * 60 * 1000);
}

async function loadReport(silent) {
  try {
    const rep = await getJSON("data/news.json");
    const live = store.get(LS.live, null);
    // دمج آخر تحديث مباشر إن كان أحدث من ملف الخادم
    if (live && live.generated_at > rep.generated_at) rep.items = mergeItems(live.items, rep.items), rep.generated_at = live.generated_at, rep.sample = false;
    rep.items.forEach(prep);
    if (Array.isArray(rep.ai_summary)) rep.ai_summary = rep.ai_summary.map(rename);
    state.report = rep;
    if (!silent) state.shown = PAGE;
    render();
  } catch (e) {
    if (!silent) { $("#updated").textContent = "لا يوجد تقرير بعد"; renderEmpty("لم يُعثر على data/news.json — شغّل سير العمل في GitHub Actions أو اضغط تحديث."); }
  }
}

function mergeItems(a, b) {
  const seen = new Set(), out = [];
  for (const it of [...a, ...b]) {
    const k = norm(it.title).replace(/\W+/g, "").slice(0, 80);
    if (seen.has(k) || seen.has(it.link)) continue;
    seen.add(k); seen.add(it.link); out.push(it);
  }
  return out.sort((x, y) => (y.published || "").localeCompare(x.published || ""));
}

/* ---------- تحديث مباشر من المتصفح (احتياطي) ---------- */
function parseFeed(xml, src) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) throw new Error("xml");
  return [...doc.querySelectorAll("item, entry")].map(el => {
    const g = n => el.getElementsByTagName(n)[0]?.textContent?.trim() || "";
    let link = g("link");
    if (!link) link = [...el.getElementsByTagName("link")].find(l => l.getAttribute("href"))?.getAttribute("href") || "";
    const strip = h => new DOMParser().parseFromString(h, "text/html").body.textContent.replace(/\s+/g, " ").trim();
    const d = new Date(g("pubDate") || g("published") || g("updated") || g("dc:date"));
    const sum = strip(g("description") || g("summary")).slice(0, 320);
    const title = strip(g("title"));
    return tag({ title, link, summary: sum === title ? "" : sum, published: isNaN(d) ? null : d.toISOString(),
      source: src.name, sourceId: src.id, lang: src.lang, id: src.id + "-" + btoa(unescape(encodeURIComponent(link))).slice(-12) });
  }).filter(i => i.title && i.link);
}
async function fetchLive(src) {
  if (src.enabled === false) return null;
  const urls = src.urls || [src.url];
  for (const u of urls) for (const p0 of PROXIES) {
    const p = x => p0(x);
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 9000);
      const r = await fetch(p(u), { signal: ctl.signal }); clearTimeout(t);
      if (r.ok) {
        const got = parseFeed(await r.text(), src).slice(0, 40);
        if (u.includes("news.google.com")) got.forEach(i => i.title = i.title.replace(/\s+[-–]\s+[^-–]{2,40}$/, ""));
        if (got.length) return got.map(prep);
      }
    } catch {}
  }
  return null;
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  const b = $("#btnRefresh"); b.disabled = true; b.classList.add("spin");
  closeView(false);
  await loadReport(true);
  toast("جارٍ جلب آخر الأخبار من المصادر…", 8000);
  const res = await Promise.all(state.sources.map(fetchLive));
  const fresh = res.filter(Boolean).flat();
  const ok = res.filter(Boolean).length;
  if (fresh.length && state.report) {
    const cutoff = Date.now() - 48 * 3600e3;
    state.report.items = mergeItems(fresh, state.report.items).filter(i => !i.published || new Date(i.published) > cutoff);
    state.report.generated_at = new Date().toISOString(); state.report.sample = false;
    store.set(LS.live, { generated_at: state.report.generated_at, items: fresh });
    toast(`تم التحديث: ${fresh.length} خبراً من ${ok} مصدراً`);
  } else {
    toast(ok ? "لا جديد" : "تعذر التحديث المباشر — عُرض آخر تقرير من الخادم");
  }
  state.shown = PAGE; render();
  b.disabled = false; b.classList.remove("spin"); state.loading = false;
}

/* ---------- الفلترة ---------- */
const current = () => state.view || state.report;
function baseFiltered() {
  const rep = current(); if (!rep) return [];
  const q = norm($("#q").value.trim()).split(/\s+/).filter(Boolean);
  const country = $("#country").value, source = $("#source").value;
  const hours = +$("#range").value;
  const since = (state.view ? new Date(rep.generated_at || rep.savedAt).getTime() : Date.now()) - hours * 3600e3;
  return rep.items.filter(it =>
    (!country || (it.countries || []).includes(country)) &&
    (!source || it.sourceId === source) &&
    (!it.published || new Date(it.published).getTime() >= since) &&
    (!q.length || q.every(w => norm([it.title, it.summary, it.title_ar, it.summary_ar].join(" ")).includes(w))));
}
const filtered = () => { const b = baseFiltered(); return state.cat ? b.filter(i => i.category === state.cat) : b; };

/* ---------- الملخص: القصص التي تغطيها مصادر أكثر ---------- */
const STOP = new Set(norm("في من على الى عن مع بعد قبل بين حول خلال ضد عند منذ حتى ان كان التي الذي هذا هذه ذلك ما لا لم لن قد او ثم كل اي امام اثر وسط عبر نحو دون اكثر اول جديد اليوم امس قال يقول عاجل فيديو the a an of to in on for and with at by from as is are after over amid says new").split(" "));
const words = t => [...new Set(norm(t).match(/[؀-ۿa-z]{3,}/g) || [])].map(w => w.replace(/^(وال|بال|لل|فال)/, "ال")).filter(w => !STOP.has(w));
function topStories(items, n = 7) {
  const W = items.map(i => words(T(i)));
  const scored = items.map((it, i) => {
    const srcs = new Set([it.sourceId]);
    W.forEach((w, j) => { if (j !== i && w.filter(x => W[i].includes(x)).length >= 2) srcs.add(items[j].sourceId); });
    return { it, score: srcs.size, srcs: srcs.size };
  }).sort((a, b) => b.score - a.score || (b.it.published || "").localeCompare(a.it.published || ""));
  const out = [], used = [];
  for (const s of scored) {
    const w = words(T(s.it));
    if (used.some(u => u.filter(x => w.includes(x)).length >= 2)) continue;
    used.push(w); out.push(s); if (out.length >= n) break;
  }
  return out;
}
function trendTerms(items, n = 12) {
  const c = new Map(), shown = new Map();
  items.forEach(i => {
    (T(i).match(/[\u0600-\u06FFA-Za-z]{3,}/g) || []).forEach(raw => { const k = words(raw)[0]; if (k && !shown.has(k)) shown.set(k, raw.replace(/^(و|ف)(?=ال)/, "")); });
    words(T(i)).forEach(w => c.set(w, (c.get(w) || 0) + 1));
  });
  return [...c].filter(([, v]) => v >= 2).sort((a, b) => b[1] - a[1]).slice(0, n).map(([w, v]) => [shown.get(w) || w, v]);
}

/* ---------- العرض ---------- */
function render(all = false) {
  const rep = current(); if (!rep) return;
  const gen = new Date(rep.generated_at || rep.savedAt);
  $("#updated").textContent = (state.view ? "تقرير محفوظ · " : "آخر تحديث ") + fmtDate(gen, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

  const base = baseFiltered(), items = filtered();
  const hasFilter = $("#q").value.trim() || $("#country").value || $("#source").value || state.cat;

  // التصنيفات
  const counts = {}; base.forEach(i => counts[i.category] = (counts[i.category] || 0) + 1);
  const cats = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  $("#cats").innerHTML = `<button class="chip ${state.cat ? "" : "on"}" data-cat="">الكل<i>${base.length}</i></button>` +
    cats.map(([c, n]) => `<button class="chip ${state.cat === c ? "on" : ""}" data-cat="${esc(c)}">${esc(c)}<i>${n}</i></button>`).join("");

  // الملخص
  const ai = !hasFilter && !state.view && Array.isArray(rep.ai_summary) && rep.ai_summary.length ? rep.ai_summary : null;
  const savedSummary = state.view && !hasFilter ? state.view.summary : null;
  if (ai || savedSummary) {
    $("#summary").innerHTML = (ai || savedSummary).map(s => typeof s === "string"
      ? `<li><span>${esc(s)}</span></li>`
      : `<li><span><a href="${esc(s.link)}" target="_blank" rel="noopener">${esc(s.title)}</a><small>${esc(s.source)}${s.srcs > 1 ? ` · تناولته ${s.srcs} مصادر` : ""}</small></span></li>`).join("");
  } else {
    const top = topStories(items);
    $("#summary").innerHTML = top.length ? top.map(({ it, srcs }) =>
      `<li><span><a href="${esc(it.link)}" target="_blank" rel="noopener">${esc(T(it))}</a><small>${esc(it.source)} · ${ago(it.published)}${srcs > 1 ? ` · تناولته ${srcs} مصادر` : ""}</small></span></li>`).join("")
      : `<li><span class="muted">لا توجد أخبار مطابقة.</span></li>`;
  }

  // الأكثر تداولاً + التوزيع
  const tr = trendTerms(items);
  $("#trending").innerHTML = tr.length ? tr.map(([w, n]) => `<button class="chip" data-term="${esc(w)}">${esc(w)}<i>${n}</i></button>`).join("") : `<span class="muted">—</span>`;
  const max = cats[0]?.[1] || 1;
  $("#stats").innerHTML = cats.slice(0, 8).map(([c, n]) =>
    `<button class="bar" data-cat="${esc(c)}"><span>${esc(c)}</span><span><b style="width:${(n / max * 100).toFixed(1)}%"></b></span><em>${n}</em></button>`).join("");

  // العنوان والقائمة
  const parts = [state.cat, $("#country").value, $("#q").value.trim() && `«${$("#q").value.trim()}»`].filter(Boolean);
  $("#listTitle").textContent = parts.length ? "أخبار: " + parts.join(" · ") : "كل الأخبار";
  $("#resultCount").textContent = `${items.length} خبراً`;
  const favs = store.get(LS.favs, {});
  const q = $("#q").value.trim().split(/\s+/).filter(w => w.length > 1);
  const hl = s => { let h = esc(s); q.forEach(w => { h = h.replace(new RegExp(esc(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), m => `<mark>${m}</mark>`); }); return h; };
  const list = all ? items : items.slice(0, state.shown);
  $("#list").innerHTML = list.length ? list.map(it => `
    <article class="card" data-id="${esc(it.id)}">
      <div class="meta"><span class="src">${esc(it.source)}</span><span>${ago(it.published)}</span><span class="cat">${esc(it.category)}</span>${(it.countries || []).slice(0, 2).map(c => `<span>${esc(c)}</span>`).join("")}</div>
      <h3><a href="${esc(it.link)}" target="_blank" rel="noopener" ${isForeign(it) && !showAr(it) ? 'dir="ltr" lang="en"' : ""}>${hl(T(it))}</a></h3>
      ${S(it) ? `<p ${isForeign(it) && !showAr(it) ? 'dir="ltr" lang="en"' : ""}>${hl(S(it))}</p>` : ""}
      ${showAr(it) ? `<small class="trnote">ترجمة آلية من ${it.lang === "en" ? "الإنجليزية" : "لغة أجنبية"}</small>` : ""}
      <a class="link" href="${esc(it.link)}" target="_blank" rel="noopener">${esc(prettyLink(it.link))}</a>
      <div class="tools">
        <button class="fav ${favs[it.id] ? "on" : ""}" data-act="fav">${favs[it.id] ? "★ في المفضلة" : "☆ حفظ الخبر"}</button>
        <button data-act="copy">نسخ الرابط</button>
        <a href="https://wa.me/?text=${encodeURIComponent(T(it) + "\n" + it.link)}" target="_blank" rel="noopener">واتساب</a>
        ${isForeign(it) ? `<button data-act="tr">${showAr(it) ? "عرض الأصل" : "ترجمة"}</button><a href="${fullTr(it)}" target="_blank" rel="noopener">ترجمة المقال كاملاً</a>` : ""}
      </div>
    </article>`).join("") : `<div class="empty">لا توجد أخبار تطابق البحث.${current().sample ? "<br>المعروض الآن عينة أولية فقط — اضغط «تحديث» لجلب الأخبار الحقيقية من كل المصادر، أو شغّل التحديث على GitHub." : " جرّب كلمة أخرى أو وسّع الفترة الزمنية."}</div>`;
  $("#more").hidden = all || items.length <= state.shown;

  // شريط التقرير المحفوظ
  const bn = $("#viewBanner");
  bn.hidden = !state.view;
  if (state.view) bn.innerHTML = `<span>تعرض: <b>${esc(state.view.name)}</b>${state.view.note ? " — " + esc(state.view.note) : ""}</span><button class="btn" id="backLive">العودة إلى تقرير اليوم</button>`;
}
function renderEmpty(msg) { $("#list").innerHTML = `<div class="empty">${esc(msg)}</div>`; $("#summary").innerHTML = ""; }

/* ---------- السلة ---------- */
function updateBasketCount() { $("#basketCount").textContent = store.get(LS.saved, []).length; }
function snapshot(name, note) {
  const items = filtered().slice(0, 300);
  return {
    id: Date.now().toString(36), name, note, savedAt: new Date().toISOString(),
    generated_at: current().generated_at,
    filters: { q: $("#q").value, country: $("#country").value, source: $("#source").value, cat: state.cat },
    summary: topStories(items).map(({ it, srcs }) => ({ title: T(it), link: it.link, source: it.source, srcs })),
    items,
  };
}
let tab = "saved";
async function renderDrawer() {
  $$(".tab").forEach(t => t.classList.toggle("on", t.dataset.tab === tab));
  const body = $("#drawerBody");
  if (tab === "saved") {
    const s = store.get(LS.saved, []);
    body.innerHTML = s.length ? s.map(r => `<div class="saved" data-id="${r.id}">
      <h4>${esc(r.name)}</h4><p>${fmtDate(new Date(r.savedAt), { day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit" })} · ${r.items.length} خبراً${r.note ? " · " + esc(r.note) : ""}</p>
      <div class="row"><button class="btn" data-act="open">فتح</button><button class="btn" data-act="pdf">PDF</button><button class="btn" data-act="json">تنزيل JSON</button><button class="btn" data-act="del">حذف</button></div></div>`).join("")
      : `<p class="muted">السلة فارغة. اضغط «حفظ» في الأعلى لحفظ التقرير الحالي (مع الفلاتر المختارة).</p>`;
  } else if (tab === "archive") {
    body.innerHTML = `<p class="muted">جارٍ التحميل…</p>`;
    try {
      const idx = await getJSON("data/archive/index.json");
      body.innerHTML = idx.length ? `<p class="muted">يحفظه GitHub تلقائياً كل يوم (آخر 90 يوماً).</p>` + idx.map(d => `<div class="saved" data-date="${esc(d)}">
        <h4>${fmtDate(new Date(d + "T12:00:00"))}</h4><div class="row"><button class="btn" data-act="openArchive">فتح</button></div></div>`).join("")
        : `<p class="muted">لا يوجد أرشيف بعد.</p>`;
    } catch { body.innerHTML = `<p class="muted">لا يوجد أرشيف بعد — سيظهر بعد أول تشغيل لسير العمل.</p>`; }
  } else {
    const f = Object.values(store.get(LS.favs, {}));
    body.innerHTML = f.length ? f.map(it => `<div class="saved" data-fid="${esc(it.id)}"><h4><a href="${esc(it.link)}" target="_blank" rel="noopener">${esc(T(it))}</a></h4>
      <p>${esc(it.source)} · ${ago(it.published)}</p><div class="row"><button class="btn" data-act="unfav">إزالة</button></div></div>`).join("")
      : `<p class="muted">لا توجد أخبار مفضلة بعد. اضغط «☆ حفظ الخبر» تحت أي خبر.</p>`;
  }
}
function openView(rep) {
  state.view = rep; state.cat = ""; state.shown = PAGE;
  $("#q").value = ""; $("#country").value = ""; $("#source").value = ""; $("#range").value = "48";
  if (rep.filters) { $("#q").value = rep.filters.q || ""; $("#country").value = rep.filters.country || ""; $("#source").value = rep.filters.source || ""; state.cat = rep.filters.cat || ""; }
  $("#drawer").hidden = true; render(); scrollTo({ top: 0, behavior: "smooth" });
}
function closeView(r = true) { if (!state.view) return; state.view = null; $("#range").value = "24"; state.cat = ""; if (r) render(); }
function download(name, text, type = "application/json") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- PDF ---------- */
const prettyLink = u => { try { return decodeURI(u); } catch { return u; } };
function buildPdfDoc() {
  const rep = current(), items = filtered();
  const parts = [state.cat, $("#country").value, $("#source").selectedOptions[0]?.value && $("#source").selectedOptions[0].text, $("#q").value.trim() && `«${$("#q").value.trim()}»`].filter(Boolean);
  const top = $("#summary").innerHTML;
  const d = document.createElement("div");
  d.className = "pdf-doc"; d.dir = "rtl";
  d.innerHTML = `
    <header><h1>الموجز اليومي</h1>
      <p>${esc(state.view ? state.view.name : fmtDate(new Date(rep.generated_at)))} · ${items.length} خبراً${parts.length ? " · " + esc(parts.join(" · ")) : ""}</p></header>
    <h2>ملخص اليوم</h2><ol class="summary">${top}</ol>
    <h2>الأخبار</h2>
    ${items.map(it => `<div class="pdf-item">
      <div class="meta"><b>${esc(it.source)}</b> · ${esc(it.category)} · ${it.published ? fmtDate(new Date(it.published), { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : ""}</div>
      <h3 ${isForeign(it) && !showAr(it) ? 'dir="ltr"' : ""}>${esc(T(it))}</h3>
      ${S(it) ? `<p ${isForeign(it) && !showAr(it) ? 'dir="ltr"' : ""}>${esc(S(it))}</p>` : ""}
      <a href="${esc(it.link)}">${esc(prettyLink(it.link))}</a></div>`).join("")}
    <p class="copy">جميع الحقوق محفوظة © ${new Date().getFullYear()} باسم أبو أنس</p>`;
  return d;
}
// يُنشئ نسخة مخصصة للطباعة ثم يفتح نافذة الطباعة: اختر «حفظ بتنسيق PDF».
// هذه الطريقة تحافظ على تشكيل العربية، والنص قابل للنسخ، والروابط قابلة للضغط داخل الـ PDF.
function exportPdf() {
  $(".pdf-doc")?.remove();
  const doc = buildPdfDoc(); document.body.appendChild(doc);
  const oldTitle = document.title;
  document.title = (state.view ? state.view.name : "الموجز اليومي " + new Date().toISOString().slice(0, 10)).replace(/[\\/:*?"<>|]/g, "-");
  document.body.classList.add("printing");
  const done = () => { document.body.classList.remove("printing"); doc.remove(); document.title = oldTitle; removeEventListener("afterprint", done); };
  addEventListener("afterprint", done);
  setTimeout(() => { try { window.print(); } catch { toast("الطباعة غير متاحة في هذا المتصفح"); } setTimeout(() => { if (document.body.classList.contains("printing") && !matchMedia("print").matches) done(); }, 1500); }, 60);
  toast("اختر «حفظ بتنسيق PDF» من نافذة الطباعة", 5000);
}

/* ---------- السمة ---------- */
function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }

/* ---------- الأحداث ---------- */
let qT;
$("#q").addEventListener("input", () => { clearTimeout(qT); qT = setTimeout(() => { state.shown = PAGE; render(); }, 220); });
["#country", "#source", "#range"].forEach(s => $(s).addEventListener("change", () => { state.shown = PAGE; render(); }));
$("#filters").addEventListener("submit", e => e.preventDefault());
document.addEventListener("click", e => {
  const c = e.target.closest("[data-cat]"); if (c) { state.cat = c.dataset.cat; state.shown = PAGE; render(); return; }
  const t = e.target.closest("[data-term]"); if (t) { $("#q").value = t.dataset.term; state.shown = PAGE; render(); return; }
  if (e.target.closest("#backLive")) { closeView(); return; }
  if (e.target.closest("[data-close]")) { e.target.closest(".drawer").hidden = true; return; }
  if (e.target.classList.contains("drawer")) { e.target.hidden = true; return; }

  const card = e.target.closest(".card"), act = e.target.closest("[data-act]")?.dataset.act;
  if (card && act) {
    const it = current().items.find(i => i.id === card.dataset.id); if (!it) return;
    if (act === "fav") { const f = store.get(LS.favs, {}); if (f[it.id]) delete f[it.id]; else f[it.id] = it; store.set(LS.favs, f); render(); }
    if (act === "tr") {
      if (showAr(it)) { it._orig = 1; render(); return; }
      it._orig = 0;
      if (!trOn()) { store.set(LS.tr, true); syncTrBtn(); }
      if (it.title_ar) { render(); return; }
      toast("جارٍ الترجمة…");
      translateItem(it).then(render, () => { toast("تعذرت الترجمة هنا — سيُفتح المقال مترجماً"); open(fullTr(it), "_blank"); });
      return;
    }
    if (act === "copy") navigator.clipboard?.writeText(it.link).then(() => toast("نُسخ الرابط"), () => toast(it.link, 6000));
    return;
  }
  const sv = e.target.closest(".saved");
  if (sv && act) {
    const all = store.get(LS.saved, []), r = all.find(x => x.id === sv.dataset.id);
    if (act === "open") openView(r);
    if (act === "pdf") { openView(r); setTimeout(exportPdf, 200); }
    if (act === "json") download(r.name + ".json", JSON.stringify(r, null, 1));
    if (act === "del") { store.set(LS.saved, all.filter(x => x.id !== r.id)); updateBasketCount(); if (state.view?.id === r.id) closeView(); renderDrawer(); toast("حُذف التقرير"); }
    if (act === "openArchive") getJSON(`data/archive/${sv.dataset.date}.json`).then(rep => openView({ ...rep, name: "أرشيف " + fmtDate(new Date(sv.dataset.date + "T12:00:00")) })).catch(() => toast("تعذر فتح الأرشيف"));
    if (act === "unfav") { const f = store.get(LS.favs, {}); delete f[sv.dataset.fid]; store.set(LS.favs, f); renderDrawer(); render(); }
  }
});
$$(".tab").forEach(t => t.addEventListener("click", () => { tab = t.dataset.tab; renderDrawer(); }));
$("#more").addEventListener("click", () => { state.shown += PAGE; render(); });
$("#btnRefresh").addEventListener("click", refresh);
$("#btnPdf").addEventListener("click", exportPdf);
$("#btnBasket").addEventListener("click", () => { $("#drawer").hidden = false; renderDrawer(); });
function syncTrBtn() { const b = $("#btnTr"); b.textContent = trOn() ? "الترجمة: مفعّلة" : "الترجمة: متوقفة"; b.setAttribute("aria-pressed", trOn()); }
syncTrBtn();
$("#btnTr").addEventListener("click", () => {
  store.set(LS.tr, !trOn()); syncTrBtn(); (current()?.items || []).forEach(i => i._orig = 0); render();
  toast(trOn() ? "تُعرض الأخبار الأجنبية مترجمة للعربية" : "تُعرض الأخبار الأجنبية بلغتها الأصلية");
});
$("#btnTheme").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const t = dark ? "light" : "dark"; applyTheme(t); store.set(LS.theme, t);
});
$("#btnSave").addEventListener("click", () => {
  if (!current()) return;
  const parts = [state.cat, $("#country").value, $("#q").value.trim()].filter(Boolean);
  $("#saveName").value = "موجز " + fmtDate(new Date(), { day: "numeric", month: "long", year: "numeric" }) + (parts.length ? " — " + parts.join("، ") : "");
  $("#saveNote").value = ""; $("#saveDlg").hidden = false; $("#saveName").focus();
});
$("#saveForm").addEventListener("submit", e => {
  e.preventDefault();
  const all = store.get(LS.saved, []);
  all.unshift(snapshot($("#saveName").value.trim(), $("#saveNote").value.trim()));
  if (store.set(LS.saved, all.slice(0, 60))) { updateBasketCount(); toast("حُفظ التقرير في السلة"); }
  $("#saveDlg").hidden = true;
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") $$(".drawer").forEach(d => d.hidden = true);
  if (e.key === "/" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") { e.preventDefault(); $("#q").focus(); }
});

boot();
}
