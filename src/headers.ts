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

/** The lowercased directive names of a `Cache-Control` header */
export function cacheControlDirectives(headers: unknown): Set<string> {
  const value = readHeader(headers, "cache-control") ?? "";

  return new Set(
    value
      .split(",")
      .map((directive) => directive.split("=")[0]?.trim().toLowerCase() ?? "")
      .filter(Boolean),
  );
}
