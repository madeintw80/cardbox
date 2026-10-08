# 產生「電腦端通行密碼」(RUNNER_SECRET)：存到 Boss 電腦的 secrets 資料夾，並同步設定到 Cloudflare 收件櫃
# 密碼不會印出來。已經有密碼就沿用（加 --rotate 才換新的）
# 用法：python C:/Users/User/projects/CardBox/tools/setup_runner_secret.py [--rotate]
import secrets
import subprocess
import sys
from pathlib import Path

SECRET_FILE = Path("C:/Users/User/.claude/secrets/cardbox_runner.env")
NODE = "C:/Users/User/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe"
WRANGLER = "C:/Users/User/projects/Guandan5/node_modules/wrangler/bin/wrangler.js"
CONFIG = "C:/Users/User/projects/CardBox/worker/wrangler.jsonc"


def read_existing():
    if not SECRET_FILE.exists():
        return None
    for line in SECRET_FILE.read_text(encoding="utf-8").splitlines():
        if line.startswith("RUNNER_SECRET="):
            return line.split("=", 1)[1].strip() or None
    return None


def main():
    rotate = "--rotate" in sys.argv
    token = None if rotate else read_existing()
    if token:
        print("沿用已存在的密碼檔")
    else:
        token = secrets.token_urlsafe(32)
        SECRET_FILE.parent.mkdir(parents=True, exist_ok=True)
        SECRET_FILE.write_text(
            "# 名片盒拿件小程式 ↔ Cloudflare 收件櫃的通行密碼（tools/setup_runner_secret.py 產生）\n"
            f"RUNNER_SECRET={token}\n",
            encoding="utf-8", newline="\n",
        )
        print("已產生新密碼並存檔")
    # 透過 stdin 交給 wrangler，密碼不會出現在指令列或畫面上
    r = subprocess.run([NODE, WRANGLER, "secret", "put", "RUNNER_SECRET", "--config", CONFIG],
                       input=token + "\n", capture_output=True, text=True, encoding="utf-8", timeout=180)
    tail = (r.stdout + r.stderr).strip().splitlines()[-3:]
    print("Cloudflare：", " / ".join(tail))
    sys.exit(r.returncode)


if __name__ == "__main__":
    main()
