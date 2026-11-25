import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 这些约束是「前端字看起来发虚」的直接成因，用测试固定住，避免以后又塞回 12px 或浅灰。
const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');

const screenOnly = src => {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const start = src.indexOf('@media print', i);
    if (start === -1) { out += src.slice(i); break; }
    out += src.slice(i, start);
    let depth = 0;
    let j = src.indexOf('{', start);
    if (j === -1) break;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') { depth -= 1; if (!depth) { j += 1; break; } }
    }
    i = j;
  }
  return out;
};

const luminance = hex => {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map(char => char + char).join('') : value;
  const channels = [0, 2, 4].map(index => parseInt(full.slice(index, index + 2), 16) / 255);
  const linear = channels.map(channel => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};
const contrast = (a, b) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};

// 装饰性小字（结束符、印章角标），不承载信息。
const DECORATIVE = new Set(['.paper-end', '.collection-stamp span']);

test('屏幕样式里不出现小于 13px 的正文或标签字号', () => {
  const offenders = [];
  for (const file of ['styles.css', 'office.css', 'auth.css', 'admin.css', 'themes.css']) {
    const src = screenOnly(read(file));
    for (const match of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1].trim().split('\n').pop().trim();
      if (DECORATIVE.has(selector)) continue;
      const body = match[2];
      for (const decl of body.matchAll(/font(?:-size)?\s*:\s*([^;}]*)/g)) {
        for (const size of decl[1].matchAll(/([0-9.]+)px/g)) {
          if (parseFloat(size[1]) < 13) offenders.push(`${file} ${selector} → ${decl[0].trim()}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], '中文在 12px 及以下会明显发虚：' + offenders.join('；'));
});

test('字体族统一走令牌，中文排在拉丁字体之前', () => {
  const src = read('styles.css');
  const families = [...src.matchAll(/font-family\s*:\s*([^;}]+)/g)].map(match => match[1].trim());
  const allowed = /^var\(--font-(sans|serif|mono)\)$|^inherit$|^Georgia,serif$|^serif$/;
  const strays = families.filter(value => !allowed.test(value));
  assert.deepEqual(strays, [], '字体族应使用 --font-sans / --font-serif / --font-mono：' + strays.join('；'));

  const sans = /--font-sans\s*:\s*([^;}]+)/.exec(src)[1];
  const cjk = sans.indexOf('Microsoft YaHei');
  const latin = sans.indexOf('Segoe UI');
  assert.ok(cjk >= 0, '字体栈应包含微软雅黑');
  assert.ok(latin === -1 || cjk < latin, '中文应排在 Segoe UI 之前，否则同一行会出现两种笔画质感');
});

test('次要文字与占位符使用不同深浅，且次要文字达到 AA 以上', () => {
  const themes = read('themes.css');
  const light = themes.slice(0, themes.indexOf('[data-theme="dark"]'));
  const dark = themes.slice(themes.indexOf('[data-theme="dark"]'));

  const pick = (chunk, name) => {
    const found = new RegExp('--' + name + '\\s*:\\s*(#[0-9a-fA-F]{3,6})').exec(chunk);
    assert.ok(found, `缺少 --${name}`);
    return found[1];
  };

  const lightMuted = contrast(pick(light, 'muted'), pick(light, 'surface'));
  const lightPlaceholder = contrast(pick(light, 'placeholder'), pick(light, 'surface'));
  assert.ok(lightMuted >= 7, `浅色主题次要文字对比度只有 ${lightMuted.toFixed(1)}:1`);
  assert.ok(lightPlaceholder >= 3.5 && lightPlaceholder < lightMuted, '占位符要比正文浅、但仍可读');

  const darkMuted = contrast(pick(dark, 'muted'), pick(dark, 'surface'));
  const darkPlaceholder = contrast(pick(dark, 'placeholder'), pick(dark, 'surface'));
  assert.ok(darkMuted >= 7, `深色主题次要文字对比度只有 ${darkMuted.toFixed(1)}:1`);
  assert.ok(darkPlaceholder < darkMuted, '深色主题占位符也要比次要文字浅');
});

test('中文小标签不带正字距', () => {
  const src = read('styles.css');
  const chinese = ['.brand small', '.sidebar-label', '.quality-eyebrow', '.paper-overline', '.page-eyebrow', '.eyebrow'];
  const spaced = [];
  for (const selector of chinese) {
    const rule = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}').exec(src);
    if (rule && /letter-spacing:\s*[0-9.]+px/.test(rule[1])) spaced.push(selector);
  }
  assert.deepEqual(spaced, [], '中文标签拉开字距会显得散、不聚拢：' + spaced.join('；'));
});
