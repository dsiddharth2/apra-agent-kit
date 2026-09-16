import json
import ssl
import sys
import urllib.request
import urllib.error
from datetime import datetime

try:
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL_CTX = None


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "workflow-kit/1.0"})
    with urllib.request.urlopen(req, timeout=10, context=_SSL_CTX) as resp:
        return json.loads(resp.read().decode())


def fetch_holidays(country_code, year=None):
    if year is None:
        year = datetime.now().year
    try:
        data = _get(f"https://date.nager.at/api/v3/PublicHolidays/{year}/{urllib.request.quote(country_code.upper())}")
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"holidays fetch failed: {exc}"})
    except (json.JSONDecodeError, ValueError):
        return json.dumps({"ok": False, "error": f"No holiday data available for {country_code.upper()} {year} (API returned empty response)"})

    if not isinstance(data, list):
        return json.dumps({"ok": False, "error": f"No holiday data for {country_code} {year}"})

    holidays = []
    for h in data:
        holidays.append({
            "date": h.get("date"),
            "name": h.get("localName"),
            "name_en": h.get("name"),
            "fixed": h.get("fixed"),
            "global": h.get("global"),
            "types": h.get("types", []),
        })

    return json.dumps({
        "ok": True,
        "country_code": country_code.upper(),
        "year": year,
        "count": len(holidays),
        "holidays": holidays,
    })


if __name__ == "__main__":
    cc = sys.argv[1] if len(sys.argv) > 1 else "US"
    yr = int(sys.argv[2]) if len(sys.argv) > 2 else None
    print(fetch_holidays(cc, yr))
