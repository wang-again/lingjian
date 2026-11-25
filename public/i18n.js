import english from './i18n-en.js';
import workflows from './i18n-workflows-en.js';

const translations = { ...english, ...workflows };

const preference = 'lingjian.language';
const supported = new Set(['zh-CN', 'en']);
const attributes = ['title', 'aria-label', 'placeholder', 'alt', 'data-placeholder'];
const slots = /\{\{(\d+)\}\}/g;
const markupText = /\b(title|aria-label|placeholder|alt|data-placeholder)="([^"]*)"|(^|>)([^<>]+)(?=<|$)/g;

function currentLanguage() {
  if (typeof window === 'undefined') return 'zh-CN';
  const requested = new URL(window.location.href).searchParams.get('lang');
  if (supported.has(requested)) return requested;
  try { return localStorage.getItem(preference) === 'en' ? 'en' : 'zh-CN'; }
  catch { return 'zh-CN'; }
}

export const language = currentLanguage();

export function changeLanguage(next) {
  if (!supported.has(next) || next === language) return;
  const url = new URL(window.location.href);
  try {
    localStorage.setItem(preference, next);
    url.searchParams.delete('lang');
  } catch {
    url.searchParams.set('lang', next);
  }
  window.location.replace(url);
}

function lookup(text) {
  if (language !== 'en' || typeof text !== 'string') return text;
  const key = text.trim();
  if (!key || !Object.hasOwn(translations, key)) return text;
  return text.replace(key, () => translations[key]);
}

function pattern(strings) {
  return strings.reduce((text, part, index) => index === 0 ? part : text + '{{' + (index - 1) + '}}' + part, '');
}

function fill(text, values) {
  return text.replace(slots, (slot, index) => Number(index) < values.length ? String(values[Number(index)]) : slot);
}

// Call for static UI labels or use as a template tag for app-authored messages.
export function t(message, ...values) {
  return Array.isArray(message) ? fill(lookup(pattern(message)), values) : lookup(message);
}

function escapeMarkupValue(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function localizedMarkup(markup) {
  if (language !== 'en') return markup;
  return markup.replace(markupText, (match, attribute, value, delimiter, text) => {
    const original = attribute ? value : text;
    const translated = lookup(original);
    if (translated === original) return match;
    const escaped = escapeMarkupValue(translated);
    return attribute ? `${attribute}="${escaped}"` : delimiter + escaped;
  });
}

// Translate authored HTML before inserting interpolations. Document text, filenames,
// and other interpolated values still use the caller's existing escaping.
export function uiHtml(markup, ...values) {
  return Array.isArray(markup)
    ? fill(localizedMarkup(pattern(markup)), values)
    : localizedMarkup(markup);
}

export function localizePage(page = document) {
  page.documentElement.lang = language;
  if (language !== 'en') return;
  const walker = page.createTreeWalker(page.documentElement, page.defaultView.NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement.closest('script, style, [data-language-picker]')) node.data = lookup(node.data);
  }
  const selector = attributes.map(name => `[${name}]`).join(', ');
  for (const element of page.querySelectorAll(selector)) {
    for (const attribute of attributes) {
      if (element.hasAttribute(attribute)) element.setAttribute(attribute, lookup(element.getAttribute(attribute)));
    }
  }
  const description = page.querySelector('meta[name="description"]');
  if (description) description.content = lookup(description.content);
}
