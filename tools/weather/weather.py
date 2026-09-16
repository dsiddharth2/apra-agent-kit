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

_WMO_CODES = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Foggy", 48: "Depositing rime fog",
    51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
    56: "Light freezing drizzle", 57: "Dense freezing drizzle",
    61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
    66: "Light freezing rain", 67: "Heavy freezing rain",
    71: "Slight snowfall", 73: "Moderate snowfall", 75: "Heavy snowfall",
    77: "Snow grains",
    80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
    85: "Slight snow showers", 86: "Heavy snow showers",
    95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
}

_COMPASS = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
]


def _wind_dir(degrees):
    if degrees is None:
        return ""
    return _COMPASS[int((degrees + 11.25) / 22.5) % 16]


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "workflow-kit/1.0"})
    with urllib.request.urlopen(req, timeout=10, context=_SSL_CTX) as resp:
        return json.loads(resp.read().decode())


def fetch_weather(city):
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
    lat, lon = place["latitude"], place["longitude"]
    location = f"{place.get('name', city)}, {place.get('country', '')}"

    try:
        weather = _get(
            f"https://api.open-meteo.com/v1/forecast"
            f"?latitude={lat}&longitude={lon}"
            f"&current=temperature_2m,relative_humidity_2m,apparent_temperature"
            f",weather_code,wind_speed_10m,wind_direction_10m,uv_index"
            f"&timezone=auto"
        )
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"weather fetch failed: {exc}"})

    cur = weather.get("current", {})
    temp_c = cur.get("temperature_2m")
    temp_f = round(temp_c * 9 / 5 + 32, 1) if temp_c is not None else None

    return json.dumps({
        "ok": True,
        "location": location,
        "temp_c": str(temp_c) if temp_c is not None else None,
        "temp_f": str(temp_f) if temp_f is not None else None,
        "feels_like_c": str(cur.get("apparent_temperature")) if cur.get("apparent_temperature") is not None else None,
        "humidity": str(cur.get("relative_humidity_2m")) if cur.get("relative_humidity_2m") is not None else None,
        "description": _WMO_CODES.get(cur.get("weather_code"), "Unknown"),
        "wind_speed_kmph": str(cur.get("wind_speed_10m")) if cur.get("wind_speed_10m") is not None else None,
        "wind_dir": _wind_dir(cur.get("wind_direction_10m")),
        "visibility_km": None,
        "uv_index": str(cur.get("uv_index")) if cur.get("uv_index") is not None else None,
    })


if __name__ == "__main__":
    city = sys.argv[1] if len(sys.argv) > 1 else "London"
    print(fetch_weather(city))
