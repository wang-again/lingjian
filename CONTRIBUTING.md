# 贡献指南

感谢愿意改进灵笺。本项目当前阶段只做**本地开发、本地运行和代码整理**：不接受服务器部署、容器编排、反向代理、上线发布相关的改动。

默认运行方式是无需登录的单机模式（`LINGJIAN_AUTH_MODE=local`）；账号模式仍需保持可用，改动涉及会话、鉴权或密钥存储时要两种模式都验证。

## 本地开发

需要 Node.js 22.23.5、24.22.3、26.13.1 或对应版本线的更高补丁版本。桌面版依赖 Electron。

```bash
npm ci           # 安装锁定的依赖
npm start        # 打开桌面工作台
npm run start:browser # 启动浏览器版，访问 http://127.0.0.1:3210
npm run doctor   # 检查端口、数据目录、Office/OCR 依赖
npm test         # 全部自动测试
npm run check    # 语法检查
```

账号模式：在 `.env` 中设置 `LINGJIAN_AUTH_MODE=accounts` 后启动，才会出现登录页。`tests/fixtures/http.mjs` 的 `createTestApp` 默认用单机模式，账号相关用例显式传 `authMode: 'accounts'`。

基础开发只需要 Node.js。Office 文档处理与本地 OCR 需要 Python 3.10+，组件安装方式见 README 的「可选安装 Office 工具」：

- Windows：双击 `安装Office依赖.cmd`
- Linux/macOS：`python3 -m venv .venv-office && .venv-office/bin/python -m pip install -r requirements-office.txt`
- 验证：`.venv-office/bin/python tools/check-ocr.py`（Windows 用 `.venv-office\Scripts\python.exe`）

缺少兼容 Office 集成时，需要它的测试会标为跳过。验证完整集成请使用带精确修改和 OCR 的本地副本，通过 `OFFICE_TOOL_DIR` 指定目录，然后运行 `npm run test:office`。

## 依赖升级

`requirements-office.txt` 只写允许的版本区间，`requirements-office.lock` 记录当前验证过的顶层版本（9 个直接依赖，不含传递依赖）。`npm run doctor` 会比对两者与已装版本，不一致时给出具体包名。

升级流程：

1. 在 `.venv-office` 中安装目标版本，跑 `npm test` 与 `npm run test:office`。
2. 用实际安装版本更新 `requirements-office.lock`。
3. 在 PR 说明里写清升级原因与验证结果；只改 lock、不改区间时也要说明。

锁文件不锁传递依赖：不同平台由 pip 解析，避免 Windows/Linux 各维护一份。

## 提交前检查

1. `npm run check` 与 `npm test` 通过；改动文档处理功能时额外跑 `npm run test:office`。
2. 自动测试使用临时目录与本地模拟模型服务，不应调用真实付费 API；请勿提交需要真实密钥才能运行的用例。
3. 新增或修改行为时同步更新 `README.md` 对应章节。
4. 参与讨论前请读 [贡献者行为准则](CODE_OF_CONDUCT.md)。

CI 在 GitHub Actions 上跑 Ubuntu 与 Windows 两个平台、Node 22 与 24 两个版本（`.github/workflows/ci.yml`）。Office 与 OCR 用例另有一个 job，因为需要真实 Python 依赖，失败不阻断主流程判定——但这不代表可以提交会让它们失败的改动。

## 敏感信息

以下内容已在 `.gitignore` 中忽略，任何情况下都不要提交：

- `.env` 及各类 `.env.*`（仅保留 `.env.example`）
- `.data/`：账号（含密码哈希）、文档、文件库、`keys.json`、备份与恢复快照
- `test-results/`：本机验收截图与测试产物
- `.venv-office/`：本机 Python 虚拟环境
- `.workbuddy/`：开发过程记录

注意 `.gitignore` 只忽略 `.data/.service.lock` 这一个运行时锁文件，**不要**改成 `*.lock`——那样会把必须入库的 `requirements-office.lock` 一并忽略掉，别人克隆后 `npm run doctor` 就找不到锁定版本。

提交前自查：

```bash
git status --ignored --short
git check-ignore -v .data/accounts.json .env
```

不要使用 `git add -f` 绕过忽略规则。示例配置只写占位符，不写真实 Key、域名、账号或邀请码。

## 代码约定

- 仅使用 Node.js 内置模块，不引入构建步骤和前端框架；新增依赖需在 PR 说明必要性。
- 文件读写、路径边界、密钥处理等安全相关逻辑需附测试。
- 注释与提交信息用中文或英文均可，同一 PR 内保持一致。

## 许可

贡献的代码按 [MIT](LICENSE) 发布。

提交前请确认你新增的内容（尤其是从别处复制的代码、模板、字体、图片）的授权与 MIT 兼容。office-tool 源码和安装文件保存在 Git 忽略目录。 [第三方组件与授权说明](docs/third-party.md)
