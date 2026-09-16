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


def fetch_forecast(city, days=7):
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

    try:
        data = _get(
            f"https://api.open-meteo.com/v1/forecast"
            f"?latitude={lat}&longitude={lon}"
            f"&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code,wind_speed_10m_max"
            f"&forecast_days={days}&timezone=auto"
        )
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"forecast fetch failed: {exc}"})

    daily = data.get("daily", {})
    dates = daily.get("time", [])
    forecast_days = []
    for i, date in enumerate(dates):
        forecast_days.append({
            "date": date,
            "temp_max_c": daily.get("temperature_2m_max", [None])[i],
            "temp_min_c": daily.get("temperature_2m_min", [None])[i],
            "precipitation_mm": daily.get("precipitation_sum", [None])[i],
            "weather_code": daily.get("weather_code", [None])[i],
            "wind_max_kmph": daily.get("wind_speed_10m_max", [None])[i],
        })

    return json.dumps({
        "ok": True,
        "location": f"{place.get('name', city)}, {place.get('country', '')}",
        "days": forecast_days,
    })


if __name__ == "__main__":
    city = sys.argv[1] if len(sys.argv) > 1 else "London"
    days = int(sys.argv[2]) if len(sys.argv) > 2 else 7
    print(fetch_forecast(city, days))
