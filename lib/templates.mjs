import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const editorTemplates = [
  {
    id: 'proposal', category: '商务办公', title: '项目策划方案', subtitle: '把想法转化为清晰、可执行的行动', color: 'slate', tag: '精选模板',
    description: '适用于新项目立项、内部提案和业务规划，覆盖目标、路径、资源与验收。',
    rules: '先说明问题和目标，再展开执行路径。区分已知事实与假设；缺失的预算、日期和负责人标注“待补充”。用里程碑和验收标准描述执行计划。',
    sections: ['项目概述', '背景与问题', '目标与成功标准', '实施路径', '资源与预算', '风险与应对', '里程碑与验收'],
    content: '## 一、项目概述\n用一段话说明项目为谁解决什么问题，以及预期交付的成果。\n\n## 二、背景与问题\n- 当前现状：待补充\n- 核心问题：待补充\n- 支撑材料：待补充\n\n## 三、目标与成功标准\n目标应当明确、可衡量，并注明验收依据。\n\n| 目标 | 衡量方式 | 验收标准 |\n| --- | --- | --- |\n| 核心目标 | 待补充 | 待补充 |\n\n## 四、实施路径\n### 阶段一：需求确认\n梳理需求边界，确认交付清单与协作方式。\n### 阶段二：实施与验证\n按照里程碑推进，并定期评审成果。\n### 阶段三：交付与复盘\n完成验收、归档和经验总结。\n\n## 五、资源与预算\n列明人员、时间、工具与费用；未确认的金额标注为待补充。\n\n## 六、风险与应对\n| 风险 | 影响 | 应对措施 |\n| --- | --- | --- |\n| 需求变化 | 进度与范围变动 | 建立需求确认与变更记录 |\n\n## 七、里程碑与验收\n明确每个阶段的负责人、交付物、时间与验收标准。'
  },
  {
    id: 'research', category: '研究分析', title: '调研分析报告', subtitle: '让材料、数据与结论彼此对应', color: 'blue', tag: '证据驱动',
    description: '适用于用户调研、市场分析和专题研究，强调研究口径和结论依据。',
    rules: '区分访谈、问卷和公开资料。标明样本与统计口径。每项结论对应资料依据，不编造调查数据、文献或样本；指出局限性。',
    sections: ['研究摘要', '背景与研究问题', '方法与样本', '主要发现', '分析与讨论', '建议与局限', '资料来源'],
    content: '## 一、研究摘要\n简述研究问题、研究方法、关键发现与建议。\n\n## 二、背景与研究问题\n说明研究的背景、对象和需要回答的具体问题。\n\n## 三、方法与样本\n- 研究方法：待补充\n- 调研时间：待补充\n- 样本规模与来源：待补充\n- 数据处理与统计口径：待补充\n\n## 四、主要发现\n### 发现一：待补充\n按“发现—证据—解释”的顺序展开。\n### 发现二：待补充\n标明所引用的资料名称与位置。\n\n## 五、分析与讨论\n解释发现之间的关联，区分相关关系与因果推断。\n\n## 六、建议与研究局限\n根据证据提出建议，并说明样本、方法和数据的限制。\n\n## 七、资料来源\n逐项列出实际使用的文件、公开资料或文献。'
  },
  {
    id: 'review', category: '商务办公', title: '工作总结与复盘', subtitle: '从完成了什么，到下一步怎么做', color: 'sand', tag: '常用',
    description: '适用于月度、季度、年度工作总结及项目复盘。',
    rules: '用实际成果与目标对照，明确个人或团队贡献。数据必须有来源；复盘应说明原因、可改进动作和负责人，避免空泛评价。',
    sections: ['阶段概览', '目标与成果', '关键工作', '问题与复盘', '下一阶段计划'],
    content: '## 一、阶段概览\n总结周期：待补充\n本阶段重点：待补充\n\n## 二、目标与成果\n| 原定目标 | 实际成果 | 完成情况 |\n| --- | --- | --- |\n| 待补充 | 待补充 | 待补充 |\n\n## 三、关键工作\n### 重点工作一\n说明采取的行动、产生的结果和可验证的依据。\n### 重点工作二\n说明协作过程与实际贡献。\n\n## 四、问题与复盘\n从问题、原因、经验和改进措施四个方面展开。\n\n## 五、下一阶段计划\n明确优先事项、负责人、时间节点与预期成果。'
  },
  {
    id: 'business', category: '商务办公', title: '商业计划书', subtitle: '讲清价值、模式和增长路径', color: 'ink', tag: '完整框架',
    description: '适用于创业构想、商业模式梳理与早期项目沟通。',
    rules: '明确目标客户、付费主体和价值主张。市场规模与预测必须标明来源或假设；财务预测需说明计算口径。',
    sections: ['执行摘要', '问题与解决方案', '客户与市场', '产品与竞争', '商业模式', '增长计划', '团队与财务'],
    content: '## 一、执行摘要\n概括目标客户、核心价值、商业模式和当前阶段。\n\n## 二、问题与解决方案\n说明客户面临的问题，以及产品如何解决。\n\n## 三、客户与市场\n描述目标客户、使用场景、购买决策与市场依据。\n\n## 四、产品与竞争\n列出核心功能、替代方案及差异化价值。\n\n## 五、商业模式\n说明收费方式、成本结构与关键经营指标。\n\n## 六、增长计划\n说明客户获取、留存和阶段性验证计划。\n\n## 七、团队与财务\n列明团队职责、资金需求和预测假设。'
  },
  {
    id: 'requirements', category: '产品技术', title: '产品需求文档', subtitle: '对齐问题、功能边界和验收标准', color: 'blue', tag: 'PRD',
    description: '帮助产品、设计与研发团队形成可以评审和验收的需求说明。',
    rules: '从用户问题出发，用场景说明需求。写明正常流程、异常情况、权限边界、优先级和可验证的验收条件。',
    sections: ['背景与目标', '用户与场景', '范围与优先级', '功能说明', '异常与边界', '验收标准'],
    content: '## 一、背景与目标\n描述需要解决的用户问题和衡量目标。\n\n## 二、用户与场景\n明确用户角色、触发条件和完成任务的路径。\n\n## 三、范围与优先级\n| 需求 | 优先级 | 本期范围 |\n| --- | --- | --- |\n| 核心需求 | P0 | 待补充 |\n\n## 四、功能说明\n### 功能一\n- 入口与前置条件\n- 输入与输出\n- 交互与业务规则\n\n## 五、异常与边界\n说明空状态、失败重试、权限和数据边界。\n\n## 六、验收标准\n用具体操作和预期结果描述可验证的验收条件。'
  },
  {
    id: 'minutes', category: '日常协作', title: '会议纪要', subtitle: '把讨论留成决策与行动', color: 'slate', tag: '高效协作',
    description: '将会议内容整理为讨论要点、明确决策及有负责人的行动项。',
    rules: '区分提议、争议和已确认决策。未明确的信息标注待确认，不虚构参会人、结论、负责人或截止时间。',
    sections: ['会议信息', '讨论要点', '确认决策', '行动事项', '待确认问题'],
    content: '## 一、会议信息\n- 会议主题：待补充\n- 会议时间：待补充\n- 参会人员：待补充\n\n## 二、讨论要点\n按议题记录核心观点与分歧。\n\n## 三、确认决策\n只记录会议已明确达成的决策。\n\n## 四、行动事项\n| 事项 | 负责人 | 截止时间 | 交付物 |\n| --- | --- | --- | --- |\n| 待补充 | 待确认 | 待确认 | 待补充 |\n\n## 五、待确认问题\n列明尚未决定的问题和后续确认方式。'
  },
  {
    id: 'policy', category: '日常协作', title: '制度与操作规范', subtitle: '把经验沉淀成可遵循的流程', color: 'sand', tag: '流程清晰',
    description: '适用于团队制度、岗位操作指南和标准作业流程。',
    rules: '明确适用范围、职责、操作步骤与例外处理。每一步写明执行者、输入、动作和输出。不得虚构法规条款。',
    sections: ['目的与范围', '术语与职责', '操作流程', '例外处理', '记录与检查', '版本说明'],
    content: '## 一、目的与适用范围\n说明规范的目的、适用对象和业务边界。\n\n## 二、术语与职责\n列出必要术语及各角色职责。\n\n## 三、操作流程\n### 步骤一：准备\n明确执行人、前置条件和所需材料。\n### 步骤二：执行\n按顺序描述动作与检查点。\n### 步骤三：完成\n说明交付结果、记录和归档位置。\n\n## 四、例外与升级处理\n说明异常情况的处理方式与升级路径。\n\n## 五、记录与检查\n列明记录要求、检查频率和负责角色。\n\n## 六、版本说明\n版本：V1.0\n生效日期：待确认\n负责人：待确认'
  },
  {
    id: 'application', category: '研究分析', title: '项目申报材料', subtitle: '让问题、创新和实施逻辑完整衔接', color: 'ink', tag: '申报框架',
    description: '适用于课题、竞赛及创新项目的初稿组织，具体要求以申报通知为准。',
    rules: '依照实际申报要求组织内容。研究基础、成果、预算与引用必须有依据；突出问题与方案的对应关系，不虚构奖项、数据和成果。',
    sections: ['项目摘要', '背景与意义', '目标与内容', '特色与创新', '实施计划', '已有基础', '预期成果与预算'],
    content: '## 一、项目摘要\n概括项目问题、目标、方法与预期成果。\n\n## 二、背景与意义\n结合实际资料说明问题和项目价值。\n\n## 三、目标与主要内容\n明确研究或实施目标，以及相互对应的任务。\n\n## 四、特色与创新\n说明与已有方案相比的具体改进及证据。\n\n## 五、实施计划\n按阶段列出工作内容、时间和交付物。\n\n## 六、已有基础与团队分工\n只填写真实存在的工作基础、资源与团队经历。\n\n## 七、预期成果与预算\n说明成果形式、验收方式、预算构成和计算依据。'
  }
];

