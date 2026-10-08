# 產生一張假的中文名片圖片（測辨識用，資料全是虛構的）
# 用法：python C:/Users/User/projects/CardBox/tools/make_test_card.py [輸出路徑]
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "sample_card.jpg"
out.parent.mkdir(parents=True, exist_ok=True)

FONT = "C:/Windows/Fonts/msjh.ttc"      # 微軟正黑體
FONT_BOLD = "C:/Windows/Fonts/msjhbd.ttc"


def font(size, bold=False):
    return ImageFont.truetype(FONT_BOLD if bold else FONT, size)


W, H = 1050, 600
img = Image.new("RGB", (W, H), (250, 250, 247))
d = ImageDraw.Draw(img)
d.rectangle([0, 0, 18, H], fill=(15, 118, 110))
d.text((70, 60), "星辰半導體股份有限公司", font=font(34, True), fill=(15, 118, 110))
d.text((70, 108), "Star Semiconductor Corp.", font=font(22), fill=(100, 100, 100))
d.text((70, 200), "王小明", font=font(64, True), fill=(20, 20, 20))
d.text((300, 228), "Ming Wang", font=font(28), fill=(80, 80, 80))
d.text((70, 290), "業務部　資深業務經理", font=font(28), fill=(40, 40, 40))
lines = [
    "手機  0912-345-678",
    "電話  (02) 2345-6789 分機 321",
    "傳真  (02) 2345-6790",
    "Email  ming.wang@example.com",
    "台北市信義區松仁路 100 號 20 樓",
    "www.example.com　　LINE ID: ming0912",
]
y = 360
for line in lines:
    d.text((70, y), line, font=font(24), fill=(50, 50, 50))
    y += 36
img.save(out, quality=90)
print(out)
