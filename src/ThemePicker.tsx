import { useEffect, useState } from "react";
import {
  applyTheme,
  isThemeSelection,
  resolveTheme,
  THEME_GROUPS,
  THEMES,
  THEME_STORAGE_KEY,
  type ThemeSelection,
} from "./themes";

function storedTheme(): ThemeSelection {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeSelection(value) ? value : "system";
  } catch {
    return "system";
  }
}

export default function ThemePicker() {
  const [selection, setSelection] = useState<ThemeSelection>(storedTheme);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyTheme(resolveTheme(selection, media.matches));
    update();
    if (selection === "system") media.addEventListener("change", update);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, selection);
    } catch {
      // Theme remains active when persistence is unavailable.
    }
    return () => media.removeEventListener("change", update);
  }, [selection]);

  return (
    <label className="theme-picker" title="Color theme">
      <span className="visually-hidden">Theme</span>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41" />
      </svg>
      <select value={selection} onChange={(event) => setSelection(event.target.value as ThemeSelection)} aria-label="Theme">
        <option value="system">System</option>
        {THEME_GROUPS.map((family) => (
          <optgroup key={family} label={family}>
            {THEMES.filter((theme) => theme.family === family).map((theme) => (
              <option key={theme.id} value={theme.id}>{theme.name}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

export { ThemePicker };
