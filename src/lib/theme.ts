/** Appearance: System / Light / Dark, remembered per device. */
export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'psx-theme';
const media = () => window.matchMedia('(prefers-color-scheme: dark)');

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(pref: ThemePref = getThemePref()) {
  const dark = pref === 'dark' || (pref === 'system' && media().matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#000000' : '#f8fafc');
}

export function setThemePref(pref: ThemePref) {
  try { if (pref === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, pref); } catch { /* private mode */ }
  applyTheme(pref);
}

/** Follow the phone's setting while on System. */
export function watchSystemTheme() {
  const m = media();
  const on = () => getThemePref() === 'system' && applyTheme('system');
  m.addEventListener('change', on);
  return () => m.removeEventListener('change', on);
}
