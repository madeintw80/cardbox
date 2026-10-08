# 本機端到端測試：App 放件 → 拿件小程式用真的 Claude 讀 → App 拿到欄位
# 會用一次 Boss 的 Claude 訂閱額度（讀一張測試名片，約 5 秒）
# 前置：啟動本機收件櫃（launch.json 的 cardbox-ocr，帶 DEV_FAKE_EMAIL＋RUNNER_SECRET=local-test-secret）
# 用法：python C:/Users/User/projects/CardBox/worker/e2e_local.py
import base64
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

BASE = "http://localhost:8810"
ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / "tests" / "fixtures" / "sample_card.jpg"
APP = {"Origin": "http://localhost:3480", "Content-Type": "application/json", "User-Agent": "e2e"}


def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, headers=APP,
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status, json.loads(r.read() or b"{}")


# 1) App 放件
s, data = call("POST", "/jobs", {"image": base64.b64encode(IMG.read_bytes()).decode(), "media_type": "image/jpeg"})
job_id = data["id"]
print("1) 放件成功", job_id[:8], "電腦在線：", data["runner_online"])

s, data = call("GET", f"/jobs/{job_id}")
print("2) 還沒人拿：", data["status"])
assert data["status"] == "pending"

# 2) 拿件小程式只拿一件
env = {**os.environ, "CARDBOX_WORKER_URL": BASE, "CARDBOX_RUNNER_SECRET": "local-test-secret", "PYTHONIOENCODING": "utf-8"}
t = time.time()
r = subprocess.run([sys.executable, str(ROOT / "runner" / "cardbox_runner.py"), "--once"],
                   env=env, capture_output=True, text=True, encoding="utf-8", timeout=240)
print("3) 拿件小程式：", r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr[-300:], f"（{time.time() - t:.1f} 秒）")

# 3) App 拿結果
s, data = call("GET", f"/jobs/{job_id}")
print("4) App 拿到：", data["status"], "電腦在線：", data["runner_online"])
card = data.get("card") or {}
print(json.dumps(card, ensure_ascii=False, indent=2))

checks = {
    "狀態 done": data["status"] == "done",
    "姓名": card.get("name") == "王小明",
    "英文名": card.get("name_alt") == "Ming Wang",
    "手機": card.get("mobile") == "0912-345-678",
    "電話含分機": "321" in card.get("phone", ""),
    "電腦在線": data["runner_online"] is True,
}
for k, ok in checks.items():
    print(("PASS " if ok else "FAIL ") + k)
print(f"\n{sum(checks.values())}/{len(checks)} 通過")
sys.exit(0 if all(checks.values()) else 1)
