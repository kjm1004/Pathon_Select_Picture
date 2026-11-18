"""사진 정리 — 날짜별 폴더의 사진을 보면서 직접 골라 삭제하는 로컬 프로그램.

실행:  python app.py [--root "E:\\사진"] [--port 8765] [--no-browser]
브라우저에서 http://127.0.0.1:8765 이 열립니다. 서버는 이 PC(127.0.0.1)에서만 접속됩니다.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import os
import secrets
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

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
CACHE_DIR = Path(os.environ.get("PHOTO_CLEANER_CACHE", Path.home() / ".photo-cleaner" / "cache"))

# 미리보기를 만들 수 있는 형식
VIEWABLE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tif", ".tiff"}
if HEIF_OK:
    VIEWABLE_EXT |= {".heic", ".heif"}
# 목록에는 보이지만 미리보기는 없는 형식(RAW 등)
LIST_ONLY_EXT = {".heic", ".heif", ".cr2", ".cr3", ".nef", ".arw", ".dng", ".orf", ".rw2", ".raf"} - VIEWABLE_EXT
PHOTO_EXT = VIEWABLE_EXT | LIST_ONLY_EXT

THUMB_SIZES = {"s": 160, "m": 360, "l": 1600}
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


def count_photos(folder: Path) -> int:
    n = 0
    try:
        with os.scandir(folder) as it:
            for e in it:
                if e.is_file(follow_symlinks=False) and is_photo(e.name):
                    n += 1
    except OSError:
        pass
    return n


def has_subdirs(folder: Path) -> bool:
    try:
        with os.scandir(folder) as it:
            for e in it:
                if e.is_dir(follow_symlinks=False) and not is_hidden(e):
                    return True
    except OSError:
        pass
    return False


def list_roots() -> list[dict]:
    roots = []
    start = app.config.get("START_ROOT")
    if start:
        roots.append({"name": str(start), "path": str(start)})
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
    except Exception:
        pass
    return info


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
    start = app.config.get("START_ROOT")
    return jsonify(roots=list_roots(), start=str(start) if start else None)


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
        dirs.append({"name": e.name, "path": str(p), "count": count_photos(p), "hasChildren": has_subdirs(p)})
    return jsonify(path=str(folder), dirs=dirs, disk=disk_usage(folder))


@app.get("/api/photos")
def api_photos():
    folder = safe_path(request.args.get("path"))
    if not folder.is_dir():
        abort(400, "폴더가 아닙니다")
    photos = []
    with os.scandir(folder) as it:
        entries = [e for e in it if e.is_file(follow_symlinks=False) and is_photo(e.name)]
    for e in sorted(entries, key=lambda e: e.name.lower()):
        st = e.stat()
        photos.append(
            {
                "name": e.name,
                "path": e.path,
                "size": st.st_size,
                "mtime": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
                "viewable": Path(e.name).suffix.lower() in VIEWABLE_EXT,
            }
        )
    return jsonify(path=str(folder), photos=photos)


@app.get("/api/thumb")
def api_thumb():
    path = safe_path(request.args.get("path"))
    size_key = request.args.get("size", "s")
    if size_key not in THUMB_SIZES:
        abort(400, "size는 s, m, l 중 하나입니다")
    if not path.is_file() or path.suffix.lower() not in VIEWABLE_EXT:
        abort(415, "미리보기를 만들 수 없는 형식입니다")
    try:
        out = make_thumb(path, size_key)
    except Exception:
        abort(415, "이미지를 읽을 수 없습니다")
    resp = send_file(out, mimetype="image/jpeg")
    resp.headers["Cache-Control"] = "private, max-age=86400"
    return resp


@app.get("/api/info")
def api_info():
    path = safe_path(request.args.get("path"))
    if not path.is_file():
        abort(400, "파일이 아닙니다")
    return jsonify(read_info(path))


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
    return jsonify(deleted=done, failed=failed, freed=sum(d["size"] for d in done))


# ---------------------------------------------------------------- 실행

def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="사진 정리 프로그램")
    ap.add_argument("--root", help="처음 열 사진 폴더 (예: E:\\사진)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true", help="브라우저를 자동으로 열지 않음")
    args = ap.parse_args(argv)

    if args.root:
        root = Path(args.root).expanduser()
        if not root.is_dir():
            sys.exit(f"폴더를 찾을 수 없습니다: {root}")
        app.config["START_ROOT"] = root.resolve()

    url = f"http://127.0.0.1:{args.port}/"
    print(f"사진 정리 실행 중: {url}  (종료: Ctrl+C)")
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=args.port, threaded=True, debug=False)


if __name__ == "__main__":
    main()
