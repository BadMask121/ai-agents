"""Builds the DJ Sync OG cards (1200x630) as HTML, one per page."""
import html, pathlib
OUT = pathlib.Path(__file__).parent

LOGO = '''<svg viewBox="0 0 32 32" class="logo"><rect width="32" height="32" rx="8" fill="#ff6a3d"/><circle cx="16" cy="16" r="8.6" fill="none" stroke="#1a0904" stroke-width="2.2"/><circle cx="16" cy="16" r="2.3" fill="#1a0904"/><path d="M23.5 6.5 19 11" stroke="#1a0904" stroke-width="2.2" stroke-linecap="round"/></svg>'''

CSS = '''
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1200px;height:630px;overflow:hidden}
body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",Arial,sans-serif;
 background:#0a0a0c;color:#f4f4f6;position:relative;-webkit-font-smoothing:antialiased}
.glow{position:absolute;inset:0;background:
 radial-gradient(620px 420px at 1040px 40px,rgba(255,106,61,.30),transparent 70%),
 radial-gradient(560px 420px at 40px 650px,rgba(168,85,247,.20),transparent 70%),
 radial-gradient(420px 300px at 420px 700px,rgba(236,72,153,.14),transparent 70%)}
.rings{position:absolute;right:-170px;top:-150px;width:760px;height:760px;opacity:.55}
.frame{position:absolute;inset:56px 64px 52px 64px;display:flex;flex-direction:column}
.top{display:flex;align-items:center;justify-content:space-between}
.brand{display:flex;align-items:center;gap:16px;font-size:34px;font-weight:700;letter-spacing:-.02em}
.logo{width:52px;height:52px;border-radius:13px;box-shadow:0 8px 24px -8px rgba(255,106,61,.6)}
.tag{font-size:21px;font-weight:600;color:#ffb39c;background:rgba(255,106,61,.14);
 border:1px solid rgba(255,106,61,.35);padding:9px 18px;border-radius:999px;letter-spacing:.01em}
.main{flex:1;display:flex;align-items:center;gap:44px}
.copy{flex:1;min-width:0}
h1{font-size:68px;line-height:1.03;font-weight:800;letter-spacing:-.038em;text-wrap:balance}
h1 em{font-style:normal;background:linear-gradient(92deg,#ff7a45,#ff4f8b 60%,#c06cff);
 -webkit-background-clip:text;background-clip:text;color:transparent}
.sub{margin-top:22px;font-size:28px;line-height:1.32;color:#b3b3bd;letter-spacing:-.005em;max-width:600px;text-wrap:balance}
.check{width:30px;height:30px;border-radius:50%;flex:none;display:grid;place-items:center;background:#ff7a45;color:#1a0904;font-size:18px;font-weight:900}
.app.on i{display:grid;place-items:center}
.app.on i svg{width:64px;height:64px}
.panel{width:430px;flex:none;background:linear-gradient(180deg,rgba(28,28,35,.94),rgba(19,19,23,.94));
 border:1px solid rgba(255,255,255,.10);border-radius:26px;padding:24px;
 box-shadow:0 1px 0 rgba(255,255,255,.06) inset,0 40px 80px -30px rgba(0,0,0,.85)}
.bottom{display:flex;align-items:center;justify-content:space-between}
.chips{display:flex;gap:10px}
.chip{font-size:20px;font-weight:600;color:#d7d7de;background:rgba(255,255,255,.06);
 border:1px solid rgba(255,255,255,.10);padding:8px 16px;border-radius:999px}
.chip b{color:#ff8a63;font-weight:700}
.url{font-size:22px;color:#8a8a96;font-weight:500;letter-spacing:.01em}
/* panel parts */
.label{font-size:17px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#7d7d89}
.pill{display:flex;align-items:center;gap:12px;background:#0f0f13;border:1px solid rgba(255,255,255,.09);
 border-radius:16px;padding:14px 16px;font:500 21px ui-monospace,"SF Mono",Menlo,monospace;color:#d6d6de}
.dot{width:14px;height:14px;border-radius:50%;flex:none}
.arrow{display:flex;justify-content:center;margin:12px 0;color:#ff7a45}
.list{margin-top:12px;display:flex;flex-direction:column;gap:8px}
.row{display:flex;align-items:center;gap:14px;padding:11px 14px;border-radius:14px;background:rgba(255,255,255,.035)}
.row .art{width:40px;height:40px;border-radius:9px;flex:none;background:linear-gradient(135deg,#3a3a46,#24242c)}
.row .t{font-size:20px;font-weight:600;color:#ececf1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .a{font-size:17px;color:#8f8f9a}
.row .grow{flex:1;min-width:0}
.row.new{background:linear-gradient(90deg,rgba(255,106,61,.20),rgba(255,106,61,.06));border:1px solid rgba(255,106,61,.38)}
.row.new .art{background:linear-gradient(135deg,#ff7a45,#ff4f8b)}
.badge{font-size:15px;font-weight:800;color:#1a0904;background:#ff7a45;padding:5px 10px;border-radius:999px;letter-spacing:.04em}
.bub{max-width:88%;padding:14px 18px;border-radius:20px;font-size:21px;line-height:1.35}
.me{align-self:flex-end;background:linear-gradient(135deg,#ff7a45,#ff5a6e);color:#1a0904;font-weight:600;border-bottom-right-radius:6px}
.bot{align-self:flex-start;background:#23232b;color:#ececf1;border-bottom-left-radius:6px}
.chat{display:flex;flex-direction:column;gap:12px}
.btns{display:flex;gap:8px;flex-wrap:wrap}
.btn{font-size:18px;font-weight:600;color:#ffb39c;border:1px solid rgba(255,106,61,.45);padding:8px 14px;border-radius:12px}
.step{display:flex;align-items:center;gap:16px;padding:14px 4px;border-bottom:1px solid rgba(255,255,255,.07)}
.step:last-child{border-bottom:0}
.num{width:42px;height:42px;border-radius:50%;flex:none;display:grid;place-items:center;font-size:21px;font-weight:800;
 color:#1a0904;background:linear-gradient(135deg,#ff7a45,#ff4f8b)}
.step .t{font-size:23px;font-weight:650;color:#ececf1}
.step .a{font-size:17px;color:#8f8f9a;margin-top:2px}
.q{display:flex;align-items:center;justify-content:space-between;padding:15px 6px;border-bottom:1px solid rgba(255,255,255,.07);font-size:21px;font-weight:600;color:#e4e4ea}
.q:last-child{border-bottom:0}
.q span{color:#ff8a63;font-size:24px}
.share{display:flex;gap:14px;justify-content:space-between;margin:6px 0 16px}
.app{display:flex;flex-direction:column;align-items:center;gap:8px;font-size:15px;color:#9a9aa5;width:84px}
.app i{width:64px;height:64px;border-radius:16px;display:block;background:#2a2a33}
.app.on{color:#fff;font-weight:700}
.app.on i{background:#ff6a3d;box-shadow:0 0 0 3px #0a0a0c,0 0 0 6px #ff7a45}
'''

