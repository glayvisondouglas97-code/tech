import { useCallback, useState } from 'react';

/** Preferências deste aparelho (não vão para o servidor). Tudo protegido: o navegador pode bloquear o armazenamento. */
export interface Prefs {
  templateId: string | 'none' | null;
  theme: 'auto' | 'light' | 'dark';
}

const KEY = 'cl_prefs';

function defaults(): Prefs {
  return { templateId: null, theme: 'auto' };
}

export function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    return { ...defaults(), ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return defaults();
  }
}

function writePrefs(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {}
}

export function applyTheme(theme: Prefs['theme']) {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  try {
    if (theme === 'auto') localStorage.removeItem('cl_theme');
    else localStorage.setItem('cl_theme', theme);
  } catch {}
}

export function usePrefs(): [Prefs, (patch: Partial<Prefs>) => void] {
  const [prefs, setPrefs] = useState<Prefs>(readPrefs);
  const update = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      writePrefs(next);
      return next;
    });
  }, []);
  return [prefs, update];
}

/** Guarda um valor simples por aparelho (ex.: modo foco ligado). */
export function useLocalFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? initial : raw === '1';
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: boolean) => {
      setV(next);
      try {
        localStorage.setItem(key, next ? '1' : '0');
      } catch {}
    },
    [key],
  );
  return [v, set];
}
