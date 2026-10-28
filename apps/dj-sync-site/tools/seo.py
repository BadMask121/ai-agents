"""Rewrites every page's <head> SEO block and JSON-LD; writes manifest, robots, sitemap, llms.txt."""
import html, json, re, sys, pathlib
from html.parser import HTMLParser

P = pathlib.Path(sys.argv[1])
BASE = "https://djsync.jeffrey.build"
# The app's version, so a release (apps/dj-sync/release.sh) restamps the pages.
VERSION = (pathlib.Path(__file__).resolve().parents[2] / "dj-sync/macos/VERSION").read_text().strip()
DMG = f"{BASE}/download/DJ-Sync-{VERSION}.dmg"
# Download links name the release (DJ-Sync-1.2.1.dmg), not DJ-Sync-latest.dmg.
DMG_LINK = re.compile(r"/download/DJ-Sync-(?:latest|\d+\.\d+\.\d+)\.dmg")
def stamp(text): return DMG_LINK.sub(f"/download/DJ-Sync-{VERSION}.dmg", text)
SUPPORT = "jeff.emakpor@gmail.com"

PAGES = {
  "index.html": dict(path="/", og="home", type="website",
    title="Spotify & YouTube to Rekordbox, from any chat · DJ Sync",
    og_title="DJ Sync: ask your AI, it lands in Rekordbox",
    desc="Free Mac app: send a Spotify or YouTube link from Telegram, Claude, ChatGPT or your iPhone and it lands in your Rekordbox library and playlists.",
    alt="DJ Sync: a Spotify link becomes a new track in a Rekordbox playlist. Works from Telegram, Claude, ChatGPT and iPhone."),
  "install/index.html": dict(path="/install/", og="install", type="article", crumb="Install", howto=True,
    title="Install the free Mac app for Rekordbox · DJ Sync",
    desc="Download DJ Sync for Mac, allow it once with Open Anyway, then connect Telegram, Claude, ChatGPT or your iPhone. Free, about five minutes.",
    alt="Set up DJ Sync in five minutes: download, Open Anyway, connect."),
  "faq/index.html": dict(path="/faq/", og="faq", type="article", crumb="FAQ", faq=True,
    title="FAQ: Rekordbox, backups, offline Macs · DJ Sync",
    desc="Answers about DJ Sync: Rekordbox open or closed, backups and restore, offline Macs, which way to connect, pricing, privacy and removal.",
    alt="DJ Sync FAQ: Rekordbox open or closed, library safety, offline Macs, pricing."),
  "connect/telegram/index.html": dict(path="/connect/telegram/", og="connect-telegram", type="article", crumb="Connect Telegram", howto=True,
    title="Telegram bot for Rekordbox downloads (free) · DJ Sync",
    desc="Pair the free DJ Sync Telegram bot by QR code, then share Spotify or YouTube links and they land in your Rekordbox playlists. Any phone.",
    alt="DJ Sync in Telegram: share a link, pick a playlist, it's added to Rekordbox."),
  "connect/claude/index.html": dict(path="/connect/claude/", og="connect-claude", type="article", crumb="Connect Claude", howto=True,
    title="Use Claude to download into Rekordbox (free) · DJ Sync",
    desc="Add DJ Sync to Claude as a custom connector (free plans get one) and ask Claude to download tracks and manage your Rekordbox playlists.",
    alt="Claude moves tracks between Rekordbox playlists with DJ Sync."),
  "connect/iphone/index.html": dict(path="/connect/iphone/", og="connect-iphone", type="article", crumb="Connect iPhone", howto=True,
    title="iPhone Share to Rekordbox in one tap · DJ Sync",
    desc="Scan one QR code, tap Add Shortcut, then share any Spotify or YouTube song to DJ Sync. It lands in your Rekordbox playlist. Free.",
    alt="iPhone Share sheet with DJ Sync, then picking a Rekordbox playlist."),
  "connect/chatgpt/index.html": dict(path="/connect/chatgpt/", og="connect-chatgpt", type="article", crumb="Connect ChatGPT", howto=True,
    title="Use ChatGPT to download into Rekordbox · DJ Sync",
    desc="Add DJ Sync to ChatGPT as a custom MCP connector (paid plan) and ask it to download tracks or build Rekordbox playlists, on web or phone.",
    alt="ChatGPT adds a track to a Rekordbox playlist with DJ Sync."),
  "privacy/index.html": dict(path="/privacy/", og="default", type="website", crumb="Privacy",
    title="Privacy: what the DJ Sync cloud stores · DJ Sync",
    desc="What the DJ Sync cloud stores and never stores, how long it keeps it, and what Telegram, Claude, ChatGPT and your iPhone can see.",
    alt="DJ Sync: Spotify and YouTube to Rekordbox, from any chat."),
  "terms/index.html": dict(path="/terms/", og="default", type="website", crumb="Terms",
    title="Terms of use · DJ Sync",
    desc="Plain-language terms for using DJ Sync, the free Mac app that sends Spotify and YouTube links to Rekordbox, and the DJ Sync cloud.",
    alt="DJ Sync: Spotify and YouTube to Rekordbox, from any chat."),
  "404.html": dict(path=None, og="default", type="website", noindex=True,
    title="Page not found · DJ Sync",
    desc="This page doesn't exist. DJ Sync is a free Mac app that sends Spotify and YouTube links from any chat to Rekordbox.",
    alt="DJ Sync: Spotify and YouTube to Rekordbox, from any chat."),
}

