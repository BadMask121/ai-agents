# career-ops-ui overhaul — plan + current status

Handoff doc so work can resume after a break. The detailed plan lives at `~/.claude/plans/virtual-nibbling-popcorn.md` — this doc is the executive summary + current status + next steps.

---

## Where we are right now

### Deployed and working
- career-ops-ui is live on Coolify at `http://utvvmofv16f39k2k0uf8zw9d.95.217.185.93.sslip.io`
- Login works — bcrypt hash is in the Coolify `AUTH_PASSWORD_HASH` env var with `Is Literal?` ticked. Plaintext password is in the user's password manager, not in this repo.
- PDF resume upload works (uses `pdftotext` from poppler-utils, not pandoc — pandoc cannot read PDFs)
- Session cookies work over plain HTTP via the temporary `ALLOW_INSECURE_COOKIES=1` flag (tracked for removal by bd `ai-agents-0xv` once real TLS is set up)

### Recent fix chain
1. `fc92a1b` — Dockerfile runtime layout mirrors `/repo` so pnpm symlinks resolve and `next` binary is found
2. `0e25fbf` — middleware pinned to `nodejs` runtime so it can read `AUTH_SECRET`
3. `7688fb2` — `ALLOW_INSECURE_COOKIES` opt-in with loud safety rails
4. `f63b378` — PDF uploads routed through `pdftotext` instead of pandoc
5. (uncommitted) — Dockerfile updated with `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`, `@playwright/mcp` install, pre-configured `.claude.json` with playwright MCP entry

### Critical backend discovery
The career-ops backend on the VPS (`/home/career/work/career-ops`) already produces scored jobs with a rich pipeline.md format and per-job reports with 5 sub-scores (CV Match, North Star, Comp, Cultural, Global — all out of 5). **The UI parser is stale** — it only understands `- [ ] URL | Company | Role` but the backend writes `- [x] #NNN | URL | Company | Role | X.X/5 | PDF ✅`. Phase 1 of the plan fixes this.

### Hard rule
**Never modify `/home/career/work/career-ops` on the VPS.** It's the source-of-truth backend, updated separately from upstream. All new agent behavior goes in `packages/career-ops-ui/src/agents/` instead. Details in `feedback_career_ops_readonly.md` in Claude's memory.

---

## The plan (5 phases)

Full version at `~/.claude/plans/virtual-nibbling-popcorn.md`. Compressed here:

**Phase 0 — Pre-flight: install tools + de-risking spike** *(in progress — blocker below)*
Install `@playwright/mcp`, fix chromium path to `/opt/ms-playwright` with node ownership, pre-configure Claude MCP, then spike two risky assumptions (screenshot emission via MCP, pause/resume across multiple claude invocations) before committing to Phase 3.

**Phase 1 — Data layer: rewrite pipeline parser**
Port `analyze-patterns.mjs:126-148` regexes into TypeScript, extend `PipelineItem` with `score`, `num`, `pdfReady`, `error`. Add `src/lib/report.ts` with `readReportWithScores()`. Update `/api/pipeline` to return scores. No UI changes.

**Phase 2 — Design system foundation + Discover view**
Design tokens in `globals.css` (semantic colors, focus rings). Reusable components under `src/components/ui/` (Button, Card, StarRating, ScoreBar, LoadingSkeleton, EmptyState, ConfirmDialog, Toast). New `/discover` page as the landing route, showing scored jobs with star ratings, sub-score breakdowns, threshold slider (default 4.0). Status strip reads `data/logs/scan-*.log` for "last scan: 2h ago · 47 new · 3 above threshold". **No scan/evaluate buttons** — those run on cron via `career-scan.service`, UI is a pure consumer.

**Phase 3 — Chat-driven apply + VPS dispatch + Chrome extension + QR handoff**
The big one. Three flows that share one session state:

1. **Chat iteration** *(on phone or desktop)*: user clicks Approve on a Discover card, lands on `/apply/{sessionId}`, left pane shows the agent's pre-drafted payload (form fields + cover letter), right pane is streaming chat, user iterates via conversation ("make cover letter more casual, cut it to 3 sentences").

2. **Primary submit flow — VPS dispatch with live screenshot stream** *(mobile-first, matches the reference UX)*: user hits **Dispatch**, Playwright spawns inside the career-ops-ui container and drives Chromium through the real job portal, screenshots stream back to the user's phone at 1-2fps via SSE. User watches the agent fill fields live, hits an approval gate before the final submit click. Uses the built-in Playwright MCP we installed in Phase 0.

3. **Fallback submit flow — Chrome extension takeover** *(laptop, for when dispatch is blocked by CAPTCHA/SSO/weird form)*: user taps **Take over on laptop** on their phone, a full-screen QR code appears, scanning it from a laptop opens a takeover landing page in career-ops-ui which in turn opens the job posting in a new tab. A Chrome extension the user installed once (MV3, `packages/career-ops-extension/`) auto-fills the form from the same session payload. User solves the CAPTCHA themselves, clicks the portal's real submit button, extension pings career-ops-ui so the phone sees "submitted!" in real-time.

