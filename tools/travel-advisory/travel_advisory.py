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


def _get_insecure(url):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers={"User-Agent": "workflow-kit/1.0"})
    with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
        return json.loads(resp.read().decode())


def fetch_advisory(country_code):
    data = None
    try:
        data = _get(f"https://www.travel-advisory.info/api?countrycode={urllib.request.quote(country_code.upper())}")
    except (urllib.error.URLError, TimeoutError):
        try:
            data = _get_insecure(f"https://www.travel-advisory.info/api?countrycode={urllib.request.quote(country_code.upper())}")
        except (urllib.error.URLError, TimeoutError):
            pass

    if data is None:
        return json.dumps({
            "ok": True,
            "country_code": country_code.upper(),
            "score": None,
            "message": "Travel advisory data is temporarily unavailable. Check travel.state.gov (US), gov.uk/foreign-travel-advice (UK), or smartraveller.gov.au (AU) for current advisories.",
            "source": "fallback",
            "updated": None,
        })

    api_status = data.get("api_status", {})
    if api_status.get("reply", {}).get("code") != 200:
        return json.dumps({
            "ok": True,
            "country_code": country_code.upper(),
            "score": None,
            "message": "Travel advisory data is temporarily unavailable. Check travel.state.gov (US), gov.uk/foreign-travel-advice (UK), or smartraveller.gov.au (AU) for current advisories.",
            "source": "fallback",
            "updated": None,
        })

    entry = (data.get("data") or {}).get(country_code.upper())
    if not entry:
        return json.dumps({
            "ok": True,
            "country_code": country_code.upper(),
            "score": None,
            "message": f"No specific advisory data for {country_code.upper()}. Check official government travel advisory sites for current information.",
            "source": "fallback",
            "updated": None,
        })

    advisory = entry.get("advisory", {})
    return json.dumps({
        "ok": True,
        "country": entry.get("name", country_code),
        "country_code": country_code.upper(),
        "score": advisory.get("score"),
        "message": advisory.get("message", ""),
        "updated": advisory.get("updated", ""),
        "source": advisory.get("source", ""),
    })


if __name__ == "__main__":
    cc = sys.argv[1] if len(sys.argv) > 1 else "JP"
    print(fetch_advisory(cc))
