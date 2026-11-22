// Reading settings and their cookie format. Pure string functions, so they can be tested without a DOM.
// index.html repeats the cookie parsing in a few lines to apply the settings before the first paint; keep both in step.
export const THEMES = ["system", "light", "warm", "dark"] as const;
export const FONTS = ["system", "atkinson", "lexend", "literata"] as const;
export const LANGS = ["en", "pt-BR"] as const;
// Line length in characters. The measure is set in rem so it follows the text size; 2.05 characters per rem is what
// the system font measured on note prose (the other reading fonts land within about 5%).
export const MEASURE = { min: 50, max: 110, default: 78, presets: { narrow: 65, medium: 78, wide: 90 } } as const;
export const proseMax = (chars: number) => `${(chars / 2.05).toFixed(2)}rem`;
export type Lang = (typeof LANGS)[number];
export const SIZE = { min: 13, max: 24, default: 16 } as const;
export const COOKIE = "atlas-settings";

export interface Settings { theme: (typeof THEMES)[number]; font: (typeof FONTS)[number]; size: number; lang: Lang; measure: number }
export const DEFAULTS: Settings = { theme: "system", font: "system", size: SIZE.default, lang: "en", measure: MEASURE.default };

const clamp = (r: { min: number; max: number; default: number }) => (n: unknown) =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(r.max, Math.max(r.min, Math.round(n))) : r.default;
export const clampSize = clamp(SIZE);
export const clampMeasure = clamp(MEASURE);

// Takes a document.cookie string. Anything missing or invalid falls back to the default for that field.
export function parseSettings(cookie: string): Settings {
  const entry = cookie.split("; ").find((c) => c.startsWith(`${COOKIE}=`));
  if (!entry) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(decodeURIComponent(entry.slice(COOKIE.length + 1)));
    return {
      theme: THEMES.find((t) => t === raw?.theme) ?? DEFAULTS.theme,
      font: FONTS.find((f) => f === raw?.font) ?? DEFAULTS.font,
      size: clampSize(raw?.size),
      lang: LANGS.find((l) => l === raw?.lang) ?? DEFAULTS.lang,
      measure: clampMeasure(raw?.measure),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

// Returns the string to assign to document.cookie.
export const serializeSettings = (s: Settings) =>
  `${COOKIE}=${encodeURIComponent(JSON.stringify(s))}; Max-Age=31536000; Path=/; SameSite=Lax`;