Session state lives in `data/apply-sessions/{id}.json` with a state machine: `draft → ready → dispatch_active → (applied | handoff_pending → laptop_takeover_active → applied)`.

**Phase 4 — DELETED.** The dispatch flow in Phase 3 IS the autonomous submit story. No separate Phase 4.

**Phase 5 — UI/UX polish pass on remaining surfaces**
Apply the Phase 2 design system to login, resume editor, settings. Focus rings everywhere, consistent error styling, confirm dialogs for destructive actions, mobile responsive audit, WCAG AA pass.

---

## Phase 0 — DONE ✓

Both de-risking spikes passed. Phase 3 dispatch confidence is now ~85%. Total spike spend: ~$0.20.

**Spike 1 (screenshot emission via MCP) — PASS.** Image data is delivered as `tool_result` content with an `image` part: `ev.message.content[N].content[M].source.data` (base64 PNG). One full tool-call cycle (`browser_take_screenshot`) is ~9s, so 1-2fps live streaming during dispatch needs either (a) a tight Claude polling loop or (b) Node-side Playwright with Claude only making decisions. Decision deferred to Phase 3 design.

**Spike 2 (pause/resume across invocations) — PASS.** Inv1 filled a form and stopped before submit, emitting JSON state inside `<STATE>` tags. Inv2 received that state, re-navigated, re-snapshotted, re-filled, clicked Submit, and verified httpbin echoed back the values. **CRITICAL:** Playwright MCP refs (`e5`, `e8`, etc.) are ephemeral per snapshot — they change between invocations. The dispatch flow MUST re-snapshot before acting on any persisted state and never trust stale refs.

Both bd issues for Phase 0 closed. Original status checklist preserved below for the historical fix path.

### ✅ Done

- [x] Dockerfile updated at `packages/career-ops-ui/Dockerfile`:
  - `ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`
  - `mkdir -p /opt/ms-playwright` before install
  - `npm install -g @anthropic-ai/claude-code@2.1.104 @playwright/mcp`
  - `npx playwright@1.58.1 install chromium` (lands in /opt/ms-playwright)
  - `chown -R node:node /opt/ms-playwright`
  - `/home/node/.claude.json` written with mcpServers.playwright entry
- [x] Image builds successfully as `career-ops-ui:mcp-test`
- [x] As node user inside the container:
  - `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright` is set ✓
  - `/opt/ms-playwright/chromium-1208/chrome-linux/chrome` exists and is readable by node ✓
  - `claude mcp list` returns `playwright: npx -y @playwright/mcp - ✓ Connected` ✓
  - `/home/node/.claude.json` contains the correct mcpServers entry ✓
- [x] **Spike test 1 partially run** — Claude connected to Anthropic API, spawned @playwright/mcp, enumerated all 23 browser tools (`mcp__playwright__browser_navigate`, `mcp__playwright__browser_take_screenshot`, `mcp__playwright__browser_click`, `mcp__playwright__browser_fill_form`, etc.), called `browser_navigate("https://example.com")` — and hit a blocker (see below). Cost: $0.0693.

### 🧱 Blocker

**`@playwright/mcp` is hardcoded to use the `chrome` channel**, which means the *system Google Chrome* at `/opt/google/chrome/chrome`, NOT the Playwright-bundled chromium we installed.

Error observed:
```
Error: server: Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome
Run "npx playwright install chrome"
```

The `npx playwright install chrome` command needs root (it runs `su` internally to install system deps), which fails inside a container running as node user.

Checked `@playwright/mcp`'s CLI flags via `npx @playwright/mcp --help`:

```
--browser <browser>    browser or chrome channel to use,
                       possible values: chrome, firefox, webkit, msedge.
```

**`chromium` is NOT in the list of valid values.** The Playwright-bundled chromium binary cannot be directly specified. Options are chrome (system), firefox, webkit, or msedge — all of which need separate system packages.

### Fix options (pick one when resuming)

