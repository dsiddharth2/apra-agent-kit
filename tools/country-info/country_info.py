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


def fetch_country(name):
    try:
        data = _get(f"https://restcountries.com/v3.1/name/{urllib.request.quote(name)}?fields=name,capital,region,subregion,population,languages,currencies,timezones,flags")
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"country fetch failed: {exc}"})

    if not isinstance(data, list) or len(data) == 0:
        return json.dumps({"ok": False, "error": f"Country not found: {name}"})

    c = data[0]
    langs = list((c.get("languages") or {}).values())
    currs = c.get("currencies") or {}
    currency_list = [{"code": k, "name": v.get("name"), "symbol": v.get("symbol")} for k, v in currs.items()]

    return json.dumps({
        "ok": True,
        "name": c.get("name", {}).get("common", name),
        "official_name": c.get("name", {}).get("official", ""),
        "capital": (c.get("capital") or [None])[0],
        "region": c.get("region"),
        "subregion": c.get("subregion"),
        "population": c.get("population"),
        "languages": langs,
        "currencies": currency_list,
        "timezones": c.get("timezones", []),
    })


if __name__ == "__main__":
    country = sys.argv[1] if len(sys.argv) > 1 else "Japan"
    print(fetch_country(country))
