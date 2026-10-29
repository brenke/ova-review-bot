/**
 * Разбирает плоский текст Google-документа в структуру:
 *   { sections, fields, stats }
 *
 * txt-экспорт Google отдаёт таблицы как
 *   \tМЕТКА:
 *   \tзначение
 * поэтому поля ловятся по «метка + двоеточие», а значения — по следующим
 * строкам с отступом. Заголовки — строки без отступа в ВЕРХНЕМ РЕГИСТРЕ
 * (или markdown-решётки, если документ пишут в markdown).
 */

const WORD_RE = /[A-Za-zА-Яа-яЁё0-9]+/g;

export const DEFAULT_PLACEHOLDERS = [
  '-',
  '—',
  '–',
  '―',
  '.',
  '..',
  '...',
  '…',
  '___',
  'нет',
  'нет данных',
  'не указано',
  'не указан',
  'не заполнено',
  'н/д',
  'нд',
  'n/a',
  'na',
  'todo',
  'tbd',
  'заполнить',
  'указать',
  'xxx',
  '???',
  'null',
  'none',
];

export function countWords(text) {
  const matches = String(text ?? '').match(WORD_RE);
  return matches ? matches.length : 0;
}

/** Ключ для сравнения названий: без регистра, ё→е, без пунктуации. */
export function normalizeKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Пустое ли значение поля (прочерк, «не указано», пустая строка…). */
export function isEmptyValue(value, extraPlaceholders = []) {
  const raw = String(value ?? '').trim();
  if (!raw) return true;
  if (/^[-—–―_.…\s]+$/.test(raw)) return true;
  const key = normalizeKey(raw);
  if (!key) return true;
  const pool = [...DEFAULT_PLACEHOLDERS, ...extraPlaceholders].map((p) => normalizeKey(p));
  return pool.includes(key);
}

