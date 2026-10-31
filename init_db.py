"""
Database initialisation / reset ("migration") script.

    python init_db.py           # drop + recreate all tables, load sample data
    python init_db.py --empty   # drop + recreate all tables, no sample data

The database path can be overridden with the STUDYSYNC_DB environment variable.
WARNING: this drops existing tables — all data in the database is replaced.
"""
import os
import sqlite3
import sys

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
DB_PATH = os.environ.get("STUDYSYNC_DB", os.path.join(BASE_DIR, "studysync.db"))
SCHEMA_PATH = os.path.join(BASE_DIR, "schema.sql")
SAMPLE_MARKER = "-- ===================== SAMPLE DATA"


def init_db(db_path: str = DB_PATH, with_sample: bool = True) -> None:
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        script = f.read()
    if not with_sample:
        script = script.split(SAMPLE_MARKER)[0]
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(script)
        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    sample = "--empty" not in sys.argv
    init_db(with_sample=sample)
    print(f"Database initialised at {DB_PATH}"
          + (" with sample data (login: demo@studysync.app / demo1234)." if sample else " (empty)."))
