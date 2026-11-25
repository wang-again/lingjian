// Apply before styles load to avoid flashing the wrong theme during sign-in/reload.
(() => {
  const key = 'lingjian.theme';
  const normalize = value => ['light', 'dark', 'system'].includes(value) ? value : 'system';
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let choice = 'system';
  try { choice = normalize(localStorage.getItem(key)); } catch {}
  function render() {
    document.documentElement.dataset.theme = choice === 'system' ? (media.matches ? 'dark' : 'light') : choice;
    document.documentElement.dataset.themeChoice = choice;
    document.querySelectorAll('[data-theme-picker]').forEach(select => { select.value = choice; });
  }
  render();
  media.addEventListener('change', () => { if (choice === 'system') render(); });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) { choice = normalize(event.newValue); render(); }
  });
  document.addEventListener('DOMContentLoaded', () => {
    render();
    document.querySelectorAll('[data-theme-picker]').forEach(select => {
      select.addEventListener('change', () => {
        choice = normalize(select.value);
        try { localStorage.setItem(key, choice); } catch {}
        render();
      });
    });
  });
})();
