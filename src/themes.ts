export const THEME_STORAGE_KEY = "codeflow.theme";

export type ThemeId =
  | "light"
  | "dark"
  | "catppuccin-latte"
  | "catppuccin-frappe"
  | "catppuccin-macchiato"
  | "catppuccin-mocha"
  | "sand"
  | "dawn-paper"
  | "golden-sand"
  | "golden-paper"
  | "sunset"
  | "dusk";

export type ThemeSelection = ThemeId | "system" | "wallpaper";

export type ThemeColors = {
  bg: string;
  panel: string;
  panel2: string;
  elevated: string;
  line: string;
  lineStrong: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  accentHover: string;
  accentSoft: string;
  danger: string;
  success: string;
  warm: string;
  shadow: string;
};

export type AppTheme = {
  id: ThemeId | "wallpaper";
  name: string;
  family: "Basic" | "Catppuccin" | "Solar / Sand";
  scheme: "light" | "dark";
  colors: ThemeColors;
  diagram: DiagramColors;
};

export type DiagramColors = {
  processFill: string;
  processStroke: string;
  decisionFill: string;
  decisionStroke: string;
  ioFill: string;
  ioStroke: string;
  terminatorFill: string;
  terminatorStroke: string;
  subprocessFill: string;
  subprocessStroke: string;
};

type DiagramAccents = Pick<DiagramColors, "processStroke" | "decisionStroke" | "ioStroke" | "terminatorStroke" | "subprocessStroke">;