RINGS = '''<svg class="rings" viewBox="0 0 760 760" fill="none">''' + "".join(
    f'<circle cx="380" cy="380" r="{r}" stroke="rgba(255,255,255,{a})" stroke-width="1.5"/>'
    for r, a in [(370, .05), (320, .045), (270, .04), (220, .035), (170, .03), (120, .03)]) + '</svg>'

CHIPS = '''<div class="chips"><span class="chip">Telegram</span><span class="chip">Claude</span><span class="chip">ChatGPT</span><span class="chip">iPhone</span></div>'''

def page(tag, headline, sub, panel, chips=True):
    return f'''<!doctype html><html><head><meta charset="utf-8"><style>{CSS}</style></head><body>
<div class="glow"></div>{RINGS}
<div class="frame">
 <div class="top"><div class="brand">{LOGO}<span>DJ Sync</span></div><span class="tag">{tag}</span></div>
 <div class="main"><div class="copy"><h1>{headline}</h1><p class="sub">{sub}</p></div>{f'<div class="panel">{panel}</div>' if panel else ''}</div>
 <div class="bottom">{CHIPS if chips else '<span></span>'}<span class="url">djsync.jeffrey.build</span></div>
</div></body></html>'''

def track(t, a, new=False, picked=False):
    badge = '<span class="badge">NEW</span>' if new else ('<span class="check">✓</span>' if picked else '')
    return f'<div class="row{" new" if new or picked else ""}"><span class="art"></span><div class="grow"><div class="t">{t}</div><div class="a">{a}</div></div>{badge}</div>'

