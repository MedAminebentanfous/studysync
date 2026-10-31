"""API test-suite.  Run with:  python -m pytest -q"""
import io
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app import create_app  # noqa: E402
from init_db import init_db  # noqa: E402


@pytest.fixture()
def client(tmp_path):
    db = tmp_path / "test.db"
    init_db(str(db), with_sample=True)
    app = create_app({"TESTING": True, "DATABASE": str(db), "UPLOAD_FOLDER": str(tmp_path / "uploads")})
    with app.test_client() as c:
        yield c


def login(c, email="demo@studysync.app", password="demo1234"):
    r = c.post("/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.get_json()
    return r


def test_requires_auth(client):
    assert client.get("/api/tasks").status_code == 401


def test_register_login_logout(client):
    r = client.post("/api/auth/register", json={"full_name": "Ada", "email": "ada@x.io", "password": "password1"})
    assert r.status_code == 201
    assert client.get("/api/auth/me").get_json()["user"]["email"] == "ada@x.io"
    assert client.post("/api/auth/register", json={"full_name": "A", "email": "ADA@x.io", "password": "password1"}).status_code == 409
    client.post("/api/auth/logout")
    assert client.get("/api/auth/me").status_code == 401
    assert client.post("/api/auth/login", json={"email": "ada@x.io", "password": "wrong"}).status_code == 401


def test_weighted_average_math(client):
    client.post("/api/auth/register", json={"full_name": "B", "email": "b@x.io", "password": "password1"})
    math = client.post("/api/subjects", json={"name": "Math", "coefficient": 4}).get_json()["subject"]
    phys = client.post("/api/subjects", json={"name": "Physics", "coefficient": 2}).get_json()["subject"]
    # Math: 10/20 x1 and 16/20 x2 -> (10 + 32) / 3 = 14
    client.post("/api/grades", json={"subject_id": math["id"], "title": "Quiz", "score": 10, "max_score": 20, "weight": 1})
    client.post("/api/grades", json={"subject_id": math["id"], "title": "Exam", "score": 80, "max_score": 100, "weight": 2})
    # Physics: 11/20 -> 11
    client.post("/api/grades", json={"subject_id": phys["id"], "title": "Lab", "score": 11, "max_score": 20})
    p = client.get("/api/performance").get_json()
    by = {s["name"]: s for s in p["subjects"]}
    assert by["Math"]["average"] == 14
    assert by["Physics"]["average"] == 11
    # Overall: (14*4 + 11*2) / 6 = 13
    assert p["overall_average"] == 13
    assert p["gpa_4"] == 2.6
    assert p["percentage"] == 65.0


def test_grade_validation(client):
    login(client)
    r = client.post("/api/grades", json={"subject_id": 1, "title": "Bad", "score": 25, "max_score": 20})
    assert r.status_code == 400
    r = client.post("/api/grades", json={"subject_id": 1, "title": "Bad", "score": "abc"})
    assert r.status_code == 400
    r = client.post("/api/grades", json={"subject_id": 999, "title": "X", "score": 1})
    assert r.status_code == 404


def test_subject_crud_and_cascade(client):
    login(client)
    r = client.post("/api/subjects", json={"name": "Chemistry", "coefficient": 2, "target_average": 14, "color": "#123456"})
    sid = r.get_json()["subject"]["id"]
    assert client.post("/api/subjects", json={"name": "Chemistry", "coefficient": 1}).status_code == 409
    client.post("/api/grades", json={"subject_id": sid, "title": "T1", "score": 12})
    r = client.patch(f"/api/subjects/{sid}", json={"coefficient": 3})
    assert r.get_json()["subject"]["coefficient"] == 3
    assert r.get_json()["subject"]["name"] == "Chemistry"
    assert client.delete(f"/api/subjects/{sid}").status_code == 200
    assert all(g["subject_id"] != sid for g in client.get("/api/grades").get_json()["grades"])


def test_task_crud_toggle_filter(client):
    login(client)
    r = client.post("/api/tasks", json={"title": "Read ch.1", "priority": "high", "due_date": "2030-01-01"})
    assert r.status_code == 201
    tid = r.get_json()["task"]["id"]
    t = client.post(f"/api/tasks/{tid}/toggle").get_json()["task"]
    assert t["status"] == "done" and t["completed_at"]
    t = client.patch(f"/api/tasks/{tid}", json={"status": "in_progress"}).get_json()["task"]
    assert t["status"] == "in_progress" and t["completed_at"] is None
    high = client.get("/api/tasks?priority=high").get_json()["tasks"]
    assert all(x["priority"] == "high" for x in high)
    assert client.post("/api/tasks", json={"title": "x", "priority": "urgent"}).status_code == 400
    assert client.delete(f"/api/tasks/{tid}").status_code == 200
    assert client.get(f"/api/tasks/{tid}").status_code == 404


def test_exams(client):
    login(client)
    r = client.post("/api/exams", json={"title": "Final", "exam_at": "2031-06-01T09:00", "subject_id": 1})
    assert r.status_code == 201
    eid = r.get_json()["exam"]["id"]
    assert client.patch(f"/api/exams/{eid}", json={"location": "Hall B"}).get_json()["exam"]["location"] == "Hall B"
    assert client.post("/api/exams", json={"title": "Bad", "exam_at": "tomorrow"}).status_code == 400
    assert client.delete(f"/api/exams/{eid}").status_code == 200


def test_resources_link_and_file(client):
    login(client)
    r = client.post("/api/resources", json={"title": "Docs", "url": "https://example.com", "category": "Reference"})
    assert r.status_code == 201
    assert client.post("/api/resources", json={"title": "Bad", "url": "javascript:alert(1)"}).status_code == 400
    data = {"title": "Notes", "category": "Notes", "file": (io.BytesIO(b"hello"), "notes.txt")}
    r = client.post("/api/resources", data=data, content_type="multipart/form-data")
    assert r.status_code == 201, r.get_json()
    rid = r.get_json()["resource"]["id"]
    dl = client.get(f"/api/resources/{rid}/file")
    assert dl.status_code == 200 and dl.data == b"hello"
    dl.close()
    bad = {"title": "Evil", "file": (io.BytesIO(b"x"), "evil.exe")}
    assert client.post("/api/resources", data=bad, content_type="multipart/form-data").status_code == 400
    listing = client.get("/api/resources?category=Notes").get_json()
    assert all(x["category"] == "Notes" for x in listing["resources"])
    assert "Reference" in listing["categories"]
    assert client.delete(f"/api/resources/{rid}").status_code == 200


def test_user_isolation(client):
    client.post("/api/auth/register", json={"full_name": "Eve", "email": "eve@x.io", "password": "password1"})
    # Eve must not see or touch the demo user's data
    assert client.get("/api/tasks").get_json()["tasks"] == []
    assert client.get("/api/subjects/1").status_code == 404
    assert client.delete("/api/tasks/1").status_code == 404
    assert client.post("/api/grades", json={"subject_id": 1, "title": "x", "score": 1}).status_code == 404


def test_dashboard(client):
    login(client)
    d = client.get("/api/dashboard").get_json()
    assert d["performance"]["overall_average"] is not None
    assert d["tasks"]["total"] == 6
    assert len(d["next_exams"]) == 3
