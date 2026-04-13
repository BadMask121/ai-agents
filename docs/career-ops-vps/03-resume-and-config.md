# 03 — Resume & Configuration

career-ops uses three user-supplied inputs:
- `cv.md` — your resume in markdown, the source of truth for tailored CV generation
- `config/profile.yml` — your contact info, preferences, scoring weights
- `config/portals.yml` — the company career boards to scan

## Convert your resume to markdown

Get your resume onto the VPS first. From your laptop:
```bash
scp resume.docx career@<your-hetzner-ip>:~/
```
(After step 04 you can do this over Tailscale instead.)

On the VPS:
```bash
cd ~

# from a docx
pandoc resume.docx -t gfm -o cv.md

# from a pdf (rougher, will need cleanup)
pandoc resume.pdf -t gfm -o cv.md
```

Open `cv.md` and clean it up:
```bash
nano cv.md
```

What to clean:
- Section headings (`## Experience`, `## Education`, `## Skills`)
- Bullet structure (consistent `-` or `*`)
- Remove page-break artifacts, weird unicode, header/footer noise
- Make sure dates and titles are clean

**Spend 20 minutes here.** Every tailored CV career-ops generates is downstream of this file. Garbage in, garbage out.

Move it into the project:
```bash
cp ~/cv.md ~/work/career-ops/cv.md
```

## Profile

```bash
cd ~/work/career-ops
cp config/profile.example.yml config/profile.yml
nano config/profile.yml
```

If `config/profile.example.yml` does not exist under that exact name, list the directory and find the actual example file:
```bash
ls config/
```

Fill in your name, email, location, target roles, and scoring weights according to the schema in the example.

## Portals

```bash
nano config/portals.yml
```

Same caveat — confirm the actual filename:
```bash
ls config/ templates/ 2>/dev/null
```

### How to populate portals.yml for global jobs

The career-ops scanner is **per-company, not per-geography**. There is no LinkedIn-style "remote, worldwide, ML engineer" search. You give it a list of company career boards on supported ATSes (Greenhouse, Lever, Ashby) and it pulls postings from those.

To target jobs worldwide, curate a list of companies that:
1. Hire remote-worldwide (or remote in regions you can work from)
2. Use Greenhouse, Lever, or Ashby

Seed sources:
- [weworkremotely.com](https://weworkremotely.com)
- [remoteok.com](https://remoteok.com)
- [Y Combinator jobs](https://www.ycombinator.com/jobs) — filterable by remote
- Greenhouse public board index
- Lever customer list

Plan ~1 hour to build a v1 list of 30–60 companies. You will refine it weekly.

## Sanity-check directories

```bash
ls -la data/ reports/ output/ 2>/dev/null
mkdir -p data reports output logs
```

career-ops may create these on first run; pre-creating them is harmless.

## Done

Move on to [04-mobile-access.md](04-mobile-access.md).
