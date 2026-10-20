export const KEY_ROWS = {
  ru: ["ё1234567890", "йцукенгшщзх", "фывапролджэ", "ячсмитьбю"],
  en: ["`1234567890", "qwertyuiop", "asdfghjkl;", "zxcvbnm,./"],
};
export const FINGER_ROWS = {
  ru: [
    ["left-pinky", "left-pinky", "left-ring", "left-middle", "left-index", "left-index", "right-index", "right-index", "right-middle", "right-ring", "right-pinky"],
    ["left-pinky", "left-ring", "left-middle", "left-index", "left-index", "right-index", "right-index", "right-middle", "right-ring", "right-pinky", "right-pinky"],
    ["left-pinky", "left-ring", "left-middle", "left-index", "left-index", "right-index", "right-index", "right-middle", "right-ring", "right-pinky", "right-pinky"],
    ["left-pinky", "left-ring", "left-middle", "left-index", "left-index", "right-index", "right-index", "right-middle", "right-ring"],
  ],
  en: [
    ["left-pinky", "left-pinky", "left-ring", "left-middle", "left-index", "left-index", "right-index", "right-index", "right-middle", "right-ring", "right-pinky"],
    ["left-pinky", "left-ring", "left-middle", "left-index", "left-index", "right-index", "right-index", "right-middle", "right-ring", "right-pinky"],
    ["left-pinky", "left-ring", "left-middle", "left-index", "left-index", "right-index", "right-index", "right-middle", "right-ring", "right-pinky"],
    ["left-pinky", "left-ring", "left-middle", "left-index", "left-index", "right-index", "right-index", "right-middle", "right-ring", "right-pinky"],
  ],
};
const FINGER_LABELS = {
  "left-pinky": "левый мизинец",
  "left-ring": "левый безымянный",
  "left-middle": "левый средний",
  "left-index": "левый указательный",
  "right-index": "правый указательный",
  "right-middle": "правый средний",
  "right-ring": "правый безымянный",
  "right-pinky": "правый мизинец",
};
const ENGLISH_BY_CODE = {
  KeyA: "a", KeyB: "b", KeyC: "c", KeyD: "d", KeyE: "e", KeyF: "f", KeyG: "g", KeyH: "h", KeyI: "i", KeyJ: "j", KeyK: "k", KeyL: "l", KeyM: "m",
  KeyN: "n", KeyO: "o", KeyP: "p", KeyQ: "q", KeyR: "r", KeyS: "s", KeyT: "t", KeyU: "u", KeyV: "v", KeyW: "w", KeyX: "x", KeyY: "y", KeyZ: "z",
  Digit0: "0", Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4", Digit5: "5", Digit6: "6", Digit7: "7", Digit8: "8", Digit9: "9",
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Space: " ",
};
const RUSSIAN_BY_CODE = {
  Backquote: "ё", KeyQ: "й", KeyW: "ц", KeyE: "у", KeyR: "к", KeyT: "е", KeyY: "н", KeyU: "г", KeyI: "ш", KeyO: "щ", KeyP: "з",
  Digit0: "0", Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4", Digit5: "5", Digit6: "6", Digit7: "7", Digit8: "8", Digit9: "9",
  BracketLeft: "х", BracketRight: "ъ", KeyA: "ф", KeyS: "ы", KeyD: "в", KeyF: "а", KeyG: "п", KeyH: "р", KeyJ: "о", KeyK: "л", KeyL: "д",
  Semicolon: "ж", Quote: "э", KeyZ: "я", KeyX: "ч", KeyC: "с", KeyV: "м", KeyB: "и", KeyN: "т", KeyM: "ь", Comma: "б", Period: "ю", Slash: ".",
  Minus: "-", Equal: "=", Backslash: "\\", Space: " ",
};
const ENGLISH_SHIFTED_BY_CODE = {
  Backquote: "~", Digit1: "!", Digit2: "@", Digit3: "#", Digit4: "$", Digit5: "%", Digit6: "^", Digit7: "&", Digit8: "*", Digit9: "(", Digit0: ")",
  Minus: "_", Equal: "+", BracketLeft: "{", BracketRight: "}", Backslash: "|", Semicolon: ":", Quote: '"', Comma: "<", Period: ">", Slash: "?",
};
const RUSSIAN_SHIFTED_BY_CODE = {
  Backquote: "Ё", Digit1: "!", Digit2: '"', Digit3: "№", Digit4: ";", Digit5: "%", Digit6: ":", Digit7: "?", Digit8: "*", Digit9: "(", Digit0: ")",
  Minus: "_", Equal: "+", BracketLeft: "Х", BracketRight: "Ъ", Backslash: "/", Semicolon: "Ж", Quote: "Э", Comma: "Б", Period: "Ю", Slash: ",",
};

