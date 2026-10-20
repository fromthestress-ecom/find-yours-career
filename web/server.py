#!/usr/bin/env python3
"""Local web UI for the AI Job Search framework.

Run from the repo root:  python web/server.py   (then open http://127.0.0.1:8765)

Standard library only - nothing to install. The server binds to 127.0.0.1, serves
the static UI from web/static/, reads the repo's own state files (the tracker CSV,
job_scraper/seen_jobs.json, the cv/ and cover_letters/ outputs) and drives two
things that already exist in the repo:

  * the portal-search CLIs under .agents/skills/*/cli (via bun), and
  * Claude Code in headless mode (`claude -p`), so /setup, /scrape, /rank, /apply
    and /outcome run from a chat panel instead of a terminal.

Everything here is personal data on the user's machine; the server refuses
requests whose Host/Origin is not loopback so a web page you visit cannot drive it.
"""

import argparse
import csv
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
STATIC = Path(__file__).resolve().parent / "static"
TRACKER = ROOT / "job_search_tracker.csv"
SEEN = ROOT / "job_scraper" / "seen_jobs.json"
SKILLS = ROOT / ".agents" / "skills"

TRACKER_HEADER = [
    "date", "company", "sector", "role", "role_type", "channel", "status",
    "contact_person", "fit_rating", "notes", "cv_file", "cover_letter_file",
    "source", "deadline",
]
STATUSES = [
    "drafted", "applied", "interview", "offer", "hired",
    "rejected", "no_response", "offer_declined", "withdrawn",
]
# Fields the UI may edit on an existing row.
EDITABLE = {"status", "notes", "fit_rating", "deadline", "contact_person", "channel", "sector", "role_type"}

# Directories (relative to ROOT) whose files may be listed and downloaded, with the
# extensions allowed from each. Personal output only - never the profile files.
FILE_DIRS = {
    "cv": {".pdf", ".tex", ".typ", ".txt"},
    "cover_letters": {".pdf", ".tex", ".typ"},
    "documents/applications": {".pdf", ".tex", ".typ", ".md", ".txt"},
    "upskill": {".md"},
    "reports": {".html"},
}

# Per-portal flag mapping: UI field -> CLI flag. `required` fields must be present.
PORTALS = {
    "linkedin-search": {"label": "LinkedIn (toàn cầu)", "query": "-q", "location": "-l", "jobage": "--jobage", "remote": "--remote", "limit": "--limit", "required": ["location"]},
    "freehire-search": {"label": "freehire (IT, đa quốc gia)", "query": "-q", "location": "--country", "jobage": "--jobage", "remote": "--remote", "limit": "--limit", "required": []},
    "jobindex-search": {"label": "Jobindex.dk", "query": "-q", "jobage": "--jobage", "limit": "--limit", "required": []},
    "jobnet-search": {"label": "Jobnet.dk", "query": "--search-string", "limit": "--limit", "required": []},
    "jobbank-search": {"label": "Akademikernes Jobbank", "query": "--key", "remote": None, "limit": "--limit", "required": []},
    "jobdanmark-search": {"label": "Jobdanmark.dk", "query": "--text", "location": "--municipality", "limit": "--limit", "required": []},
}

COUNTRY_ALIASES = {"vietnam": "VN", "viet nam": "VN", "việt nam": "VN", "singapore": "SG", "thailand": "TH",
                   "germany": "DE", "united kingdom": "GB", "uk": "GB", "united states": "US", "usa": "US"}

# The chat replies in Vietnamese. This only covers what the assistant says to the user:
# the CV and cover-letter language is a separate profile setting (CLAUDE.md "CV language")
# and must keep following that, as must the posting's own language when quoted.
REPLY_LANGUAGE_NOTE = (
    "Always write your replies, questions and summaries to the user in Vietnamese (tiếng Việt), "
    "even when the user's message, a slash command or a posting is in English. "
    "Keep file paths, commands, code, field names and quoted posting text in their original language. "
    "This applies to chat only: do NOT change the language of generated CVs or cover letters - "
    "those follow the 'CV language' in the candidate profile."
)

