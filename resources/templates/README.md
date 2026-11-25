# 模板来源与使用说明

当前模板中心共 33 份模板，其中 18 份中文、15 份英文。中文包括原有 8 份写作框架和新增的 10 份精选模板。两份来源目录共包含 32 个本地文件：6 个 DOCX、4 个真实二进制 DOC、4 个 PDF、5 个 XLSX、1 个 XLS、12 个 Markdown。原有中文写作框架另可即时下载 Markdown。

模板中心默认筛选中文，英文原版可通过语言筛选查看。非 Markdown 原版旁的「使用中文填写提纲」是平台整理的写作起点，不声称复刻原版版式。所有 PDF 为静态打印或参考文件，不声称为交互表单。

## 新增中文模板

| 模板 | 文件 | 用法 |
| --- | --- | --- |
| 工作通知、专项工作方案 | MD / DOCX / PDF | 按方括号替换事项、单位、日期与责任分工，PDF 供打印核对 |
| 事项请示、工作情况报告 | MD / DOCX | 按实际依据、进展和待决策事项起草 |
| 专题汇报材料、工作简报、年度工作总结、会议讲话稿 | MD | 在编辑器直接套用正文结构，亦可加入文件库 |
| 年度预算执行表 中文版 | XLSX | 填浅蓝色预算和实际输入格，自动计算结余与差额 |
| 月度现金流预测表 中文版 | XLSX | 填首月期初及各月流入流出，后续期初自动结转 |

8 份中文文书的 Markdown 来自 `zhaohui-yang/official-document-drafting` 的原创模板，固定到提交 `6b4166a50b96733684b36da6336ea85a847cf3be`；Word 与 PDF 是灵笺重新排版的派生文件，不宣称为官方发文范本。全文保留 MIT 署名与许可；未收录上游第三方字体或其他二进制资源。2 份中文表格依据 business.gov.au 的开放许可模板改编，调整为 1—12 月、中文科目和单表布局，保留收支汇总、结余与滚动余额的计算功能。表内明确金额单位和含税口径，空白输入按 0 计算。具体公式以中文改编文件为准，不声称逐格复刻英文原件。

DOCX、XLSX、PDF、Markdown 可复制到文件库，让模型读取并结合实际资料填写或参考。导入始终创建新副本，原始模板保持不变。旧版 DOC / XLS 仅供下载，需在 Word、WPS 或 Excel 另存为 DOCX / XLSX 后上传，平台不把它们伪装成可直接编辑的新格式。

## 来源和许可

核对日期为 2026 年 11 月 11 日。每份文件的下载来源或派生关系、来源页、许可、署名、大小和 SHA-256 记录于 `catalog.json` 及 `catalog.zh-CN.json`，模板详情显示来源和许可链接。派生文件说明改编，未声称得到发布者背书。

| 发布者 | 收录内容 | 来源 | 许可与署名 |
| --- | --- | --- | --- |
| business.gov.au | 年度经营预算、月度现金流预测 | [预算](https://business.gov.au/finance/financial-tools-and-templates/create-a-budget)、[现金流](https://business.gov.au/finance/cash-flow/set-up-a-cash-flow-statement) | [CC BY 3.0 AU](https://creativecommons.org/licenses/by/3.0/au/)，© Commonwealth of Australia 2020；[版权说明](https://business.gov.au/legal-notices/copyright) |
| HM Treasury | 立项论证、评审核对清单、2026 投资方案评估汇总表 | [Green Book 模板](https://www.gov.uk/government/publications/the-green-book-templates-and-support-material) | Contains public sector information licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). Source: HM Treasury. |
| Health and Safety Executive | 风险记录 DOCX、办公室填写示例 PDF | [风险评估模板及示例](https://www.hse.gov.uk/simple-health-safety/risk/risk-assessment-template-and-examples.htm) | Contains public sector information licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). Source: Health and Safety Executive；[版权说明](https://www.hse.gov.uk/help/copyright.htm) |
| Department of Finance NI | 项目简报、PID、结项评审、变更单、收益跟踪 | [项目模板](https://www.finance-ni.gov.uk/publications/project-management-templates)、[通用模板](https://www.finance-ni.gov.uk/publications/templates-programmes-or-projects)、[收益管理](https://www.finance-ni.gov.uk/publications/templates-benefits-management-programmes-or-projects) | Contains public sector information licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). Source: Department of Finance, Northern Ireland；[版权说明](https://www.finance-ni.gov.uk/articles/crown-copyright-finance) |
| Fokuus | README、会议记录、技术规范、一页简历 | [markdown-templates](https://github.com/Fokuus/markdown-templates) | [MIT](https://github.com/Fokuus/markdown-templates/blob/main/LICENSE)，Copyright (c) 2026 Anton Pycarelle (Fokuus) |
| official-document-drafting contributors | 通知、请示、报告、汇报、简报、方案、总结、讲话稿 | [固定版本的中文模板](https://github.com/zhaohui-yang/official-document-drafting/tree/6b4166a50b96733684b36da6336ea85a847cf3be/assets/templates) | [MIT](https://github.com/zhaohui-yang/official-document-drafting/blob/6b4166a50b96733684b36da6336ea85a847cf3be/LICENSE)，Copyright (c) 2026 official-document-drafting contributors |

Fokuus 原版 Markdown 的末尾增加了 HTML 注释，保留完整 MIT 许可和来源。许可另存于 `Fokuus-LICENSE.txt`，在应用内可随正文导出。

项目立项论证书与工作场所风险评估的 DOCX 已移除原发布者电脑上的附加模板引用。正文和样式文件保持原样。目录分别记录上游与本地文件的 SHA-256。

## 维护

`tools/template-sources.json` 是人工审核的来源清单。需要明确更新时运行 `tools/import-template-sources.py`；导入脚本检查真实 Office 容器、拒绝宏项目并记录上游与本地校验值。运行中的应用只读取本地文件，下载或使用模板时不请求外部网站。

中文来源清单单独维护在 `tools/chinese-template-sources.json`。更新中文库依次运行 `tools/import-chinese-template-sources.py`、`tools/build-chinese-documents.py`、`tools/build-chinese-workbooks.mjs`；表格构建依赖 `@oai/artifact-tool`，文档构建依赖 `python-docx`，仅维护时需要。用 LibreOffice 和 `render_docx.py` 将四份 Word 渲染至 `test-results/chinese-templates/<模板 ID>-final/` 并逐页检查，再运行 `tools/register-chinese-pdfs.py` 收录通知及方案的 PDF。重新下载中文原版会重建中文目录，因此须重跑派生步骤并检查校验值。英文库刷新不会覆盖中文目录。

`tools/check-template-assets.py` 使用 python-docx、openpyxl 和 pypdf 对原文件做只读检查，验证正文、工作表、公式缓存及 PDF 文本。此检查不等同于 Word / Excel 原生应用的完整排版和重算验证；未重新排版或改写原文件。PDF 可用 Poppler 渲染复查。

模板下载使用固定目录清单，不接受外部 URL 或任意文件路径；服务端发送前验证校验值。后续添加模板时须同时更新来源说明、实际文件、格式与完整性测试。
