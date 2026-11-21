#!/usr/bin/env python3
"""
يجمع الأخبار من خلاصات RSS/Atom المحددة في config/sources.json
ويكتب:
  data/news.json                 ← آخر تقرير (تقرأه الواجهة)
  data/archive/YYYY-MM-DD.json   ← أرشيف يومي تلقائي
  data/archive/index.json        ← فهرس الأرشيف
لا يحتاج أي مكتبات خارجية (Python 3.9+).
إذا وُجد متغير البيئة ANTHROPIC_API_KEY يكتب ملخصاً ذكياً بالعربية (اختياري).
"""
import hashlib
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config"
DATA = ROOT / "data"
ARCHIVE = DATA / "archive"

MAX_AGE_HOURS = 48
MAX_PER_SOURCE = 40
UA = "Mozilla/5.0 (compatible; NewsDigestBot/1.0; +https://github.com)"

STOPWORDS = set("""
في من على إلى عن مع بعد قبل بين حول خلال ضد عند منذ حتى تحت فوق أن إن كان كانت يكون التي الذي الذين هذا هذه ذلك تلك
ما لا لم لن قد هل أو ثم كل بعض غير أي أمام إثر وسط لدى عبر نحو دون أكثر أول آخر جديد جديدة يوم اليوم أمس العام
و ف ب ل ك ال وزير رئيس يقول قال تقول قالت مقتل أخبار عاجل فيديو صور شاهد بالفيديو بالصور
the a an of to in on for and or with at by from as is are was were be after over into amid about new says say
""".split())


def load_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return default


def local(tag):
    return tag.rsplit("}", 1)[-1].lower() if isinstance(tag, str) else ""


def child_text(el, *names):
    for c in el:
        if local(c.tag) in names and (c.text or "").strip():
            return c.text.strip()
    return ""


def clean(text, limit=None):
    text = html.unescape(re.sub(r"<[^>]+>", " ", text or ""))
    text = re.sub(r"\s+", " ", text).strip()
    if limit and len(text) > limit:
        text = text[:limit].rsplit(" ", 1)[0] + "…"
    return text


def parse_date(s):
    if not s:
        return None
    s = s.strip()
    try:
        d = parsedate_to_datetime(s)
    except Exception:
        d = None
    if d is None:
        try:
            d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except Exception:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc)


def find_image(el):
    for c in el.iter():
        t = local(c.tag)
        if t in ("content", "thumbnail") and c.get("url") and re.search(r"\.(jpe?g|png|webp)", c.get("url"), re.I):
            return c.get("url")
        if t == "enclosure" and (c.get("type") or "").startswith("image"):
            return c.get("url")
    return ""


def parse_feed(xml_bytes, source):
    root = ET.fromstring(xml_bytes)
    items = []
    for el in root.iter():
        if local(el.tag) not in ("item", "entry"):
            continue
        title = clean(child_text(el, "title"))
        link = child_text(el, "link")
        if not link:
            for c in el:
                if local(c.tag) == "link" and c.get("href") and c.get("rel", "alternate") == "alternate":
                    link = c.get("href")
                    break
        if not link:
            link = child_text(el, "guid", "id") if child_text(el, "guid", "id").startswith("http") else ""
        if not title or not link:
            continue
        desc = clean(child_text(el, "description", "summary", "encoded", "content"), 320)
        date = parse_date(child_text(el, "pubdate", "published", "updated", "date"))
        items.append({
            "title": title,
            "link": link.strip(),
            "summary": desc if desc != title else "",
            "published": date.isoformat() if date else None,
            "source": source["name"],
            "sourceId": source["id"],
            "lang": source.get("lang", "ar"),
            "image": find_image(el),
        })
    return items


