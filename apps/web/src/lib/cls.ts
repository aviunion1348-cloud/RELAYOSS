/** Tiny class-name joiner (keeps the bundle dependency-free). */
export function cls(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
