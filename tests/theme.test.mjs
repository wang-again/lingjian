import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8');
function browser({stored = null, dark = false, blocked = false} = {}) {
  const events = {}, documentEvents = {}, mediaEvents = {}, values = new Map([['lingjian.theme', stored]]);
  const selects = Array.from({length: 2}, () => ({value: '', handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; }}));
  const media = {matches: dark, addEventListener(name, fn) { mediaEvents[name] = fn; }};
  const document = {documentElement: {dataset: {}}, querySelectorAll: () => selects, addEventListener(name, fn) { documentEvents[name] = fn; }};
  const localStorage = {getItem(key) { if (blocked) throw Error('blocked'); return values.get(key); }, setItem(key, value) { if (blocked) throw Error('blocked'); values.set(key, value); }};
  vm.runInNewContext(source, {window: {matchMedia: () => media, addEventListener(name, fn) { events[name] = fn; }}, document, localStorage});
  return {data: document.documentElement.dataset, selects, values,
    ready: () => documentEvents.DOMContentLoaded(),
    choose(value) { selects[0].value = value; selects[0].handlers.change(); },
    system(value) { media.matches = value; mediaEvents.change(); },
    storage(value, key = 'lingjian.theme') { events.storage({key, newValue: value}); }};
}

test('system theme applies before DOM ready and tracks live OS changes', () => {
  const b = browser({dark: true});
  assert.equal(b.data.theme, 'dark');
  b.ready(); b.system(false);
  assert.equal(b.data.theme, 'light');
  assert.ok(b.selects.every(s => s.value === 'system'));
});
test('explicit choice persists across reload and overrides OS until system is selected again', () => {
  const b = browser({dark: false}); b.ready(); b.choose('dark'); b.system(false);
  assert.equal(b.data.theme, 'dark');
  assert.ok(b.selects.every(s => s.value === 'dark'));
  assert.equal(browser({stored: b.values.get('lingjian.theme')}).data.theme, 'dark');
  b.choose('system'); assert.equal(b.data.theme, 'light'); b.system(true);
  assert.equal(b.data.theme, 'dark');
});
test('blocked browser storage still permits session theme switching', () => {
  const b = browser({blocked: true}); b.ready(); b.choose('dark');
  assert.equal(b.data.theme, 'dark'); b.choose('light'); assert.equal(b.data.theme, 'light');
});
test('invalid preferences fall back safely; other tabs and clearing preferences synchronize', () => {
  const b = browser({stored: 'invalid', dark: true}); b.ready();
  assert.equal(b.data.themeChoice, 'system');
  b.storage('light'); assert.equal(b.data.theme, 'light');
  b.storage('dark', 'unrelated'); assert.equal(b.data.theme, 'light');
  b.storage(null, null); assert.equal(b.data.themeChoice, 'system'); assert.equal(b.data.theme, 'dark');
});
