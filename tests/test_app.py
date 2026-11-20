import os
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


def test_ratings_set_list_collect_and_clear(client):
    tok = {"X-Token": client.mod.TOKEN}
    f0, f1 = str(client.day / "IMG_0.JPG"), str(client.day / "IMG_1.JPG")
    assert client.post("/api/rating", json={"paths": [f0], "stars": 5}).status_code == 403
    assert client.post("/api/rating", json={"paths": [f0], "stars": 9}, headers=tok).status_code == 400
    assert client.post("/api/rating", json={"paths": [f0, f1], "stars": 5}, headers=tok).get_json()["count"] == 2
    client.post("/api/rating", json={"paths": [f1], "stars": 2}, headers=tok)
    ph = {p["name"]: p["rating"] for p in client.get("/api/photos", query_string={"path": str(client.day)}).get_json()["photos"]}
    assert ph == {"IMG_0.JPG": 5, "IMG_1.JPG": 2, "IMG_2.JPG": 0}
    s = client.get("/api/ratings/summary", query_string={"root": str(client.root)}).get_json()["counts"]
    assert s["5"] == 1 and s["2"] == 1 and s["3"] == 0
    c = client.get("/api/ratings/collect", query_string={"root": str(client.root), "stars": 5}).get_json()
    assert [p["name"] for p in c["photos"]] == ["IMG_0.JPG"] and c["photos"][0]["dir"] == "2024-03-16 제주"
    # 별점 지우기
    client.post("/api/rating", json={"paths": [f0], "stars": 0}, headers=tok)
    assert client.get("/api/ratings/summary", query_string={"root": str(client.root)}).get_json()["counts"]["5"] == 0


def test_delete_removes_rating_and_collect_prunes_missing(client):
    tok = {"X-Token": client.mod.TOKEN}
    f1, f2 = str(client.day / "IMG_1.JPG"), str(client.day / "IMG_2.JPG")
    client.post("/api/rating", json={"paths": [f1, f2], "stars": 4}, headers=tok)
    client.post("/api/delete", json={"paths": [f1], "permanent": True}, headers=tok)
    Path(f2).unlink()  # 프로그램 밖에서 지운 파일
    c = client.get("/api/ratings/collect", query_string={"root": str(client.root), "stars": 4}).get_json()
    assert c["photos"] == []
    assert client.get("/api/ratings/summary", query_string={"root": str(client.root)}).get_json()["counts"]["4"] == 0


def test_ratings_prefix_does_not_match_sibling_folder(client, tmp_path):
    tok = {"X-Token": client.mod.TOKEN}
    sib = client.root.parent / (client.root.name + "_백업")
    sib.mkdir()
    Image.new("RGB", (8, 8)).save(sib / "x.jpg")
    client.post("/api/rating", json={"paths": [str(sib / "x.jpg")], "stars": 5}, headers=tok)
    assert client.get("/api/ratings/summary", query_string={"root": str(client.root)}).get_json()["counts"]["5"] == 0


def _jpeg_with_exif(path, gps=True):
    from PIL import Image as Im
    from PIL.TiffImagePlugin import IFDRational as R

    im = Im.new("RGB", (120, 80), (200, 40, 40))
    ex = im.getexif()
    ex[0x010F] = "Canon"
    ex[0x0110] = "Canon EOS R6"
    sub = ex.get_ifd(0x8769)
    sub[0x829A] = R(1, 250)      # 노출 1/250
    sub[0x829D] = R(28, 10)      # f/2.8
    sub[0x8827] = 400            # ISO
    sub[0x920A] = R(50, 1)       # 50mm
    sub[0x9003] = "2024:03:16 10:20:30"
    sub[0xA434] = "RF50mm F1.8 STM"
    if gps:
        g = ex.get_ifd(0x8825)
        g[1], g[2] = "N", (R(33, 1), R(30, 1), R(0, 1))     # 33.5
        g[3], g[4] = "E", (R(126, 1), R(31, 1), R(48, 1))   # 126.53
    im.save(path, exif=ex)


