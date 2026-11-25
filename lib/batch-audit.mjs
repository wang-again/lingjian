// 跨文档批量审计与对比：对多篇文档跑同一套确定性检查，再汇总成一张可比较的表。
// 不进模型，不修改任何文档；每篇文档的检查结果与单篇体检完全同源，避免两套口径。

import { buildEvidenceLedger } from './evidence.mjs';
import { runDeliveryCheck } from './delivery-check.mjs';
import { sectionStats } from './sections.mjs';
import { mergeSources } from './projects.mjs';

export const BATCH_LIMIT = 20;

export function auditDocument(document, { project = null } = {}) {
  if (!document || typeof document.html !== 'string') throw new Error('缺少可审计的文档正文。');
  const sources = mergeSources(document.sources, project);
  const scoped = { ...document, sources };
  const ledger = buildEvidenceLedger({ html: document.html, sources, brief: document.brief || null });
  const report = runDeliveryCheck({ document: scoped, ledger });
  const sections = sectionStats(document.html);
  return {
    id: document.id,
    title: document.title,
    revision: document.revision,
    templateId: document.templateId || null,
    projectId: document.projectId || null,
    projectName: project?.name || '',
    words: report.stats.words,
    sections,
    sources: { total: sources.length, enabled: sources.filter(source => source.enabled !== false).length },
    citations: report.stats.citations,
    coverage: report.stats.evidenceCoverage,
    grade: report.grade,
    score: report.score,
    counts: report.counts,
    topIssues: report.issues.filter(issue => issue.severity !== 'info').slice(0, 3).map(issue => ({ severity: issue.severity, title: issue.title, category: issue.category })),
    at: report.at
  };
}

const GRADE_ORDER = { blocked: 0, review: 1, ready: 2 };

export function runBatchAudit({ documents = [], ids = null, projects = [] } = {}) {
  const wanted = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  const selected = documents.filter(document => (wanted ? wanted.has(document.id) : true)).slice(0, BATCH_LIMIT);
  if (!selected.length) throw new Error('没有选择要审计的文档。');
  const projectById = new Map((projects || []).map(project => [project.id, project]));
  const rows = selected.map(document => auditDocument(document, { project: projectById.get(document.projectId) || null }));
  const byGrade = { ready: 0, review: 0, blocked: 0 };
  for (const row of rows) byGrade[row.grade]++;
  const averageScore = Math.round(rows.reduce((sum, row) => sum + row.score, 0) / rows.length);
  const issueMap = new Map();
  for (const row of rows) {
    for (const issue of row.topIssues) {
      const entry = issueMap.get(issue.title) || { title: issue.title, severity: issue.severity, category: issue.category, documents: [] };
      entry.documents.push(row.title);
      issueMap.set(issue.title, entry);
    }
  }
  const commonIssues = [...issueMap.values()]
    .filter(entry => entry.documents.length > 1)
    .sort((a, b) => b.documents.length - a.documents.length || GRADE_ORDER[a.severity] - GRADE_ORDER[b.severity])
    .slice(0, 8)
    .map(entry => ({ ...entry, count: entry.documents.length, documents: entry.documents.slice(0, 5) }));
  const outliers = rows
    .filter(row => row.grade === 'blocked' || row.score < averageScore - 15)
    .sort((a, b) => a.score - b.score)
    .map(row => ({ id: row.id, title: row.title, score: row.score, grade: row.grade }));
  return {
    version: 1,
    at: new Date().toISOString(),
    count: rows.length,
    rows,
    summary: {
      byGrade,
      averageScore,
      totalIssues: rows.reduce((sum, row) => sum + row.counts.blocker + row.counts.warn + row.counts.info, 0),
      blockers: rows.reduce((sum, row) => sum + row.counts.blocker, 0),
      words: rows.reduce((sum, row) => sum + row.words, 0),
      commonIssues,
      outliers
    },
    compare: {
      metrics: [
        { key: 'words', label: '正文字数' },
        { key: 'sections', label: '章节数' },
        { key: 'citations', label: '引用标记' },
        { key: 'coverage', label: '依据覆盖 %' },
        { key: 'blocker', label: '必须处理' },
        { key: 'warn', label: '建议确认' },
        { key: 'score', label: '体检得分' }
      ],
      rows: rows.map(row => ({
        id: row.id, title: row.title, grade: row.grade,
        values: {
          words: row.words, sections: row.sections.total, citations: row.citations,
          coverage: row.coverage, blocker: row.counts.blocker, warn: row.counts.warn, score: row.score
        }
      }))
    },
    scope: '批量审计逐篇执行与单篇体检相同的结构、占位符、引用与依据检查；对比表只并列指标，不做跨文档事实核对。'
  };
}
