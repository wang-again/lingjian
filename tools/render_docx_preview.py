"""Render up to four page previews from a local PDF."""
import base64
import json
import math
import sys

import pymupdf


with pymupdf.open(sys.argv[1]) as document:
    start = int(sys.argv[2]) - 1
    pages = []
    for index in range(start, min(start + 4, len(document))):
        page = document[index]
        scale = min(1.5, math.sqrt(1_000_000 / (page.rect.width * page.rect.height)))
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
        png = base64.b64encode(pixmap.tobytes("png")).decode("ascii")
        pages.append({"page": index + 1, "png": png})
    print(json.dumps({"total": len(document), "pages": pages}))