def test_info_exif_and_gps(client):
    f = client.day / "exif.jpg"
    _jpeg_with_exif(f)
    info = client.get("/api/info", query_string={"path": str(f)}).get_json()
    e = info["exif"]
    assert e["model"] == "Canon EOS R6" and e["iso"] == 400 and abs(e["fnumber"] - 2.8) < 1e-6
    assert abs(e["exposure"] - 1 / 250) < 1e-9 and e["focal"] == 50 and e["lens"] == "RF50mm F1.8 STM"
    assert info["taken"] == "2024-03-16 10:20:30"
    assert abs(info["gps"]["lat"] - 33.5) < 1e-6 and abs(info["gps"]["lon"] - 126.53) < 1e-6


def test_info_without_gps_and_histogram(client):
    f = client.day / "nogps.jpg"
    _jpeg_with_exif(f, gps=False)
    assert client.get("/api/info", query_string={"path": str(f)}).get_json()["gps"] is None
    h = client.get("/api/histogram", query_string={"path": str(f)}).get_json()
    assert len(h["r"]) == len(h["g"]) == len(h["b"]) == len(h["l"]) == 256
    assert max(range(256), key=lambda i: h["r"][i]) > 180   # 빨간 사진


def test_folder_size_and_video_listing(client):
    vid = client.day / "clip.mp4"
    vid.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 2000)
    d = client.get("/api/dirs", query_string={"path": str(client.root / "2024")}).get_json()["dirs"][0]
    expected = sum(f.stat().st_size for f in client.day.iterdir() if f.suffix.lower() in (".jpg", ".mp4"))
    assert d["count"] == 4 and d["size"] == expected
    ph = {p["name"]: p for p in client.get("/api/photos", query_string={"path": str(client.day)}).get_json()["photos"]}
    assert ph["clip.mp4"]["video"] is True and ph["IMG_0.JPG"]["video"] is False


def test_video_stream_range_and_client_thumbnail(client):
    import io as _io
    vid = client.day / "clip.mp4"
    vid.write_bytes(bytes(range(256)) * 40)
    r = client.get("/api/video", query_string={"path": str(vid)}, headers={"Range": "bytes=10-19"})
    assert r.status_code == 206 and r.data == bytes(range(10, 20)) and r.mimetype == "video/mp4"
    # 첫 화면이 아직 없으면 404
    assert client.get("/api/thumb", query_string={"path": str(vid), "size": "s"}).status_code == 404
    buf = _io.BytesIO(); Image.new("RGB", (320, 180), (10, 200, 10)).save(buf, "JPEG")
    assert client.post("/api/vthumb", query_string={"path": str(vid)}, data=buf.getvalue()).status_code == 403
    assert client.post("/api/vthumb", query_string={"path": str(vid)}, data=b"not an image",
                       headers={"X-Token": client.mod.TOKEN}).status_code == 400
    assert client.post("/api/vthumb", query_string={"path": str(vid)}, data=buf.getvalue(),
                       headers={"X-Token": client.mod.TOKEN}).get_json()["ok"]
    r = client.get("/api/thumb", query_string={"path": str(vid), "size": "s"})
    assert r.status_code == 200 and r.mimetype == "image/jpeg"
    # 동영상도 삭제·별점 가능
    tok = {"X-Token": client.mod.TOKEN}
    assert client.post("/api/rating", json={"paths": [str(vid)], "stars": 4}, headers=tok).status_code == 200
    assert len(client.post("/api/delete", json={"paths": [str(vid)], "permanent": True}, headers=tok).get_json()["deleted"]) == 1


DATA = Path(__file__).resolve().parent / "data"


