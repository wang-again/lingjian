# 模型厂商连接复核

复核日期：2026 年 11 月 11 日。范围为当前五个内置厂商预设及默认模型，不声称所有预设型号或所有账号均已获得调用权限。

## 真实网络检查

`node tools/probe-provider-network.mjs` 使用工作台实际的地址拼接、模型目录适配和请求构造代码，对每个预设发出一次不带 Key 的目录 GET 和对话 POST。未读取或发送 API Key。

| 厂商 | 默认模型 | 模型目录 GET | 对话 POST | 检查结果 |
| --- | --- | --- | --- | --- |
| 阿里云百炼 | qwen-plus | HTTP 401 | HTTP 401 | 到达鉴权层 |
| DeepSeek | deepseek-flash | HTTP 401 | HTTP 401 | 到达鉴权层 |
| Kimi | kimi-k3.1-pro | HTTP 401 | HTTP 401 | 到达鉴权层 |
| 智谱 | glm-5.3 | HTTP 401 | HTTP 401 | 到达鉴权层 |
| 硅基流动 | Qwen/Qwen3.5-4B | HTTP 401 | HTTP 401 | 到达鉴权层 |

401 是这些无凭证探测的预期结果，只说明 DNS、TLS、网络访问及厂商网关能响应。它不能证明 Key 正确、账号有权限或余额充足，也不能证明每个模型 ID 都可用。当前工作区没有保存模型配置，本机 3210 服务未运行，未执行真实账号的生成调用。

运行脚本会保存 `test-results/provider-network-audit.json`，含实际请求地址、检查时间、HTTP 状态及耗时。网络、网关或账号状态变化后需重新验证。

## 工作台协议回归

`tests/provider-matrix.test.mjs` 逐个预设通过本地模拟上游验证：

- 通过 HTTP 保存独立配置，使用各自的 Bearer Key，后续测试和目录查询可复用本次进程中保存的 Key。
- 使用各家规定的路径；百炼切换原生目录、携带分页和 TG 筛选，硅基流动携带 chat 筛选。
- 流式与非流式连接测试均返回正文，模型 ID、输出预算及默认不发送温度的行为保留。
- 两种输出模式的工具调用与后续结果回传，保留思考内容并正确组装工具参数。

这些回归使用模拟 Key 和响应，证明应用的请求与解析链路，不等同于厂商的真实账号测试。现有真实 Office 测试另行验证文件工具执行。

本次补充硅基流动 `x-siliconcloud-trace-id` 响应头的识别，避免错误诊断漏掉厂商追踪编号。

## 官方地址核对依据

- [百炼 Base URL](https://help.aliyun.com/zh/model-studio/base-url) 与 [模型目录](https://help.aliyun.com/zh/model-studio/list-models)：按量付费北京域名仍可使用，Key 与地域、计费方案须匹配。
- [DeepSeek 首次调用](https://api-docs.deepseek.com/)：`https://api.deepseek.com`，默认模型 `deepseek-flash`。
- [Kimi 快速开始](https://platform.kimi.com/docs/get-api-key)：`https://api.moonshot.cn/v1`，默认模型 `kimi-k3.1-pro`。
- [智谱 OpenAI 兼容](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction)：`https://open.bigmodel.cn/api/paas/v4/`，示例模型 `glm-5.3`。
- [硅基流动 Chat API](https://docs.siliconflow.cn/docs/api/chat-completions-post)：`https://api.siliconflow.cn/v1/chat/completions`，Bearer 认证；错误排查可使用 `x-siliconcloud-trace-id`。

## 真实账号的最后一步

在工作台分别填写五家自己的 Key、账号对应地域和可用模型，保存配置后执行「测试连接」。测试会实际生成一条简短回复，可能计费。每家得到非空回复后才能确认该账号及所选模型可调用；如果失败，复制页面排查信息，不要发送 API Key。
