"""
StudySync & Academic Performance Tracker — Flask REST API + static frontend.
Author: Med Amine Ben Tanfous

Run locally:
    python init_db.py      # create studysync.db with schema + sample data
    python app.py          # http://127.0.0.1:5000

Run in production (Render, any Linux host):
    gunicorn wsgi:app      # settings are read from gunicorn.conf.py

All /api routes return JSON. Authentication uses a signed session cookie;
every query is scoped to the logged-in user.
"""
from __future__ import annotations

import logging
import os
import re
import sqlite3
import uuid
from datetime import date, datetime, timedelta
from functools import wraps

from flask import (Flask, abort, g, jsonify, request, send_from_directory,
                   session)
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
SCHEMA_PATH = os.path.join(BASE_DIR, "schema.sql")
SAMPLE_MARKER = "-- ===================== SAMPLE DATA"
DEFAULT_SECRET = "dev-change-me-in-production"
log = logging.getLogger("studysync")


def env_flag(name: str, default: bool = False) -> bool:
    val = os.environ.get(name)
    if val is None:
        return default
    return val.strip().lower() in {"1", "true", "yes", "on"}


def bootstrap_database(db_path: str, seed_demo: bool = False) -> bool:
    """Create the tables if the database has none yet. Never drops existing data.

    Safe to call from several processes at once: the whole script runs inside one
    write transaction, and a process that loses the race simply finds the tables
    already there. Returns True when this call created the schema.
    """
    parent = os.path.dirname(os.path.abspath(db_path))
    os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=30)
    try:
        conn.execute("PRAGMA journal_mode = WAL")  # better concurrency for several workers
        exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").fetchone()
        if exists:
            return False
        with open(SCHEMA_PATH, encoding="utf-8") as f:
            schema, _, sample = f.read().partition(SAMPLE_MARKER)
        # Strip the DROP statements: auto-initialisation must never delete anything.
        schema = "\n".join(line for line in schema.splitlines()
                           if not line.strip().upper().startswith("DROP TABLE"))
        script = schema + ("\n" + SAMPLE_MARKER + sample if seed_demo else "")
        try:
            conn.executescript("BEGIN IMMEDIATE;\n" + script + "\nCOMMIT;")
        except sqlite3.OperationalError as exc:
            conn.rollback()
            if "already exists" in str(exc):
                return False  # another worker initialised it first
            raise
        log.info("StudySync database created at %s%s", db_path, " with demo data" if seed_demo else "")
        return True
    finally:
        conn.close()

ALLOWED_EXTENSIONS = {
    "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "csv", "txt", "md",
    "png", "jpg", "jpeg", "gif", "webp", "zip", "py", "ipynb", "odt", "odp",
}
GRADE_TYPES = {"exam", "quiz", "homework", "project", "oral", "lab", "other"}
PRIORITIES = {"low", "medium", "high"}
STATUSES = {"todo", "in_progress", "done"}
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


# ---------------------------------------------------------------------------
# Errors & validation helpers
# ---------------------------------------------------------------------------
class ApiError(Exception):
    def __init__(self, message: str, status: int = 400, fields: dict | None = None):
        super().__init__(message)
        self.message, self.status, self.fields = message, status, fields or {}


def body() -> dict:
    data = request.get_json(silent=True)
    if data is None:
        data = request.form.to_dict() if request.form else {}
    if not isinstance(data, dict):
        raise ApiError("Request body must be a JSON object.")
    return data


def req_str(data: dict, key: str, label: str, max_len: int = 200, required: bool = True) -> str | None:
    val = data.get(key)
    if val is None or (isinstance(val, str) and not val.strip()):
        if required:
            raise ApiError(f"{label} is required.", fields={key: "required"})
        return None
    val = str(val).strip()
    if len(val) > max_len:
        raise ApiError(f"{label} must be at most {max_len} characters.", fields={key: "too long"})
    return val


def req_num(data: dict, key: str, label: str, *, minimum: float | None = None,
            maximum: float | None = None, exclusive_min: bool = False,
            required: bool = True) -> float | None:
    val = data.get(key)
    if val is None or val == "":
        if required:
            raise ApiError(f"{label} is required.", fields={key: "required"})
        return None
    try:
        num = float(val)
    except (TypeError, ValueError):
        raise ApiError(f"{label} must be a number.", fields={key: "invalid"})
    if num != num or num in (float("inf"), float("-inf")):
        raise ApiError(f"{label} must be a finite number.", fields={key: "invalid"})
    if minimum is not None and (num <= minimum if exclusive_min else num < minimum):
        cmp = "greater than" if exclusive_min else "at least"
        raise ApiError(f"{label} must be {cmp} {minimum:g}.", fields={key: "out of range"})
    if maximum is not None and num > maximum:
        raise ApiError(f"{label} must be at most {maximum:g}.", fields={key: "out of range"})
    return num


