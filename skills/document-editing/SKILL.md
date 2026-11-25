---
name: document-editing
description: 修改已有 Word、文字型 PDF、Excel 或 PPT，先定位实际原文，再按快照修改、核对并另存副本。
---

# 修改现有文档

用户要求修改已有 DOCX/PDF 时，优先 inspect_document + edit_document，不要重新生成整份文件来代替局部修改。

XLSX/PPTX 也使用 inspect_document → preview_document_edits → edit_document，不能为局部修改重建整份文件。Excel 指定 sheet_name、cell_range（如 B2:C5）读取底层值及空白格，只能按 cell_operations 使用 set_spreadsheet_cell；find 为完整底层值，replace 为新值字符串，value_type 必选 string/number/boolean/blank。数字格式保留，日期可能显示序列号，不能假装已经转换日期；公式、合并区域、数据验证、链接、富文本、隐藏或受保护工作表禁止修改。不生成新公式，不增删行列；保存会清除公式缓存并要求打开 Excel 后重算，不能声称计算已完成。PPT 使用实际 slide_operations 允许的位置，以 replace_slide_text 改写唯一文字片段，保留未改文字样式；不修改图片、母版、备注、图表或 SmartArt，域和链接段落受保护。PPT 长文字可能溢出，没有实际渲染不能声称版式已检查。只支持 XLSX/PPTX，宏、数字签名、旧 XLS/PPT 文件不支持此精确流程。
先用 inspect_document(file_path, query, limit) 检索实际原文，读取 source_sha256、location 和上下文。相同短语可能出现在多处，必须结合用户指定的位置确定目标，不猜坐标或段落编号。无匹配时换关键词查找，不虚构成功。

edit_document 的 spec_json 为：
{"source_sha256":"实际快照","operations":[{"location":"实际定位","find":"实际原文","replace":"用户要求的新内容","expected_matches":1}]}
output 可省略，平台自动另存副本。同一批次位置基于修改前快照，最多 50 项；重复匹配数量必须明确，不能为了绕过错误随意增加 expected_matches。文件已变化时重新定位。DOCX 支持正文、表格、页眉页脚、文本框及脚注；自动域和已有修订不能作为普通文字改写。PDF 仅支持可选中文字的行内替换，长文字放不下时不要擅自缩小字号，说明需要缩短内容或修改 Word 原件。扫描件需要 OCR，不能声称已修改。

工具会核对实际新文字。读取 changes 和 limitations，说明修改数量及必要限制。DOCX 另有结构检查；PDF 可渲染修改页并调用 read_image 查看，但没有实际目检不能声称版式完全一致。不要让用户选择工具或填写 JSON。

Word 表格任务先 inspect_document(include_tables=true) 获取真实表格号、行列号、整行及单元格位置，按返回的 table_operations 操作。set_cell_text 使用完整单元格 find（空白格可为空），replace 为单段文字；insert_row_before/insert_row_after 使用整行完整 text 作为 find，replace 为与参考行列数一致的 JSON 文字数组；delete_row 的 replace 为空。插入继承参考行及各单元格的格式，同一行的结构操作不能与内部单元格或文字修改混用。整表须为普通矩形表格；合并、嵌套、重复表头以及含域、图片、修订、书签等内容的目标行受保护。不能删除最后一行，不增删列，不自动重算公式或汇总。PDF 不支持表格结构修改。

Word 正文普通段落可使用结构操作。先确认 inspect_document 对该位置返回的 paragraph_operations 允许目标类型；find 必须是完整段落，expected_matches 为1。同一段落不能在同批次混用多个结构操作或文字替换。type=insert_before 或 insert_after 时 replace 为一个非空新段落；delete_paragraph 时 replace 为空；split_paragraph 时 replace 在原文中添加一个换行，两段均非空且不改字。插入继承参考段落和首个文字片段样式，拆分保留原文字片段样式。表格、页眉页脚、文本框、图片、域、修订、书签范围、编号和分节等段落不开放结构操作；PDF 仍只支持 replace_text。可先用 preview_document_edits 做不保存的整批预检。
