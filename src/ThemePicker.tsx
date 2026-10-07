import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  applyTheme,
  diagramColors,
  isThemeSelection,
  resolveTheme,
  THEME_GROUPS,
  THEMES,
  THEME_STORAGE_KEY,
  type ThemeSelection,
  type AppTheme,
} from "./themes";
import "./ThemePicker.css";

type WallpaperTheme = Pick<AppTheme, "scheme" | "colors">;

const selectionName = (selection: ThemeSelection): string => {
  if (selection === "system") return "System";
  if (selection === "wallpaper") return "Wallpaper";
  return THEMES.find((theme) => theme.id === selection)?.name ?? "System";
};

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
  const picker = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    let active = true;
    let timer: number | undefined;
    const fallback = () => applyTheme(resolveTheme("system", media.matches));
    const update = async () => {
      if (selection !== "wallpaper") {
        applyTheme(resolveTheme(selection, media.matches));
        return;
      }
      try {
        const sampled = await invoke<WallpaperTheme | null>("wallpaper_theme");
        if (active && sampled) applyTheme({ id: "wallpaper", name: "Wallpaper", family: "Basic", ...sampled, diagram: diagramColors(sampled.colors) });
        else if (active) fallback();
      } catch {
        if (active) fallback();
      }
      if (active && selection === "wallpaper") timer = window.setTimeout(update, 5_000);
    };
    update();
    if (selection === "system") media.addEventListener("change", update);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, selection);
    } catch {
      // Theme remains active when persistence is unavailable.
    }
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      media.removeEventListener("change", update);
    };
  }, [selection]);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      const element = picker.current;
      if (element && !element.contains(event.target as Node)) element.open = false;
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, []);

  const choose = (value: ThemeSelection) => {
    setSelection(value);
    if (picker.current) picker.current.open = false;
  };

  return (
    <details ref={picker} className="theme-picker" title="Color theme" onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (picker.current) picker.current.open = false;
        picker.current?.querySelector("summary")?.focus();
      }
    }}>
      <summary aria-label={`Theme: ${selectionName(selection)}`}>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41" />
        </svg>
        <span>{selectionName(selection)}</span>
      </summary>
      <div className="theme-picker__menu" aria-label="Themes">
        <button aria-pressed={selection === "system"} onClick={() => choose("system")}>System</button>
        <button aria-pressed={selection === "wallpaper"} onClick={() => choose("wallpaper")}>Wallpaper <small>Windows</small></button>
        {THEME_GROUPS.map((family) => (
          <div className="theme-picker__group" role="group" aria-label={family} key={family}>
            <span>{family}</span>
            {THEMES.filter((theme) => theme.family === family).map((theme) => (
              <button key={theme.id} aria-pressed={selection === theme.id} onClick={() => choose(theme.id)}>{theme.name}</button>
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}

export { ThemePicker };
