# 06 — Daily Approval Flow

What you actually do every morning to triage, tailor, and apply.

## The flow

1. **Wake up.** The 7am scan already ran. New jobs are queued in the tracker.
2. **Phone:** toggle Tailscale on.
3. **Tap the career-ops PWA icon** on your home screen → drops you into the persistent tmux session.
4. **Start (or reattach) the dashboard** in one tmux window:
   ```bash
   ./dashboard/career-dashboard
   ```
5. Browse the queued jobs in the TUI. Pick one that catches your eye.
6. **Switch to a Claude Code window** in tmux: `Ctrl-b 0` (or `Ctrl-b c` to create a new window the first time, then `claude`).
7. Paste the job URL:
   ```
   /career-ops https://boards.greenhouse.io/companyname/jobs/12345
   ```
8. career-ops will:
   - Classify the role type
   - Score against your `cv.md` across the A–F dimensions
   - Generate a tailored CV PDF in `output/`
   - Generate a cover letter (if configured)
   - Add the job to the tracker
9. **Review the score and the generated files.** If the score is below ~4.0/5, the README author recommends skipping (not spray-and-pray).
10. **You decide:** apply or skip.
11. **If applying:** get the PDF off the VPS to actually upload it. Easiest path:
    ```bash
    # from your laptop, over Tailscale
    scp career@career-vps:~/work/career-ops/output/<filename>.pdf ~/Desktop/
    ```
    Or open the markdown drafts in `less` on your phone for a quick read.
12. **Open the company portal** in a normal browser, upload the PDF, click submit. **career-ops never auto-submits** — this step is on you.
13. **Mark the job as applied** in the tracker. Either `/career-ops tracker` (if it has a mark-applied subcommand) or by editing the tracker file directly. Confirm the actual interface in your installed version.

## Slash command reference

Per the README — confirm exact behavior by reading `.claude/commands/` in the cloned repo.

| Command | Purpose |
|---|---|
| `/career-ops {jd_url}` | Full pipeline on a single job |
| `/career-ops scan` | Sweep configured portals for new jobs |
| `/career-ops batch` | Process a list of URLs in parallel |
| `/career-ops tracker` | View / manage the tracker |
| `/career-ops pdf` | Regenerate a CV PDF |

## tmux cheat sheet

You will be living in tmux. The minimum:

| Keys | Action |
|---|---|
| `Ctrl-b c` | New window |
| `Ctrl-b 0`, `Ctrl-b 1`, ... | Switch to window N |
| `Ctrl-b n` / `Ctrl-b p` | Next / previous window |
| `Ctrl-b d` | Detach (session keeps running) |
| `Ctrl-b "` | Split horizontally |
| `Ctrl-b %` | Split vertically |
| `Ctrl-b o` | Switch panes |
| `Ctrl-b [` | Enter scroll mode (q to exit) |

The PWA's tap targets for `Ctrl-b` on a phone keyboard are awkward. Many phone browsers map `Ctrl` to a long-press or a dedicated key in ttyd's toolbar. Practice on your laptop first.

## Pulling PDFs to your phone

Three options, in order of effort:

1. **scp from laptop over Tailscale** (above) — easiest if you apply from a laptop anyway
2. **Serve `output/` over a tiny HTTP file server** bound to Tailscale:
   ```bash
   cd ~/work/career-ops/output
   python3 -m http.server 8080 --bind $(tailscale ip -4)
   ```
   Visit `http://career-vps:8080` from your phone.
3. **Open markdown drafts in `less`** in the terminal — fine for review, useless for the actual binary PDF

## Done

Move on to [07-verification.md](07-verification.md).
