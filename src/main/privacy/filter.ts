const SENSITIVE_PATTERNS: RegExp[] = [
  /\b\d{15,19}\b/,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b\d{17}[\dXx]\b/,
  /password[:=]\s*\S+/i,
  /\b[A-Z0-9]{20,}\b/
];

export function isSensitiveContent(content: string): boolean {
  const text = content.trim();
  if (!text) {
    return false;
  }
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}
