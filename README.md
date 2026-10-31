# StudySync — Academic Performance Tracker

A full-stack web app for students: weighted averages and GPA, a revision planner, live exam countdowns and a study-resource library.

**Stack:** Python 3.10+ · Flask 3 · SQLite · vanilla HTML/CSS/JS (no build step, no frameworks) · pytest

## Features

| Module | What it does |
|---|---|
| **Weighted GPA calculator** | Subjects carry a *coefficient* (credit weight); each grade carries a *weight multiplier* (e.g. final ×2, quiz ×0.5). Scores on any scale (e.g. 92/100) are normalised to your grading scale (/20 by default, or /100, /10, /4). Shows per-subject averages, contribution to the final average, targets, GPA on a 4.0 scale and a standing label. |
| **What-if calculator** | Type a hypothetical grade and see the subject and overall averages update live, plus the minimum score needed to reach your subject target. |
| **Revision planner** | Create, edit, delete and check off tasks with due dates, priority tags (high/medium/low) and status (to do / in progress / done). Filter by status, priority and subject; overdue and due-soon tasks are highlighted. |
| **Exam countdowns** | Add exam dates and watch live day/hour/minute/second timers; urgency badges for exams this week. |
| **Resource manager** | Save links or upload files (≤16 MB), categorise them, attach them to a subject, search and filter. |
| **Accounts** | Register/login with hashed passwords (Werkzeug scrypt) and session cookies; every query is scoped to the logged-in user. |
| **UI** | Responsive (desktop sidebar → mobile drawer), light/dark theme, toasts, modal forms with validation. |

## Formulas

```
normalised grade   = score / max_score × scale
subject average    = Σ(normalised × weight) / Σ weight
overall average    = Σ(subject average × coefficient) / Σ coefficient   (graded subjects only)
GPA (4.0)          = overall / scale × 4
```

## Project structure

```
studysync/
├── app.py              # Flask app: REST API + serves the frontend
├── schema.sql          # Tables, constraints, indexes + sample data
├── init_db.py          # Creates / resets the SQLite database
├── requirements.txt
├── static/
│   ├── index.html      # App shell, auth screen, modal
│   ├── styles.css      # Design system, light/dark themes, responsive layout
│   └── app.js          # SPA: router, fetch API client, all views
├── tests/test_api.py   # 10 pytest API tests
└── uploads/            # Uploaded study files (created automatically)
```

## Setup & run

```bash
# 1. Create and activate a virtual environment
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Create the database (schema + sample data)
python init_db.py                  # or: python init_db.py --empty  (no sample data)

# 4. Start the server
python app.py
```

Open **http://127.0.0.1:5000** and sign in with the demo account (pre-filled):
**`demo@studysync.app` / `demo1234`** — or create your own account.

> `init_db.py` drops and recreates all tables, so re-run it any time you want a fresh demo. If you start `app.py` without running it, an empty database is created automatically.

### Run the tests

```bash
python -m pytest -q
```

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `STUDYSYNC_SECRET_KEY` | dev value | **Set a long random value in production** (signs session cookies) |
| `STUDYSYNC_DB` | `./studysync.db` | SQLite database path |
| `STUDYSYNC_UPLOADS` | `./uploads` | Uploaded files folder |
| `STUDYSYNC_SECURE_COOKIES` | off | Set to `1` when served over HTTPS |
| `HOST` / `PORT` | `127.0.0.1` / `5000` | Bind address |
| `FLASK_DEBUG` | off | Set to `1` for auto-reload during development |

### Production

```bash
pip install gunicorn
export STUDYSYNC_SECRET_KEY="$(python -c 'import secrets; print(secrets.token_hex(32))')"
gunicorn -w 4 -b 0.0.0.0:8000 app:app
```
(On Windows use `pip install waitress` and `waitress-serve --port=8000 app:app`.)

## REST API

All endpoints are JSON, under `/api`, and require a session (except register/login/health). `PUT` and `PATCH` both accept partial updates.

| Method | Endpoint | Description |
|---|---|---|
| POST | `/auth/register` · `/auth/login` · `/auth/logout` | Account & session |
| GET / PATCH | `/auth/me` | Current user; update name / grading scale |
| GET / POST | `/subjects` | List (with averages) / create |
| GET / PUT / PATCH / DELETE | `/subjects/<id>` | Read (with grades) / update / delete (cascades grades) |
| GET / POST | `/grades?subject_id=` | List / create |
| GET / PUT / PATCH / DELETE | `/grades/<id>` | Read / update / delete |
| GET | `/performance` | Weighted averages, GPA, per-subject breakdown |
| GET / POST | `/tasks?status=&priority=&subject_id=` | List (filtered) / create |
| GET / PUT / PATCH / DELETE | `/tasks/<id>` | Read / update / delete |
| POST | `/tasks/<id>/toggle` | Toggle done ↔ to do |
| GET / POST | `/exams?upcoming=1` | List / create |
| PUT / PATCH / DELETE | `/exams/<id>` | Update / delete |
| GET / POST | `/resources?category=&subject_id=&q=` | List + categories / create (JSON link or multipart file) |
| PUT / PATCH / DELETE | `/resources/<id>` | Update / delete (removes stored file) |
| GET | `/resources/<id>/file?download=1` | View / download an uploaded file |
| GET | `/dashboard` | Aggregated summary for the dashboard |

Example:

```bash
curl -c jar -H 'Content-Type: application/json' \
     -d '{"email":"demo@studysync.app","password":"demo1234"}' http://127.0.0.1:5000/api/auth/login
curl -b jar -H 'Content-Type: application/json' \
     -d '{"subject_id":1,"title":"Final","score":17,"max_score":20,"weight":2}' http://127.0.0.1:5000/api/grades
curl -b jar http://127.0.0.1:5000/api/performance
```

## Database schema

`users` 1─* `subjects` 1─* `grades`; `users` 1─* `tasks`, `exams`, `resources` (each optionally linked to a subject, `ON DELETE SET NULL`). CHECK constraints enforce valid priorities, statuses, positive coefficients/weights and `score ≤ max_score`; foreign keys cascade on user/subject deletion. See `schema.sql`.

## Security notes

Salted password hashes · HttpOnly + SameSite session cookies · parameterised SQL everywhere · per-user ownership checks on every row · server-side validation of all input · upload extension allow-list, `secure_filename`, random stored names and a 16 MB limit · output escaping in the frontend to prevent XSS · `http(s)`-only resource URLs.
