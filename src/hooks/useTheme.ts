import { useState, useEffect } from 'react';

export type Theme = 'oled' | 'dark' | 'light';

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('vortex-theme');
    if (saved === 'light' || saved === 'dark' || saved === 'oled') return saved;
    return 'oled';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('vortex-theme', theme);
  }, [theme]);

  const toggleTheme = () =>
    setTheme(t => (t === 'oled' ? 'dark' : t === 'dark' ? 'light' : 'oled'));

  return { theme, setTheme, toggleTheme };
}