def test_video_codec_detection(client):
    import shutil
    for name, codec, hevc in [("hevc_sample.mp4", "HEVC (H.265)", True), ("h264_sample.mp4", "H.264", False)]:
        dst = client.day / name
        shutil.copy(DATA / name, dst)
        v = client.get("/api/info", query_string={"path": str(dst)}).get_json()["video"]
        assert v["videoName"] == codec and v["hevc"] is hevc and v["audioName"] == "AAC"


def test_open_requires_token_and_media(client, monkeypatch):
    opened = []
    monkeypatch.setattr(client.mod.subprocess, "Popen", lambda args: opened.append(args))
    # Windows에서는 os.startfile 로 연다
    monkeypatch.setattr(client.mod.os, "startfile", lambda p: opened.append([p]), raising=False)
    f = str(client.day / "IMG_0.JPG")
    assert client.post("/api/open", json={"path": f}).status_code == 403
    assert client.post("/api/open", json={"path": str(client.day / "memo.txt")}, headers={"X-Token": client.mod.TOKEN}).status_code == 400
    assert client.post("/api/open", json={"path": f}, headers={"X-Token": client.mod.TOKEN}).get_json()["ok"]
    assert opened and opened[0][-1] == f


def test_hevc_thumbnail_and_preview_conversion(client):
    import shutil, time
    if not client.mod.ffmpeg_exe():
        pytest.skip("ffmpeg 없음")
    vid = client.day / "20260904_103455.mp4"
    shutil.copy(DATA / "hevc_sample.mp4", vid)
    # 첫 화면은 서버가 ffmpeg로 바로 만든다
    r = client.get("/api/thumb", query_string={"path": str(vid), "size": "s"})
    assert r.status_code == 200 and r.mimetype == "image/jpeg"
    info = client.get("/api/info", query_string={"path": str(vid)}).get_json()["video"]
    assert info["hevc"] and info["canConvert"] and info["preview"] is False
    assert client.post("/api/preview", query_string={"path": str(vid)}).status_code == 403
    st = client.post("/api/preview", query_string={"path": str(vid)}, headers={"X-Token": client.mod.TOKEN}).get_json()
    assert st["state"] in ("queued", "running", "ready")
    for _ in range(120):
        st = client.get("/api/preview", query_string={"path": str(vid)}).get_json()
        if st["state"] in ("ready", "error"):
            break
        time.sleep(0.25)
    assert st["state"] == "ready", st
    r = client.get("/api/video", query_string={"path": str(vid), "preview": 1}, headers={"Range": "bytes=0-99"})
    assert r.status_code == 206 and r.mimetype == "video/mp4"
    out = client.mod.preview_file(vid)
    assert client.mod.video_codecs(out)["video"] == "avc1"   # H.264로 바뀜
    assert vid.read_bytes() == (DATA / "hevc_sample.mp4").read_bytes()   # 원본 그대로


def test_live_stream_starts_quickly(client):
    import shutil
    if not client.mod.ffmpeg_exe():
        pytest.skip("ffmpeg 없음")
    vid = client.day / "live.mp4"
    shutil.copy(DATA / "hevc_sample.mp4", vid)
    r = client.get("/api/video", query_string={"path": str(vid), "live": 1})
    assert r.status_code == 200 and r.mimetype == "video/mp4" and r.headers["Accept-Ranges"] == "none"
    data = r.get_data()
    assert data[4:8] == b"ftyp" and b"moof" in data          # 조각 MP4
    assert client.mod.video_codecs  # noqa: 존재 확인
    client.mod._stop_live()


def test_reveal_folder_and_file(client, monkeypatch):
    opened = []
    monkeypatch.setattr(client.mod.subprocess, "Popen", lambda args: opened.append(args))
    monkeypatch.setattr(client.mod.os, "startfile", lambda p: opened.append([p]), raising=False)
    tok = {"X-Token": client.mod.TOKEN}
    assert client.post("/api/reveal", json={"path": str(client.day)}).status_code == 403
    assert client.post("/api/reveal", json={"path": str(client.day / "없음")}, headers=tok).status_code == 400
    assert client.post("/api/reveal", json={"path": str(client.day / "memo.txt")}, headers=tok).status_code == 400
    assert client.post("/api/reveal", json={"path": str(client.day)}, headers=tok).get_json()["ok"]
    assert client.post("/api/reveal", json={"path": str(client.day / "IMG_0.JPG")}, headers=tok).get_json()["ok"]
    assert len(opened) == 2


