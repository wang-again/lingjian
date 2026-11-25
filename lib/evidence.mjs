import { createHash } from 'node:crypto';
import { parseBlocks, splitSentences, sourceCitation } from './html-blocks.mjs';

// 证据台账：把正文中的关键说法逐条对照“本次启用的资料原文”。
// 只做逐字与近似重合核验，不联网、不判断外部事实为真；找不到依据就明确标记，而不是猜。

const ASSERTIVE = /(显示|表明|达到|占比|合计|共计|超过|低于|预计|同比|环比|统计|调查|覆盖|约为)/;
const PLAN = /(目标|计划|下一步|继续|建议|拟|争取|预计于)/;
const MAX_SOURCES = 12;
const MAX_INDEX_CHARS = 120_000;

const normalize = value => String(value ?? '')
  .toLowerCase()
  .replace(/[\s\u3000]/g, '')
  .replace(/[，。；：！？、“”‘’（）【】《》〈〉…—－\-_,.;:!?"'()\[\]{}<>/\\|+*=~`@#$^&]/g, '');

const hash = value => createHash('sha1').update(String(value)).digest('hex').slice(0, 12);

function numbersIn(text) {
  return [...String(text ?? '').matchAll(/\d[\d,]*(?:\.\d+)?/g)].map(match => match[0].replaceAll(',', ''));
}

function sourceSentences(text) {
  const parts = String(text ?? '').match(/[^。！？；!?;\n]+[。！？；!?;]?/g) || [];
  const sentences = [];
  let offset = 0;
  for (const part of parts) {
    const norm = normalize(part);
    if (!norm) continue;
    sentences.push({ index: sentences.length, text: part.trim().slice(0, 500), norm, start: offset });
    offset += norm.length;
  }
  return sentences;
}

function prepareSource(source) {
  const raw = String(source.text ?? '');
  const text = raw.slice(0, MAX_INDEX_CHARS);
  return {
    id: source.id,
    name: source.name,
    truncated: raw.length > text.length,
    norm: normalize(text),
    sentences: sourceSentences(text),
    meta: source.meta && typeof source.meta === 'object' ? source.meta : null
  };
}

// 在规范化文本里找最长公共片段；找不到 6 字以上的连续重合就不算“有原文依据”。
function longestOverlap(claimNorm, sourceNorm) {
  if (!claimNorm || !sourceNorm) return { length: 0, index: -1 };
  const window = 6;
  if (claimNorm.length < window) return { length: 0, index: -1 };
  const step = Math.max(1, Math.floor(claimNorm.length / 32));
  let best = { length: 0, index: -1 };
  for (let start = 0; start + window <= claimNorm.length; start += step) {
    const probe = claimNorm.slice(start, start + window);
    let from = 0, hits = 0;
    while (hits < 8) {
      const hit = sourceNorm.indexOf(probe, from);
      if (hit < 0) break;
      hits++;
      let left = hit, claimLeft = start;
      while (left > 0 && claimLeft > 0 && sourceNorm[left - 1] === claimNorm[claimLeft - 1]) { left--; claimLeft--; }
      let right = hit + window, claimRight = start + window;
      while (right < sourceNorm.length && claimRight < claimNorm.length && sourceNorm[right] === claimNorm[claimRight]) { right++; claimRight++; }
      const length = right - left;
      if (length > best.length) best = { length, index: left };
      if (length >= claimNorm.length) return best;
      from = hit + 1;
    }
  }
  return best;
}

function locateSentence(source, normIndex) {
  if (normIndex < 0) return null;
  let candidate = source.sentences.find(sentence => normIndex >= sentence.start && normIndex < sentence.start + sentence.norm.length);
  if (!candidate) candidate = source.sentences.find(sentence => sentence.start >= normIndex) || source.sentences.at(-1);
  return candidate || null;
}

function locationLabel(source, sentence) {
  const locations = Array.isArray(source.meta?.locations) ? source.meta.locations : [];
  const hit = locations.find(item => item && typeof item.text === 'string' && sentence?.text && (item.text.includes(sentence.text) || sentence.text.includes(item.text.slice(0, 40))));
  if (hit?.label) return String(hit.label).slice(0, 120);
  const kind = source.meta?.origin?.kind === 'file' ? '按提取文本' : '按资料文本';
  return sentence ? `第 ${sentence.index + 1} 段（${kind}）` : '未定位';
}

function matchCitations(names, sources) {
  const resolved = [];
  for (const name of names) {
    const raw = name.trim();
    const bare = raw.replace(/\.(docx|pdf|xlsx|xlsm|pptx|txt|md|markdown|csv)$/i, '');
    const found = sources.find(source => source.name === raw)
      || sources.find(source => source.name.replace(/\.(docx|pdf|xlsx|xlsm|pptx|txt|md|markdown|csv)$/i, '') === bare)
      || sources.find(source => source.name.includes(bare) || bare.includes(source.name.replace(/\.(docx|pdf|xlsx|xlsm|pptx|txt|md|markdown|csv)$/i, '')));
    resolved.push({ name: raw, source: found || null });
  }
  return resolved;
}

export function extractClaims(html, { max = 60 } = {}) {
  const blocks = parseBlocks(html);
  const claims = [];
  for (const block of blocks) {
    if (block.tag === 'table' || /^h[1-6]$/.test(block.tag)) continue;
    const sentences = splitSentences(block.text);
    for (const [sentenceIndex, sentence] of sentences.entries()) {
      const citations = [...sentence.matchAll(sourceCitation)].map(match => match[1].trim()).filter(Boolean);
      const plain = sentence.replace(sourceCitation, '').trim();
      if (plain.length < 8 || plain.length > 300) continue;
      const hasNumber = /\d/.test(plain);
      if (!hasNumber && !citations.length && !ASSERTIVE.test(plain)) continue;
      // 计划、目标和建议是作者的安排，不是需要外部资料证明的事实；带百分比或数字结论仍保留。
      if (PLAN.test(plain) && !citations.length && !/%/.test(plain)) continue;
      claims.push({
        id: `c${claims.length + 1}`,
        text: sentence.slice(0, 500),
        plain,
        blockIndex: block.blockIndex,
        blockTag: block.tag,
        sentenceIndex,
        citations,
        anchor: { blockHash: hash(block.text), sentenceHash: hash(sentence) }
      });
      if (claims.length >= max) return claims;
    }
  }
  return claims;
}

export function buildEvidenceLedger({ html, sources = [], brief = null, maxClaims = 60 } = {}) {
  const all = Array.isArray(sources) ? sources.filter(source => source && typeof source.text === 'string') : [];
  const enabled = all.filter(source => source.enabled !== false);
  const prepared = enabled.slice(0, MAX_SOURCES).map(prepareSource);
  const notes = [];
  if (enabled.length > MAX_SOURCES) notes.push(`本次只比对前 ${MAX_SOURCES} 份启用资料（共 ${enabled.length} 份），其余资料未纳入。`);
  if (prepared.some(source => source.truncated)) notes.push(`部分资料超过 ${MAX_INDEX_CHARS.toLocaleString('zh-CN')} 字符，超出部分未比对。`);
  if (!enabled.length) notes.push('未启用参考资料：只能检查引用标记是否指向现有资料，无法核验原文依据。');
  notes.push('只核对所给资料是否支持该说法，不判断外部事实为真；引用状态需人工复核后交付。');

  const claims = extractClaims(html, { max: maxClaims }).map(claim => {
    const claimNorm = normalize(claim.plain);
    let best = null;
    for (const source of prepared) {
      const overlap = longestOverlap(claimNorm, source.norm);
      if (!overlap.length) continue;
      const coverage = claimNorm.length ? Math.min(1, overlap.length / claimNorm.length) : 0;
      if (!best || overlap.length > best.overlap) best = { source, ...overlap, coverage };
    }
    const resolvedCitations = matchCitations(claim.citations, all);
    const citedIds = new Set(resolvedCitations.filter(item => item.source).map(item => item.source.id));
    const disabledCitations = resolvedCitations.filter(item => item.source && item.source.enabled === false);
    const missingCitations = resolvedCitations.filter(item => !item.source);

    const sentence = best ? locateSentence(best.source, best.index) : null;
    const quote = sentence?.text ? sentence.text.slice(0, 300) : '';
    const supported = Boolean(best && (best.overlap >= 10 || best.coverage >= 0.45));
    const numberList = numbersIn(claim.plain);
    const missingNumbers = best ? numberList.filter(number => !best.source.norm.includes(number.toLowerCase())) : numberList;

    let status = 'unverified', note = '';
    if (missingCitations.length) {
      status = 'broken';
      note = `引用的资料「${missingCitations.map(item => item.name).join('、')}」不在当前资料列表中。`;
    } else if (disabledCitations.length) {
      status = 'broken';
      note = `引用的资料「${disabledCitations.map(item => item.name).join('、')}」已停用，本次不会随任务发送。`;
    } else if (claim.citations.length) {
      if (supported && citedIds.has(best.source.id)) {
        status = 'supported';
        note = missingNumbers.length ? `原文已匹配，但数字 ${missingNumbers.join('、')} 未在所引资料中出现，请核对。` : '所引资料中找到逐字依据。';
      } else if (supported) {
        status = 'weak';
        note = `所引资料中未找到逐字依据；相近内容出现在「${best.source.name}」，请核对引用对象。`;
      } else {
        status = 'weak';
        note = '所引资料中未找到逐字依据，可能需要补充原文或调整表述。';
      }
    } else if (supported) {
      status = 'uncited';
      const citationHint = `找到可核对原文（${best.source.name}），建议补上 [资料：${best.source.name}]。`;
      note = missingNumbers.length ? `${citationHint} 但数字 ${missingNumbers.join('、')} 未在该资料中出现，请核对。` : citationHint;
    } else if (best && best.coverage >= 0.25) {
      status = 'needs-check';
      note = '只有少量词语重合，未达到逐字依据标准，请人工确认。';
    } else {
      status = 'unverified';
      note = numberList.length ? '未在所给资料中找到依据，数字需补来源。' : '未在所给资料中找到依据。';
    }

    return {
      ...claim,
      status,
      note,
      source: best ? {
        id: best.source.id,
        name: best.source.name,
        location: locationLabel(best.source, sentence),
        quote,
        overlap: best.overlap,
        coverage: Math.round(best.coverage * 100)
      } : null,
      numbers: { total: numberList.length, missing: missingNumbers }
    };
  });

  const count = status => claims.filter(claim => claim.status === status).length;
  const summary = {
    total: claims.length,
    supported: count('supported'),
    uncited: count('uncited'),
    weak: count('weak'),
    needsCheck: count('needs-check'),
    unverified: count('unverified'),
    broken: count('broken'),
    withCitations: claims.filter(claim => claim.citations.length).length,
    sources: enabled.length,
    coverage: claims.length ? Math.round((count('supported') + count('uncited')) / claims.length * 100) : 0,
    notes
  };
  return {
    version: 1,
    at: new Date().toISOString(),
    htmlHash: hash(html),
    brief: brief ? { purpose: brief.purpose || '', audience: brief.audience || '' } : null,
    claims,
    summary
  };
}

export function locateAnchor(html, anchor) {
  if (!anchor?.blockHash) return -1;
  const blocks = parseBlocks(html);
  const exact = blocks.findIndex(block => hash(block.text) === anchor.blockHash);
  if (exact >= 0) return exact;
  return blocks.findIndex(block => anchor.sentenceHash && hash(block.text).startsWith(anchor.blockHash.slice(0, 6)));
}
