import { cyrb128 } from "./hash.js";

/** A header of a request or response config, matched case-insensitively */
export function readHeader(headers: unknown, name: string): string | undefined {
  if (typeof headers !== "object" || headers === null) {
    return undefined;
  }

  const wanted = name.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (
      key.toLowerCase() === wanted &&
      value !== undefined &&
      value !== null &&
      value !== false
    ) {
      return Array.isArray(value) ? value.join(", ") : String(value);
    }
  }

  return undefined;
}

/**
 * The directives of a `Cache-Control` header by lowercased name, with their
 * unquoted value if they have one
 */
export function cacheControlDirectives(
  headers: unknown,
): Map<string, string | undefined> {
  const directives = new Map<string, string | undefined>();

  for (const directive of (readHeader(headers, "cache-control") ?? "").split(
    ",",
  )) {
    const separator = directive.indexOf("=");
    const name = (separator === -1 ? directive : directive.slice(0, separator))
      .trim()
      .toLowerCase();

    if (name) {
      directives.set(
        name,
        separator === -1
          ? undefined
          : directive
              .slice(separator + 1)
              .trim()
              .replace(/^"|"$/g, ""),
      );
    }
  }

  return directives;
}

/** The lowercased field names of a `Vary` header, or `"*"` */
export function varyFields(headers: unknown): string[] | "*" | undefined {
  const fields = (readHeader(headers, "vary") ?? "")
    .split(",")
    .map((field) => field.trim().toLowerCase())
    .filter(Boolean);

  if (fields.includes("*")) {
    return "*";
  }

  return fields.length === 0 ? undefined : [...new Set(fields)];
}

/**
 * A digest of each request header named in `Vary`, or `null` when it is absent,
 * so that a stored entry holds no raw header value
 */
export function varyValues(
  headers: unknown,
  fields: string[],
): Record<string, string | null> {
  return Object.fromEntries(
    fields.map((field) => {
      const value = readHeader(headers, field);
      return [field, value === undefined ? null : cyrb128(value)];
    }),
  );
}

/** Whether a request sends the same headers that `Vary` named on storing */
export function matchesVary(
  vary: Record<string, string | null> | undefined,
  headers: unknown,
): boolean {
  if (!vary) {
    return true;
  }

  const fields = Object.keys(vary);
  const current = varyValues(headers, fields);

  return fields.every((field) => current[field] === vary[field]);
}
