import json
import ssl
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone

try:
    from zoneinfo import ZoneInfo
except ImportError:
    from backports.zoneinfo import ZoneInfo

try:
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL_CTX = None

_DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "workflow-kit/1.0"})
    with urllib.request.urlopen(req, timeout=10, context=_SSL_CTX) as resp:
        return json.loads(resp.read().decode())


def fetch_time(city):
    try:
        geo = _get(
            f"https://geocoding-api.open-meteo.com/v1/search"
            f"?name={urllib.request.quote(city)}&count=1&language=en"
        )
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"geocoding failed: {exc}"})

    results = geo.get("results")
    if not results:
        return json.dumps({"ok": False, "error": f"City not found: {city}"})

    place = results[0]
    tz_name = place.get("timezone", "UTC")

    try:
        data = _get(f"https://timeapi.io/api/time/current/zone?timeZone={urllib.request.quote(tz_name)}")
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"time fetch failed: {exc}"})

    day_name = data.get("dayOfWeek", "")
    day_of_week = _DAY_NAMES.index(day_name) + 1 if day_name in _DAY_NAMES else None

    try:
        zi = ZoneInfo(tz_name)
        local_dt = datetime(
            data["year"], data["month"], data["day"],
            data["hour"], data["minute"], data["seconds"],
            tzinfo=zi,
        )
        offset = local_dt.utcoffset()
        total_secs = int(offset.total_seconds())
        sign = "+" if total_secs >= 0 else "-"
        h, m = divmod(abs(total_secs) // 60, 60)
        utc_offset = f"{sign}{h:02d}:{m:02d}"
        iso_dt = local_dt.isoformat()
        tz_abbr = local_dt.strftime("%Z") or tz_name
    except Exception:
        iso_dt = data.get("dateTime", "")
        utc_offset = None
        tz_abbr = tz_name

    return json.dumps({
        "ok": True,
        "timezone": tz_name,
        "datetime": iso_dt,
        "utc_offset": utc_offset,
        "day_of_week": day_of_week,
        "abbreviation": tz_abbr,
    })


if __name__ == "__main__":
    city = sys.argv[1] if len(sys.argv) > 1 else "London"
    print(fetch_time(city))
