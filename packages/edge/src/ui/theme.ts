/**
 * K-535: light or dark mode on this device. "system" follows the device; "light" and "dark" set the tokens of
 * that scheme on the page itself, over the `prefers-color-scheme` block of styles.css.
 */

export type Theme = "system" | "light" | "dark";

export const THEME_KEY = "kitshn.theme";

/** The stored choice; anything else, or nothing, follows the system. */
export const parseTheme = (stored: string | null): Theme =>
  stored === "light" || stored === "dark" ? stored : "system";

/** The toolbar button goes system, light, dark and back. */
export const nextTheme = (theme: Theme): Theme =>
  theme === "system" ? "light" : theme === "light" ? "dark" : "system";

export const THEME_ICONS: Record<Theme, string> = { system: "◐", light: "☀", dark: "☾" };

const NOW: Record<Theme, string> = { system: "as this device", light: "light", dark: "dark" };
const NEXT: Record<Theme, string> = { system: "the mode of this device", light: "light", dark: "dark" };

export const themeTip = (theme: Theme) =>
  `Mode: ${NOW[theme]}. Click for ${NEXT[nextTheme(theme)]}. Each device keeps its own choice.`;

/** The tokens of the page's own stylesheet: the light `:root` block and its dark override. */
export function rootTokens() {
  const light = new Map<string, string>();
  const dark = new Map<string, string>();
  const collect = (style: CSSStyleDeclaration, into: Map<string, string>) => {
    for (let index = 0; index < style.length; index++) {
      const name = style.item(index);
      into.set(name, style.getPropertyValue(name).trim());
    }
  };
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // The font stylesheet of another origin.
    }
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule && rule.selectorText === ":root") collect(rule.style, light);
      if (rule instanceof CSSMediaRule && rule.conditionText.includes("prefers-color-scheme: dark"))
        for (const inner of rule.cssRules)
          if (inner instanceof CSSStyleRule && inner.selectorText === ":root") collect(inner.style, dark);
    }
  }
  return { light, dark };
}

/** Sets the tokens of one scheme on the page itself, so it shows whatever the system setting is. */
export function applyTheme(theme: Theme) {
  const { light, dark } = rootTokens();
  const root = document.documentElement.style;
  // Only the names that the dark block changes differ between the two schemes.
  for (const name of dark.keys()) {
    const value = theme === "dark" ? dark.get(name) : theme === "light" ? light.get(name) : undefined;
    if (value === undefined) root.removeProperty(name);
    else root.setProperty(name, value);
  }
  // The browser bar takes the canvas of the chosen scheme; "system" leaves each tag to its media query.
  const canvas =
    theme === "dark" ? dark.get("--canvas") : theme === "light" ? light.get("--canvas") : undefined;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.dataset["content"] ??= meta.content;
    meta.content = canvas ?? meta.dataset["content"];
  }
}

/** The theme this device keeps, applied once at start so the first paint is already right. */
export function startTheme(): Theme {
  const theme = parseTheme(localStorage.getItem(THEME_KEY));
  if (theme !== "system") applyTheme(theme);
  return theme;
}

export function saveTheme(theme: Theme) {
  if (theme === "system") localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
}
