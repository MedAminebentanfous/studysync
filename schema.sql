-- =====================================================================
--  StudySync & Academic Performance Tracker — database schema (SQLite)
--  Run with:  python init_db.py            (schema + sample data)
--             python init_db.py --empty    (schema only)
-- =====================================================================

PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS resources;
DROP TABLE IF EXISTS exams;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS grades;
DROP TABLE IF EXISTS subjects;
DROP TABLE IF EXISTS users;

-- ---------------------------------------------------------------------
-- Users: one account per student. Passwords are stored as salted hashes.
-- ---------------------------------------------------------------------
CREATE TABLE users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name       TEXT    NOT NULL,
    email           TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash   TEXT    NOT NULL,
    grade_scale     REAL    NOT NULL DEFAULT 20 CHECK (grade_scale > 0),
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Subjects: each subject carries a coefficient (credit weight) used to
-- compute the overall weighted average.
-- ---------------------------------------------------------------------
CREATE TABLE subjects (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT    NOT NULL,
    coefficient     REAL    NOT NULL DEFAULT 1 CHECK (coefficient > 0),
    target_average  REAL             CHECK (target_average IS NULL OR target_average >= 0),
    color           TEXT    NOT NULL DEFAULT '#4f46e5',
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, name)
);

-- ---------------------------------------------------------------------
-- Grades: individual assessments inside a subject. `weight` is the
-- coefficient multiplier of the assessment within its subject
-- (e.g. final exam x2, quiz x0.5). Scores are normalised to the user's
-- grade scale using max_score.
-- ---------------------------------------------------------------------
CREATE TABLE grades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject_id      INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    title           TEXT    NOT NULL,
    grade_type      TEXT    NOT NULL DEFAULT 'exam'
                    CHECK (grade_type IN ('exam','quiz','homework','project','oral','lab','other')),
    score           REAL    NOT NULL CHECK (score >= 0),
    max_score       REAL    NOT NULL DEFAULT 20 CHECK (max_score > 0),
    weight          REAL    NOT NULL DEFAULT 1 CHECK (weight > 0),
    graded_on       TEXT    NOT NULL DEFAULT (date('now')),
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    CHECK (score <= max_score)
);

-- ---------------------------------------------------------------------
-- Tasks: study / revision planner items.
-- ---------------------------------------------------------------------
CREATE TABLE tasks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject_id      INTEGER          REFERENCES subjects(id) ON DELETE SET NULL,
    title           TEXT    NOT NULL,
    description     TEXT    NOT NULL DEFAULT '',
    due_date        TEXT,
    priority        TEXT    NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
    status          TEXT    NOT NULL DEFAULT 'todo'   CHECK (status IN ('todo','in_progress','done')),
    completed_at    TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Exams: target dates that drive the live countdown timers.
