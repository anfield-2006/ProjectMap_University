"""
ArriveWise local server.

  python server.py            -> http://127.0.0.1:5500

- Serves the static web app (allow-listed folders only)
- /api/nlp/tokenize  : Thai word segmentation + POS tagging with PyThaiNLP (newmm + orchid_ud)
- /api/geocode       : place search (OpenStreetMap Nominatim, cached, 1 req/s)
- /api/reverse       : GPS -> address label
- /api/route         : road distance/duration (OSRM, cached)
- /api/health

If PyThaiNLP is not installed the app still works: the browser falls back to Intl.Segmenter.
"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOST = os.environ.get("AW_HOST", "127.0.0.1")
PORT = int(os.environ.get("AW_PORT", "5500"))
USER_AGENT = "ArriveWise/1.0 (local student project)"
STATIC_DIRS = {"css", "js", "assets", "legacy"}
STATIC_FILES = {"index.html", "favicon.svg", "manifest.webmanifest", "sw.js"}



def load_dotenv(path: Path):
    """Minimal .env loader (KEY=VALUE lines); existing env vars win."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_dotenv(ROOT / ".env")
GOOGLE_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()
GOOGLE_MODES = {"car": "DRIVE", "motorbike": "TWO_WHEELER", "bus": "TRANSIT", "walk": "WALK", "bicycle": "BICYCLE"}

sys.path.insert(0, str(ROOT))
from nlp.thai_nlp import NLP  # noqa: E402

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("image/svg+xml", ".svg")

_cache: dict[str, tuple[float, object]] = {}
_cache_lock = threading.Lock()
_nominatim_lock = threading.Lock()
_nominatim_last = [0.0]


def cached(key: str, ttl: float, fn):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    value = fn()
    with _cache_lock:
        _cache[key] = (now, value)
        if len(_cache) > 500:
            for k in sorted(_cache, key=lambda k: _cache[k][0])[:100]:
                _cache.pop(k, None)
    return value


def fetch_json(url: str, timeout: float = 8.0, polite: bool = False):
    if polite:  # Nominatim usage policy: max 1 request / second
        with _nominatim_lock:
            wait = 1.05 - (time.time() - _nominatim_last[0])
            if wait > 0:
                time.sleep(wait)
            _nominatim_last[0] = time.time()
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": "th,en"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def decode_polyline(s: str):
    """Google encoded polyline -> [[lat, lng], ...]"""
    coords, idx, lat, lng = [], 0, 0, 0
    while idx < len(s):
        for which in (0, 1):
            shift = result = 0
            while True:
                b = ord(s[idx]) - 63
                idx += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if which == 0:
                lat += delta
            else:
                lng += delta
        coords.append([lat / 1e5, lng / 1e5])
    return coords


def google_route(a, b, mode: str, departure: str | None):
    """Google Routes API computeRoutes — traffic-aware duration for the planned departure time."""
    travel = GOOGLE_MODES.get(mode, "DRIVE")
    body = {
        "origin": {"location": {"latLng": {"latitude": a[0], "longitude": a[1]}}},
        "destination": {"location": {"latLng": {"latitude": b[0], "longitude": b[1]}}},
        "travelMode": travel,
        "languageCode": "th",
        "units": "METRIC",
    }
    if travel in ("DRIVE", "TWO_WHEELER"):
        body["routingPreference"] = "TRAFFIC_AWARE_OPTIMAL"
    if departure and travel != "WALK" and travel != "BICYCLE":
        body["departureTime"] = departure
    req = urllib.request.Request(
        "https://routes.googleapis.com/directions/v2:computeRoutes",
        data=json.dumps(body).encode("utf-8"), method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": GOOGLE_KEY,
            "X-Goog-FieldMask": "routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline",
        })
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    route = (data.get("routes") or [None])[0]
    if not route:
        return None
    sec = lambda v: float(str(v or "0s").rstrip("s") or 0)
    return {
        "km": route.get("distanceMeters", 0) / 1000,
        "trafficMin": sec(route.get("duration")) / 60,
        "baseMin": sec(route.get("staticDuration") or route.get("duration")) / 60,
        "line": decode_polyline(route.get("polyline", {}).get("encodedPolyline", "")),
        "source": "Google",
        "departure": departure,
        "mode": mode,
    }


def parse_latlng(value: str | None):
    try:
        lat, lng = (float(x) for x in (value or "").split(","))
    except ValueError:
        return None
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None
    return lat, lng


