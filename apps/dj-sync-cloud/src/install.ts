// The one-scan iPhone install (connect-anywhere spec §2b): the page at
// /i/<tenant_id>/<code> and the signed Shortcut under it. The URL is a secret
// for 10 minutes (the file holds the DJ's Shortcut key), so: noindex,
// no-store, no referrer, nothing loaded from elsewhere. Colours follow
// dj-sync-site's tokens (dark first, light on request).

export const SHORTCUT_FILENAME = "DJ Sync.shortcut";

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const STYLE = `
:root{--bg:#0a0a0c;--card:#131317;--line:rgba(255,255,255,.08);--text:#f4f4f6;--text-2:#a7a7b1;--accent:#ff6a3d;--accent-ink:#1a0904;color-scheme:dark light}
@media (prefers-color-scheme:light){:root{--bg:#fbfaf8;--card:#fff;--line:rgba(23,20,15,.08);--text:#17140f;--text-2:#5c564e;--accent:#e3501f;--accent-ink:#fff}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px 16px calc(24px + env(safe-area-inset-bottom));background:var(--bg);color:var(--text);font:17px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px 22px}
.tag{font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--accent);margin:0 0 10px}
h1{font-size:27px;line-height:1.15;letter-spacing:-.01em;margin:0 0 10px}
p,li{color:var(--text-2)}
p{margin:0 0 14px}
.add{display:block;margin:22px 0;padding:17px;border-radius:14px;background:var(--accent);color:var(--accent-ink);font-weight:650;font-size:19px;text-align:center;text-decoration:none;-webkit-tap-highlight-color:transparent}
.add:active{transform:scale(.98)}
ol{margin:0 0 16px;padding-left:22px}
li{margin:6px 0}
strong{color:var(--text);font-weight:600}
.small{font-size:14px;margin:0}
a{color:var(--accent)}
`;

function page(title: string, body: string, status: number): Response {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` +
    `<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">` +
    `<title>${title}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: PAGE_HEADERS });
}

/** The live page: one big button to the file. */
export function installPage(fileHref: string): Response {
  return page(
    "Add DJ Sync to your iPhone",
    `<p class="tag">DJ Sync</p>` +
      `<h1>Add DJ Sync to your iPhone</h1>` +
      `<p>Send songs from Spotify and YouTube straight into Rekordbox on your Mac.</p>` +
      `<a class="add" href="${fileHref}">Add Shortcut</a>` +
      `<ol><li>Tap <strong>Add Shortcut</strong> above, then <strong>Add Shortcut</strong> again in the Shortcuts app ` +
      `(if Safari asks first, allow the download and open it).</li>` +
      `<li>In Spotify or YouTube, tap <strong>Share → DJ Sync</strong> and pick a playlist.</li></ol>` +
      `<p class="small">This link works for a few minutes and is only for you: the Shortcut holds your DJ Sync key.</p>`,
    200,
  );
}

/** Unknown, expired or used up: all look the same. */
export function installExpired(status = 410): Response {
  return page(
    "This link expired — DJ Sync",
    `<p class="tag">DJ Sync</p>` +
      `<h1>This link expired</h1>` +
      `<p>Make a new QR code in DJ Sync on your Mac — <strong>Assistants → Connect iPhone</strong> — and scan it with your iPhone's camera.</p>` +
      `<p class="small"><a href="/connect/iphone/">How the iPhone Shortcut works</a></p>`,
    status,
  );
}

/** The signed Shortcut as a download. */
export function shortcutFile(bytes: ArrayBuffer, head: boolean): Response {
  return new Response(head ? null : bytes, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${SHORTCUT_FILENAME}"`,
      "content-length": String(bytes.byteLength),
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff",
    },
  });
}
