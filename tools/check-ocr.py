"""Provision/verify the local OCR models after installing Office dependencies."""
import os
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
directory = root / (sys.argv[1] if len(sys.argv) > 1 else os.environ.get('OFFICE_TOOL_DIR', '.vendor/office-tool'))
if not (directory / 'tools' / 'ocr_tools.py').is_file():
    raise SystemExit('本地 OCR 需要带 OCR 的兼容 Office 集成。可传入集成目录作为第一个参数。')
sys.path.insert(0, str(directory))
from PIL import Image, ImageDraw, ImageFont
from tools.ocr_tools import recognize
image=Image.new('RGB',(800,180),'white')
try:
    font=ImageFont.load_default(size=48)
except TypeError:
    font=ImageFont.load_default()
ImageDraw.Draw(image).text((40,50),'OCR 12345',font=font,fill='black')
result=recognize(image,1)
if '12345' not in result['text']:
    raise SystemExit('OCR verification failed: test text not recognized')
print('Local OCR ready (CPU, Chinese/English models).')
