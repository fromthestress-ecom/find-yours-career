# Web UI

A local dashboard for the framework. Standard library only (Python 3.10+), nothing to install.

```bash
python web/server.py          # then open http://127.0.0.1:8765
python web/server.py --port 9000
```

| Tab | What it does |
|-----|--------------|
| Tổng quan | Pipeline board and stats from `job_search_tracker.csv`; add and edit applications |
| Tìm việc | Runs the portal CLIs under `.agents/skills/*/cli` and lists the results |
| Tin đã quét | Browses `job_scraper/seen_jobs.json` (ranked by `/rank`) |
| Trợ lý | Chat with Claude Code (`claude -p`, resumable session) for `/setup`, `/scrape`, `/rank`, `/apply`, `/outcome`, ... |
| Tài liệu | Previews the CVs, cover letters and application archives that `/apply` writes |

## Security notes

- Binds to `127.0.0.1` only and rejects any request whose `Host` or `Origin` is not loopback.
- The chat runs Claude Code non-interactively: edits inside the repo are auto-accepted and a fixed list of
  tools is pre-approved (`CLAUDE_ALLOWED` in `server.py`). Everything else is denied and shown under the
  reply. The deny list in `.claude/settings.json` still applies.
- Tracker writes keep the repo's no-quoting convention: commas, double quotes and line breaks are replaced
  before saving (see `/gmail-sync` Step 7).
- Only files under `cv/`, `cover_letters/`, `documents/applications/`, `upskill/` and `reports/` are served.