# ---------- tiny DOM ----------
VOID = {"area","base","br","col","embed","hr","img","input","link","meta","source","track","wbr"}
class Node:
    def __init__(s, tag, attrs, parent): s.tag, s.attrs, s.parent, s.kids = tag, dict(attrs), parent, []
    def text(s):
        return "".join(k if isinstance(k, str) else k.text() for k in s.kids)
    def find_all(s, pred):
        for k in s.kids:
            if isinstance(k, Node):
                if pred(k): yield k
                yield from k.find_all(pred)
class Builder(HTMLParser):
    def __init__(s):
        super().__init__(convert_charrefs=True); s.root = Node("#root", {}, None); s.cur = s.root
    def handle_starttag(s, tag, attrs):
        n = Node(tag, attrs, s.cur); s.cur.kids.append(n)
        if tag not in VOID: s.cur = n
    def handle_endtag(s, tag):
        c = s.cur
        while c is not s.root and c.tag != tag: c = c.parent
        if c is not s.root: s.cur = c.parent
    def handle_data(s, d): s.cur.kids.append(d)
def dom(src):
    b = Builder(); b.feed(src); return b.root
def clean(t): return re.sub(r"\s+", " ", t).strip()

def faq_entities(root):
    out = []
    for d in root.find_all(lambda n: n.tag == "details"):
        q = next(d.find_all(lambda n: n.tag == "summary"))
        a = next(d.find_all(lambda n: n.tag == "div"))
        out.append({"@type": "Question", "name": clean(q.text()),
                    "acceptedAnswer": {"@type": "Answer", "text": clean(a.text())}})
    return out

def howto_steps(root):
    ol = next(root.find_all(lambda n: n.tag == "ol" and "howto" in n.attrs.get("class", "")))
    steps = []
    for li in [k for k in ol.kids if isinstance(k, Node) and k.tag == "li"]:
        h3 = next(li.find_all(lambda n: n.tag == "h3"))
        body = clean("".join(k if isinstance(k, str) else ("" if k is h3 or k.tag == "figure" else k.text()) for k in li.kids))
        if len(body) > 480:
            body = body[:480].rsplit(". ", 1)[0] + "."
        steps.append({"@type": "HowToStep", "position": len(steps) + 1, "name": clean(h3.text()), "text": body})
    return steps

