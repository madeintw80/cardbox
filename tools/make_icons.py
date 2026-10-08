# 產生名片盒的 App 圖示（192／512／apple-touch 180）
# 用法：python C:/Users/User/projects/CardBox/tools/make_icons.py
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "icons"
TEAL = (15, 118, 110)
TEAL_LIGHT = (45, 212, 191)
WHITE = (255, 255, 255)
GRAY = (203, 213, 225)


def draw_icon(size: int) -> Image.Image:
    # 先畫 4 倍大再縮小，邊緣比較平滑
    s = size * 4
    img = Image.new("RGB", (s, s), TEAL)
    d = ImageDraw.Draw(img)

    # 後面那張名片（淡色、稍微歪）→ 有「一疊名片」的感覺
    back = [s * 0.22, s * 0.30, s * 0.80, s * 0.64]
    d.rounded_rectangle(back, radius=s * 0.04, fill=TEAL_LIGHT)

    # 前面那張白色名片（內容都在中間 80% 安全區，Android 圓形裁切也不會切到）
    card = [s * 0.18, s * 0.38, s * 0.82, s * 0.74]
    d.rounded_rectangle(card, radius=s * 0.045, fill=WHITE)

    # 名片上的頭像圓點＋三條字
    cx, cy, r = s * 0.31, s * 0.53, s * 0.065
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=TEAL)
    d.rounded_rectangle([s * 0.42, s * 0.47, s * 0.72, s * 0.51], radius=s * 0.02, fill=TEAL)
    d.rounded_rectangle([s * 0.42, s * 0.55, s * 0.66, s * 0.58], radius=s * 0.015, fill=GRAY)
    d.rounded_rectangle([s * 0.26, s * 0.65, s * 0.72, s * 0.68], radius=s * 0.015, fill=GRAY)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    for name, size in [("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)]:
        draw_icon(size).save(OUT / name, optimize=True)
        print("寫入", OUT / name)


if __name__ == "__main__":
    main()