def req_choice(data: dict, key: str, label: str, choices: set, default: str | None = None) -> str:
    val = data.get(key, default)
    if val not in choices:
        raise ApiError(f"{label} must be one of: {', '.join(sorted(choices))}.", fields={key: "invalid"})
    return val


def req_date(data: dict, key: str, label: str, required: bool = False) -> str | None:
    val = data.get(key)
    if not val:
        if required:
            raise ApiError(f"{label} is required.", fields={key: "required"})
        return None
    try:
        return date.fromisoformat(str(val)[:10]).isoformat()
    except ValueError:
        raise ApiError(f"{label} must be a date (YYYY-MM-DD).", fields={key: "invalid"})


def req_datetime(data: dict, key: str, label: str) -> str:
    val = data.get(key)
    if not val:
        raise ApiError(f"{label} is required.", fields={key: "required"})
    try:
        return datetime.fromisoformat(str(val)).strftime("%Y-%m-%dT%H:%M")
    except ValueError:
        raise ApiError(f"{label} must be a date-time (YYYY-MM-DDTHH:MM).", fields={key: "invalid"})


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------
DEMO_EMAIL = "demo@studysync.app"
DEMO_TABLES = ("subjects", "grades", "tasks", "exams", "resources")


def reset_demo_account(db_path: str) -> list[str]:
    """Restore the demo account's sample data from schema.sql, keeping its user id.

    Only the demo account is touched; every other user's data stays as it is.
    Returns the stored names of the demo account's uploaded files, which the
    caller deletes from disk.
    """
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        script = f.read()
    sample_db = sqlite3.connect(":memory:")
    sample_db.row_factory = sqlite3.Row
    sample_db.executescript(script)  # schema + sample data in a scratch database
    sample_user = dict(sample_db.execute("SELECT * FROM users WHERE email = ?", (DEMO_EMAIL,)).fetchone())

    conn = sqlite3.connect(db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT id FROM users WHERE email = ?", (DEMO_EMAIL,)).fetchone()
        if row:
            uid = row["id"]
            conn.execute("UPDATE users SET full_name = ?, password_hash = ?, grade_scale = ? WHERE id = ?",
                         (sample_user["full_name"], sample_user["password_hash"], sample_user["grade_scale"], uid))
        else:
            uid = conn.execute("INSERT INTO users (full_name, email, password_hash, grade_scale) VALUES (?,?,?,?)",
                               (sample_user["full_name"], DEMO_EMAIL, sample_user["password_hash"],
                                sample_user["grade_scale"])).lastrowid
        stored_files = [r["stored_name"] for r in conn.execute(
            "SELECT stored_name FROM resources WHERE user_id = ? AND stored_name IS NOT NULL", (uid,))]
        for table in reversed(DEMO_TABLES):
            conn.execute(f"DELETE FROM {table} WHERE user_id = ?", (uid,))

        subject_map: dict[int, int] = {}
        for table in DEMO_TABLES:
            for r in sample_db.execute(f"SELECT * FROM {table} WHERE user_id = ? ORDER BY id", (sample_user["id"],)):
                data = {k: r[k] for k in r.keys() if k != "id"}
                data["user_id"] = uid
                if data.get("subject_id") is not None:
                    data["subject_id"] = subject_map[data["subject_id"]]
                cols = ", ".join(data)
                marks = ", ".join("?" for _ in data)
                new_id = conn.execute(f"INSERT INTO {table} ({cols}) VALUES ({marks})", tuple(data.values())).lastrowid
                if table == "subjects":
                    subject_map[r["id"]] = new_id
        conn.commit()
        return stored_files
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
        sample_db.close()


def create_app(test_config: dict | None = None) -> Flask:
    app = Flask(__name__, static_folder=os.path.join(BASE_DIR, "static"), static_url_path="/static")
    app.config.update(
        SECRET_KEY=os.environ.get("STUDYSYNC_SECRET_KEY") or os.environ.get("SECRET_KEY") or DEFAULT_SECRET,
        DATABASE=os.environ.get("STUDYSYNC_DB", os.path.join(BASE_DIR, "studysync.db")),
        UPLOAD_FOLDER=os.environ.get("STUDYSYNC_UPLOADS", os.path.join(BASE_DIR, "uploads")),
        SEED_DEMO=env_flag("STUDYSYNC_SEED_DEMO"),
        MAX_CONTENT_LENGTH=16 * 1024 * 1024,  # 16 MB uploads
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=env_flag("STUDYSYNC_SECURE_COOKIES"),
        PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    )
    if test_config:
        app.config.update(test_config)
    app.json.sort_keys = False  # keep JSON keys in the order the API builds them

    # Render (and most hosts) sit behind one reverse proxy that sets X-Forwarded-*.
    if env_flag("STUDYSYNC_BEHIND_PROXY", default=bool(os.environ.get("RENDER"))):
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    if app.config["SECRET_KEY"] == DEFAULT_SECRET and not app.config.get("TESTING"):
        log.warning("STUDYSYNC_SECRET_KEY is not set: using an insecure development key.")

    os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)

    # ------------------------------------------------------------------ DB
    def get_db() -> sqlite3.Connection:
        if "db" not in g:
            g.db = sqlite3.connect(app.config["DATABASE"], timeout=30)
            g.db.row_factory = sqlite3.Row
            g.db.execute("PRAGMA foreign_keys = ON")
            g.db.execute("PRAGMA busy_timeout = 30000")
        return g.db

    @app.teardown_appcontext
    def close_db(_exc):
        db = g.pop("db", None)
        if db is not None:
            db.close()

    def rows(sql: str, args: tuple = ()) -> list[dict]:
        return [dict(r) for r in get_db().execute(sql, args).fetchall()]

    def one(sql: str, args: tuple = ()) -> dict | None:
        r = get_db().execute(sql, args).fetchone()
        return dict(r) if r else None

    def execute(sql: str, args: tuple = ()) -> int:
        db = get_db()
        cur = db.execute(sql, args)
        db.commit()
        return cur.lastrowid

    # First start on a new server: create the tables (and the demo account if
    # STUDYSYNC_SEED_DEMO=1). An existing database is left untouched.
    bootstrap_database(app.config["DATABASE"], seed_demo=app.config["SEED_DEMO"])

    @app.after_request
    def security_headers(resp):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        if request.path.startswith("/api/"):
            resp.headers.setdefault("Cache-Control", "no-store")
        return resp

    # ------------------------------------------------------------ errors
    @app.errorhandler(ApiError)
    def handle_api_error(err: ApiError):
        return jsonify(error=err.message, fields=err.fields), err.status

    @app.errorhandler(sqlite3.IntegrityError)
    def handle_integrity(err):
        msg = str(err)
        if "UNIQUE" in msg:
            return jsonify(error="An item with that name already exists."), 409
        return jsonify(error="The data violates a database constraint.", detail=msg), 400

    @app.errorhandler(HTTPException)
    def handle_http(err: HTTPException):
        if request.path.startswith("/api/"):
            return jsonify(error=err.description or err.name), err.code
        return err

    # -------------------------------------------------------------- auth
    def login_required(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            uid = session.get("user_id")
            if uid is None or one("SELECT id FROM users WHERE id = ?", (uid,)) is None:
                session.clear()
                raise ApiError("Authentication required.", 401)
            g.user_id = uid
            return fn(*args, **kwargs)
        return wrapper

    def public_user(u: dict) -> dict:
        return {k: u[k] for k in ("id", "full_name", "email", "grade_scale", "created_at")}

    @app.post("/api/auth/register")
    def register():
        data = body()
        name = req_str(data, "full_name", "Full name", 100)
        email = req_str(data, "email", "Email", 254).lower()
        if not EMAIL_RE.match(email):
            raise ApiError("Please enter a valid email address.", fields={"email": "invalid"})
        password = data.get("password") or ""
        if len(password) < 8:
            raise ApiError("Password must be at least 8 characters.", fields={"password": "too short"})
        if one("SELECT id FROM users WHERE email = ?", (email,)):
            raise ApiError("An account with this email already exists.", 409, {"email": "taken"})
        uid = execute("INSERT INTO users (full_name, email, password_hash) VALUES (?, ?, ?)",
                      (name, email, generate_password_hash(password)))
        session.clear()
        session["user_id"] = uid
        session.permanent = True
        return jsonify(user=public_user(one("SELECT * FROM users WHERE id = ?", (uid,)))), 201

    @app.post("/api/auth/login")
    def login():
        data = body()
        email = (data.get("email") or "").strip().lower()
        user = one("SELECT * FROM users WHERE email = ?", (email,))
        if not user or not check_password_hash(user["password_hash"], data.get("password") or ""):
            raise ApiError("Invalid email or password.", 401)
        session.clear()
        session["user_id"] = user["id"]
        session.permanent = True
        return jsonify(user=public_user(user))

    @app.post("/api/auth/logout")
    def logout():
        session.clear()
        return jsonify(ok=True)

    @app.get("/api/auth/me")
    @login_required
    def me():
        return jsonify(user=public_user(one("SELECT * FROM users WHERE id = ?", (g.user_id,))))

    @app.route("/api/auth/me", methods=["PUT", "PATCH"])
    @login_required
    def update_me():
        data = body()
        user = one("SELECT * FROM users WHERE id = ?", (g.user_id,))
        name = req_str(data, "full_name", "Full name", 100, required=False) or user["full_name"]
        scale = req_num(data, "grade_scale", "Grade scale", minimum=0, maximum=1000,
                        exclusive_min=True, required=False) or user["grade_scale"]
        execute("UPDATE users SET full_name = ?, grade_scale = ? WHERE id = ?", (name, scale, g.user_id))
        return jsonify(user=public_user(one("SELECT * FROM users WHERE id = ?", (g.user_id,))))

    # ------------------------------------------------- ownership helpers
    def own_or_404(table: str, item_id: int) -> dict:
        item = one(f"SELECT * FROM {table} WHERE id = ? AND user_id = ?", (item_id, g.user_id))
        if item is None:
            raise ApiError(f"{table[:-1].capitalize()} not found.", 404)
        return item

    def optional_subject(data: dict) -> int | None:
        sid = data.get("subject_id")
        if sid in (None, "", "null"):
            return None
        try:
            sid = int(sid)
        except (TypeError, ValueError):
            raise ApiError("Invalid subject.", fields={"subject_id": "invalid"})
        own_or_404("subjects", sid)
        return sid

    # ------------------------------------------- performance calculation
    def compute_performance(user_id: int) -> dict:
        scale = one("SELECT grade_scale FROM users WHERE id = ?", (user_id,))["grade_scale"]
        subjects = rows("SELECT * FROM subjects WHERE user_id = ? ORDER BY name COLLATE NOCASE", (user_id,))
        grades = rows("SELECT * FROM grades WHERE user_id = ?", (user_id,))
        by_subject: dict[int, list[dict]] = {}
        for gr in grades:
            by_subject.setdefault(gr["subject_id"], []).append(gr)

        breakdown, weighted_sum, coef_sum = [], 0.0, 0.0
        for s in subjects:
            sg = by_subject.get(s["id"], [])
            w_total = sum(x["weight"] for x in sg)
            avg = (sum((x["score"] / x["max_score"]) * scale * x["weight"] for x in sg) / w_total) if sg else None
            if avg is not None:
                weighted_sum += avg * s["coefficient"]
                coef_sum += s["coefficient"]
            breakdown.append({
                "subject_id": s["id"], "name": s["name"], "color": s["color"],
                "coefficient": s["coefficient"], "target_average": s["target_average"],
                "grade_count": len(sg),
                "average": round(avg, 2) if avg is not None else None,
                "weighted_points": round(avg * s["coefficient"], 2) if avg is not None else None,
                "meets_target": (avg >= s["target_average"]) if (avg is not None and s["target_average"] is not None) else None,
            })

        overall = weighted_sum / coef_sum if coef_sum else None
        for b in breakdown:  # share of the final average each subject contributes
            b["contribution"] = round(b["weighted_points"] / coef_sum, 2) if (b["weighted_points"] is not None and coef_sum) else None

        def mention(pct: float | None) -> str | None:
            if pct is None:
                return None
            for limit, label in ((80, "Excellent"), (70, "Very good"), (60, "Good"), (50, "Pass")):
                if pct >= limit:
                    return label
            return "Below pass"

        pct = overall / scale * 100 if overall is not None else None
        return {
            "grade_scale": scale,
            "overall_average": round(overall, 2) if overall is not None else None,
            "percentage": round(pct, 1) if pct is not None else None,
            "gpa_4": round(min(4.0, overall / scale * 4), 2) if overall is not None else None,
            "mention": mention(pct),
            "total_coefficient": coef_sum,
            "graded_subjects": sum(1 for b in breakdown if b["average"] is not None),
            "subjects": breakdown,
        }

    # ------------------------------------------------------------ subjects
    def subject_payload(data: dict, current: dict | None = None) -> tuple:
        cur = current or {}
        partial = current is not None
        name = req_str(data, "name", "Subject name", 80, required=not partial) or cur.get("name")
        coef = req_num(data, "coefficient", "Coefficient", minimum=0, maximum=100, exclusive_min=True,
                       required=not partial)
        coef = coef if coef is not None else cur.get("coefficient")
        if "target_average" in data:
            target = req_num(data, "target_average", "Target average", minimum=0, maximum=1000, required=False)
        else:
            target = cur.get("target_average")
        color = data.get("color", cur.get("color", "#4f46e5"))
        if not HEX_COLOR.match(str(color)):
            raise ApiError("Color must be a hex value like #4f46e5.", fields={"color": "invalid"})
        return name, coef, target, color

    @app.get("/api/subjects")
    @login_required
    def list_subjects():
        perf = {b["subject_id"]: b for b in compute_performance(g.user_id)["subjects"]}
        items = rows("SELECT * FROM subjects WHERE user_id = ? ORDER BY name COLLATE NOCASE", (g.user_id,))
        for s in items:
            p = perf.get(s["id"], {})
            s["average"], s["grade_count"] = p.get("average"), p.get("grade_count", 0)
        return jsonify(subjects=items)

    @app.post("/api/subjects")
    @login_required
    def create_subject():
        name, coef, target, color = subject_payload(body())
        sid = execute("INSERT INTO subjects (user_id, name, coefficient, target_average, color) VALUES (?,?,?,?,?)",
                      (g.user_id, name, coef, target, color))
        return jsonify(subject=one("SELECT * FROM subjects WHERE id = ?", (sid,))), 201

    @app.get("/api/subjects/<int:sid>")
    @login_required
    def get_subject(sid):
        s = own_or_404("subjects", sid)
        s["grades"] = rows("SELECT * FROM grades WHERE subject_id = ? ORDER BY graded_on DESC", (sid,))
        return jsonify(subject=s)

    @app.route("/api/subjects/<int:sid>", methods=["PUT", "PATCH"])
    @login_required
    def update_subject(sid):
        current = own_or_404("subjects", sid)
        name, coef, target, color = subject_payload(body(), current)
        execute("UPDATE subjects SET name=?, coefficient=?, target_average=?, color=? WHERE id=?",
                (name, coef, target, color, sid))
        return jsonify(subject=one("SELECT * FROM subjects WHERE id = ?", (sid,)))

    @app.delete("/api/subjects/<int:sid>")
    @login_required
    def delete_subject(sid):
        own_or_404("subjects", sid)
        execute("DELETE FROM subjects WHERE id = ?", (sid,))
        return jsonify(ok=True)

    # -------------------------------------------------------------- grades
    def grade_payload(data: dict, current: dict | None = None) -> dict:
        cur = current or {}
        partial = current is not None
        out = {}
        if not partial or "subject_id" in data:
            sid = optional_subject(data)
            if sid is None:
                raise ApiError("Subject is required.", fields={"subject_id": "required"})
            out["subject_id"] = sid
        else:
            out["subject_id"] = cur["subject_id"]
        out["title"] = req_str(data, "title", "Title", 120, required=not partial) or cur.get("title")
        out["grade_type"] = req_choice(data, "grade_type", "Type", GRADE_TYPES,
                                       default=cur.get("grade_type", "exam"))
        max_score = req_num(data, "max_score", "Max score", minimum=0, maximum=10000, exclusive_min=True,
                            required=False)
        out["max_score"] = max_score if max_score is not None else cur.get("max_score", 20)
        score = req_num(data, "score", "Score", minimum=0, required=not partial)
        out["score"] = score if score is not None else cur.get("score")
        if out["score"] > out["max_score"]:
            raise ApiError("Score cannot exceed the max score.", fields={"score": "out of range"})
        weight = req_num(data, "weight", "Weight", minimum=0, maximum=100, exclusive_min=True, required=False)
        out["weight"] = weight if weight is not None else cur.get("weight", 1)
        out["graded_on"] = req_date(data, "graded_on", "Date") or cur.get("graded_on") or date.today().isoformat()
        return out

    GRADE_SELECT = """SELECT gr.*, s.name AS subject_name, s.color AS subject_color, s.coefficient AS subject_coefficient
                      FROM grades gr JOIN subjects s ON s.id = gr.subject_id"""

    @app.get("/api/grades")
    @login_required
    def list_grades():
        sql, args = GRADE_SELECT + " WHERE gr.user_id = ?", [g.user_id]
        if request.args.get("subject_id"):
            sql += " AND gr.subject_id = ?"
            args.append(request.args.get("subject_id", type=int))
        sql += " ORDER BY gr.graded_on DESC, gr.id DESC"
        return jsonify(grades=rows(sql, tuple(args)))

    @app.post("/api/grades")
    @login_required
    def create_grade():
        p = grade_payload(body())
        gid = execute("""INSERT INTO grades (user_id, subject_id, title, grade_type, score, max_score, weight, graded_on)
                         VALUES (?,?,?,?,?,?,?,?)""",
                      (g.user_id, p["subject_id"], p["title"], p["grade_type"], p["score"],
                       p["max_score"], p["weight"], p["graded_on"]))
        return jsonify(grade=one(GRADE_SELECT + " WHERE gr.id = ?", (gid,))), 201

    @app.get("/api/grades/<int:gid>")
    @login_required
    def get_grade(gid):
        own_or_404("grades", gid)
        return jsonify(grade=one(GRADE_SELECT + " WHERE gr.id = ?", (gid,)))

    @app.route("/api/grades/<int:gid>", methods=["PUT", "PATCH"])
    @login_required
    def update_grade(gid):
        p = grade_payload(body(), own_or_404("grades", gid))
        execute("""UPDATE grades SET subject_id=?, title=?, grade_type=?, score=?, max_score=?, weight=?, graded_on=?
                   WHERE id=?""",
                (p["subject_id"], p["title"], p["grade_type"], p["score"], p["max_score"],
                 p["weight"], p["graded_on"], gid))
        return jsonify(grade=one(GRADE_SELECT + " WHERE gr.id = ?", (gid,)))

    @app.delete("/api/grades/<int:gid>")
    @login_required
    def delete_grade(gid):
        own_or_404("grades", gid)
        execute("DELETE FROM grades WHERE id = ?", (gid,))
        return jsonify(ok=True)

    @app.get("/api/performance")
    @login_required
    def performance():
        return jsonify(compute_performance(g.user_id))

    # --------------------------------------------------------------- tasks
    TASK_SELECT = """SELECT t.*, s.name AS subject_name, s.color AS subject_color
                     FROM tasks t LEFT JOIN subjects s ON s.id = t.subject_id"""

    def task_payload(data: dict, current: dict | None = None) -> dict:
        cur = current or {}
        partial = current is not None
        out = {
            "title": req_str(data, "title", "Title", 150, required=not partial) or cur.get("title"),
            "description": (req_str(data, "description", "Description", 2000, required=False) or "")
                           if "description" in data else cur.get("description", ""),
            "priority": req_choice(data, "priority", "Priority", PRIORITIES, cur.get("priority", "medium")),
            "status": req_choice(data, "status", "Status", STATUSES, cur.get("status", "todo")),
            "due_date": req_date(data, "due_date", "Due date") if "due_date" in data else cur.get("due_date"),
            "subject_id": optional_subject(data) if "subject_id" in data else cur.get("subject_id"),
        }
        if out["status"] == "done":
            out["completed_at"] = cur.get("completed_at") or datetime.now().isoformat(timespec="seconds")
        else:
            out["completed_at"] = None
        return out

    @app.get("/api/tasks")
    @login_required
    def list_tasks():
        sql, args = TASK_SELECT + " WHERE t.user_id = ?", [g.user_id]
        status, priority = request.args.get("status"), request.args.get("priority")
        if status:
            if status not in STATUSES:
                raise ApiError("Invalid status filter.")
            sql += " AND t.status = ?"
            args.append(status)
        if priority:
            if priority not in PRIORITIES:
                raise ApiError("Invalid priority filter.")
            sql += " AND t.priority = ?"
            args.append(priority)
        if request.args.get("subject_id"):
            sql += " AND t.subject_id = ?"
            args.append(request.args.get("subject_id", type=int))
        sql += """ ORDER BY t.status = 'done', t.due_date IS NULL, t.due_date,
                   CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.id"""
        return jsonify(tasks=rows(sql, tuple(args)))

    @app.post("/api/tasks")
    @login_required
    def create_task():
        p = task_payload(body())
        tid = execute("""INSERT INTO tasks (user_id, subject_id, title, description, due_date, priority, status, completed_at)
                         VALUES (?,?,?,?,?,?,?,?)""",
                      (g.user_id, p["subject_id"], p["title"], p["description"], p["due_date"],
                       p["priority"], p["status"], p["completed_at"]))
        return jsonify(task=one(TASK_SELECT + " WHERE t.id = ?", (tid,))), 201

    @app.get("/api/tasks/<int:tid>")
    @login_required
    def get_task(tid):
        own_or_404("tasks", tid)
        return jsonify(task=one(TASK_SELECT + " WHERE t.id = ?", (tid,)))

    @app.route("/api/tasks/<int:tid>", methods=["PUT", "PATCH"])
    @login_required
    def update_task(tid):
        p = task_payload(body(), own_or_404("tasks", tid))
        execute("""UPDATE tasks SET subject_id=?, title=?, description=?, due_date=?, priority=?, status=?, completed_at=?
                   WHERE id=?""",
                (p["subject_id"], p["title"], p["description"], p["due_date"], p["priority"],
                 p["status"], p["completed_at"], tid))
        return jsonify(task=one(TASK_SELECT + " WHERE t.id = ?", (tid,)))

    @app.post("/api/tasks/<int:tid>/toggle")
    @login_required
    def toggle_task(tid):
        t = own_or_404("tasks", tid)
        new_status = "todo" if t["status"] == "done" else "done"
        done_at = datetime.now().isoformat(timespec="seconds") if new_status == "done" else None
        execute("UPDATE tasks SET status=?, completed_at=? WHERE id=?", (new_status, done_at, tid))
        return jsonify(task=one(TASK_SELECT + " WHERE t.id = ?", (tid,)))

    @app.delete("/api/tasks/<int:tid>")
    @login_required
    def delete_task(tid):
        own_or_404("tasks", tid)
        execute("DELETE FROM tasks WHERE id = ?", (tid,))
        return jsonify(ok=True)

    # --------------------------------------------------------------- exams
    EXAM_SELECT = """SELECT e.*, s.name AS subject_name, s.color AS subject_color
                     FROM exams e LEFT JOIN subjects s ON s.id = e.subject_id"""

    def exam_payload(data: dict, current: dict | None = None) -> dict:
        cur = current or {}
        partial = current is not None
        return {
            "title": req_str(data, "title", "Title", 120, required=not partial) or cur.get("title"),
            "exam_at": req_datetime(data, "exam_at", "Exam date") if (not partial or "exam_at" in data) else cur["exam_at"],
            "location": (req_str(data, "location", "Location", 120, required=False) or "")
                        if "location" in data else cur.get("location", ""),
            "notes": (req_str(data, "notes", "Notes", 1000, required=False) or "")
                     if "notes" in data else cur.get("notes", ""),
            "subject_id": optional_subject(data) if "subject_id" in data else cur.get("subject_id"),
        }

    @app.get("/api/exams")
    @login_required
    def list_exams():
        sql = EXAM_SELECT + " WHERE e.user_id = ?"
        if request.args.get("upcoming") == "1":
            sql += " AND e.exam_at >= strftime('%Y-%m-%dT%H:%M', 'now', 'localtime')"
        return jsonify(exams=rows(sql + " ORDER BY e.exam_at", (g.user_id,)))

    @app.post("/api/exams")
    @login_required
    def create_exam():
        p = exam_payload(body())
        eid = execute("INSERT INTO exams (user_id, subject_id, title, exam_at, location, notes) VALUES (?,?,?,?,?,?)",
                      (g.user_id, p["subject_id"], p["title"], p["exam_at"], p["location"], p["notes"]))
        return jsonify(exam=one(EXAM_SELECT + " WHERE e.id = ?", (eid,))), 201

    @app.route("/api/exams/<int:eid>", methods=["PUT", "PATCH"])
    @login_required
    def update_exam(eid):
        p = exam_payload(body(), own_or_404("exams", eid))
        execute("UPDATE exams SET subject_id=?, title=?, exam_at=?, location=?, notes=? WHERE id=?",
                (p["subject_id"], p["title"], p["exam_at"], p["location"], p["notes"], eid))
        return jsonify(exam=one(EXAM_SELECT + " WHERE e.id = ?", (eid,)))

    @app.delete("/api/exams/<int:eid>")
    @login_required
    def delete_exam(eid):
        own_or_404("exams", eid)
        execute("DELETE FROM exams WHERE id = ?", (eid,))
        return jsonify(ok=True)

    # ----------------------------------------------------------- resources
    RES_SELECT = """SELECT r.*, s.name AS subject_name, s.color AS subject_color
                    FROM resources r LEFT JOIN subjects s ON s.id = r.subject_id"""

    def valid_url(url: str) -> str:
        if not re.match(r"^https?://[^\s/$.?#].[^\s]*$", url, re.I):
            raise ApiError("URL must start with http:// or https://", fields={"url": "invalid"})
        return url

    def remove_stored_file(stored_name: str | None):
        if stored_name:
            path = os.path.join(app.config["UPLOAD_FOLDER"], stored_name)
            if os.path.isfile(path):
                os.remove(path)

    @app.get("/api/resources")
    @login_required
    def list_resources():
        sql, args = RES_SELECT + " WHERE r.user_id = ?", [g.user_id]
        if request.args.get("category"):
            sql += " AND r.category = ?"
            args.append(request.args["category"])
        if request.args.get("subject_id"):
            sql += " AND r.subject_id = ?"
            args.append(request.args.get("subject_id", type=int))
        if request.args.get("q"):
            sql += " AND (r.title LIKE ? OR r.notes LIKE ?)"
            like = f"%{request.args['q']}%"
            args += [like, like]
        items = rows(sql + " ORDER BY r.created_at DESC, r.id DESC", tuple(args))
        cats = [r["category"] for r in rows(
            "SELECT DISTINCT category FROM resources WHERE user_id = ? ORDER BY category", (g.user_id,))]
        return jsonify(resources=items, categories=cats)

    @app.post("/api/resources")
    @login_required
    def create_resource():
        """Accepts JSON (link) or multipart/form-data with a `file` field (upload)."""
        data = body()
        title = req_str(data, "title", "Title", 150)
        category = req_str(data, "category", "Category", 50, required=False) or "Other"
        notes = req_str(data, "notes", "Notes", 1000, required=False) or ""
        sid = optional_subject(data)
        upload = request.files.get("file")
        if upload and upload.filename:
            if not allowed_file(upload.filename):
                raise ApiError("File type not allowed.", fields={"file": "invalid type"})
            original = secure_filename(upload.filename) or "file"
            stored = f"{uuid.uuid4().hex}_{original}"
            path = os.path.join(app.config["UPLOAD_FOLDER"], stored)
            upload.save(path)
            rid = execute("""INSERT INTO resources (user_id, subject_id, title, category, kind, stored_name,
                             original_name, file_size, notes) VALUES (?,?,?,?, 'file', ?,?,?,?)""",
                          (g.user_id, sid, title, category, stored, original, os.path.getsize(path), notes))
        else:
            url = valid_url(req_str(data, "url", "URL", 2000))
            rid = execute("""INSERT INTO resources (user_id, subject_id, title, category, kind, url, notes)
                             VALUES (?,?,?,?, 'link', ?, ?)""", (g.user_id, sid, title, category, url, notes))
        return jsonify(resource=one(RES_SELECT + " WHERE r.id = ?", (rid,))), 201

    @app.route("/api/resources/<int:rid>", methods=["PUT", "PATCH"])
    @login_required
    def update_resource(rid):
        cur = own_or_404("resources", rid)
        data = body()
        title = req_str(data, "title", "Title", 150, required=False) or cur["title"]
        category = req_str(data, "category", "Category", 50, required=False) or cur["category"]
        notes = (req_str(data, "notes", "Notes", 1000, required=False) or "") if "notes" in data else cur["notes"]
        sid = optional_subject(data) if "subject_id" in data else cur["subject_id"]
        url = cur["url"]
        if cur["kind"] == "link" and data.get("url"):
            url = valid_url(req_str(data, "url", "URL", 2000))
        execute("UPDATE resources SET title=?, category=?, notes=?, subject_id=?, url=? WHERE id=?",
                (title, category, notes, sid, url, rid))
        return jsonify(resource=one(RES_SELECT + " WHERE r.id = ?", (rid,)))

    @app.delete("/api/resources/<int:rid>")
    @login_required
    def delete_resource(rid):
        r = own_or_404("resources", rid)
        execute("DELETE FROM resources WHERE id = ?", (rid,))
        remove_stored_file(r["stored_name"])
        return jsonify(ok=True)

    @app.get("/api/resources/<int:rid>/file")
    @login_required
    def download_resource(rid):
        r = own_or_404("resources", rid)
        if r["kind"] != "file":
            raise ApiError("This resource is a link, not a file.", 400)
        return send_from_directory(app.config["UPLOAD_FOLDER"], r["stored_name"],
                                   as_attachment=request.args.get("download") == "1",
                                   download_name=r["original_name"])

    # ----------------------------------------------------------- dashboard
    @app.get("/api/dashboard")
    @login_required
    def dashboard():
        today = date.today().isoformat()
        counts = one("""SELECT
                COUNT(*) AS total,
                SUM(status = 'done') AS done,
                SUM(status != 'done' AND due_date < ?) AS overdue,
                SUM(status != 'done' AND due_date = ?) AS due_today
            FROM tasks WHERE user_id = ?""", (today, today, g.user_id))
        counts = {k: (v or 0) for k, v in counts.items()}
        upcoming_tasks = rows(TASK_SELECT + """ WHERE t.user_id = ? AND t.status != 'done'
                              ORDER BY t.due_date IS NULL, t.due_date,
                              CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END LIMIT 5""",
                              (g.user_id,))
        next_exams = rows(EXAM_SELECT + """ WHERE e.user_id = ?
                          AND e.exam_at >= strftime('%Y-%m-%dT%H:%M', 'now', 'localtime')
                          ORDER BY e.exam_at LIMIT 3""", (g.user_id,))
        recent_grades = rows(GRADE_SELECT + " WHERE gr.user_id = ? ORDER BY gr.graded_on DESC, gr.id DESC LIMIT 5",
                             (g.user_id,))
        res_count = one("SELECT COUNT(*) AS n FROM resources WHERE user_id = ?", (g.user_id,))["n"]
        return jsonify(performance=compute_performance(g.user_id), tasks=counts,
                       upcoming_tasks=upcoming_tasks, next_exams=next_exams,
                       recent_grades=recent_grades, resource_count=res_count)

    # --------------------------------------------------------- frontend
    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    @app.get("/api/meta")
    def meta():
        """Tells the frontend whether the public demo account is enabled."""
        return jsonify(demo=bool(app.config["SEED_DEMO"]), demo_email=DEMO_EMAIL if app.config["SEED_DEMO"] else None)

    last_reset = {"at": 0.0}

    @app.post("/api/demo/reset")
    def demo_reset():
        """Restore the demo account's sample data (enabled only when STUDYSYNC_SEED_DEMO=1)."""
        if not app.config["SEED_DEMO"]:
            raise ApiError("The demo account is not enabled on this server.", 404)
        now = datetime.now().timestamp()
        if now - last_reset["at"] < 10 and not app.config.get("TESTING"):
            raise ApiError("Demo data was just reset. Try again in a few seconds.", 429)
        last_reset["at"] = now
        for stored in reset_demo_account(app.config["DATABASE"]):
            remove_stored_file(stored)
        return jsonify(ok=True)

    @app.get("/api/health")
    def health():
        """Used by Render's health check: also confirms the database answers."""
        try:
            get_db().execute("SELECT 1").fetchone()
        except sqlite3.Error as exc:
            return jsonify(status="error", detail=str(exc)), 503
        return jsonify(status="ok")

    @app.get("/api/<path:_unknown>")
    def api_404(_unknown):
        abort(404, description="Endpoint not found.")

    return app


logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
app = create_app()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG") == "1"
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=port, debug=debug)
