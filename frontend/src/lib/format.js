export function formatSpeed(value, unit) {
  return `${Number(value ?? 0).toLocaleString("ru-RU", { maximumFractionDigits: unit === "wpm" ? 1 : 0 })} ${unit === "wpm" ? "слов/мин" : "знаков/мин"}`;
}

export function formatDate(value) {
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function modeLabel(mode) {
  return { words: "Слова", sentences: "Фразы", code: "Код", symbols: "Знаки", custom: "Свои слова", race: "Клавагонки" }[mode] || mode;
}
