/** Decodes bytes as UTF-8, falling back to Windows-1252 (common in old .kar/.txt files). */
export function decodeText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