def ldjson(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")

ORG = {"@type": "Organization", "@id": f"{BASE}/#org", "name": "DJ Sync", "url": f"{BASE}/",
       "logo": {"@type": "ImageObject", "url": f"{BASE}/icon-512.png", "width": 512, "height": 512},
       "contactPoint": {"@type": "ContactPoint", "contactType": "customer support", "email": SUPPORT}}

def structured(name, meta, root, url):
    img = f"{BASE}/og/{meta['og']}.png"
    graph = []
    if name == "index.html":
        graph += [ORG,
          {"@type": "WebSite", "@id": f"{BASE}/#website", "url": f"{BASE}/", "name": "DJ Sync",
           "description": meta["desc"], "inLanguage": "en", "publisher": {"@id": f"{BASE}/#org"}},
          {"@type": "SoftwareApplication", "@id": f"{BASE}/#app", "name": "DJ Sync", "url": f"{BASE}/",
           "description": meta["desc"], "image": img, "operatingSystem": "macOS 14 or later",
           "applicationCategory": "MultimediaApplication", "softwareVersion": VERSION, "downloadUrl": DMG,
           "installUrl": f"{BASE}/install/", "isAccessibleForFree": True,
           "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
           "publisher": {"@id": f"{BASE}/#org"}}]
    elif meta.get("path"):
        graph.append({"@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "DJ Sync", "item": f"{BASE}/"},
            {"@type": "ListItem", "position": 2, "name": meta["crumb"], "item": url}]})
    if meta.get("faq"):
        graph.append({"@type": "FAQPage", "@id": f"{url}#faq", "url": url, "mainEntity": faq_entities(root)})
    if meta.get("howto"):
        h1 = clean(next(root.find_all(lambda n: n.tag == "h1")).text())
        graph.append({"@type": "HowTo", "@id": f"{url}#howto", "name": h1, "description": meta["desc"],
                      "image": img, "totalTime": "PT5M" if "install" in name else "PT2M",
                      "estimatedCost": {"@type": "MonetaryAmount", "currency": "USD", "value": "0"},
                      "step": howto_steps(root)})
    return {"@context": "https://schema.org", "@graph": graph}

KEEP = [
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  '<meta name="theme-color" content="#0a0a0c" media="(prefers-color-scheme: dark)">',
  '<meta name="theme-color" content="#fbfaf8" media="(prefers-color-scheme: light)">',
  '<link rel="stylesheet" href="/assets/site.css">',
  '<script src="/assets/site.js" defer></script>',
]
REPLACED = re.compile(r'^(<title>.*</title>|<meta name="description".*>|<meta name="robots".*>|<link rel="canonical".*>|'
                      r'<link rel="(icon|apple-touch-icon|manifest)".*>|<meta (property|name)="(og|twitter):.*>|'
                      r'<script type="application/ld\+json">.*</script>)$')

def esc(s): return html.escape(s, quote=True)

