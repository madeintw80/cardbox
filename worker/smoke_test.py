# 中繼站安全檢查冒煙測試（不會呼叫 AI、不花錢）
# 用法：先啟動本機中繼站（launch.json 的 cardbox-ocr，port 8810），再跑
#   python C:/Users/User/projects/CardBox/worker/smoke_test.py [網址]
# 預設測本機；部署後可以帶線上網址再測一次
import json
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost:8810"
GOOD_ORIGIN = "http://localhost:3480"


def call(method, path, headers=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, dict(r.headers), r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode()


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""))
    return ok


results = []

s, h, b = call("GET", "/health")
results.append(check("health 200", s == 200, b))

s, h, b = call("OPTIONS", "/ocr", {"Origin": GOOD_ORIGIN, "Access-Control-Request-Method": "POST"})
results.append(check("允許的網站 preflight 有 CORS", s == 204 and h.get("Access-Control-Allow-Origin") == GOOD_ORIGIN, str(s)))

s, h, b = call("OPTIONS", "/ocr", {"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
results.append(check("陌生網站 preflight 沒有 CORS", "Access-Control-Allow-Origin" not in h, str(s)))

s, h, b = call("POST", "/ocr", {"Origin": "https://evil.example", "Content-Type": "application/json"}, {"image": "x"})
results.append(check("陌生網站直接打 → 403", s == 403, b))

s, h, b = call("POST", "/ocr", {"Origin": GOOD_ORIGIN, "Content-Type": "application/json"}, {"image": "x"})
results.append(check("沒帶 Google 憑證 → 401 bad_token", s == 401 and "bad_token" in b, b))

s, h, b = call("POST", "/ocr", {"Origin": GOOD_ORIGIN, "Content-Type": "application/json",
                                "Authorization": "Bearer ya29.fake-token-for-test"}, {"image": "x"})
results.append(check("假的 Google 憑證 → 401 bad_token", s == 401 and "bad_token" in b, b))

s, h, b = call("GET", "/ocr", {"Origin": GOOD_ORIGIN})
results.append(check("GET /ocr → 404", s == 404, b))

print(f"\n{sum(results)}/{len(results)} 通過")
sys.exit(0 if all(results) else 1)