const resourceRoot = new URL('../resources/templates/', import.meta.url);
const curated = ['catalog.zh-CN.json', 'catalog.json'].flatMap(file => JSON.parse(readFileSync(new URL(file, resourceRoot), 'utf8')));

function outline(template) {
  return `# ${template.title}\n\n> 这是平台整理的中文填写提纲，${template.language === '中文' ? '中文模板文件' : '原版文件'}请在模板详情中下载。\n\n` + template.sections.map(section => `## ${section}\n\n填写本部分的实际信息、依据和待确认事项。`).join('\n\n') + `\n\n## 填写与检查\n\n${template.usage.map(item => `- ${item}`).join('\n')}\n\n## 参考来源\n\n${template.source.name}\n${template.source.url}\n\n${template.source.attribution}\n${template.source.licenseUrl}\n`;
}

export const templates = [
  ...editorTemplates.map(template => ({ ...template, language: '中文', editorLabel: '使用中文模板', usage: ['填写项目的实际背景与目标。', '提供资料后，可让 AI 根据内置规范起草，缺失信息会保留待补充。', '完成后可从编辑器导出 Word 或 Markdown。'], assets: [{ id: 'markdown', format: 'MD', label: '中文 Markdown 模板', generated: true }] })),
  ...curated.map(template => {
    const markdown = template.assets.find(asset => asset.format === 'MD');
    const license = markdown ? readFileSync(new URL(template.source.licenseFile || 'Fokuus-LICENSE.txt', resourceRoot), 'utf8') : '';
    const content = markdown ? readFileSync(new URL(markdown.file, resourceRoot), 'utf8').replace(/\n\n<!--\nSource:[\s\S]*$/, '') + `\n\n## 来源与许可\n\nSource: ${template.source.url}\n\n${license}` : outline(template);
    const { licenseFile, ...source } = template.source;
    return { ...template, source, color: 'slate', tag: template.language === '中文' ? '中文精选' : '来源精选', content, editorLabel: markdown ? '在编辑器打开 Markdown' : '使用中文填写提纲', assets: template.assets.map(({ file, upstreamSha256, ...asset }) => ({ ...asset, downloadName: `${template.title} - ${asset.label}.${asset.format.toLowerCase()}` })) };
  })
].sort((a, b) => Number(b.language === '中文' && !!b.source) - Number(a.language === '中文' && !!a.source));

