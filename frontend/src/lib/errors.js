export function errorMessage(payload, fallback) {
  const detail = payload?.detail;
  if (Array.isArray(detail)) {
    return detail.map((item) => (item.msg || "").replace(/^Value error, /, "")).filter(Boolean).join(". ") || fallback;
  }
  return typeof detail === "string" ? detail : fallback;
}
