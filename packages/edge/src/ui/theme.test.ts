// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { nextTheme, parseTheme, saveTheme, startTheme, THEME_KEY, themeTip } from "./theme.ts";

/** K-535: the mode of this device. */

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
});

describe("theme", () => {
  it("follows the device unless light or dark is stored", () => {
    expect(parseTheme(null)).toBe("system");
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("sepia")).toBe("system");
  });

  it("goes from the device to light to dark and back", () => {
    expect(nextTheme("system")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("system");
  });

  it("names the mode and the next one in its tooltip", () => {
    expect(themeTip("system")).toBe(
      "Mode: as this device. Click for light. Each device keeps its own choice.",
    );
    expect(themeTip("light")).toBe("Mode: light. Click for dark. Each device keeps its own choice.");
    expect(themeTip("dark")).toBe(
      "Mode: dark. Click for the mode of this device. Each device keeps its own choice.",
    );
  });

  it("keeps light or dark on this device and forgets the device mode", () => {
    saveTheme("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(startTheme()).toBe("dark");
    saveTheme("system");
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(startTheme()).toBe("system");
  });

  it("sets the tokens of the chosen mode on the page and removes them for the device mode", () => {
    const style = document.createElement("style");
    style.textContent =
      ":root { --canvas: #ececea; --ink: #19191b; } @media (prefers-color-scheme: dark) { :root { --canvas: #161618; } }";
    document.head.append(style);
    saveTheme("dark");
    expect(document.documentElement.style.getPropertyValue("--canvas")).toBe("#161618");
    saveTheme("light");
    expect(document.documentElement.style.getPropertyValue("--canvas")).toBe("#ececea");
    saveTheme("system");
    expect(document.documentElement.style.getPropertyValue("--canvas")).toBe("");
    style.remove();
  });
});
