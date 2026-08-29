/**
 * Light/dark theme state.
 *
 * The palette itself lives entirely in styles.css, driven by `documentElement`'s
 * `data-theme` attribute and the `prefers-color-scheme` media query — this module
 * only owns the one bit of state a stylesheet cannot: which of the three modes the
 * user picked, persisted across visits, and the two things that follow from it that
 * CSS cannot reach either: the `<meta name="theme-color">` the OS reads for the
 * status bar/task switcher, and (needed because `<html>` renders before this module
 * runs) which theme is in effect at all.
 */
export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'marksync-theme';
// Matches --bg in styles.css for each theme. Kept in sync by hand: the meta tag
// can only ever hold one literal color, never a CSS custom property.
const META_COLOR: Record<'light' | 'dark', string> = {
  dark: '#0e0e0b',
  light: '#f6f5ee',
};

const media = window.matchMedia('(prefers-color-scheme: dark)');

function readStored(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

function effectiveTheme(pref: ThemePreference): 'light' | 'dark' {
  return pref === 'system' ? (media.matches ? 'dark' : 'light') : pref;
}

function apply(pref: ThemePreference): void {
  const root = document.documentElement;
  if (pref === 'system') {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = pref;
  }
  // Only a real DOM query, never cached: index.html owns this element and nothing
  // here needs to assume it survives untouched.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META_COLOR[effectiveTheme(pref)]);
}

let current: ThemePreference = readStored();

/** Applies the stored (or system) theme. Call once, as early in boot as possible. */
export function initTheme(): void {
  apply(current);
  // Only matters in 'system' mode — an explicit choice already pins the meta color,
  // and the CSS media query itself keeps repainting the page independently of this.
  media.addEventListener('change', () => {
    if (current === 'system') apply(current);
  });
}

export function getThemePreference(): ThemePreference {
  return current;
}

function nextPreference(pref: ThemePreference): ThemePreference {
  switch (pref) {
    case 'system':
      return 'light';
    case 'light':
      return 'dark';
    case 'dark':
      return 'system';
  }
}

/** Cycles system → light → dark → system, persists the choice, and applies it. */
export function cycleTheme(): ThemePreference {
  current = nextPreference(current);
  if (current === 'system') {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, current);
  }
  apply(current);
  return current;
}