def fetch(source):
    """يجرب روابط المصدر بالترتيب حتى ينجح أحدها (الأخير غالباً بحث Google News كاحتياط)."""
    urls = source.get("urls") or [source["url"]]
    last_err = None
    for url in urls:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml, */*"})
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                items = parse_feed(r.read(), source)
            if not items:
                raise ValueError("خلاصة فارغة")
            if "news.google.com" in url:
                for it in items:  # Google News يضيف " - اسم الموقع" لنهاية العنوان
                    it["title"] = re.sub(r"\s+[-–]\s+[^-–]{2,40}$", "", it["title"])
            print(f"  ✓ {source['name']}: {len(items)}  ({url[:60]})")
            return source["id"], items, None
        except Exception as e:
            last_err = f"{url[:60]}: {e}"
    print(f"  ✗ {source['name']}: {last_err}", file=sys.stderr)
    return source["id"], [], last_err


GT = "https://translate.googleapis.com/translate_a/single?client=gtx&sl={sl}&tl=ar&dt=t&q={q}"


def translate(text, sl="en"):
    if not text:
        return ""
    url = GT.format(sl=sl, q=urllib.parse.quote(text[:1500]))
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.loads(r.read())
    return "".join(seg[0] for seg in data[0] if seg and seg[0]).strip()


def translate_items(items, limit=120):
    """يترجم عناوين وملخصات الأخبار غير العربية إلى العربية (title_ar / summary_ar)."""
    todo = [it for it in items if it.get("lang", "ar") != "ar"][:limit]
    if not todo:
        return

    def work(it):
        try:
            joined = it["title"] + ("\n" + it["summary"] if it.get("summary") else "")
            out = translate(joined, it.get("lang", "en")).split("\n", 1)
            it["title_ar"] = out[0].strip()
            if len(out) > 1:
                it["summary_ar"] = out[1].strip()
        except Exception as e:
            print(f"  (تعذرت ترجمة خبر: {e})", file=sys.stderr)

    with ThreadPoolExecutor(max_workers=6) as ex:
        list(ex.map(work, todo))
    print(f"  ترجمة: {sum(1 for t in todo if t.get('title_ar'))}/{len(todo)}")


def compile_terms(terms):
    pats = []
    for t in terms:
        if re.search(r"[A-Za-z]", t):
            tail = r"(?![A-Za-z])" if len(t) <= 3 else ""   # الكلمات القصيرة مثل UK وAI تُطابق ككلمة كاملة
            pats.append(re.compile(r"(?<![A-Za-z])" + re.escape(t) + tail, re.I if len(t) > 3 else 0))
        else:
            pats.append(re.compile(re.escape(t)))
    return pats


def tag_items(items, taxonomy):
    countries = {k: compile_terms(v) for k, v in taxonomy.get("countries", {}).items()}
    cats = {k: compile_terms(v) for k, v in taxonomy.get("categories", {}).items()}
    for it in items:
        text = it["title"] + " " + it["summary"]
        it["countries"] = [c for c, pats in countries.items() if any(p.search(text) for p in pats)]
        scores = {c: sum(1 for p in pats if p.search(text)) for c, pats in cats.items()}
        best = max(scores.items(), key=lambda kv: kv[1]) if scores else ("عام", 0)
        it["category"] = best[0] if best[1] > 0 else "عام"


def norm_title(t):
    return re.sub(r"[^\w]+", "", t.lower())[:80]


def trending(items, n=12):
    cnt = Counter()
    for it in items:
        words = set(re.findall(r"[؀-ۿA-Za-z]{3,}", it["title"]))
        for w in words:
            w2 = re.sub(r"^(وال|بال|لل|فال|كال)", "ال", w)
            if w2.lower() in STOPWORDS or w2 in STOPWORDS:
                continue
            cnt[w2] += 1
    return [{"term": w, "count": c} for w, c in cnt.most_common(n) if c >= 2]


def highlights(items, per_cat=2):
    seen_sources, out = {}, []
    for it in items:  # items sorted newest first
        cat = it["category"]
        bucket = seen_sources.setdefault(cat, set())
        if len(bucket) < per_cat and it["sourceId"] not in bucket:
            bucket.add(it["sourceId"])
            out.append({"title": it["title"], "link": it["link"], "source": it["source"], "category": cat})
    return out


def ai_summary(items):
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key or not items:
        return None
    lines = "\n".join(f"- [{it['source']}] {it['title']}" for it in items[:120])
    prompt = ("أنت محرر أخبار. اكتب ملخصاً يومياً بالعربية الفصحى في 6 إلى 8 نقاط قصيرة لأهم ما في هذه العناوين، "
              "مرتبة حسب الأهمية، دون إضافة أي معلومة غير موجودة في العناوين. أعد النقاط فقط، كل نقطة في سطر يبدأ بـ •\n\n" + lines)
    body = json.dumps({
        "model": os.environ.get("SUMMARY_MODEL", "claude-haiku-5-5"),
        "max_tokens": 900,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, headers={
        "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            res = json.loads(r.read())
        text = "".join(b.get("text", "") for b in res.get("content", []))
        return [l.strip(" •-\t") for l in text.splitlines() if l.strip(" •-\t")]
    except Exception as e:
        print(f"  (تعذر الملخص الذكي: {e})", file=sys.stderr)
        return None


def main():
    sources = [s for s in load_json(CONFIG / "sources.json", []) if s.get("enabled", True)]
    taxonomy = load_json(CONFIG / "taxonomy.json", {})
    print(f"جلب {len(sources)} مصدراً…")
    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(fetch, sources))

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=MAX_AGE_HOURS)
    all_items, status, seen = [], {}, set()
    for sid, items, err in results:
        status[sid] = {"ok": err is None, "count": len(items), "error": err}
        kept = 0
        for it in items:
            d = parse_date(it["published"]) if it["published"] else None
            if d and d < cutoff:
                continue
            key = norm_title(it["title"])
            if key in seen:
                continue
            seen.add(key)
            all_items.append(it)
            kept += 1
            if kept >= MAX_PER_SOURCE:
                break

    if not all_items:
        print("لم يُجلب أي خبر؛ سيُترك التقرير السابق كما هو.", file=sys.stderr)
        sys.exit(0)

    all_items.sort(key=lambda x: x["published"] or "", reverse=True)
    tag_items(all_items, taxonomy)
    translate_items(all_items)
    for it in all_items:
        it["id"] = hashlib.md5(it["link"].encode()).hexdigest()[:12]

    report = {
        "generated_at": now.isoformat(),
        "date": now.astimezone(timezone(timedelta(hours=3))).strftime("%Y-%m-%d"),
        "count": len(all_items),
        "sources": status,
        "trending": trending(all_items),
        "highlights": highlights(all_items),
        "ai_summary": ai_summary(all_items),
        "items": all_items,
    }

    DATA.mkdir(exist_ok=True)
    ARCHIVE.mkdir(exist_ok=True)
    (DATA / "news.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    (ARCHIVE / f"{report['date']}.json").write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")

    idx = sorted({p.stem for p in ARCHIVE.glob("????-??-??.json")}, reverse=True)[:90]
    for old in sorted(ARCHIVE.glob("????-??-??.json"))[:-90]:
        old.unlink()
    (ARCHIVE / "index.json").write_text(json.dumps(idx), encoding="utf-8")
    print(f"تم: {len(all_items)} خبراً ← data/news.json")


if __name__ == "__main__":
    main()
