"""사진 정리 — 날짜별 폴더의 사진을 보면서 직접 골라 삭제하는 프로그램.

실행:  python app.py                 별도 프로그램 창으로 실행 (기본)
       python app.py --browser       예전처럼 웹 브라우저로 실행
       python app.py --root "E:\\사진"  처음 열 폴더 지정 (지정하지 않으면 마지막 작업 폴더)
화면은 내부 서버(127.0.0.1, 이 PC에서만 접속)가 그립니다.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
import os
import secrets
import sqlite3
import string
import sys
import threading
import webbrowser
from datetime import datetime
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_file, send_from_directory
from PIL import ExifTags, Image, ImageOps

try:  # HEIC(아이폰 사진) 지원은 선택 사항
    from pillow_heif import register_heif_opener

    register_heif_opener()
    HEIF_OK = True
except Exception:  # pragma: no cover
    HEIF_OK = False

from send2trash import send2trash

# PyInstaller로 만든 exe에서는 static 폴더가 임시 압축 해제 폴더에 있다
BASE_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = Path(os.environ.get("PHOTO_CLEANER_HOME", Path.home() / ".photo-cleaner"))
CACHE_DIR = Path(os.environ.get("PHOTO_CLEANER_CACHE", DATA_DIR / "cache"))
SETTINGS_FILE = DATA_DIR / "settings.json"
RATINGS_DB = DATA_DIR / "ratings.db"
DEFAULT_SETTINGS = {"root": None, "folder": None, "photo": None, "view": "single", "nup": 2, "gridSize": "m", "sidebar": True, "smooth": 2, "defaultStars": 3, "indexBar": True, "indexSize": "m", "infoPanel": False}

# 미리보기를 만들 수 있는 형식
VIEWABLE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tif", ".tiff"}
if HEIF_OK:
    VIEWABLE_EXT |= {".heic", ".heif"}
# 목록에는 보이지만 미리보기는 없는 형식(RAW 등)
LIST_ONLY_EXT = {".heic", ".heif", ".cr2", ".cr3", ".nef", ".arw", ".dng", ".orf", ".rw2", ".raf"} - VIEWABLE_EXT
# 동영상: 목록·삭제·별점은 사진과 같고, 재생은 화면(브라우저 엔진)이 직접 한다
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".3gp", ".mts", ".m2ts", ".wmv"}
VIDEO_MIME = {".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/mp4", ".webm": "video/webm", ".mkv": "video/webm",
              ".3gp": "video/3gpp", ".avi": "video/x-msvideo", ".mts": "video/mp2t", ".m2ts": "video/mp2t", ".wmv": "video/x-ms-wmv"}
PHOTO_EXT = VIEWABLE_EXT | LIST_ONLY_EXT | VIDEO_EXT   # 목록에 나오는 모든 파일 (사진 + 동영상)


def is_video(name: str) -> bool:
    return Path(name).suffix.lower() in VIDEO_EXT

THUMB_SIZES = {"s": 160, "m": 360, "l": 1600, "x": 2560}
TOKEN = secrets.token_urlsafe(24)

app = Flask(__name__, static_folder=None)
app.config["START_ROOT"] = None


# ---------------------------------------------------------------- 유틸

def is_photo(name: str) -> bool:
    return Path(name).suffix.lower() in PHOTO_EXT


def is_hidden(entry: os.DirEntry) -> bool:
    name = entry.name
    if name.startswith(".") or name.startswith("$") or name.lower() in {"system volume information"}:
        return True
    return False


def safe_path(raw: str | None) -> Path:
    """클라이언트가 보낸 경로를 절대 경로로 정리하고 존재 여부를 확인한다."""
    if not raw:
        abort(400, "path가 필요합니다")
    p = Path(raw)
    if not p.is_absolute():
        abort(400, "절대 경로만 허용됩니다")
    try:
        p = p.resolve(strict=True)
    except (OSError, RuntimeError):
        abort(404, "경로를 찾을 수 없습니다")
    return p


def count_photos(folder: Path) -> tuple[int, int]:
    """폴더 바로 안의 사진·동영상 개수와 전체 크기(바이트)."""
    n = size = 0
    try:
        with os.scandir(folder) as it:
            for e in it:
                if e.is_file(follow_symlinks=False) and is_photo(e.name):
                    n += 1
                    try:
                        size += e.stat().st_size
                    except OSError:
                        pass
    except OSError:
        pass
    return n, size


def has_subdirs(folder: Path) -> bool:
    try:
        with os.scandir(folder) as it:
            for e in it:
                if e.is_dir(follow_symlinks=False) and not is_hidden(e):
                    return True
    except OSError:
        pass
    return False


# ---------------------------------------------------------------- 별점 저장소
# 사진 파일은 건드리지 않고 별점만 따로 기록한다. key는 대소문자/구분자를 정리한 경로.

def rkey(path: str) -> str:
    return os.path.normcase(os.path.normpath(str(path)))


def ratings_db() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(RATINGS_DB, timeout=10)
    con.execute(
        "CREATE TABLE IF NOT EXISTS ratings ("
        " key TEXT PRIMARY KEY, path TEXT NOT NULL, dir TEXT NOT NULL,"
        " stars INTEGER NOT NULL, updated TEXT NOT NULL)"
    )
    con.execute("CREATE INDEX IF NOT EXISTS ratings_dir ON ratings(dir)")
    return con


def ratings_in_dir(folder: Path) -> dict:
    with ratings_db() as con:
        rows = con.execute("SELECT key, stars FROM ratings WHERE dir = ?", (rkey(folder),)).fetchall()
    return dict(rows)


def like_prefix(root: str) -> str:
    """root 아래 모든 경로에 맞는 LIKE 패턴 (%, _ 는 이스케이프)."""
    k = rkey(root)
    if not k.endswith(os.sep):
        k += os.sep
    return k.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def remove_ratings(paths: list[str]) -> None:
    if not paths:
        return
    with ratings_db() as con:
        con.executemany("DELETE FROM ratings WHERE key = ?", [(rkey(p),) for p in paths])


def photo_entry(path: str, st: os.stat_result, rating: int = 0) -> dict:
    name = os.path.basename(path)
    return {
        "name": name,
        "path": path,
        "size": st.st_size,
        "mtime": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
        "viewable": Path(name).suffix.lower() in VIEWABLE_EXT,
        "video": is_video(name),
        "rating": rating,
    }


def load_settings() -> dict:
    data = dict(DEFAULT_SETTINGS)
    try:
        saved = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        if isinstance(saved, dict):
            data.update({k: v for k, v in saved.items() if k in DEFAULT_SETTINGS})
    except (OSError, ValueError):
        pass
    return data


def save_settings(changes: dict) -> dict:
    data = load_settings()
    data.update({k: v for k, v in changes.items() if k in DEFAULT_SETTINGS})
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, SETTINGS_FILE)
    return data


def start_root() -> str | None:
    """처음 열 폴더: --root 지정 > 마지막 작업 드라이브/폴더."""
    start = app.config.get("START_ROOT")
    if start:
        return str(start)
    saved = load_settings().get("root")
    if saved and os.path.isdir(saved):
        return saved
    return None


def list_roots() -> list[dict]:
    roots = []
    start = start_root()
    if start:
        roots.append({"name": start, "path": start})
    if os.name == "nt":
        for letter in string.ascii_uppercase:
            d = f"{letter}:\\"
            if os.path.exists(d):
                roots.append({"name": f"{letter}: 드라이브", "path": d})
    else:
        roots.append({"name": "/", "path": "/"})
        for base in ("/media", "/mnt", "/Volumes", str(Path.home())):
            if os.path.isdir(base):
                roots.append({"name": base, "path": base})
    seen, out = set(), []
    for r in roots:
        if r["path"] not in seen:
            seen.add(r["path"])
            out.append(r)
    return out


def disk_usage(path: Path) -> dict | None:
    try:
        import shutil

        u = shutil.disk_usage(path)
        return {"total": u.total, "used": u.used, "free": u.free}
    except OSError:
        return None


def cache_file(path: Path, size_key: str) -> Path:
    st = path.stat()
    key = f"{path}|{st.st_mtime_ns}|{st.st_size}|{size_key}".encode("utf-8", "surrogatepass")
    h = hashlib.sha1(key).hexdigest()
    return CACHE_DIR / h[:2] / f"{h}.jpg"


def make_thumb(path: Path, size_key: str) -> Path:
    out = cache_file(path, size_key)
    if out.exists():
        return out
    px = THUMB_SIZES[size_key]
    with Image.open(path) as im:
        im.draft("RGB", (px * 2, px * 2))  # JPEG는 축소 디코딩으로 빠르게
        im = ImageOps.exif_transpose(im)
        im.thumbnail((px, px), Image.LANCZOS)
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(".tmp")
        im.save(tmp, "JPEG", quality=85 if size_key != "l" else 90)
        os.replace(tmp, out)
    return out


EXIF_TAGS = {v: k for k, v in ExifTags.TAGS.items()}


def read_info(path: Path) -> dict:
    st = path.stat()
    info = {
        "name": path.name,
        "path": str(path),
        "size": st.st_size,
        "mtime": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
        "taken": None,
        "camera": None,
        "width": None,
        "height": None,
    }
    if path.suffix.lower() not in VIEWABLE_EXT:
        return info
    try:
        with Image.open(path) as im:
            w, h = im.size
            exif = im.getexif()
            orient = exif.get(EXIF_TAGS["Orientation"], 1)
            if orient in (5, 6, 7, 8):
                w, h = h, w
            info["width"], info["height"] = w, h
            make = (exif.get(EXIF_TAGS["Make"]) or "").strip()
            model = (exif.get(EXIF_TAGS["Model"]) or "").strip()
            if model:
                if not make or model.lower().startswith(make.lower()):
                    info["camera"] = model
                else:
                    info["camera"] = f"{make} {model}"
            sub = exif.get_ifd(0x8769) if hasattr(exif, "get_ifd") else {}
            taken = sub.get(EXIF_TAGS["DateTimeOriginal"]) or exif.get(EXIF_TAGS["DateTime"])
            if taken:
                info["taken"] = str(taken).replace(":", "-", 2)
            info["exif"] = exif_details(exif, sub)
            info["gps"] = gps_details(exif.get_ifd(0x8825) if hasattr(exif, "get_ifd") else {})
            info["format"] = im.format
            info["mode"] = im.mode
    except Exception:
        pass
    return info


def _num(v):
    """EXIF 숫자(분수 포함)를 float로. 실패하면 None."""
    try:
        if isinstance(v, tuple) and len(v) == 2:
            return float(v[0]) / float(v[1]) if v[1] else None
        return float(v)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _text(v):
    if v is None:
        return None
    if isinstance(v, bytes):
        v = v.decode("utf-8", "ignore")
    v = str(v).replace("\x00", "").strip()
    return v or None


def exif_details(ifd0, sub) -> dict:
    """촬영 정보: 화면에서 읽기 좋은 값만 골라 보낸다."""
    t = EXIF_TAGS
    out = {
        "make": _text(ifd0.get(t["Make"])),
        "model": _text(ifd0.get(t["Model"])),
        "software": _text(ifd0.get(t["Software"])),
        "orientation": ifd0.get(t["Orientation"]),
        "lens": _text(sub.get(t["LensModel"])) or _text(sub.get(t.get("LensMake", 0))),
        "exposure": _num(sub.get(t["ExposureTime"])),
        "fnumber": _num(sub.get(t["FNumber"])),
        "iso": sub.get(t["ISOSpeedRatings"]),
        "focal": _num(sub.get(t["FocalLength"])),
        "focal35": sub.get(t["FocalLengthIn35mmFilm"]),
        "bias": _num(sub.get(t["ExposureBiasValue"])),
        "flash": sub.get(t["Flash"]),
        "whiteBalance": sub.get(t["WhiteBalance"]),
        "program": sub.get(t["ExposureProgram"]),
        "metering": sub.get(t["MeteringMode"]),
    }
    if isinstance(out["iso"], (tuple, list)):
        out["iso"] = out["iso"][0] if out["iso"] else None
    return {k: v for k, v in out.items() if v not in (None, "")}


def gps_details(g) -> dict | None:
    """GPS 정보를 십진수 위도/경도로. 없으면 None."""
    if not g or 2 not in g or 4 not in g:
        return None

    def dms(v, ref):
        try:
            d, m, sec = (_num(x) for x in v)
            val = d + m / 60 + sec / 3600
        except (TypeError, ValueError):
            val = _num(v)
        if val is None:
            return None
        ref = _text(ref) or ""
        return -val if ref.upper() in ("S", "W") else val

    lat, lon = dms(g.get(2), g.get(1)), dms(g.get(4), g.get(3))
    if lat is None or lon is None or (lat == 0 and lon == 0) or abs(lat) > 90 or abs(lon) > 180:
        return None
    alt = _num(g.get(6))
    if alt is not None and g.get(5) in (1, b"\x01"):
        alt = -alt
    return {"lat": round(lat, 7), "lon": round(lon, 7), "alt": round(alt, 1) if alt is not None else None}


def histogram(path: Path) -> dict:
    """중간 크기 썸네일로 RGB / 밝기 히스토그램(각 256칸)을 계산한다."""
    thumb = make_thumb(path, "m")
    with Image.open(thumb) as im:
        im = im.convert("RGB")
        h = im.histogram()
        lum = im.convert("L").histogram()
    return {"r": h[0:256], "g": h[256:512], "b": h[512:768], "l": lum}


# ---------------------------------------------------------------- 보안

@app.before_request
def check_token():
    if request.path.startswith("/api/") and request.method != "GET":
        if request.headers.get("X-Token") != TOKEN:
            abort(403, "잘못된 요청입니다")


@app.errorhandler(400)
@app.errorhandler(403)
@app.errorhandler(404)
@app.errorhandler(415)
def json_error(e):
    return jsonify(error=getattr(e, "description", str(e))), e.code


# ---------------------------------------------------------------- 화면

@app.get("/")
def index():
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    return html.replace("__TOKEN__", TOKEN), 200, {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"}


@app.get("/static/<path:name>")
def static_files(name):
    return send_from_directory(STATIC_DIR, name)


# ---------------------------------------------------------------- API

@app.get("/api/roots")
def api_roots():
    return jsonify(roots=list_roots(), start=start_root(), desktop=bool(app.config.get("DESKTOP")))


@app.get("/api/settings")
def api_settings_get():
    data = load_settings()
    if app.config.get("START_ROOT"):  # --root 로 시작하면 그 폴더를 우선
        root = str(app.config["START_ROOT"])
        if data.get("root") != root:
            data.update(root=root, folder=None, photo=None)
    return jsonify(data)


@app.post("/api/settings")
def api_settings_post():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        abort(400, "잘못된 설정입니다")
    return jsonify(save_settings(data))


@app.get("/api/dirs")
def api_dirs():
    folder = safe_path(request.args.get("path"))
    if not folder.is_dir():
        abort(400, "폴더가 아닙니다")
    dirs = []
    try:
        with os.scandir(folder) as it:
            entries = [e for e in it if e.is_dir(follow_symlinks=False) and not is_hidden(e)]
    except PermissionError:
        abort(403, "폴더에 접근할 수 없습니다")
    for e in sorted(entries, key=lambda e: e.name.lower()):
        p = Path(e.path)
        count, size = count_photos(p)
        dirs.append({"name": e.name, "path": str(p), "count": count, "size": size, "hasChildren": has_subdirs(p)})
    return jsonify(path=str(folder), dirs=dirs, disk=disk_usage(folder))


@app.get("/api/photos")
def api_photos():
    folder = safe_path(request.args.get("path"))
    if not folder.is_dir():
        abort(400, "폴더가 아닙니다")
    with os.scandir(folder) as it:
        entries = [e for e in it if e.is_file(follow_symlinks=False) and is_photo(e.name)]
    stars = ratings_in_dir(folder)
    photos = [photo_entry(e.path, e.stat(), stars.get(rkey(e.path), 0)) for e in sorted(entries, key=lambda e: e.name.lower())]
    return jsonify(path=str(folder), photos=photos)


@app.post("/api/rating")
def api_rating():
    """별점 매기기. stars 0 = 별점 지우기(기본 별점으로 돌아감)."""
    data = request.get_json(silent=True) or {}
    paths, stars = data.get("paths") or [], data.get("stars")
    if not isinstance(paths, list) or not paths or stars not in (0, 1, 2, 3, 4, 5):
        abort(400, "잘못된 별점 요청입니다")
    now = datetime.now().isoformat(timespec="seconds")
    rows = []
    for raw in paths:
        p = Path(str(raw))
        if not p.is_absolute() or not p.is_file() or not is_photo(p.name):
            abort(400, f"사진 파일이 아닙니다: {raw}")
        rows.append((rkey(p), str(p), rkey(p.parent), stars, now))
    with ratings_db() as con:
        if stars == 0:
            con.executemany("DELETE FROM ratings WHERE key = ?", [(r[0],) for r in rows])
        else:
            con.executemany(
                "INSERT INTO ratings(key, path, dir, stars, updated) VALUES (?,?,?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET path=excluded.path, dir=excluded.dir, stars=excluded.stars, updated=excluded.updated",
                rows,
            )
    return jsonify(ok=True, stars=stars, count=len(rows))


@app.get("/api/ratings/summary")
def api_ratings_summary():
    """root 아래에서 별점을 매긴 사진 수 (별점별)."""
    root = safe_path(request.args.get("root"))
    with ratings_db() as con:
        rows = con.execute(
            "SELECT stars, COUNT(*) FROM ratings WHERE key LIKE ? ESCAPE '\\' GROUP BY stars", (like_prefix(str(root)),)
        ).fetchall()
    counts = {str(n): 0 for n in range(1, 6)}
    counts.update({str(k): v for k, v in rows})
    return jsonify(root=str(root), counts=counts)


@app.get("/api/ratings/collect")
def api_ratings_collect():
    """root 아래에서 같은 별점의 사진을 모두 모은다. 없어진 파일은 기록에서 지운다."""
    root = safe_path(request.args.get("root"))
    try:
        stars = int(request.args.get("stars", ""))
    except ValueError:
        abort(400, "stars가 필요합니다")
    with ratings_db() as con:
        rows = con.execute(
            "SELECT path FROM ratings WHERE stars = ? AND key LIKE ? ESCAPE '\\' ORDER BY path",
            (stars, like_prefix(str(root))),
        ).fetchall()
    photos, missing = [], []
    for (path,) in rows:
        try:
            st = os.stat(path)
        except OSError:
            missing.append(path)
            continue
        e = photo_entry(path, st, stars)
        e["dir"] = os.path.basename(os.path.dirname(path))
        photos.append(e)
    remove_ratings(missing)
    return jsonify(root=str(root), stars=stars, photos=photos)


@app.get("/api/thumb")
def api_thumb():
    path = safe_path(request.args.get("path"))
    size_key = request.args.get("size", "s")
    if size_key not in THUMB_SIZES:
        abort(400, "size는 s, m, l, x 중 하나입니다")
    if path.is_file() and is_video(path.name):
        # 동영상 첫 화면은 화면 쪽에서 만들어 올려 둔 것을 쓴다 (없으면 404 → 화면이 만들어 올림)
        out = cache_file(path, "v")
        if not out.exists():
            abort(404, "동영상 첫 화면이 아직 없습니다")
        resp = send_file(out, mimetype="image/jpeg")
        resp.headers["Cache-Control"] = "no-cache"
        return resp
    if not path.is_file() or path.suffix.lower() not in VIEWABLE_EXT:
        abort(415, "미리보기를 만들 수 없는 형식입니다")
    try:
        out = make_thumb(path, size_key)
    except Exception:
        abort(415, "이미지를 읽을 수 없습니다")
    resp = send_file(out, mimetype="image/jpeg")
    resp.headers["Cache-Control"] = "private, max-age=86400"
    return resp


# 브라우저가 직접 그릴 수 있는 형식은 확대할 때 원본을 그대로 보낸다
BROWSER_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}


@app.get("/api/original")
def api_original():
    path = safe_path(request.args.get("path"))
    if not path.is_file() or path.suffix.lower() not in VIEWABLE_EXT:
        abort(415, "미리보기를 만들 수 없는 형식입니다")
    if path.suffix.lower() not in BROWSER_EXT:  # TIFF, HEIC 등은 큰 JPEG로 변환
        return api_thumb_for(path, "x")
    resp = send_file(path, conditional=True)
    resp.headers["Cache-Control"] = "private, max-age=86400"
    return resp


def api_thumb_for(path: Path, size_key: str):
    try:
        out = make_thumb(path, size_key)
    except Exception:
        abort(415, "이미지를 읽을 수 없습니다")
    resp = send_file(out, mimetype="image/jpeg")
    resp.headers["Cache-Control"] = "private, max-age=86400"
    return resp


@app.get("/api/video")
def api_video():
    """동영상 파일 그대로 (구간 요청 지원 → 재생 바로 이동 가능)."""
    path = safe_path(request.args.get("path"))
    if not path.is_file() or not is_video(path.name):
        abort(415, "동영상 파일이 아닙니다")
    resp = send_file(path, mimetype=VIDEO_MIME.get(path.suffix.lower(), "application/octet-stream"), conditional=True)
    resp.headers["Cache-Control"] = "private, max-age=3600"
    return resp


@app.post("/api/vthumb")
def api_vthumb():
    """화면이 동영상에서 뽑은 첫 화면(JPEG)을 썸네일 캐시에 저장한다."""
    path = safe_path(request.args.get("path"))
    if not path.is_file() or not is_video(path.name):
        abort(415, "동영상 파일이 아닙니다")
    data = request.get_data(cache=False)
    if not data or len(data) > 5 * 1024 * 1024:
        abort(400, "잘못된 이미지입니다")
    try:
        with Image.open(io.BytesIO(data)) as im:
            im = im.convert("RGB")
            im.thumbnail((640, 640))
            out = cache_file(path, "v")
            out.parent.mkdir(parents=True, exist_ok=True)
            tmp = out.with_suffix(".tmp")
            im.save(tmp, "JPEG", quality=85)
            os.replace(tmp, out)
    except Exception:
        abort(400, "잘못된 이미지입니다")
    return jsonify(ok=True)


@app.get("/api/info")
def api_info():
    path = safe_path(request.args.get("path"))
    if not path.is_file():
        abort(400, "파일이 아닙니다")
    return jsonify(read_info(path))


@app.get("/api/histogram")
def api_histogram():
    path = safe_path(request.args.get("path"))
    if not path.is_file() or path.suffix.lower() not in VIEWABLE_EXT:
        abort(415, "히스토그램을 만들 수 없는 형식입니다")
    try:
        return jsonify(histogram(path))
    except Exception:
        abort(415, "이미지를 읽을 수 없습니다")


@app.post("/api/delete")
def api_delete():
    data = request.get_json(silent=True) or {}
    paths = data.get("paths") or []
    permanent = bool(data.get("permanent"))
    if not isinstance(paths, list) or not paths:
        abort(400, "삭제할 파일이 없습니다")
    done, failed = [], []
    for raw in paths:
        try:
            p = Path(str(raw))
            if not p.is_absolute() or not p.is_file() or not is_photo(p.name):
                raise ValueError("사진 파일이 아닙니다")
            size = p.stat().st_size
            if permanent:
                p.unlink()
            else:
                send2trash(str(p))
            done.append({"path": str(p), "size": size})
        except Exception as ex:  # 한 장이 실패해도 나머지는 계속
            failed.append({"path": str(raw), "error": str(ex)})
    remove_ratings([d["path"] for d in done])
    return jsonify(deleted=done, failed=failed, freed=sum(d["size"] for d in done))


# ---------------------------------------------------------------- 실행

class DesktopApi:
    """화면(JS)에서 window.pywebview.api.* 로 부르는 기능."""

    def __init__(self):
        self._window = None
        self._fullscreen = False

    def pick_folder(self):
        import webview

        kind = getattr(getattr(webview, "FileDialog", None), "FOLDER", None) or webview.FOLDER_DIALOG
        result = self._window.create_file_dialog(kind)
        if not result:
            return None
        return result[0] if isinstance(result, (list, tuple)) else str(result)

    def open_url(self, url):
        """지도 링크 등을 기본 웹 브라우저로 연다 (https만)."""
        url = str(url)
        if url.startswith("https://"):
            webbrowser.open(url)
            return True
        return False

    def set_fullscreen(self, on):
        on = bool(on)
        if on != self._fullscreen:
            self._window.toggle_fullscreen()
            self._fullscreen = on
        return self._fullscreen


def redirect_output_if_windowless() -> None:
    """pythonw / exe(창 모드)에서는 콘솔이 없으므로 로그를 파일로 보낸다."""
    if sys.stdout is None or sys.stderr is None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        log = open(DATA_DIR / "app.log", "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stdout or log
        sys.stderr = sys.stderr or log


def run_desktop() -> bool:
    try:
        import webview
    except ImportError:
        print("pywebview가 설치되지 않아 웹 브라우저로 실행합니다. (pip install pywebview)")
        return False
    from werkzeug.serving import make_server

    app.config["DESKTOP"] = True
    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    server = make_server("127.0.0.1", 0, app, threaded=True)  # 빈 포트 자동 선택
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/"

    api = DesktopApi()
    api._window = webview.create_window(
        "사진 정리", url, js_api=api, width=1440, height=900, min_size=(960, 640), background_color="#121417"
    )
    webview.start()
    server.shutdown()
    return True


def main(argv: list[str] | None = None) -> None:
    redirect_output_if_windowless()
    ap = argparse.ArgumentParser(description="사진 정리 프로그램")
    ap.add_argument("--root", help="처음 열 사진 폴더 (예: E:\\사진). 생략하면 마지막 작업 폴더")
    ap.add_argument("--browser", action="store_true", help="별도 창 대신 웹 브라우저로 실행")
    ap.add_argument("--port", type=int, default=8765, help="브라우저 모드 포트 (기본 8765)")
    ap.add_argument("--no-browser", action="store_true", help="브라우저 모드에서 브라우저를 자동으로 열지 않음")
    args = ap.parse_args(argv)

    if args.root:
        root = Path(args.root).expanduser()
        if not root.is_dir():
            sys.exit(f"폴더를 찾을 수 없습니다: {root}")
        app.config["START_ROOT"] = root.resolve()

    if not args.browser and run_desktop():
        return

    url = f"http://127.0.0.1:{args.port}/"
    print(f"사진 정리 실행 중: {url}  (종료: Ctrl+C)")
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=args.port, threaded=True, debug=False)


if __name__ == "__main__":
    main()
