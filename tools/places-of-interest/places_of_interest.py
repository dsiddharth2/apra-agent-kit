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
    with urllib.request.urlopen(req, timeout=15, context=_SSL_CTX) as resp:
        return json.loads(resp.read().decode())


def fetch_places(location, limit=8):
    query = f"{location} tourism attractions things to do"
    try:
        search = _get(
            f"https://en.wikipedia.org/w/api.php"
            f"?action=query&list=search"
            f"&srsearch={urllib.request.quote(query)}"
            f"&srlimit={limit}&format=json"
        )
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"wikipedia search failed: {exc}"})

    results = search.get("query", {}).get("search", [])
    if not results:
        return json.dumps({"ok": False, "error": f"No results for: {location}"})

    page_ids = [str(r["pageid"]) for r in results]
    try:
        extracts = _get(
            f"https://en.wikipedia.org/w/api.php"
            f"?action=query&prop=extracts&exintro=true&explaintext=true"
            f"&pageids={'|'.join(page_ids)}&format=json"
        )
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"wikipedia extract failed: {exc}"})

    pages = extracts.get("query", {}).get("pages", {})
    places = []
    for r in results:
        pid = str(r["pageid"])
        page = pages.get(pid, {})
        extract = page.get("extract", "")
        if len(extract) > 500:
            extract = extract[:497] + "..."
        places.append({
            "title": r.get("title", ""),
            "extract": extract,
            "pageid": r["pageid"],
        })

    return json.dumps({
        "ok": True,
        "location": location,
        "count": len(places),
        "places": places,
    })


if __name__ == "__main__":
    loc = " ".join(sys.argv[1:-1]) if len(sys.argv) > 2 and sys.argv[-1].isdigit() else " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "London"
    lim = int(sys.argv[-1]) if len(sys.argv) > 2 and sys.argv[-1].isdigit() else 8
    if len(sys.argv) == 2:
        loc = sys.argv[1]
    print(fetch_places(loc, lim))
