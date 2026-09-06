export function parseBtwCommand(text: string): { readonly query?: string } | null {
  const match = /^\/btw(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (!match) {
    return null;
  }
  const query = match[1]?.trim();
  return query ? { query } : {};
}
