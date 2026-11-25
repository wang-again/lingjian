// API addresses and model suggestions checked against the linked official docs.
// Suggestions remain editable: availability depends on the user's account.
export const providerPresets = [
  {
    id: 'bailian', name: '阿里云百炼 · 千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      'qwen-plus', 'qwen-flash', 'qwen-max',
      'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus', 'qwen3.7-max', 'qwen3.7-flash',
      'qwen3.6-plus', 'qwen3.6-flash', 'qwen3.6-35b-a3b',
      'qwen3.5-plus', 'qwen3.5-flash', 'qwen3.5-397b-a17b', 'qwen3.5-122b-a10b',
      'qwen3.5-27b', 'qwen3.5-35b-a3b', 'qwen3-coder-flash', 'qwen3-vl-plus',
      'deepseek-v4.1-flash-1017', 'glm-5.3', 'kimi-k3.1-pro', 'kimi-k3',
      'MiniMax-M3.1-Flash', 'mimo-v2.6-pro-ultraspeed', 'step-5-preview'
    ],
    maxTokens: 8192, timeout: 180,
    hint: '默认使用北京地域地址，API Key 必须与地域一致。也可改为控制台提供的业务空间专属地址；新加坡等地域请同时更换地址和密钥。第三方模型需先在百炼开通，模型可用性随地域及账号权限变化。',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
    consoleUrl: 'https://bailian.console.aliyun.com/'
  },
  {
    id: 'deepseek', name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    maxTokens: 16384, timeout: 300,
    hint: '使用 DeepSeek 开放平台 API Key。推理模型会先思考再输出正文，可在高级设置中调整输出长度和超时。',
    docsUrl: 'https://api-docs.deepseek.com/',
    consoleUrl: 'https://platform.deepseek.com/'
  },
  {
    id: 'moonshot', name: '月之暗面 · Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: [
      'kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3',
      'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6'
    ],
    modelNotes: {
      'kimi-k2.7-code': '仅 2026-11-01 前注册账号，预计 2026-12 底下线',
      'kimi-k2.7-code-highspeed': '仅 2026-11-01 前注册账号，预计 2026-12 底下线',
      'kimi-k2.6': '仅 2026-11-01 前注册账号，预计 2026-12 底下线'
    },
    maxTokens: 16384, timeout: 300,
    hint: '使用 Kimi API 开放平台的密钥。推理模型首次输出可能较慢；温度留空以使用模型默认值。',
    docsUrl: 'https://platform.kimi.com/docs/get-api-key',
    consoleUrl: 'https://platform.kimi.com/'
  },
  {
    id: 'zhipu', name: '智谱 · GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      'glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.3-flashx-legal',
      'glm-5.2', 'glm-5.1', 'glm-5', 'glm-5-turbo',
      'glm-4.7', 'glm-4.7-flashx', 'glm-4.7-flash', 'glm-4.6',
      'glm-4.5-air', 'glm-4.5-airx', 'glm-4.5-flash',
      'glm-4-flashx-250414', 'glm-4-flash-250414', 'glm-5v-turbo', 'glm-4.6v'
    ],
    maxTokens: 16384, timeout: 300,
    hint: '使用智谱开放平台的 API Key。这里预填通用 API 地址，订阅专用地址请按控制台说明修改。',
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
    consoleUrl: 'https://bigmodel.cn/'
  },
  {
    id: 'siliconflow', name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: [
      'Qwen/Qwen3.5-4B', 'deepseek-ai/DeepSeek-V4-Flash', 'deepseek-ai/DeepSeek-V4-Pro',
      'deepseek-ai/DeepSeek-V3.2', 'Pro/deepseek-ai/DeepSeek-V3.2',
      'deepseek-ai/DeepSeek-R1', 'Pro/deepseek-ai/DeepSeek-R1',
      'Qwen/Qwen3.6-27B', 'Qwen/Qwen3.6-35B-A3B', 'Qwen/Qwen3-VL-30B-A3B-Instruct',
      'Pro/moonshotai/Kimi-K2.6', 'zai-org/GLM-5.2'
    ],
    maxTokens: 8192, timeout: 180,
    hint: '模型 ID 需要保留组织名前缀及大小写。可从模型广场复制其他模型 ID；文件智能体需要所选模型支持工具调用。',
    docsUrl: 'https://docs.siliconflow.cn/docs/api/chat-completions-post',
    consoleUrl: 'https://cloud.siliconflow.cn/'
  }
];