report = []
for name, meta in PAGES.items():
    f = P / name
    src = f.read_text()
    m = re.search(r"<head>\n(.*?)\n</head>", src, re.S)
    lines = [l.strip() for l in m.group(1).split("\n") if l.strip()]
    unknown = [l for l in lines if l not in KEEP and not REPLACED.match(l)]
    assert not unknown, (name, unknown)
    assert all(k in lines for k in KEEP), (name, [k for k in KEEP if k not in lines])
    root = dom(src)
    url = f"{BASE}{meta['path']}" if meta.get("path") else None
    title, desc = meta["title"], meta["desc"]
    og_title = meta.get("og_title", title)
    img = f"{BASE}/og/{meta['og']}.png"
    head = [KEEP[0], KEEP[1], f"<title>{esc(title)}</title>", f'<meta name="description" content="{esc(desc)}">',
            f'<meta name="robots" content="{"noindex, follow" if meta.get("noindex") else "index, follow, max-image-preview:large"}">']
    if url: head.append(f'<link rel="canonical" href="{url}">')
    head += [KEEP[2], KEEP[3],
      '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
      '<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">',
      '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
      '<link rel="manifest" href="/site.webmanifest">',
      KEEP[4],
      f'<meta property="og:type" content="{meta["type"]}">',
      '<meta property="og:site_name" content="DJ Sync">',
      '<meta property="og:locale" content="en_US">',
      f'<meta property="og:title" content="{esc(og_title)}">',
      f'<meta property="og:description" content="{esc(desc)}">']
    if url: head.append(f'<meta property="og:url" content="{url}">')
    head += [f'<meta property="og:image" content="{img}">',
      '<meta property="og:image:width" content="1200">',
      '<meta property="og:image:height" content="630">',
      '<meta property="og:image:type" content="image/png">',
      f'<meta property="og:image:alt" content="{esc(meta["alt"])}">',
      '<meta name="twitter:card" content="summary_large_image">',
      f'<meta name="twitter:title" content="{esc(og_title)}">',
      f'<meta name="twitter:description" content="{esc(desc)}">',
      f'<meta name="twitter:image" content="{img}">',
      f'<meta name="twitter:image:alt" content="{esc(meta["alt"])}">']
    if url:
        head.append(f'<script type="application/ld+json">{ldjson(structured(name, meta, root, url))}</script>')
    head.append(KEEP[5])
    new = stamp(src[:m.start(1)] + "\n".join(head) + src[m.end(1):])
    f.write_text(new)
    report.append((name, len(title), len(desc)))

# manifest
(P / "site.webmanifest").write_text(json.dumps({
  "name": "DJ Sync", "short_name": "DJ Sync",
  "description": "Spotify and YouTube links to Rekordbox, from any chat. Free Mac app.",
  "start_url": "/", "scope": "/", "display": "browser",
  "background_color": "#0a0a0c", "theme_color": "#0a0a0c",
  "icons": [
    {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
    {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
    {"src": "/apple-touch-icon.png", "sizes": "180x180", "type": "image/png", "purpose": "maskable"},
    {"src": "/favicon.svg", "sizes": "any", "type": "image/svg+xml"}]}, indent=2) + "\n")

# robots
bots = ["*", "Googlebot", "Bingbot", "Google-Extended", "GPTBot", "OAI-SearchBot", "ChatGPT-User",
        "ClaudeBot", "Claude-User", "Claude-SearchBot", "PerplexityBot", "Perplexity-User", "Applebot", "Applebot-Extended"]
(P / "robots.txt").write_text(
  "# DJ Sync — everyone, including AI crawlers, is welcome to read the site.\n"
  "# API, download and install endpoints aren't pages.\n"
  + "".join(f"User-agent: {b}\n" for b in bots)
  + "Allow: /\nDisallow: /api/\nDisallow: /v2/\nDisallow: /i/\nDisallow: /telegram/\nDisallow: /download/\n\n"
  f"Sitemap: {BASE}/sitemap.xml\n")

# sitemap (with image entries)
urls = [(m["path"], m["og"]) for m in PAGES.values() if m.get("path")]
order = ["/", "/install/", "/connect/telegram/", "/connect/claude/", "/connect/iphone/", "/connect/chatgpt/", "/faq/", "/privacy/", "/terms/"]
urls.sort(key=lambda u: order.index(u[0]))
sm = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">']
for path, og in urls:
    sm.append(f"  <url><loc>{BASE}{path}</loc><lastmod>2026-10-28</lastmod>"
              f"<image:image><image:loc>{BASE}/og/{og}.png</image:loc></image:image></url>")
sm.append("</urlset>")
(P / "sitemap.xml").write_text("\n".join(sm) + "\n")

llms = P / "llms.txt"
llms.write_text(stamp(llms.read_text()))

for r in report: print(*r)
