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


def fetch_rate(from_currency, to_currency, amount=1):
    try:
        url = (
            f"https://api.frankfurter.app/latest"
            f"?from={urllib.request.quote(from_currency.upper())}"
            f"&to={urllib.request.quote(to_currency.upper())}"
            f"&amount={amount}"
        )
        data = _get(url)
    except (urllib.error.URLError, TimeoutError) as exc:
        return json.dumps({"ok": False, "error": f"currency fetch failed: {exc}"})

    rates = data.get("rates", {})
    converted = rates.get(to_currency.upper())
    return json.dumps({
        "ok": True,
        "from": from_currency.upper(),
        "to": to_currency.upper(),
        "amount": amount,
        "rate": converted / amount if converted and amount else None,
        "converted": converted,
        "date": data.get("date"),
    })


if __name__ == "__main__":
    from_c = sys.argv[1] if len(sys.argv) > 1 else "USD"
    to_c = sys.argv[2] if len(sys.argv) > 2 else "EUR"
    amt = float(sys.argv[3]) if len(sys.argv) > 3 else 1
    print(fetch_rate(from_c, to_c, amt))
