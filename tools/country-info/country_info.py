import json
import ssl
import sys
import urllib.request
import urllib.error

try:
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL_CTX = None


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "workflow-kit/1.0"})
    with urllib.request.urlopen(req, timeout=10, context=_SSL_CTX) as resp:
        return json.loads(resp.read().decode())


def _wiki_summary(topic):
    url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{urllib.request.quote(topic)}"
    return _get(url)


def _resolve_country_name(query):
    if len(query) in (2, 3) and query.isalpha() and query == query.upper():
        try:
            geo = _get(
                f"https://nominatim.openstreetmap.org/search?"
                f"country={urllib.request.quote(query)}&format=json&limit=1&accept-language=en"
            )
            if geo and isinstance(geo, list) and len(geo) > 0:
                name = geo[0].get("display_name", "").split(",")[0].strip()
                if name:
                    return name
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            pass
    return query


def fetch_country(name):
    country_name = _resolve_country_name(name)

    try:
        wiki = _wiki_summary(country_name)
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"country fetch failed: {exc}"})

    if wiki.get("type") == "disambiguation" or not wiki.get("extract"):
        return json.dumps({"ok": False, "error": f"Country not found: {name}"})

    return json.dumps({
        "ok": True,
        "name": wiki.get("title", country_name),
        "description": wiki.get("description", ""),
        "summary": wiki.get("extract", ""),
        "thumbnail": wiki.get("thumbnail", {}).get("source", ""),
    })


if __name__ == "__main__":
    country = sys.argv[1] if len(sys.argv) > 1 else "Japan"
    print(fetch_country(country))
