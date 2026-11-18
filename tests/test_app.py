import importlib
import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PHOTO_CLEANER_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("PHOTO_CLEANER_CACHE", str(tmp_path / "cache"))
    import app as appmod

    appmod = importlib.reload(appmod)
    trashed = []
    monkeypatch.setattr(appmod, "send2trash", lambda p: (trashed.append(p), Path(p).unlink()))
    root = tmp_path / "사진"
    day = root / "2024" / "2024-03-16 제주"
    day.mkdir(parents=True)
    for i in range(3):
        Image.new("RGB", (64, 48), (i * 80, 100, 200)).save(day / f"IMG_{i}.JPG")
    (day / "memo.txt").write_text("x")
    appmod.app.config["START_ROOT"] = root
    appmod.app.config["TESTING"] = True
    c = appmod.app.test_client()
    c.mod, c.root, c.day, c.trashed = appmod, root, day, trashed
    return c


def test_index_has_token(client):
    html = client.get("/").get_data(as_text=True)
    assert client.mod.TOKEN in html and "__TOKEN__" not in html


def test_dirs_and_photos(client):
    d = client.get("/api/dirs", query_string={"path": str(client.root)}).get_json()
    assert [x["name"] for x in d["dirs"]] == ["2024"]
    assert d["dirs"][0]["hasChildren"] is True
    d2 = client.get("/api/dirs", query_string={"path": str(client.root / "2024")}).get_json()
    assert d2["dirs"][0]["count"] == 3
    p = client.get("/api/photos", query_string={"path": str(client.day)}).get_json()
    assert [x["name"] for x in p["photos"]] == ["IMG_0.JPG", "IMG_1.JPG", "IMG_2.JPG"]


def test_thumb_and_info(client):
    f = str(client.day / "IMG_0.JPG")
    r = client.get("/api/thumb", query_string={"path": f, "size": "s"})
    assert r.status_code == 200 and r.mimetype == "image/jpeg"
    info = client.get("/api/info", query_string={"path": f}).get_json()
    assert info["width"] == 64 and info["height"] == 48


def test_relative_path_rejected(client):
    assert client.get("/api/photos", query_string={"path": "사진"}).status_code == 400


def test_delete_requires_token(client):
    f = str(client.day / "IMG_0.JPG")
    r = client.post("/api/delete", json={"paths": [f]})
    assert r.status_code == 403
    assert Path(f).exists()


def test_delete_to_trash_and_skip_non_photo(client):
    f = str(client.day / "IMG_1.JPG")
    memo = str(client.day / "memo.txt")
    r = client.post("/api/delete", json={"paths": [f, memo]}, headers={"X-Token": client.mod.TOKEN}).get_json()
    assert [d["path"] for d in r["deleted"]] == [f]
    assert len(r["failed"]) == 1 and Path(memo).exists()
    assert client.trashed == [f] and not Path(f).exists()


def test_permanent_delete(client):
    f = str(client.day / "IMG_2.JPG")
    r = client.post("/api/delete", json={"paths": [f], "permanent": True}, headers={"X-Token": client.mod.TOKEN}).get_json()
    assert len(r["deleted"]) == 1 and not Path(f).exists() and client.trashed == []


def test_settings_roundtrip(client, tmp_path, monkeypatch):
    monkeypatch.setattr(client.mod, "SETTINGS_FILE", tmp_path / "settings.json")
    client.mod.app.config["START_ROOT"] = None
    s = client.get("/api/settings").get_json()
    assert s["view"] == "single" and s["folder"] is None
    assert client.post("/api/settings", json={"view": "multi"}).status_code == 403  # 토큰 필요
    r = client.post(
        "/api/settings",
        json={"root": str(client.root), "folder": str(client.day), "view": "multi", "nup": 4, "evil": 1},
        headers={"X-Token": client.mod.TOKEN},
    ).get_json()
    assert r["nup"] == 4 and "evil" not in r
    again = client.get("/api/settings").get_json()
    assert again["folder"] == str(client.day) and again["view"] == "multi"
    # 마지막 드라이브/폴더가 시작 위치가 된다
    assert client.get("/api/roots").get_json()["start"] == str(client.root)


def test_start_root_overrides_saved_folder(client, tmp_path, monkeypatch):
    monkeypatch.setattr(client.mod, "SETTINGS_FILE", tmp_path / "settings.json")
    client.mod.save_settings({"root": "/elsewhere", "folder": "/elsewhere/x"})
    s = client.get("/api/settings").get_json()
    assert s["root"] == str(client.root) and s["folder"] is None
