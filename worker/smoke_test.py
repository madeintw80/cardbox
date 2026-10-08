# 收件櫃安全檢查冒煙測試（不會呼叫 Claude、不花額度）
# 用法：python C:/Users/User/projects/CardBox/worker/smoke_test.py [網址]
# 預設測本機（launch.json 的 cardbox-ocr，port 8810）；部署後帶線上網址再測一次
import json
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost:8810"
GOOD_ORIGIN = "http://localhost:3480"
# Cloudflare 會擋 Python 預設的 User-Agent（error code 1010），假裝成手機瀏覽器
UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
IS_LOCAL = "localhost" in BASE or "127.0.0.1" in BASE


def call(method, path, headers=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"User-Agent": UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, dict(r.headers), r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode()


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail[:120]})" if detail else ""))
    return ok


JSON = {"Content-Type": "application/json"}
results = []

s, h, b = call("GET", "/health")
results.append(check("health 200", s == 200, b))

s, h, b = call("OPTIONS", "/jobs", {"Origin": GOOD_ORIGIN, "Access-Control-Request-Method": "POST"})
results.append(check("允許的網站 preflight 有 CORS", s == 204 and h.get("Access-Control-Allow-Origin") == GOOD_ORIGIN, str(s)))

s, h, b = call("OPTIONS", "/jobs", {"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
results.append(check("陌生網站 preflight 沒有 CORS", "Access-Control-Allow-Origin" not in h, str(s)))

s, h, b = call("POST", "/jobs", {"Origin": "https://evil.example", **JSON}, {"image": "x"})
results.append(check("陌生網站放件 → 403", s == 403, b))

if not IS_LOCAL:  # 本機有 DEV_FAKE_EMAIL 測試通道，這兩項只在線上測
    s, h, b = call("POST", "/jobs", {"Origin": GOOD_ORIGIN, **JSON}, {"image": "x"})
    results.append(check("沒帶 Google 憑證 → 401 bad_token", s == 401 and "bad_token" in b, b))
    s, h, b = call("POST", "/jobs", {"Origin": GOOD_ORIGIN, "Authorization": "Bearer ya29.fake", **JSON}, {"image": "x"})
    results.append(check("假的 Google 憑證 → 401 bad_token", s == 401 and "bad_token" in b, b))

s, h, b = call("POST", "/runner/claim", JSON, {})
results.append(check("電腦端沒密碼 → 403", s == 403, b))

s, h, b = call("POST", "/runner/claim", {"Authorization": "Bearer wrong-secret", **JSON}, {})
results.append(check("電腦端密碼錯 → 403", s == 403, b))

s, h, b = call("POST", "/runner/result", {"Authorization": "Bearer wrong-secret", **JSON}, {"id": "x", "card": {}})
results.append(check("密碼錯不能回填結果 → 403", s == 403, b))

s, h, b = call("GET", "/ocr", {"Origin": GOOD_ORIGIN})
results.append(check("舊路徑 /ocr → 404", s == 404, b))

print(f"\n{sum(results)}/{len(results)} 通過")
sys.exit(0 if all(results) else 1)
