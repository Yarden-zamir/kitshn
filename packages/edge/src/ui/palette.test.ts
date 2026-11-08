// @vitest-environment happy-dom
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { describe, expect, it } from "vitest";
import type { PaletteEntry } from "./actions.ts";
import { Palette } from "./Palette.tsx";

/** K-511, K-523: the palette takes the focus, and its keys act only on what the current query shows. */

/** Opens the palette with the focus on another button, as the panel heading has it in the app; unmounts after. */
function withPalette(
  entries: ReadonlyArray<PaletteEntry>,
  test: (input: HTMLInputElement, before: HTMLElement) => void,
) {
  const root = document.createElement("div");
  const before = document.createElement("button");
  document.body.append(root, before);
  before.focus();
  try {
    act(() =>
      render(
        h(Palette, { initialQuery: "", wide: true, onClose: () => act(() => render(null, root)), entries }),
        root,
      ),
    );
    const input = root.querySelector<HTMLInputElement>('input[aria-label="Find"]');
    if (!input) throw new Error("no input");
    test(input, before);
  } finally {
    render(null, root);
    root.remove();
    before.remove();
  }
}

/** Sends the query and the keys in one task, before any render, as a script or an agent does. */
function inOneTask(input: HTMLInputElement, query: string, keys: ReadonlyArray<string>) {
  act(() => {
    input.value = query;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    for (const key of keys) input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

const entries = (ran: Array<string>): ReadonlyArray<PaletteEntry> => [
  { label: "Open History", tip: "Open it.", run: () => ran.push("history") },
  { label: "riffle · Remove app", tip: "Remove it.", danger: true, run: () => ran.push("remove") },
  { label: "riffle · Show details", tip: "Show it.", run: () => ran.push("details") },
];

describe("command palette", () => {
  it("takes the focus when it opens and gives it back when it closes", () => {
    const ran: Array<string> = [];
    withPalette(entries(ran), (input, before) => {
      expect(document.activeElement).toBe(input);
      inOneTask(input, "history", ["Enter"]);
      expect(ran).toEqual(["history"]);
      expect(document.activeElement).toBe(before);
    });
  });

  it("runs the first match of the query that the input holds when Enter comes in the same task", () => {
    const ran: Array<string> = [];
    withPalette(entries(ran), (input) => inOneTask(input, "riffle show details", ["Enter"]));
    expect(ran).toEqual(["details"]);
  });

  it("moves the arrows over the list of the current query, not the one of the last render", () => {
    const ran: Array<string> = [];
    // From the empty query, ArrowDown would pick "Remove app"; for "riffle" it picks "Show details".
    withPalette(entries(ran), (input) => inOneTask(input, "riffle", ["ArrowDown", "Enter"]));
    expect(ran).toEqual(["details"]);
  });

  it("runs a dangerous entry on Enter only when it is the only match or the arrows picked it", () => {
    const ran: Array<string> = [];
    withPalette(entries(ran), (input) => inOneTask(input, "riffle", ["Enter"]));
    expect(ran).toEqual([]);
    withPalette(entries(ran), (input) => inOneTask(input, "riffle remove", ["Enter"]));
    expect(ran).toEqual(["remove"]);
    withPalette(entries(ran), (input) => inOneTask(input, "riffle", ["ArrowDown", "ArrowUp", "Enter"]));
    expect(ran).toEqual(["remove", "remove"]);
  });

  it("leaves a key that finishes an IME composition to the composition", () => {
    const ran: Array<string> = [];
    withPalette(entries(ran), (input) => {
      act(() => {
        input.value = "history";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
      });
    });
    expect(ran).toEqual([]);
  });

  it("keeps the word that names an item, so one Enter opens the list and the next runs the item (U11)", () => {
    const ran: Array<string> = [];
    const share: PaletteEntry = {
      label: "riffle · Share with…",
      tip: "Share it.",
      keywords: "Her Owner",
      items: [
        { label: "Her", tip: "Her.", run: () => ran.push("her") },
        { label: "Owner", tip: "Owner.", run: () => ran.push("owner") },
      ],
    };
    withPalette([share], (input) => {
      inOneTask(input, "riffle her", ["Enter"]);
      expect(ran).toEqual([]);
      expect(input.value).toBe("her");
      act(() => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
      expect(ran).toEqual(["her"]);
    });
  });

  it("filters by a word that is in the parent's name too (U11)", () => {
    const ran: Array<string> = [];
    const share: PaletteEntry = {
      label: "Her · Share with…",
      tip: "Share it.",
      keywords: "Owner Her",
      items: [
        { label: "Owner", tip: "Owner.", run: () => ran.push("owner") },
        { label: "Her", tip: "Her.", run: () => ran.push("her") },
      ],
    };
    withPalette([share], (input) => {
      inOneTask(input, "her share her", ["Enter"]);
      expect(input.value).toBe("her");
    });
  });

  it("runs the action of the current entries after the map changed, not an older one (U11)", () => {
    const ran: Array<string> = [];
    const entriesOf = (version: string): ReadonlyArray<PaletteEntry> => [
      {
        label: "riffle · Share with…",
        tip: "Share it.",
        items: [{ label: "Her", tip: "Her.", run: () => ran.push(version) }],
      },
    ];
    const root = document.createElement("div");
    document.body.append(root);
    const show = (entries: ReadonlyArray<PaletteEntry>) =>
      act(() =>
        render(h(Palette, { initialQuery: "", wide: true, onClose: () => undefined, entries }), root),
      );
    try {
      show(entriesOf("old"));
      const input = root.querySelector<HTMLInputElement>('input[aria-label="Find"]');
      if (!input) throw new Error("no input");
      const enter = () =>
        act(() => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
      enter();
      show(entriesOf("new"));
      enter();
      expect(ran).toEqual(["new"]);
    } finally {
      render(null, root);
      root.remove();
    }
  });

  it("opens the list of the entry that was picked when two entries share a label", () => {
    const ran: Array<string> = [];
    const twin = (id: string): PaletteEntry => ({
      id,
      label: "docs · Share with…",
      tip: "Share it.",
      items: [{ id: `${id}/her`, label: "Her", tip: "Her.", run: () => ran.push(id) }],
    });
    withPalette([twin("card:a"), twin("card:b")], (input) => {
      const key = (name: string) =>
        act(() => void input.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));
      key("ArrowDown");
      key("Enter");
      key("Enter");
      expect(ran).toEqual(["card:b"]);
    });
  });
});