// Internal paths never come from an HTTP request or the public bootstrap data.
export function templateResource(templateId, assetId) {
  const template = templates.find(item => item.id === templateId);
  const asset = template?.assets.find(item => item.id === assetId);
  if (!asset) return null;
  if (asset.generated) return { template, asset, bytes: Buffer.from(`# ${template.title}\n\n${template.content}\n`, 'utf8'), name: `${template.title}.md` };
  const internal = curated.find(item => item.id === templateId)?.assets.find(item => item.id === assetId);
  if (!internal || !/^[a-z0-9-]+\.(docx?|xlsx?|pdf|md)$/.test(internal.file)) return null;
  return { template, asset, path: fileURLToPath(new URL(internal.file, resourceRoot)), name: asset.downloadName };
}

// Custom templates live in the workspace instead of resources/templates/.
// They only expose the generated Markdown asset, so no filesystem path is taken from a request.
export function customTemplateResource(template, assetId) {
  if (!template || typeof template.content !== 'string' || assetId !== 'markdown') return null;
  const asset = { id: 'markdown', format: 'MD', label: '中文 Markdown 模板', generated: true };
  return { template, asset, bytes: Buffer.from(`# ${template.title}\n\n${template.content}\n`, 'utf8'), name: `${String(template.title).slice(0, 80)}.md` };
}

export function initialDocument() {
  return {
    id: crypto.randomUUID(), title: '秋季阅读活动策划案', templateId: 'proposal',
    html: '<h2>一、活动主题</h2><p>本季以“在街角读一本书”为题，在社区图书馆和沿街书店设置三个共读点。读者可自带一本书，围绕同一段文字交换各自的阅读体验。</p><h2>二、现场安排</h2><p>周六上午开放自由阅读，下午三点开始小组共读。每组由一位领读人主持，结束前留十分钟，邀请读者为下一场活动推荐书目。</p>',
    sources: [], history: [], revision: 1, brief: null, evidence: null, delivery: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
}
