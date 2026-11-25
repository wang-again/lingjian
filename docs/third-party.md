# 第三方组件与授权说明

灵笺本身以 [MIT](../LICENSE) 发布。仓库中含有若干第三方内容，各自授权如下。打包分发、二次开发或商业使用前请先读本页。

## 汇总

| 位置 | 内容 | 授权 | 状态 |
| --- | --- | --- | --- |
| `.vendor/office-tool/` | 本地单独安装的可选 Office MCP 工具 | 上游 MIT 与 CC BY-NC 4.0 声明冲突 | 用户单独获取 |
| `resources/templates/` | 33 份模板 | 各自授权，逐份记录在 `catalog.json` | ✅ 已核对 |
| `skills/docx-delivery/scripts/check_docx.py` | 本项目编写 | MIT | ✅ |
| Python 依赖（`.venv-office`） | 见 `requirements-office.lock` | 各自开源授权，不随仓库分发 | ✅ 由使用者自行安装 |
| 字体 | 仅引用系统字体名，不分发字体文件 | — | ✅ |

## 可选的 Office Tool

2026 年 11 月 24 日核对了上游同一提交的两份声明。`LICENSE` 标为 MIT，README 说明采用 CC BY-NC 4.0，公开议题检索未找到维护者澄清。使用或分发这套组件前，请向上游确认适用于自身场景的授权。 [LICENSE](https://github.com/xhj-cloud/office-tool/blob/45b3aec259a8f8805c8483fe6403e17b052d82be/LICENSE) · [README](https://github.com/xhj-cloud/office-tool/blob/45b3aec259a8f8805c8483fe6403e17b052d82be/README.md)

公开仓库只包含灵笺编写的接入代码。选择使用 office-tool 的人可以自行获取，通过默认的 `.vendor/office-tool/` 或 `OFFICE_TOOL_DIR` 连接。已安装组件按其自身授权使用，灵笺的 MIT 许可适用于灵笺代码。

## 模板授权

`resources/templates/` 下 33 份模板逐份记录了来源、许可、署名和 SHA-256（`catalog.json`、`catalog.zh-CN.json`）。发布的许可类型：

| 发布者 | 许可 |
| --- | --- |
| business.gov.au | CC BY 3.0 AU |
| HM Treasury / HSE / Department of Finance NI | Open Government Licence v3.0 |
| Fokuus | MIT |
| official-document-drafting contributors | MIT |

完整署名与来源链接见 [模板库说明](../resources/templates/README.md)。使用或再分发这些模板时，需保留对应署名；OGL 与 CC BY 都要求标注来源和许可。

## 免责

本项目按 MIT 许可「按原样」提供，不附带任何担保。文档内容由使用者自行核对；模型生成的内容不构成事实依据。
