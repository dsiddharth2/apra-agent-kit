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


def geocode_city(city):
    try:
        data = _get(
            f"https://nominatim.openstreetmap.org/search"
            f"?q={urllib.request.quote(city)}&format=json&limit=1&addressdetails=1"
        )
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"geocode failed: {exc}"})

    if not data:
        return json.dumps({"ok": False, "error": f"Location not found: {city}"})

    place = data[0]
    return json.dumps({
        "ok": True,
        "query": city,
        "display_name": place.get("display_name"),
        "lat": place.get("lat"),
        "lon": place.get("lon"),
        "type": place.get("type"),
        "address": place.get("address", {}),
    })


def reverse_geocode(lat, lon):
    try:
        data = _get(
            f"https://nominatim.openstreetmap.org/reverse"
            f"?lat={lat}&lon={lon}&format=json&zoom=16"
        )
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"reverse geocode failed: {exc}"})

    return json.dumps({
        "ok": True,
        "lat": str(lat),
        "lon": str(lon),
        "display_name": data.get("display_name"),
        "address": data.get("address", {}),
    })


if __name__ == "__main__":
    if len(sys.argv) >= 3:
        try:
            lat, lon = float(sys.argv[1]), float(sys.argv[2])
            print(reverse_geocode(lat, lon))
        except ValueError:
            print(geocode_city(sys.argv[1]))
    else:
        city = sys.argv[1] if len(sys.argv) > 1 else "London"
        print(geocode_city(city))