export function detectTextLanguage(text, fallback = "ru") {
  const russianCount = (text.match(/[а-яё]/gi) || []).length;
  const englishCount = (text.match(/[a-z]/gi) || []).length;
  if (!russianCount && !englishCount) return fallback;
  return russianCount >= englishCount ? "ru" : "en";
}

export function getCharacterLanguage(char, fallback) {
  if (/[а-яё]/i.test(char)) return "ru";
  if (/[a-z]/i.test(char)) return "en";
  return fallback;
}

function getExpectedKey(code, language, shiftKey) {
  const base = language === "ru" ? RUSSIAN_BY_CODE : ENGLISH_BY_CODE;
  const shifted = language === "ru" ? RUSSIAN_SHIFTED_BY_CODE : ENGLISH_SHIFTED_BY_CODE;
  const value = base[code];
  if (!value) return "";
  if (shiftKey) return shifted[code] || (/[a-zа-яё]/i.test(value) ? value.toLocaleUpperCase() : value);
  return value;
}

export function getFingerHint(char, lang) {
  if (char === " ") return "большой палец";
  if (char === "\n") return "нажми Enter";
  const key = char.toLocaleLowerCase();
  for (const [rowIndex, row] of KEY_ROWS[lang].entries()) {
    const keyIndex = Array.from(row).findIndex((item) => item.toLocaleLowerCase() === key);
    if (keyIndex >= 0) return FINGER_LABELS[FINGER_ROWS[lang][rowIndex][keyIndex]] || "нужный палец";
  }
  return "нужный палец";
}

export function getLayoutWarning(expected, typed, code, language, shiftKey) {
  const expectedScript = getCharacterLanguage(expected, language);
  const typedUsesOtherAlphabet = expectedScript === "ru" ? /[a-z]/i.test(typed) : /[а-яё]/i.test(typed);
  if ((expectedScript === "ru" || expectedScript === "en") && typedUsesOtherAlphabet) {
    return language === "ru"
      ? "Сейчас английская раскладка, а упражнение ждёт русский. Переключите язык для следующих знаков. Ошибка учтена, можно продолжать."
      : "Сейчас русская раскладка, а упражнение ждёт английский. Переключите язык для следующих знаков. Ошибка учтена, можно продолжать.";
  }
  const expectedKey = getExpectedKey(code, language, shiftKey);
  const otherLanguage = language === "ru" ? "en" : "ru";
  const otherKey = getExpectedKey(code, otherLanguage, shiftKey);
  if (expectedKey && otherKey && expectedKey.toLocaleLowerCase() === expected.toLocaleLowerCase()
    && otherKey.toLocaleLowerCase() === typed.toLocaleLowerCase()
    && expected.toLocaleLowerCase() !== typed.toLocaleLowerCase()) {
    return language === "ru"
      ? "Сейчас английская раскладка, а упражнение ждёт русский. Переключите язык для следующих знаков. Ошибка учтена, можно продолжать."
      : "Сейчас русская раскладка, а упражнение ждёт английский. Переключите язык для следующих знаков. Ошибка учтена, можно продолжать.";
  }
  return "";
}