-- exam_at is a local datetime string 'YYYY-MM-DDTHH:MM'.
-- ---------------------------------------------------------------------
CREATE TABLE exams (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject_id      INTEGER          REFERENCES subjects(id) ON DELETE SET NULL,
    title           TEXT    NOT NULL,
    exam_at         TEXT    NOT NULL,
    location        TEXT    NOT NULL DEFAULT '',
    notes           TEXT    NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Resources: categorised study material (external links or uploaded files).
-- ---------------------------------------------------------------------
CREATE TABLE resources (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject_id      INTEGER          REFERENCES subjects(id) ON DELETE SET NULL,
    title           TEXT    NOT NULL,
    category        TEXT    NOT NULL DEFAULT 'Other',
    kind            TEXT    NOT NULL CHECK (kind IN ('link','file')),
    url             TEXT,
    stored_name     TEXT,
    original_name   TEXT,
    file_size       INTEGER,
    notes           TEXT    NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    CHECK ((kind = 'link' AND url IS NOT NULL) OR (kind = 'file' AND stored_name IS NOT NULL))
);

CREATE INDEX idx_subjects_user   ON subjects(user_id);
CREATE INDEX idx_grades_user     ON grades(user_id);
CREATE INDEX idx_grades_subject  ON grades(subject_id);
CREATE INDEX idx_tasks_user_due  ON tasks(user_id, due_date);
CREATE INDEX idx_exams_user_date ON exams(user_id, exam_at);
CREATE INDEX idx_resources_user  ON resources(user_id, category);

-- ===================== SAMPLE DATA =====================
-- Demo account:  demo@studysync.app  /  demo1234
INSERT INTO users (id, full_name, email, password_hash, grade_scale) VALUES
(1, 'Demo Student', 'demo@studysync.app',
 'scrypt:32768:8:1$Xy8RlPLe3PjAgZ96$b7503257a567177a3ebb675c61f82ad2064f44dd47e43f7288c0befdd1396cb6de37d689e8b46725a4941f7f6e50074e0c31ed7e37ea64367b65cd37b903a2de',
 20);

INSERT INTO subjects (id, user_id, name, coefficient, target_average, color) VALUES
(1, 1, 'Mathematics',       4,   16, '#4f46e5'),
(2, 1, 'Physics',           3,   14, '#0891b2'),
(3, 1, 'Computer Science',  3,   17, '#16a34a'),
(4, 1, 'English',           2,   15, '#d97706'),
(5, 1, 'Philosophy',        1,   12, '#db2777');

INSERT INTO grades (user_id, subject_id, title, grade_type, score, max_score, weight, graded_on) VALUES
(1, 1, 'Calculus quiz',          'quiz',     15.5, 20,  0.5, date('now','-40 days')),
(1, 1, 'Midterm exam',           'exam',     14,   20,  2,   date('now','-25 days')),
(1, 1, 'Linear algebra homework','homework', 18,   20,  1,   date('now','-10 days')),
(1, 2, 'Mechanics lab',          'lab',      16,   20,  1,   date('now','-35 days')),
(1, 2, 'Midterm exam',           'exam',     11.5, 20,  2,   date('now','-24 days')),
(1, 3, 'Algorithms project',     'project',  92,   100, 2,   date('now','-20 days')),
(1, 3, 'Data structures quiz',   'quiz',     17,   20,  1,   date('now','-8 days')),
(1, 4, 'Essay',                  'homework', 14,   20,  1,   date('now','-30 days')),
(1, 4, 'Oral presentation',      'oral',     16,   20,  1,   date('now','-12 days')),
(1, 5, 'Dissertation',           'exam',     11,   20,  1,   date('now','-15 days'));

INSERT INTO tasks (user_id, subject_id, title, description, due_date, priority, status, completed_at) VALUES
(1, 1, 'Revise integration by parts', 'Chapter 4 exercises 1-15',          date('now','+2 days'),  'high',   'todo',        NULL),
(1, 2, 'Redo midterm mistakes',       'Focus on energy conservation',      date('now','+4 days'),  'high',   'in_progress', NULL),
(1, 3, 'Implement Dijkstra in Python','Compare heap vs. array versions',   date('now','+6 days'),  'medium', 'todo',        NULL),
(1, 4, 'Read "Animal Farm" ch. 5-7',  '',                                  date('now','+9 days'),  'low',    'todo',        NULL),
(1, 5, 'Outline dissertation plan',   'Thesis / antithesis / synthesis',   date('now','-1 days'),  'medium', 'todo',        NULL),
(1, 1, 'Flashcards: trig identities', '',                                  date('now','-3 days'),  'low',    'done',        datetime('now','-3 days'));

INSERT INTO exams (user_id, subject_id, title, exam_at, location, notes) VALUES
(1, 1, 'Mathematics final',    strftime('%Y-%m-%dT09:00', 'now', '+12 days'), 'Amphi A',  'Calculator allowed'),
(1, 2, 'Physics final',        strftime('%Y-%m-%dT14:00', 'now', '+15 days'), 'Room 204', ''),
(1, 3, 'CS practical exam',    strftime('%Y-%m-%dT10:30', 'now', '+20 days'), 'Lab 3',    'Bring student ID');

INSERT INTO resources (user_id, subject_id, title, category, kind, url, notes) VALUES
(1, 1, 'MIT OCW — Single Variable Calculus', 'Course',  'link', 'https://ocw.mit.edu/courses/18-01sc-single-variable-calculus-fall-2010/', 'Great lecture videos'),
(1, 1, '3Blue1Brown — Essence of Linear Algebra', 'Video', 'link', 'https://www.3blue1brown.com/topics/linear-algebra', ''),
(1, 2, 'HyperPhysics', 'Reference', 'link', 'http://hyperphysics.phy-astr.gsu.edu/hbase/index.html', 'Concept maps'),
(1, 3, 'Visualgo — algorithm animations', 'Interactive', 'link', 'https://visualgo.net/en', ''),
(1, 4, 'Purdue OWL — essay writing', 'Article', 'link', 'https://owl.purdue.edu/owl/general_writing/index.html', '');
