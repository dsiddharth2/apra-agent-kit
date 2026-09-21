import json
import ssl
import sys
import time
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


def _geocode(city):
    data = _get(
        f"https://nominatim.openstreetmap.org/search"
        f"?q={urllib.request.quote(city)}&format=json&limit=1"
    )
    if not data:
        return None
    return {"lat": float(data[0]["lat"]), "lon": float(data[0]["lon"]), "name": data[0].get("display_name", city)}


def route_distance(from_city, to_city):
    try:
        origin = _geocode(from_city)
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"Failed to geocode '{from_city}': {exc}"})
    if not origin:
        return json.dumps({"ok": False, "error": f"Could not find location: {from_city}"})

    time.sleep(1)

    try:
        dest = _geocode(to_city)
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"Failed to geocode '{to_city}': {exc}"})
    if not dest:
        return json.dumps({"ok": False, "error": f"Could not find location: {to_city}"})

    try:
        route = _get(
            f"https://router.project-osrm.org/route/v1/driving/"
            f"{origin['lon']},{origin['lat']};{dest['lon']},{dest['lat']}"
            f"?overview=false"
        )
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"OSRM routing failed: {exc}"})

    if route.get("code") != "Ok" or not route.get("routes"):
        return json.dumps({"ok": False, "error": f"No driving route found between {from_city} and {to_city}"})

    leg = route["routes"][0]
    distance_km = round(leg["distance"] / 1000, 1)
    duration_sec = leg["duration"]
    hours = int(duration_sec // 3600)
    minutes = int((duration_sec % 3600) // 60)
    duration_text = f"{hours}h {minutes}m" if hours else f"{minutes}m"

    return json.dumps({
        "ok": True,
        "from": {"name": from_city, "display_name": origin["name"]},
        "to": {"name": to_city, "display_name": dest["name"]},
        "distance_km": distance_km,
        "duration_hours": round(duration_sec / 3600, 1),
        "duration_text": duration_text,
        "mode": "driving",
    })


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "Usage: route_distance.py <from_city> <to_city>"}))
        sys.exit(1)
    print(route_distance(sys.argv[1], sys.argv[2]))
