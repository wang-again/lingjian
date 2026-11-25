import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import fitz
root=Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)
image=Image.new('RGB',(1200,300),'white')
chinese=Path('C:/Windows/Fonts/msyh.ttc')
font=ImageFont.truetype(str(chinese),48) if chinese.exists() else ImageFont.load_default(size=48)
ImageDraw.Draw(image).text((50,70),'灵笺文档 OCR 12345' if chinese.exists() else 'Document OCR 12345',font=font,fill='black')
image.save(root/'scan.png')
doc=fitz.open();page=doc.new_page(width=600,height=150);page.insert_image(page.rect,filename=str(root/'scan.png'))
doc.new_page().insert_text((50,60),'Native text 67890')
doc.save(root/'mixed.pdf');doc.close()
