export const MODES = [
  { id: "words", label: "Слова" },
  { id: "sentences", label: "Фразы" },
  { id: "code", label: "Код" },
  { id: "symbols", label: "Знаки" },
  { id: "custom", label: "Свои слова" },
  { id: "race", label: "Клавагонки" },
];
export const DIFFICULTIES = [
  { id: "easy", label: "Лёгкий", hint: "Короткие слова и простые задания" },
  { id: "medium", label: "Средний", hint: "Обычная практика" },
  { id: "hard", label: "Сложный", hint: "Длинные фразы и больше знаков" },
];
export const SOCIAL_PROVIDER_LABELS = { yandex: "Яндекс", vk: "ВКонтакте", github: "GitHub" };

export const PAGE_COPY = {
  trainer: ["ТРЕНАЖЁР ПЕЧАТИ", "Найди свой ритм.", "Небольшая ежедневная практика помогает печатать свободнее и точнее."],
  stats: ["ТВОЙ ПРОГРЕСС", "Навык растёт.", "Смотри на результаты тренировок и отмечай, что уже стало получаться."],
  achievements: ["МАЛЕНЬКИЕ ПОБЕДЫ", "Есть за что собой гордиться.", "Награды открываются за скорость, точность и постоянную практику."],
  leaderboard: ["ТАБЛИЦА ЛИДЕРОВ", "Результаты участников.", "Сравнивай скорость, точность и опыт за выбранный период."],
};

export const CONTENT = {
  ru: {
    words: ["код", "бит", "сеть", "база", "стек", "ключ", "файл", "диск", "ядро", "токен", "сервер", "скрипт", "модуль", "класс", "метод", "данные", "сборка"],
    sentences: [
      "Я печатаю точно.",
      "Слепая печать помогает сосредоточиться на самой задаче.",
      "Точный ввод текста экономит время каждый день.",
      "Спокойная практика постепенно превращается в привычку.",
    ],
    symbols: ["№123!?;%:*()_+-=@#$^&[]{}<>~", "х5 + у2 = 100%; (а_1 != б_2) ? [да] : {нет};"],
  },
  en: {
    words: ["go", "js", "api", "git", "sql", "cpu", "ram", "net", "bug", "dev", "node", "code", "data", "loop", "hash", "build"],
    sentences: [
      "Type one word.",
      "Touch typing helps you focus on the task at hand.",
      "Small daily practice builds confidence and accuracy.",
      "Good habits make every new skill feel more natural.",
    ],
    symbols: ["!@#$%^&*()_+-=[]{}|;':\",./<>?~`", "export const fn = (a, b) => a?.x ?? b[0] * 2.5;"],
  },
  code: {
    python: [
      "print('hello')",
      "def fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a",
      "users = [user.name for user in records]",
    ],
    javascript: [
      "export const count = 3;",
      "export const debounce = (fn, delay = 300) => {\n  let timer;\n  return (...args) => {\n    clearTimeout(timer);\n    timer = setTimeout(() => fn(...args), delay);\n  };\n};",
      "export const names = users.map((user) => user.name);",
    ],
    html: [
      "<p>Hi</p>",
      "<article class=\"card\">\n  <h2>Practice</h2>\n  <p>One line at a time.</p>\n</article>",
    ],
  },
};

export const ACHIEVEMENT_MARKS = {
  first_step: "01",
  speed_200_cpm: "200",
  typing_genius: "300",
  steel_finger: "1K",
  flawless_1000: "0%",
  combo_master: "×5",
};