export function normalizeText(raw) {
  return String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\t{2,}/g, '\t')
    // Технические дорожки вида «vvvvvv» / «xxxxx» — не текст документа
    .replace(/([A-Za-zА-Яа-яЁё])\1{5,}/g, ' ')
    .replace(/[ ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isUpperHeading(content) {
  if (content.length > 90) return false;
  const letters = content.match(/[A-Za-zА-Яа-яЁё]/g) ?? [];
  if (letters.length < 3) return false;
  const upper = content.match(/[A-ZА-ЯЁ]/g) ?? [];
  if (upper.length / letters.length < 0.8) return false;
  return countWords(content) <= 12;
}

function matchField(content) {
  const match = content.match(/^([^:]{2,70}?)\s*:\s*(.*)$/);
  if (!match) return null;
  const label = match[1].trim();
  const value = match[2].trim();
  if (!label || label.length < 2) return null;
  if (countWords(label) > 9) return null;
  if (/[!?]/.test(label)) return null;
  if (/^(https?|\/\/)/i.test(label)) return null;
  return { label, value };
}

function headingLevel(content) {
  const md = content.match(/^(#{1,6})\s+(.+)$/);
  if (md) return { level: md[1].length, title: md[2].trim() };
  return { level: isUpperHeading(content) ? 1 : 2, title: content };
}

function isHeading(item, next) {
  if (/^#{1,6}\s+/.test(item.content)) return true;
  if (item.indent) return false;
  if (isUpperHeading(item.content)) return true;
  // Смешанный регистр: короткая строка без точки, за которой идёт поле с отступом
  // (например «Заметки для врача» → «ДАТА ЗАПОЛНЕНИЯ МЕД КАРТЫ :»).
  // Именно «поле», а не просто строка с отступом: иначе значения таблиц
  // («Фамилия» → «Ломов») превращаются в заголовки.
  if (
    next?.indent &&
    matchField(next.content) &&
    item.content.length <= 60 &&
    countWords(item.content) <= 7 &&
    !/[.:;,!?]$/.test(item.content)
  ) {
    return true;
  }
  return false;
}

/**
 * @param {string} rawText
 */
export function parseDocument(rawText) {
  const text = normalizeText(rawText);
  const lines = text.split('\n');

  /** @type {{content: string, indent: boolean}[]} */
  const items = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = /^[ \t]/.test(line);
    const content = line.replace(/^[\s>]+/, '').trim();
    if (!content) continue;
    items.push({ content, indent });
  }

  /** @type {{title: string, level: number, lines: string[], fields: {label: string, value: string}[]}[]} */
  const sections = [];
  let current = { title: 'Титульная часть', level: 0, lines: [], fields: [] };
  const fields = [];

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];

    const field = matchField(item.content);
    if (field) {
      let value = field.value;
      while (i + 1 < items.length) {
        const next = items[i + 1];
        if (!next.indent) break;
        if (matchField(next.content)) break;
        value = value ? `${value} ${next.content}` : next.content;
        i += 1;
      }

      // «ПСИХОЛОГИЧЕСКАЯ ИНФОРМАЦИЯ:» без значения, за которой сразу идут
      // другие поля — это подзаголовок ячейки, а не пустое поле.
      const nextIsField = i + 1 < items.length && Boolean(matchField(items[i + 1].content));
      if (!value && nextIsField) {
        current.lines.push(item.content);
        continue;
      }

      const entry = { label: field.label, value, section: current.title };
      current.fields.push({ label: field.label, value });
      fields.push(entry);
      continue;
    }

    if (isHeading(item, items[i + 1])) {
      sections.push(current);
      const { level, title } = headingLevel(item.content);
      current = { title, level, lines: [], fields: [] };
      continue;
    }

    current.lines.push(item.content);
  }
  sections.push(current);

  const prepared = sections
    .filter((section) => section.title || section.lines.length || section.fields.length)
    .map((section) => {
      const body = [
        ...section.lines,
        ...section.fields.map((f) => `${f.label}: ${f.value}`),
      ].join('\n');
      return {
        title: section.title,
        key: normalizeKey(section.title),
        level: section.level,
        body,
        words: countWords(body),
        lines: section.lines,
        fields: section.fields,
      };
    });

  const placeholderFields = fields.filter((f) => isEmptyValue(f.value));

  return {
    text,
    sections: prepared,
    fields: fields.map((f) => ({
      ...f,
      key: normalizeKey(f.label),
      empty: isEmptyValue(f.value),
    })),
    stats: {
      chars: text.length,
      words: countWords(text),
      sectionCount: prepared.length,
      fieldCount: fields.length,
      placeholderFields: placeholderFields.length,
      emptySections: prepared.filter((s) => s.words < 5 && s.level > 0).length,
      headings: prepared.filter((s) => s.level > 0).map((s) => s.title),
    },
  };
}

/** Находит поле по названию (нечётко). Возвращает первое совпадение. */
export function findField(parsed, ...labels) {
  const wanted = labels.map(normalizeKey);
  for (const field of parsed.fields) {
    if (wanted.some((want) => field.key === want)) return field;
  }
  for (const field of parsed.fields) {
    if (wanted.some((want) => field.key.includes(want) || want.includes(field.key))) return field;
  }
  return null;
}

/** Находит раздел по названию/алиасам. */
export function findSection(parsed, ...aliases) {
  const wanted = aliases.map(normalizeKey).filter(Boolean);
  const exact = parsed.sections.find((s) => wanted.some((w) => s.key === w || (s.key && (s.key.includes(w) || w.includes(s.key)))));
  if (exact) return exact;
  return (
    parsed.sections.find((s) => wanted.some((w) => s.key.includes(w))) ?? null
  );
}

/** Число из значения поля («197 см.» → 197, «28 июн. 2026» → 2026). */
export function extractNumber(value) {
  const normalized = String(value ?? '').replace(',', '.').replace(/\s/g, '');
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}
