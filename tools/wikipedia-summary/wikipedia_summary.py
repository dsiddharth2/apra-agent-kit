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


def fetch_summary(topic):
    slug = topic.strip().replace(" ", "_")
    try:
        data = _get(f"https://en.wikipedia.org/api/rest_v1/page/summary/{urllib.request.quote(slug)}")
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"wikipedia fetch failed: {exc}"})

    if data.get("type") == "disambiguation":
        return json.dumps({"ok": True, "title": data.get("title"), "extract": data.get("extract", ""), "disambiguation": True})

    return json.dumps({
        "ok": True,
        "title": data.get("title", topic),
        "extract": data.get("extract", ""),
        "description": data.get("description", ""),
        "thumbnail": (data.get("thumbnail") or {}).get("source"),
    })


if __name__ == "__main__":
    topic = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "London"
    print(fetch_summary(topic))