class Handler(BaseHTTPRequestHandler):
    server_version = "ArriveWise/1.0"

    def log_message(self, fmt, *args):  # quieter console
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ---------- helpers
    def send_json(self, data, status=HTTPStatus.OK):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self, limit=8192):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > limit:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    # ---------- routes
    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        q = urllib.parse.parse_qs(url.query)
        path = url.path
        try:
            if path == "/api/health":
                return self.send_json({"ok": True, "nlp": NLP.info(), "google": bool(GOOGLE_KEY)})
            if path == "/api/geocode":
                return self.api_geocode(q)
            if path == "/api/reverse":
                return self.api_reverse(q)
            if path == "/api/route":
                return self.api_route(q)
            if path.startswith("/api/"):
                return self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            return self.serve_static(path)
        except (urllib.error.URLError, TimeoutError) as exc:
            return self.send_json({"error": "upstream unavailable", "detail": str(exc)[:200]}, HTTPStatus.BAD_GATEWAY)

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/nlp/tokenize":
            data = self.read_json()
            text = (data or {}).get("text", "")
            if not isinstance(text, str) or not text.strip() or len(text) > 500:
                return self.send_json({"error": "text required (max 500 chars)"}, HTTPStatus.BAD_REQUEST)
            return self.send_json(NLP.analyze(text))
        return self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def api_geocode(self, q):
        text = (q.get("q") or [""])[0].strip()
        if not text or len(text) > 200:
            return self.send_json({"error": "q required"}, HTTPStatus.BAD_REQUEST)
        params = {"format": "jsonv2", "q": text, "limit": "6", "countrycodes": "th", "accept-language": "th"}
        near = parse_latlng((q.get("near") or [None])[0])
        if near:  # bias results around the user (≈ 1.5° box)
            lat, lng = near
            params["viewbox"] = f"{lng-1.5},{lat+1.5},{lng+1.5},{lat-1.5}"
        raw = []
        if near:  # results near the user first (avoid picking the same-name campus in another province)
            url_b = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({**params, "bounded": "1"})
            raw = cached("geo:" + url_b, 86400, lambda: fetch_json(url_b, polite=True))
        if not raw:
            url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(params)
            raw = cached("geo:" + url, 86400, lambda: fetch_json(url, polite=True))
        results = [
            {"label": r.get("display_name", ""), "name": r.get("name") or r.get("display_name", "").split(",")[0],
             "lat": float(r["lat"]), "lng": float(r["lon"]), "type": r.get("type")}
            for r in raw
        ]
        return self.send_json({"results": results, "source": "OpenStreetMap Nominatim"})

    def api_reverse(self, q):
        pt = parse_latlng(f"{(q.get('lat') or [''])[0]},{(q.get('lng') or [''])[0]}")
        if not pt:
            return self.send_json({"error": "lat,lng required"}, HTTPStatus.BAD_REQUEST)
        lat, lng = round(pt[0], 4), round(pt[1], 4)
        url = "https://nominatim.openstreetmap.org/reverse?" + urllib.parse.urlencode(
            {"format": "jsonv2", "lat": lat, "lon": lng, "zoom": "17", "accept-language": "th"})
        raw = cached("rev:" + url, 86400, lambda: fetch_json(url, polite=True))
        return self.send_json({"label": raw.get("display_name", ""), "name": raw.get("name") or ""})

    def api_route(self, q):
        a = parse_latlng((q.get("from") or [None])[0])
        b = parse_latlng((q.get("to") or [None])[0])
        if not a or not b:
            return self.send_json({"error": "from/to required as lat,lng"}, HTTPStatus.BAD_REQUEST)
        mode = (q.get("mode") or ["car"])[0]
        departure = (q.get("departure") or [None])[0]
        if departure and not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z", departure):
            departure = None
        if GOOGLE_KEY:
            try:
                key = f"g:{a}:{b}:{mode}:{(departure or '')[:13]}"  # cache per hour of departure
                g = cached(key, 1800, lambda: google_route(a, b, mode, departure))
                if g:
                    return self.send_json(g)
            except urllib.error.HTTPError as exc:
                sys.stderr.write(f"Google Routes error {exc.code}: {exc.read()[:300]!r}\n")
            except (urllib.error.URLError, TimeoutError, ValueError) as exc:
                sys.stderr.write(f"Google Routes failed: {exc}\n")
        coords = f"{a[1]:.5f},{a[0]:.5f};{b[1]:.5f},{b[0]:.5f}"
        url = f"https://router.project-osrm.org/route/v1/driving/{coords}?overview=simplified&geometries=geojson"
        raw = cached("route:" + url, 3600, lambda: fetch_json(url, timeout=10))
        if raw.get("code") != "Ok" or not raw.get("routes"):
            return self.send_json({"error": "no route"}, HTTPStatus.NOT_FOUND)
        r = raw["routes"][0]
        line = [[c[1], c[0]] for c in r["geometry"]["coordinates"]]
        return self.send_json({"km": r["distance"] / 1000, "baseMin": r["duration"] / 60, "line": line, "source": "OSRM"})

    def serve_static(self, path: str):
        rel = urllib.parse.unquote(path).lstrip("/") or "index.html"
        parts = Path(rel).parts
        allowed = rel in STATIC_FILES or (len(parts) > 1 and parts[0] in STATIC_DIRS)
        target = (ROOT / rel).resolve()
        if not allowed or ".." in parts or ROOT not in target.parents or not target.is_file():
            return self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith(("javascript", "json")):
            ctype += "; charset=utf-8"
        data = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)


def main():
    NLP.warmup()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"ArriveWise running at http://{HOST}:{PORT}  (NLP: {NLP.info()['engine']})", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
