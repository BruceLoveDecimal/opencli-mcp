// Client-side normalization mirrors the confirmed 0.1–100, one-decimal contract without inventing a server preference API.
export function normalizeThreshold(value, legacy = false) {
  if (value === '' || value === null || value === undefined || typeof value === 'boolean') return 10;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 10;
  if (legacy && numeric === 0.1) return 10;
  return Math.round(Math.min(100, Math.max(0.1, numeric)) * 10) / 10;
}

export function normalizeSettings({ execution_mode = 'auto', credit_confirmation_threshold = 10, legacy = false } = {}) {
  return { execution_mode: execution_mode === 'ask' ? 'ask' : 'auto', credit_confirmation_threshold: normalizeThreshold(credit_confirmation_threshold, legacy) };
}