LINK_TO_PLAYLIST = ('<div class="pill"><span class="dot" style="background:#1ed760"></span>open.spotify.com/track/…</div>'
    '<div class="arrow"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v15M5 12l7 7 7-7"/></svg></div>'
    '<div class="label">Rekordbox · Gqom</div><div class="list">'
    + track("Ongcwele", "Sizwe Mdlalose") + track("Water", "Tyla") + track("Your new track", "Added just now", new=True) + '</div>')

def chat(label, me, bot, buttons=None, done=None):
    b = f'<div class="btns">{"".join(f"<span class=btn>{html.escape(x)}</span>" for x in buttons)}</div>' if buttons else ''
    d = f'<div class="bub bot">{done}</div>' if done else ''
    return f'<div class="label" style="margin-bottom:14px">{label}</div><div class="chat"><div class="bub me">{me}</div><div class="bub bot">{bot}</div>{b}{d}</div>'

def steps(items):
    return ''.join(f'<div class="step"><span class="num">{i}</span><div><div class="t">{t}</div><div class="a">{a}</div></div></div>' for i, (t, a) in enumerate(items, 1))

CARDS = {
 "home": page("Free Mac app", 'Ask your AI.<br><em>It lands in Rekordbox.</em>',
   "Send a Spotify, YouTube or SoundCloud link from any chat. It downloads into your playlists.", LINK_TO_PLAYLIST),
 "install": page("Install guide", 'Set up DJ Sync<br><em>in five minutes.</em>',
   "Free for Mac with Rekordbox&nbsp;6 or&nbsp;7. No account needed.",
   steps([("Download", "DJ-Sync-latest.dmg"), ("Open Anyway", "One time, in System Settings"), ("Connect", "Telegram, Claude, ChatGPT or iPhone")])),
 "faq": page("FAQ", 'Questions,<br><em>answered.</em>',
   "Rekordbox open or closed, backups, offline Macs, pricing and privacy.",
   ''.join(f'<div class="q">{q}<span>+</span></div>' for q in ["Rekordbox open or closed?", "Is my library safe?", "Mac asleep or offline?", "Does it cost anything?"])),
 "connect-chatgpt": page("Guide · ChatGPT", 'Use DJ Sync<br><em>from ChatGPT.</em>',
   "Add it as a custom connector. Needs a paid ChatGPT plan.",
   chat("ChatGPT", "Add this to my Amapiano playlist", "Queued 1 track for “Amapiano Chill”. It’s in Rekordbox in a few minutes.")),
 "connect-claude": page("Guide · Claude", 'Use DJ Sync<br><em>from Claude.</em>',
   "Free plans include one custom connector. Works on your phone too.",
   chat("Claude", "Move my Burna Boy tracks into Afro", "Moved 4 tracks from “Gqom” to “Afro”. Your library was backed up first.")),
 "connect-telegram": page("Free · any phone", 'DJ Sync<br><em>in Telegram.</em>',
   "Scan once, then share a link. Pick a playlist with one tap.",
   chat("Telegram", "youtu.be/…", "Add it to which playlist?", ["Gqom", "Afro House", "Amapiano Chill"], "✅ Added to “Gqom” in Rekordbox.")),
 "connect-iphone": page("Free · iPhone", 'One tap from<br><em>your iPhone.</em>',
   "Scan a QR code, add the Shortcut, then share any song to DJ Sync.",
   '<div class="label">Share</div><div class="share">'
   + ''.join(f'<div class="app{" on" if n=="DJ Sync" else ""}"><i>{LOGO if n=="DJ Sync" else ""}</i>{n}</div>' for n in ["Messages", "DJ Sync", "Notes", "Mail"])
   + '</div><div class="label" style="margin-bottom:10px">Add to which playlist?</div><div class="list">'
   + track("Gqom", "109 tracks", picked=True) + track("Afro House", "86 tracks") + '</div>'),
 "default": page("Free Mac app", 'Spotify, YouTube<br><em>&amp; SoundCloud to Rekordbox.</em>',
   "From Telegram, Claude, ChatGPT or your iPhone. Free for Mac.", LINK_TO_PLAYLIST),
}
for name, doc in CARDS.items():
    (OUT / f"{name}.html").write_text(doc)
print(" ".join(CARDS))