def test_videos_listed_after_photos(client):
    (client.day / "A_clip.mp4").write_bytes(b"\x00" * 100)      # 이름은 사진보다 앞이지만
    (client.day / "Z_photo.jpg").write_bytes((client.day / "IMG_0.JPG").read_bytes())
    names = [p["name"] for p in client.get("/api/photos", query_string={"path": str(client.day)}).get_json()["photos"]]
    assert names == ["IMG_0.JPG", "IMG_1.JPG", "IMG_2.JPG", "Z_photo.jpg", "A_clip.mp4"]
    tok = {"X-Token": client.mod.TOKEN}
    client.post("/api/rating", json={"paths": [str(client.day / "A_clip.mp4"), str(client.day / "Z_photo.jpg")], "stars": 5}, headers=tok)
    c = client.get("/api/ratings/collect", query_string={"root": str(client.root), "stars": 5}).get_json()
    assert [p["name"] for p in c["photos"]] == ["Z_photo.jpg", "A_clip.mp4"]


def test_editor_launch(client, tmp_path, monkeypatch):
    launched = []
    monkeypatch.setattr(client.mod.subprocess, "Popen", lambda cmd, **kw: launched.append(cmd))
    monkeypatch.setattr(client.mod, "SETTINGS_FILE", tmp_path / "settings.json")
    # 서브모듈이 없는 환경(GitHub 빌드 등)에서도 시험할 수 있게 가짜 video_editor/main.py 를 둔다
    src = tmp_path / "src"
    (src / "video_editor").mkdir(parents=True)
    (src / "video_editor" / "main.py").write_text("print('editor')")
    monkeypatch.setattr(client.mod, "SRC_DIR", src)
    tok = {"X-Token": client.mod.TOKEN}
    assert client.post("/api/editor", json={}).status_code == 403
    # 저장소의 video_editor/main.py 를 같은 파이썬으로 실행
    assert client.post("/api/editor", json={}, headers=tok).get_json()["ok"]
    assert launched[-1][-1].endswith(os.path.join("video_editor", "main.py"))
    vid = client.day / "clip.mp4"
    vid.write_bytes(b"\x00" * 10)
    client.post("/api/editor", json={"path": str(vid)}, headers=tok)
    assert launched[-1][-1] == str(vid)
    assert client.post("/api/editor", json={"path": str(client.day / "IMG_0.JPG")}, headers=tok).status_code == 400
    # 설정에 직접 지정한 프로그램이 우선
    exe = tmp_path / "MyEditor.exe"
    exe.write_bytes(b"")
    client.mod.save_settings({"editorPath": str(exe)})
    client.post("/api/editor", json={}, headers=tok)
    assert launched[-1] == [str(exe)]
    # 못 찾으면 404
    monkeypatch.setattr(client.mod, "find_editor", lambda: None)
    assert client.post("/api/editor", json={}, headers=tok).status_code == 404


def _make_video(path, size="640x360", crf=2, dur=3, extra=()):
    import subprocess as sp
    sp.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=30:duration={dur}",
            "-f", "lavfi", "-i", f"sine=duration={dur}", "-c:v", "libx264", "-crf", str(crf), "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest", *extra, str(path)], check=True)


def _wait_jobs(client, timeout=120):
    import time
    for _ in range(int(timeout / 0.3)):
        jobs = client.get("/api/compress").get_json()["jobs"]
        if jobs and all(j["state"] not in ("queued", "running", "cancelling") for j in jobs):
            return jobs
        time.sleep(0.3)
    raise AssertionError(jobs)


