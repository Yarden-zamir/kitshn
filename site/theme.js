// The light or dark choice for the site. With no stored choice, the site follows the device.
// This script loads without defer in <head>, so the choice applies before the first paint.
// The page scripts share one global scope, so the block keeps these names local.
{
  const THEME_KEY = "kitshn.theme";
  const darkDevice = matchMedia("(prefers-color-scheme: dark)");
  const root = document.documentElement;

  const readTheme = () => {
    try {
      const theme = localStorage.getItem(THEME_KEY);
      return theme === "light" || theme === "dark" ? theme : null;
    } catch {
      return null;
    }
  };

  const saveTheme = (theme) => {
    try {
      if (theme === null) localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Storage can be blocked. The choice then lasts only for this page.
    }
  };

  const applyTheme = (theme) => {
    if (theme === null) delete root.dataset.theme;
    else root.dataset.theme = theme;
  };

  const isDark = () => (root.dataset.theme ?? (darkDevice.matches ? "dark" : "light")) === "dark";

  applyTheme(readTheme());

  const ICONS = {
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />',
    sun: '<circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />',
  };

  document.addEventListener("DOMContentLoaded", () => {
    const button = document.querySelector(".theme-toggle");
    if (!button) return;
    const show = () => {
      const dark = isDark();
      const label = dark ? "Switch to light mode" : "Switch to dark mode";
      button.setAttribute("aria-label", label);
      button.title = label;
      button.querySelector("svg").innerHTML = dark ? ICONS.sun : ICONS.moon;
    };
    button.addEventListener("click", () => {
      const next = isDark() ? "light" : "dark";
      // A choice that matches the device clears the stored choice, so the site follows the device again.
      const theme = next === (darkDevice.matches ? "dark" : "light") ? null : next;
      applyTheme(theme);
      saveTheme(theme);
      show();
    });
    darkDevice.addEventListener("change", show);
    show();
  });
}