# Tools the headless Claude session may use without asking (nobody is at a terminal
# to approve a prompt). Edits inside the repo are covered by --permission-mode
# acceptEdits. The deny list in .claude/settings.json still applies on top.
CLAUDE_ALLOWED = [
    "WebFetch", "WebSearch", "Read", "Glob", "Grep", "Edit", "Write", "Agent", "Skill",
    "Bash(python tools/*)", "Bash(python3 tools/*)", "Bash(python salary_lookup.py *)",
    "Bash(bun run .agents/skills/*)", "Bash(pdftotext *)",
    "Bash(lualatex *)", "Bash(xelatex *)", "Bash(cd *)", "Bash(ls *)", "Bash(mkdir *)",
    "Bash(cp *)", "Bash(mv *)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)",
]

_procs = {}  # chat run id -> Popen, so the UI can stop a run
_procs_lock = threading.Lock()
_tracker_lock = threading.Lock()


# ----------------------------------------------------------------- environment

def build_env():
    """Process env with the usual per-user tool dirs added (a MiKTeX/bun install
    updates the registry PATH, which a long-running parent process never sees)."""
    env = os.environ.copy()
    extra = []
    local = os.environ.get("LOCALAPPDATA")
    home = Path.home()
    if local:
        extra.append(Path(local) / "Programs" / "MiKTeX" / "miktex" / "bin" / "x64")
    extra += [home / ".bun" / "bin", home / ".local" / "bin"]
    present = [str(p) for p in extra if p.is_dir()]
    env["PATH"] = os.pathsep.join(present + [env.get("PATH", "")])
    env.setdefault("PYTHONIOENCODING", "utf-8")
    return env


ENV = build_env()


def which(name):
    return shutil.which(name, path=ENV["PATH"])


def tool_status():
    names = ["claude", "bun", "lualatex", "xelatex", "pdftotext"]
    out = {n: bool(which(n)) for n in names}
    try:
        import pypdf  # noqa: F401
        out["pypdf"] = True
    except ImportError:
        out["pypdf"] = False
    return out


def profile_status():
    """The profile counts as set up once CLAUDE.md has no [YOUR_...] placeholders left."""
    try:
        text = (ROOT / "CLAUDE.md").read_text(encoding="utf-8")
    except OSError:
        return {"ready": False, "placeholders": None}
    left = len(re.findall(r"\[YOUR_[A-Z_]+\]", text))
    return {"ready": left == 0, "placeholders": left}


# --------------------------------------------------------------------- tracker

def _clean(value):
    """The tracker readers split on commas and never unquote, so no field may hold
    a comma, a double quote or a line break (see /gmail-sync Step 7)."""
    s = "" if value is None else str(value)
    return re.sub(r"[\r\n]+", " ", s).replace(",", ";").replace('"', "'").strip()


