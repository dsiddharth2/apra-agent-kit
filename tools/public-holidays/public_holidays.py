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


_FALLBACK_HOLIDAYS = {
    "IN": [
        {"date": "{yr}-01-26", "name": "Republic Day", "name_en": "Republic Day", "types": ["Public"]},
        {"date": "{yr}-03-14", "name": "Holi", "name_en": "Holi", "types": ["Public"]},
        {"date": "{yr}-04-14", "name": "Ambedkar Jayanti", "name_en": "Ambedkar Jayanti", "types": ["Public"]},
        {"date": "{yr}-08-15", "name": "Independence Day", "name_en": "Independence Day", "types": ["Public"]},
        {"date": "{yr}-10-02", "name": "Gandhi Jayanti", "name_en": "Gandhi Jayanti", "types": ["Public"]},
        {"date": "{yr}-10-12", "name": "Dussehra", "name_en": "Dussehra", "types": ["Public"]},
        {"date": "{yr}-11-01", "name": "Diwali", "name_en": "Diwali", "types": ["Public"]},
        {"date": "{yr}-12-25", "name": "Christmas", "name_en": "Christmas", "types": ["Public"]},
    ],
    "US": [
        {"date": "{yr}-01-01", "name": "New Year's Day", "name_en": "New Year's Day", "types": ["Public"]},
        {"date": "{yr}-07-04", "name": "Independence Day", "name_en": "Independence Day", "types": ["Public"]},
        {"date": "{yr}-11-28", "name": "Thanksgiving", "name_en": "Thanksgiving", "types": ["Public"]},
        {"date": "{yr}-12-25", "name": "Christmas", "name_en": "Christmas", "types": ["Public"]},
    ],
    "GB": [
        {"date": "{yr}-01-01", "name": "New Year's Day", "name_en": "New Year's Day", "types": ["Public"]},
        {"date": "{yr}-12-25", "name": "Christmas", "name_en": "Christmas", "types": ["Public"]},
        {"date": "{yr}-12-26", "name": "Boxing Day", "name_en": "Boxing Day", "types": ["Public"]},
    ],
    "JP": [
        {"date": "{yr}-01-01", "name": "New Year", "name_en": "New Year's Day", "types": ["Public"]},
        {"date": "{yr}-02-11", "name": "National Foundation Day", "name_en": "National Foundation Day", "types": ["Public"]},
        {"date": "{yr}-05-03", "name": "Constitution Day", "name_en": "Constitution Memorial Day", "types": ["Public"]},
    ],
    "TH": [
        {"date": "{yr}-04-13", "name": "Songkran", "name_en": "Songkran", "types": ["Public"]},
        {"date": "{yr}-12-05", "name": "King's Birthday", "name_en": "King's Birthday", "types": ["Public"]},
    ],
    "AE": [
        {"date": "{yr}-12-02", "name": "National Day", "name_en": "National Day", "types": ["Public"]},
    ],
}


def _resolve_fallback(country_code, year):
    templates = _FALLBACK_HOLIDAYS.get(country_code.upper())
    if not templates:
        return None
    holidays = []
    for t in templates:
        h = dict(t)
        h["date"] = h["date"].replace("{yr}", str(year))
        h["fixed"] = True
        h["global"] = True
        holidays.append(h)
    return holidays


def fetch_holidays(country_code, year=None):
    if year is None:
        year = datetime.now().year

    data = None
    api_error = None
    try:
        data = _get(f"https://date.nager.at/api/v3/PublicHolidays/{year}/{urllib.request.quote(country_code.upper())}")
    except (urllib.error.URLError, TimeoutError) as exc:
        api_error = str(exc)
    except (json.JSONDecodeError, ValueError):
        api_error = "API returned empty response"

    if data is not None and isinstance(data, list):
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

    fallback = _resolve_fallback(country_code, year)
    if fallback:
        return json.dumps({
            "ok": True,
            "country_code": country_code.upper(),
            "year": year,
            "count": len(fallback),
            "holidays": fallback,
            "source": "fallback",
            "note": f"API unavailable ({api_error or 'no data'}); showing major fixed-date holidays only. Some movable holidays (Eid, Easter, Diwali exact date) may differ.",
        })

    return json.dumps({
        "ok": True,
        "country_code": country_code.upper(),
        "year": year,
        "count": 0,
        "holidays": [],
        "source": "fallback",
        "note": f"Holiday data unavailable for {country_code.upper()} ({api_error or 'no data'}). Check local sources for public holidays.",
    })


if __name__ == "__main__":
    cc = sys.argv[1] if len(sys.argv) > 1 else "US"
    yr = int(sys.argv[2]) if len(sys.argv) > 2 else None
    print(fetch_holidays(cc, yr))