needs_ffmpeg = pytest.mark.skipif(not __import__("shutil").which("ffmpeg"), reason="ffmpeg 없음")


@needs_ffmpeg
def test_compress_h264_smaller_keeps_original_and_date(client):
    src = client.day / "big.mp4"
    _make_video(src, crf=2)
    old_mtime = src.stat().st_mtime - 86400
    os.utime(src, (old_mtime, old_mtime))
    tok = {"X-Token": client.mod.TOKEN}
    pr = client.get("/api/vprobe", query_string={"path": str(src)}).get_json()
    assert pr["width"] == 640 and pr["height"] == 360 and abs(pr["duration"] - 3) < 0.2 and pr["vcodec"] == "h264"
    assert client.post("/api/compress", json={"paths": [str(src)]}).status_code == 403
    client.post("/api/compress", json={"paths": [str(src)], "codec": "h264", "quality": "mid", "scale": "orig"}, headers=tok)
    j = _wait_jobs(client)[0]
    assert j["state"] == "done", j
    out = Path(j["out_path"])
    assert out.name == "big_작게.mp4" and src.exists()                     # 원본은 그대로
    assert j["out_size"] < j["src_size"] and out.stat().st_size == j["out_size"]
    assert abs(out.stat().st_mtime - old_mtime) < 2                         # 파일 날짜 유지
    client.post("/api/compress/clear", headers=tok)
    assert client.get("/api/compress").get_json()["jobs"] == []


@needs_ffmpeg
def test_compress_no_gain_discards_output(client):
    src = client.day / "tiny.mp4"
    _make_video(src, size="160x90", crf=45, dur=2)
    tok = {"X-Token": client.mod.TOKEN}
    client.post("/api/compress", json={"paths": [str(src)], "quality": "high"}, headers=tok)
    j = _wait_jobs(client)[0]
    assert j["state"] == "nogain" and not (client.day / "tiny_작게.mp4").exists()


@needs_ffmpeg
def test_compress_replace_hevc_scale_and_rating(client, monkeypatch):
    trashed = []
    monkeypatch.setattr(client.mod, "send2trash", lambda p: (trashed.append(p), Path(p).unlink()))
    src = client.day / "phone.mp4"
    _make_video(src, size="1080x1920", crf=4, dur=2)
    tok = {"X-Token": client.mod.TOKEN}
    client.post("/api/rating", json={"paths": [str(src)], "stars": 5}, headers=tok)
    client.post("/api/compress", json={"paths": [str(src)], "codec": "hevc", "quality": "mid", "scale": "720",
                                       "replace": True}, headers=tok)
    j = _wait_jobs(client, 240)[0]
    assert j["state"] == "done", j
    assert trashed == [str(src)] and j["out_path"] == str(src) and src.exists()   # 원본 이름을 이어받음
    v = client.mod.video_codecs(src)
    assert v["video"] == "hvc1"
    pr = client.mod.probe_video(src)
    assert (pr["width"], pr["height"]) == (720, 1280)                        # 짧은 변 720
    ph = {p["name"]: p["rating"] for p in client.get("/api/photos", query_string={"path": str(client.day)}).get_json()["photos"]}
    assert ph["phone.mp4"] == 5                                              # 별점 유지


@needs_ffmpeg
def test_compress_cancel(client):
    src = client.day / "long.mp4"
    _make_video(src, size="1920x1080", crf=2, dur=20)
    tok = {"X-Token": client.mod.TOKEN}
    client.post("/api/compress", json={"paths": [str(src)], "codec": "hevc"}, headers=tok)
    import time
    for _ in range(50):
        if client.get("/api/compress").get_json()["jobs"][0]["state"] == "running":
            break
        time.sleep(0.1)
    client.post("/api/compress/cancel", json={"path": str(src)}, headers=tok)
    j = _wait_jobs(client)[0]
    assert j["state"] == "cancelled"
    assert not list(client.day.glob("long_작게*"))                            # 만들다 만 파일 정리
