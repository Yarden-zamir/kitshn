// K-830 to K-836: the rules of app values that the recipe, the CLI and kitshn share.

/** K-830: a var shows its value; a secret never does. */
export type ValueKind = "secret" | "var";

/** K-836: the most names that one app environment needs, `needs.secrets` and `needs.vars` together. */
export const MAX_NEEDED = 50;

/** K-836: the most bytes of one value, as UTF-8. Cloudflare takes 5 KB per variable. */
export const MAX_VALUE_BYTES = 4096;

/** K-836: the most values in the store of one kitshn. */
export const MAX_STORED = 1000;

/** K-830: the value set of all pull request environments of one app; no push environment takes this name. */
export const PREVIEWS = "previews";

/**
 * K-836: an uppercase letter, then up to 63 uppercase letters, digits or `_`, so it is a valid variable name in a
 * shell, Compose and a Worker.
 */
export function isValueName(name: string): boolean {
  if (name.length < 1 || name.length > 64) return false;
  const first = name[0] ?? "";
  if (first < "A" || first > "Z") return false;
  return [...name].every(
    (char) => char === "_" || (char >= "A" && char <= "Z") || (char >= "0" && char <= "9"),
  );
}

/** K-836: why a needed name is not allowed, or null. `KITSHN_` names belong to kitshn (K-812, K-822, K-1908). */
export function valueNameRefusal(name: string): string | null {
  if (!isValueName(name))
    return `${name} is not a value name: an uppercase letter, then up to 63 uppercase letters, digits or _ (K-836).`;
  if (name.startsWith("KITSHN_"))
    return `${name} starts with KITSHN_, which kitshn keeps for itself (K-836).`;
  return null;
}

/** K-836: why a value is not allowed, or null. */
export function valueRefusal(value: string): string | null {
  if (value === "") return "The value is empty. Remove the name instead.";
  if (value.includes("\0"))
    return "The value holds a NUL character, which no environment variable can hold (K-836).";
  if (new TextEncoder().encode(value).length > MAX_VALUE_BYTES)
    return `The value is larger than ${MAX_VALUE_BYTES} bytes (K-836).`;
  return null;
}