1. **⭐ Install Google Chrome stable in the Dockerfile** *(recommended — cleanest, matches @playwright/mcp's default)*
   ```dockerfile
   RUN wget -qO - https://dl.google.com/linux/linux_signing_key.pub \
     | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
     > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*
   ```
   ⚠️ **ARM64 caveat**: Google Chrome for Linux ships amd64-only. Coolify's VPS is x86_64 so this works in production, but local Docker builds on an Apple Silicon Mac will fail unless you build with `--platform linux/amd64` (slow, via QEMU) OR test directly on the VPS.

2. **Use Microsoft Edge** (`--browser msedge` + install edge package)
   Similar to Chrome but Edge has official ARM64 .debs, so local builds work without cross-compile. Slightly less "standard" for job portals but functionally identical.

3. **Connect via CDP to a separately-launched chromium**
   Run chromium as a sidecar service with `--remote-debugging-port=9222`, configure @playwright/mcp with `--cdp-endpoint http://localhost:9222`. Decouples the browser from the MCP server, keeps the chromium we already installed.

4. **Write our own Playwright MCP wrapper**
   Thin Node script in `packages/career-ops-ui/src/agents/` that uses Playwright directly with the chromium binary, exposes the same tool interface as @playwright/mcp via stdio. More work but gives us full control.

**Recommendation**: Option 1 for production (amd64 match), with a local-dev fallback of Option 2 if you want to iterate on an M1/M2 Mac without cross-compile. Or Option 3 if we want to decouple the browser for future flexibility (e.g., connecting to a remote chromium, or running multiple dispatches concurrently).

### 🔜 Pending in Phase 0

- [ ] Apply the Chrome (or Edge, or CDP) fix to the Dockerfile
- [ ] Rebuild `career-ops-ui:mcp-test`
- [ ] **Re-run spike test 1**: `claude -p "... navigate to example.com, take a screenshot ..."` and confirm:
  - `browser_navigate` returns success (no chrome not found error)
  - `browser_take_screenshot` produces image data in the stream-json output
  - Image data is in a parseable form (base64? file reference? URL?)
- [ ] **Run spike test 2 (pause/resume)**: invoke claude once to fill a form, save session state, invoke again with "continue from step 3", confirm state transfers cleanly
- [ ] Based on spike results, finalize the Phase 3 dispatch architecture and update the plan
- [ ] Close `ai-agents-4eo`, proceed to Phase 1

---

## bd issue state

| ID | Title | Status |
|---|---|---|
| `ai-agents-0xv` | Remove `ALLOW_INSECURE_COOKIES` flag once real TLS is set up | **open** — waiting on Phase 5 of the deploy checklist (real domain + Let's Encrypt) |
| `ai-agents-4eo` | Phase 0: install @playwright/mcp + fix chromium path + configure claude MCP | **closed** — both spike tests passed |
| `ai-agents-7zc` | Epic: career-ops-ui Discover view + dispatch overhaul | **open** — Phase 1 done, Phases 2/3/5 pending |
| `ai-agents-7zc.1` | Phase 1: data layer — rewrite pipeline parser + report parser + API routes | **closed** — typecheck + lint clean, runtime verification deferred until backend has scored data |

Run `bd ready` and `bd show <id>` to see current state when you resume.

---

## ⚠️ Security reminders

1. **The ANTHROPIC_API_KEY has been pasted in chat sessions** and should be considered exposed. Rotate it when convenient at https://console.anthropic.com/settings/keys. After rotating, update in three places: Coolify `ANTHROPIC_API_KEY` env var, `~/.bashrc` on the VPS, `~/.career-ops-env` on the VPS — then restart the career-ops-ui Coolify app to pick up the new key.
2. **`ALLOW_INSECURE_COOKIES=1` is active in production** — the app is running over plain HTTP via the sslip.io URL. Must be removed once real domain + Let's Encrypt is in place (Phase 5 of the deploy checklist).
3. The red "insecure-cookie mode is on" banner + loud boot-time log are in place to prevent this from being forgotten.

---

## Next steps when resuming

1. **Read this doc first** (you're here)
2. Read `~/.claude/plans/virtual-nibbling-popcorn.md` for the full phase plan with ASCII diagrams, API route definitions, component lists, verification steps
3. Resume Phase 0:
   - Pick one of the Fix Options above (probably Option 1 — install Google Chrome)
   - Update `packages/career-ops-ui/Dockerfile`
   - Rebuild `career-ops-ui:mcp-test` (note: if on Apple Silicon, use `--platform linux/amd64` or switch to msedge / chromium-via-CDP for local dev)
   - Re-run spike test 1 with the updated image and a **fresh, rotated** API key
   - Run spike test 2 (pause/resume)
   - Update the plan based on results, close `ai-agents-4eo`
4. Proceed to Phase 1 (data layer rewrite) — this is the low-risk, high-value path that unblocks the Discover view no matter what happens with dispatch

---

## Where session state lives

- Plan file: `~/.claude/plans/virtual-nibbling-popcorn.md` (ignored by git, lives in Claude's state dir)
- Memory files: `~/.claude/projects/.../memory/` with `feedback_career_ops_readonly.md` + `project_career_ops_ui_architecture.md` + `MEMORY.md` index
- bd issues: dolt db under `.beads/dolt/` (not pushed to remote — `bd dolt push` fails because no remote is configured, see earlier note about switching to JSONL mode or setting up DoltHub)
- Uncommitted Dockerfile changes: `git status` will show `packages/career-ops-ui/Dockerfile` as modified
- Smoke test image: `career-ops-ui:mcp-test` (local OrbStack)