def read_tracker():
    if not TRACKER.exists():
        return [], list(TRACKER_HEADER)
    with TRACKER.open(encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        header = list(reader.fieldnames or TRACKER_HEADER)
        rows = [{k: (v or "") for k, v in row.items() if k is not None} for row in reader]
    return rows, header


def write_tracker(rows, header):
    fd, tmp = tempfile.mkstemp(dir=str(ROOT), prefix=".tracker.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=header, lineterminator="\n", quoting=csv.QUOTE_NONE)
            writer.writeheader()
            for row in rows:
                writer.writerow({k: _clean(row.get(k, "")) for k in header})
        os.replace(tmp, TRACKER)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def tracker_update(index, expect, changes):
    with _tracker_lock:
        rows, header = read_tracker()
        if not (0 <= index < len(rows)):
            raise ApiError(409, "Dòng không còn tồn tại - hãy tải lại trang.")
        row = rows[index]
        if (row.get("company", ""), row.get("role", "")) != (expect.get("company", ""), expect.get("role", "")):
            raise ApiError(409, "Tracker đã thay đổi (có thể do /apply hoặc /outcome) - hãy tải lại trang.")
        for key, val in changes.items():
            if key not in EDITABLE:
                continue
            if key == "status" and val not in STATUSES:
                raise ApiError(400, f"Trạng thái không hợp lệ: {val}")
            if key == "fit_rating" and val != "" and not re.fullmatch(r"\d{1,3}", str(val)):
                raise ApiError(400, "fit_rating phải là số 0-100")
            if key == "deadline" and val != "" and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(val)):
                raise ApiError(400, "deadline phải có dạng YYYY-MM-DD")
            row[key] = val
        for col in EDITABLE:
            if col not in header:
                header.append(col)
        write_tracker(rows, header)
        return row


def tracker_add(data):
    from datetime import date
    company, role = _clean(data.get("company")), _clean(data.get("role"))
    if not company or not role:
        raise ApiError(400, "Cần có công ty và vị trí.")
    status = data.get("status") or "applied"
    if status not in STATUSES:
        raise ApiError(400, f"Trạng thái không hợp lệ: {status}")
    with _tracker_lock:
        rows, header = read_tracker()
        row = {k: "" for k in header}
        row.update({
            "date": date.today().isoformat(), "company": company, "role": role, "status": status,
            "source": _clean(data.get("source")), "notes": _clean(data.get("notes")),
            "deadline": _clean(data.get("deadline")), "channel": _clean(data.get("channel")),
            "sector": _clean(data.get("sector")),
        })
        rows.append(row)
        write_tracker(rows, header)
        return row


# ------------------------------------------------------------------------ jobs

def read_seen():
    if not SEEN.exists():
        return []
    try:
        data = json.loads(SEEN.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    items = data.get("jobs", data) if isinstance(data, dict) else data
    out = []
    if isinstance(items, dict):
        for key, entry in items.items():
            if isinstance(entry, dict):
                out.append({"key": key, **entry})
    elif isinstance(items, list):
        out = [e for e in items if isinstance(e, dict)]
    return out


def list_portals():
    found = []
    for pkg in sorted(SKILLS.glob("*/cli/package.json")):
        name = pkg.parent.parent.name
        enabled, installed = True, (pkg.parent / "node_modules").is_dir()
        skill = pkg.parent.parent / "SKILL.md"
        if skill.exists():
            m = re.search(r"^enabled:\s*(\w+)", skill.read_text(encoding="utf-8", errors="replace"), re.M)
            enabled = not (m and m.group(1).lower() == "false")
        spec = PORTALS.get(name, {"label": name, "query": "-q", "limit": "--limit", "required": []})
        found.append({
            "id": name, "label": spec["label"], "enabled": enabled, "installed": installed,
            "fields": [f for f in ("query", "location", "jobage", "remote") if spec.get(f)],
            "required": spec.get("required", []),
        })
    return found


def run_search(data):
    portal = data.get("portal", "")
    spec = PORTALS.get(portal)
    cli = SKILLS / portal / "cli" / "src" / "cli.ts"
    if not spec or not cli.exists():
        raise ApiError(400, "Portal không hợp lệ.")
    bun = which("bun")
    if not bun:
        raise ApiError(500, "Chưa cài Bun.")
    args = [bun, "run", str(cli.relative_to(ROOT)).replace("\\", "/"), "search"]
    for field in ("query", "location", "jobage", "remote"):
        val = str(data.get(field) or "").strip()
        flag = spec.get(field)
        if field in spec.get("required", []) and not val:
            raise ApiError(400, f"Thiếu trường bắt buộc: {field}")
        if not val or not flag:
            continue
        if field == "jobage" and not re.fullmatch(r"\d{1,4}", val):
            raise ApiError(400, "jobage phải là số ngày")
        if field == "remote" and val not in ("remote", "hybrid", "onsite"):
            raise ApiError(400, "remote không hợp lệ")
        if val.startswith("-"):
            raise ApiError(400, f"Giá trị không hợp lệ cho {field}")
        if field == "location" and portal == "freehire-search":
            # freehire filters by ISO-3166 alpha-2 country codes, not place names.
            val = COUNTRY_ALIASES.get(val.lower(), val).upper()
            if not re.fullmatch(r"[A-Z]{2}(,[A-Z]{2})*", val):
                raise ApiError(400, "freehire cần mã quốc gia ISO 2 chữ cái, vd: VN hoặc DE,GB.")
        args += [flag, val]
    limit = str(data.get("limit") or "20")
    if not re.fullmatch(r"\d{1,3}", limit):
        raise ApiError(400, "limit không hợp lệ")
    args += [spec["limit"], limit, "--format", "json"]
    try:
        proc = subprocess.run(args, cwd=ROOT, env=ENV, capture_output=True, text=True, encoding="utf-8", timeout=120)
    except subprocess.TimeoutExpired:
        raise ApiError(504, "Portal không phản hồi (quá 120s).")
    if proc.returncode != 0:
        msg = (proc.stdout.strip() or proc.stderr.strip())[:600]
        raise ApiError(502, f"CLI lỗi: {msg}")
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise ApiError(502, "CLI trả về dữ liệu không phải JSON.")
    return {"results": normalize_results(payload)}


def normalize_results(payload):
    """Portal CLIs differ slightly in shape; map them to one card format."""
    if isinstance(payload, dict):
        for key in ("results", "jobs", "data", "items"):
            if isinstance(payload.get(key), list):
                payload = payload[key]
                break
        else:
            inner = payload.get("data")
            payload = inner.get("results") or inner.get("jobs") or [] if isinstance(inner, dict) else []
    out = []
    for j in payload if isinstance(payload, list) else []:
        if not isinstance(j, dict):
            continue
        pick = lambda *ks: next((str(j[k]) for k in ks if j.get(k)), "")
        out.append({
            "title": pick("title", "jobTitle", "headline", "name"),
            "company": pick("company", "employer", "companyName", "hiringOrganization"),
            "location": pick("location", "city", "municipality", "workplace"),
            "date": pick("date", "published", "publishedDate", "postedAt", "created", "datePosted"),
            "url": pick("url", "link", "jobUrl", "applyUrl"),
            "description": pick("description", "snippet", "summary")[:400],
            "skills": j.get("skills") if isinstance(j.get("skills"), list) else [],
        })
    return out


# ----------------------------------------------------------------------- files

def list_files():
    out = []
    for rel, exts in FILE_DIRS.items():
        base = ROOT / rel
        if not base.is_dir():
            continue
        for p in base.rglob("*"):
            if p.is_file() and p.suffix.lower() in exts and not p.name.startswith("."):
                st = p.stat()
                out.append({"path": p.relative_to(ROOT).as_posix(), "name": p.name, "size": st.st_size, "mtime": st.st_mtime, "group": rel})
    out.sort(key=lambda f: -f["mtime"])
    return out


def resolve_file(rel):
    p = (ROOT / rel).resolve()
    for d, exts in FILE_DIRS.items():
        base = (ROOT / d).resolve()
        if (base == p or base in p.parents) and p.is_file() and p.suffix.lower() in exts and not p.name.startswith("."):
            return p
    return None


# ------------------------------------------------------------------------ chat

def claude_command(session_id):
    claude = which("claude")
    if not claude:
        raise ApiError(500, "Không tìm thấy lệnh `claude` (Claude Code).")
    cmd = [claude, "-p", "--output-format", "stream-json", "--verbose",
           "--permission-mode", "acceptEdits", "--allowedTools", ",".join(CLAUDE_ALLOWED),
           "--append-system-prompt", REPLY_LANGUAGE_NOTE]
    if session_id:
        if not re.fullmatch(r"[0-9a-fA-F-]{16,64}", session_id):
            raise ApiError(400, "session_id không hợp lệ")
        cmd += ["--resume", session_id]
    return cmd


def stream_chat(handler, data):
    prompt = (data.get("prompt") or "").strip()
    if not prompt:
        raise ApiError(400, "Chưa nhập nội dung.")
    if len(prompt) > 60000:
        raise ApiError(400, "Nội dung quá dài.")
    cmd = claude_command(data.get("session_id"))
    run_id = os.urandom(6).hex()
    handler.send_response(200)
    handler.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Run-Id", run_id)
    handler.end_headers()

    def emit(obj):
        handler.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        handler.wfile.flush()

    # The prompt goes over stdin: no shell, no command-line length or quoting limits.
    proc = subprocess.Popen(cmd, cwd=ROOT, env=ENV, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    with _procs_lock:
        _procs[run_id] = proc
    stderr_buf = []
    threading.Thread(target=lambda: stderr_buf.append(proc.stderr.read().decode("utf-8", "replace")), daemon=True).start()
    try:
        emit({"type": "run", "run_id": run_id})
        proc.stdin.write(prompt.encode("utf-8"))
        proc.stdin.close()
        for raw in proc.stdout:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                emit(json.loads(line))
            except json.JSONDecodeError:
                emit({"type": "log", "text": line})
        code = proc.wait()
        if code not in (0, None) and not data.get("_stopped"):
            err = "".join(stderr_buf).strip()[-800:]
            emit({"type": "error", "text": err or f"claude thoát với mã {code}"})
        emit({"type": "end", "code": code})
    except (BrokenPipeError, ConnectionResetError):
        pass  # browser went away: fall through to kill the run
    finally:
        with _procs_lock:
            _procs.pop(run_id, None)
        kill_tree(proc)


def kill_tree(proc):
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    else:
        proc.kill()


# ---------------------------------------------------------------------- server

class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


class Handler(BaseHTTPRequestHandler):
    server_version = "AIJobSearchUI/1.0"

    def log_message(self, fmt, *args):
        if os.environ.get("WEB_UI_VERBOSE"):
            super().log_message(fmt, *args)

    # -- helpers
    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _loopback_ok(self):
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        if host not in ("127.0.0.1", "localhost", "::1"):
            return False
        origin = self.headers.get("Origin")
        if origin:
            o = (urlparse(origin).hostname or "").lower()
            if o not in ("127.0.0.1", "localhost", "::1"):
                return False
        return True

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 2_000_000:
            raise ApiError(413, "Yêu cầu quá lớn.")
        raw = self.rfile.read(n) if n else b"{}"
        try:
            data = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            raise ApiError(400, "JSON không hợp lệ.")
        if not isinstance(data, dict):
            raise ApiError(400, "JSON phải là object.")
        return data

    def _dispatch(self, fn):
        try:
            if not self._loopback_ok():
                raise ApiError(403, "Chỉ chấp nhận truy cập từ localhost.")
            fn()
        except ApiError as e:
            try:
                self._json({"error": e.message}, e.status)
            except (BrokenPipeError, ConnectionResetError):
                pass
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001 - last-resort guard so one bad call never kills the server
            try:
                self._json({"error": f"Lỗi máy chủ: {e}"}, 500)
            except (BrokenPipeError, ConnectionResetError):
                pass

    # -- routes
    def do_GET(self):
        self._dispatch(self._get)

    def do_POST(self):
        self._dispatch(self._post)

    def _get(self):
        url = urlparse(self.path)
        path = url.path
        if path == "/api/status":
            rows, _ = read_tracker()
            return self._json({"tools": tool_status(), "profile": profile_status(), "tracker_rows": len(rows),
                               "seen_jobs": len(read_seen()), "root": ROOT.name})
        if path == "/api/tracker":
            rows, header = read_tracker()
            return self._json({"rows": rows, "statuses": STATUSES, "header": header})
        if path == "/api/jobs":
            return self._json({"jobs": read_seen()})
        if path == "/api/portals":
            return self._json({"portals": list_portals()})
        if path == "/api/files":
            return self._json({"files": list_files()})
        if path == "/file":
            rel = parse_qs(url.query).get("p", [""])[0]
            f = resolve_file(unquote(rel))
            if not f:
                raise ApiError(404, "Không tìm thấy tệp.")
            ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
            if f.suffix.lower() in (".tex", ".typ", ".md", ".txt"):
                ctype = "text/plain; charset=utf-8"
            data = f.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Disposition", "inline")
            self.send_header("X-Content-Type-Options", "nosniff")
            if f.suffix.lower() != ".pdf":
                # Generated HTML/text can carry third-party posting text: render it in an
                # opaque origin so it can never call this server's API. (Chrome's PDF viewer
                # does not work under a sandbox CSP, and a PDF cannot run script here.)
                self.send_header("Content-Security-Policy", "sandbox allow-scripts")
            self.end_headers()
            return self.wfile.write(data)
        return self._static(path)

    def _static(self, path):
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        f = (STATIC / rel).resolve()
        if STATIC.resolve() not in f.parents or not f.is_file():
            raise ApiError(404, "Không tìm thấy.")
        data = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", (mimetypes.guess_type(f.name)[0] or "application/octet-stream") + ("; charset=utf-8" if f.suffix in (".html", ".js", ".css") else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _post(self):
        path = urlparse(self.path).path
        data = self._body()
        if path == "/api/tracker/update":
            row = tracker_update(int(data.get("index", -1)), data.get("expect") or {}, data.get("changes") or {})
            return self._json({"row": row})
        if path == "/api/tracker/add":
            return self._json({"row": tracker_add(data)})
        if path == "/api/search":
            return self._json(run_search(data))
        if path == "/api/chat":
            return stream_chat(self, data)
        if path == "/api/chat/stop":
            with _procs_lock:
                proc = _procs.get(str(data.get("run_id", "")))
            if proc:
                kill_tree(proc)
            return self._json({"stopped": bool(proc)})
        raise ApiError(404, "Không có API này.")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1", help="keep this on loopback: the server can run Claude Code")
    args = ap.parse_args()
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        sys.exit("Refusing to bind a non-loopback address: this server can run commands on your machine.")
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    print(f"AI Job Search UI: http://{args.host}:{args.port}  (Ctrl+C to stop)", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