function mixHex(foreground: string, background: string, amount: number): string {
  const channel = (value: string, offset: number) => Number.parseInt(value.slice(offset, offset + 2), 16);
  const mixed = [1, 3, 5].map((offset) => Math.round(channel(foreground, offset) * amount + channel(background, offset) * (1 - amount)));
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function diagramColors(colors: ThemeColors, accents?: DiagramAccents): DiagramColors {
  const strokes = accents ?? {
    processStroke: colors.accent,
    decisionStroke: colors.warm,
    ioStroke: colors.success,
    terminatorStroke: colors.danger,
    subprocessStroke: colors.lineStrong,
  };
  return {
    ...strokes,
    processFill: mixHex(strokes.processStroke, colors.panel2, 0.16),
    decisionFill: mixHex(strokes.decisionStroke, colors.panel2, 0.16),
    ioFill: mixHex(strokes.ioStroke, colors.panel2, 0.16),
    terminatorFill: mixHex(strokes.terminatorStroke, colors.panel2, 0.16),
    subprocessFill: mixHex(strokes.subprocessStroke, colors.panel2, 0.16),
  };
}

const light = (values: Partial<ThemeColors> & Pick<ThemeColors, "bg" | "panel" | "panel2" | "elevated" | "line" | "lineStrong" | "text" | "muted" | "accent" | "accentText" | "accentHover" | "accentSoft" | "danger" | "success" | "warm">): ThemeColors => ({
  shadow: "rgba(45, 38, 32, .18)",
  ...values,
});

const dark = (values: Partial<ThemeColors> & Pick<ThemeColors, "bg" | "panel" | "panel2" | "elevated" | "line" | "lineStrong" | "text" | "muted" | "accent" | "accentText" | "accentHover" | "accentSoft" | "danger" | "success" | "warm">): ThemeColors => ({
  shadow: "rgba(0, 0, 0, .42)",
  ...values,
});

const BASE_THEMES = [
  {
    id: "light", name: "Light", family: "Basic", scheme: "light",
    colors: light({ bg: "#f5f7f3", panel: "#ffffff", panel2: "#edf1ea", elevated: "#e0e6dc", line: "#cdd6c8", lineStrong: "#a9b7a3", text: "#20261e", muted: "#5d6958", accent: "#386b22", accentText: "#ffffff", accentHover: "#2d591b", accentSoft: "#dcebd4", danger: "#a8392c", success: "#39702d", warm: "#9a591d" }),
  },
  {
    id: "dark", name: "Dark", family: "Basic", scheme: "dark",
    colors: dark({ bg: "#0d100c", panel: "#121611", panel2: "#171c15", elevated: "#20261d", line: "#293025", lineStrong: "#4d5b43", text: "#edf2e8", muted: "#94a08d", accent: "#b7f36b", accentText: "#14200e", accentHover: "#c4fa82", accentSoft: "#26351c", danger: "#f0a28e", success: "#a8d98b", warm: "#e2b575" }),
  },
  {
    id: "catppuccin-latte", name: "Latte", family: "Catppuccin", scheme: "light",
    colors: light({ bg: "#eff1f5", panel: "#e6e9ef", panel2: "#dce0e8", elevated: "#ccd0da", line: "#bcc0cc", lineStrong: "#9ca0b0", text: "#4c4f69", muted: "#5c5f77", accent: "#7732d5", accentText: "#ffffff", accentHover: "#6528b8", accentSoft: "#e2d6f5", danger: "#d20f39", success: "#327e23", warm: "#c95008" }),
  },
  {
    id: "catppuccin-frappe", name: "Frappé", family: "Catppuccin", scheme: "dark",
    colors: dark({ bg: "#303446", panel: "#292c3c", panel2: "#414559", elevated: "#51576d", line: "#51576d", lineStrong: "#737994", text: "#c6d0f5", muted: "#b5bfe2", accent: "#ca9ee6", accentText: "#292c3c", accentHover: "#d8b8eb", accentSoft: "#4b405d", danger: "#e78284", success: "#a6d189", warm: "#ef9f76" }),
  },
  {
    id: "catppuccin-macchiato", name: "Macchiato", family: "Catppuccin", scheme: "dark",
    colors: dark({ bg: "#24273a", panel: "#1e2030", panel2: "#363a4f", elevated: "#494d64", line: "#494d64", lineStrong: "#6e738d", text: "#cad3f5", muted: "#a5adcb", accent: "#c6a0f6", accentText: "#1e2030", accentHover: "#d4b8f8", accentSoft: "#463d63", danger: "#ed8796", success: "#a6da95", warm: "#f5a97f" }),
  },
  {
    id: "catppuccin-mocha", name: "Mocha", family: "Catppuccin", scheme: "dark",
    colors: dark({ bg: "#1e1e2e", panel: "#181825", panel2: "#313244", elevated: "#45475a", line: "#45475a", lineStrong: "#6c7086", text: "#cdd6f4", muted: "#a6adc8", accent: "#cba6f7", accentText: "#181825", accentHover: "#dabcf9", accentSoft: "#493e62", danger: "#f38ba8", success: "#a6e3a1", warm: "#fab387" }),
  },
  {
    id: "sand", name: "Sand", family: "Solar / Sand", scheme: "light",
    colors: light({ bg: "#f4ead7", panel: "#fbf3e4", panel2: "#eadbc2", elevated: "#dac6a7", line: "#cbb694", lineStrong: "#a98e68", text: "#3d352c", muted: "#685b4c", accent: "#765724", accentText: "#ffffff", accentHover: "#5f451c", accentSoft: "#e5d2ad", danger: "#a33c32", success: "#456b3b", warm: "#9b571d" }),
  },
  {
    id: "dawn-paper", name: "Dawn Paper", family: "Solar / Sand", scheme: "light",
    colors: light({ bg: "#fff6e8", panel: "#f6e8d2", panel2: "#eedcc2", elevated: "#e2c9a9", line: "#d2b994", lineStrong: "#ad8e67", text: "#40352f", muted: "#6f5c50", accent: "#983923", accentText: "#ffffff", accentHover: "#7e2e1d", accentSoft: "#f0d3bb", danger: "#9b3152", success: "#477343", warm: "#9a4d12" }),
  },
  {
    id: "golden-sand", name: "Golden Sand", family: "Solar / Sand", scheme: "light",
    colors: light({ bg: "#f1d79e", panel: "#f6e2b5", panel2: "#e6c680", elevated: "#d4ae61", line: "#c29a50", lineStrong: "#99702f", text: "#352b22", muted: "#604c39", accent: "#7c3f0e", accentText: "#ffffff", accentHover: "#633108", accentSoft: "#e8bf72", danger: "#923b32", success: "#3f683f", warm: "#884509" }),
  },
  {
    id: "golden-paper", name: "Golden Paper", family: "Solar / Sand", scheme: "light",
    colors: light({ bg: "#ead4a6", panel: "#dfc493", panel2: "#d3b47f", elevated: "#c5a269", line: "#b18e58", lineStrong: "#8e6d40", text: "#382e27", muted: "#554337", accent: "#833024", accentText: "#ffffff", accentHover: "#6d271e", accentSoft: "#dbb58a", danger: "#87314e", success: "#3f683f", warm: "#85410f" }),
  },
  {
    id: "sunset", name: "Sunset", family: "Solar / Sand", scheme: "dark",
    colors: dark({ bg: "#2a1f2d", panel: "#211923", panel2: "#443044", elevated: "#5a3c50", line: "#5a3c50", lineStrong: "#80566d", text: "#ffe9d6", muted: "#d4b3b1", accent: "#ff8b6a", accentText: "#2a1f2d", accentHover: "#ffa087", accentSoft: "#58342f", danger: "#f19aaf", success: "#9ccf9d", warm: "#f6c177" }),
  },
  {
    id: "dusk", name: "Dusk", family: "Solar / Sand", scheme: "dark",
    colors: dark({ bg: "#20233b", panel: "#191c30", panel2: "#303653", elevated: "#414967", line: "#414967", lineStrong: "#646d91", text: "#e7e9ff", muted: "#aeb4d6", accent: "#b8a1ff", accentText: "#20233b", accentHover: "#c9b8ff", accentSoft: "#3d3a65", danger: "#f3a6c8", success: "#95d5b2", warm: "#f6c177" }),
  },
] as const;

const CATPPUCCIN_DIAGRAM: Partial<Record<ThemeId, DiagramAccents>> = {
  "catppuccin-latte": { processStroke: "#1e66f5", decisionStroke: "#8839ef", ioStroke: "#179299", terminatorStroke: "#fe640b", subprocessStroke: "#40a02b" },
  "catppuccin-frappe": { processStroke: "#8caaee", decisionStroke: "#ca9ee6", ioStroke: "#81c8be", terminatorStroke: "#ef9f76", subprocessStroke: "#a6d189" },
  "catppuccin-macchiato": { processStroke: "#8aadf4", decisionStroke: "#c6a0f6", ioStroke: "#8bd5ca", terminatorStroke: "#f5a97f", subprocessStroke: "#a6da95" },
  "catppuccin-mocha": { processStroke: "#89b4fa", decisionStroke: "#cba6f7", ioStroke: "#94e2d5", terminatorStroke: "#fab387", subprocessStroke: "#a6e3a1" },
};

export const THEMES: readonly AppTheme[] = BASE_THEMES.map((theme) => ({
  ...theme,
  diagram: diagramColors(theme.colors, CATPPUCCIN_DIAGRAM[theme.id]),
}));

export const THEME_GROUPS = ["Basic", "Catppuccin", "Solar / Sand"] as const;

const themeById = new Map<ThemeId, AppTheme>(THEMES.map((theme) => [theme.id as ThemeId, theme]));

export function isThemeSelection(value: string | null): value is ThemeSelection {
  return value === "system" || value === "wallpaper" || themeById.has(value as ThemeId);
}

export function resolveTheme(selection: ThemeSelection, prefersDark: boolean): AppTheme {
  const id: ThemeId = selection === "system" || selection === "wallpaper"
    ? (prefersDark ? "dark" : "light")
    : selection;
  return themeById.get(id) ?? themeById.get("dark")!;
}

export function applyTheme(theme: AppTheme, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.scheme;
  for (const [name, value] of Object.entries(theme.colors)) {
    const token = name === "panel2" ? "panel-2" : name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    root.style.setProperty(`--${token}`, value);
  }
  for (const [name, value] of Object.entries(theme.diagram)) {
    const token = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    root.style.setProperty(`--diagram-${token}`, value);
  }
}
