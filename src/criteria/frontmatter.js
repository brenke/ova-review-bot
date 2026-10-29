/**
 * Разбор «шапки» .md-файла с чек-листом.
 *
 * Поддерживается разумное подмножество YAML: строки, числа, булевы значения,
 * списки (- пункт или [a, b]) и вложенные словари (для min_words / checks).
 * Полноценный YAML-парсер не нужен, правило простое: без зависимостей.
 */

export function parseFrontmatter(source) {
  const text = String(source ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?/);
  if (!match) return { data: {}, body: text.trim() };

  const lines = match[1]
    .split('\n')
    .map((raw) => ({ indent: raw.match(/^ */)[0].length, text: raw.trim() }))
    .filter((line) => line.text && !line.text.startsWith('#'));

  const [data] = parseNode(lines, 0, 0);
  return { data, body: text.slice(match[0].length).trim() };
}

function parseNode(lines, index, indent) {
  const result = {};
  let i = index;

  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      i += 1;
      continue;
    }

    const match = line.text.match(/^(.+?):(?:[ \t]+(.*))?$/);
    if (!match) {
      i += 1;
      continue;
    }

    const key = match[1].trim().replace(/^["']|["']$/g, '');
    const rest = (match[2] ?? '').trim();
    i += 1;

    if (rest) {
      result[key] = parseScalar(rest);
      continue;
    }

    const nextLine = lines[i];
    if (nextLine && nextLine.indent > indent) {
      if (nextLine.text.startsWith('- ')) {
        const [items, next] = parseList(lines, i, nextLine.indent);
        result[key] = items;
        i = next;
      } else {
        const [child, next] = parseNode(lines, i, nextLine.indent);
        result[key] = child;
        i = next;
      }
      continue;
    }

    if (nextLine && nextLine.indent === indent && nextLine.text.startsWith('- ')) {
      const [items, next] = parseList(lines, i, indent);
      result[key] = items;
      i = next;
      continue;
    }

    result[key] = '';
  }

  return [result, i];
}

function parseList(lines, index, indent) {
  const items = [];
  let i = index;
  while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
    items.push(parseScalar(lines[i].text.slice(2).trim()));
    i += 1;
  }
  return [items, i];
}

function parseScalar(raw) {
  const value = raw.trim();
  if (!value) return '';

  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    return value.slice(1, -1);
  }

  if (value.startsWith('[') && value.endsWith(']')) {
    return splitInlineList(value.slice(1, -1)).map(parseScalar).filter((v) => v !== '');
  }

  const lower = value.toLowerCase();
  if (['true', 'yes', 'on', 'да'].includes(lower)) return true;
  if (['false', 'no', 'off', 'нет'].includes(lower)) return false;
  if (['null', 'none', '~'].includes(lower)) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);

  return value;
}

function splitInlineList(body) {
  const out = [];
  let current = '';
  let quote = null;

  for (const char of body) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ',') {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current.trim());
  return out.filter(Boolean);
}

/** Приводит разобранную шапку к предсказуемому виду. */
export function normalizeCriteriaConfig(data) {
  const asArray = (value) => {
    if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
    if (typeof value === 'string' && value.trim()) return [value.trim()];
    return [];
  };

  const minWordsRaw = data.min_words && typeof data.min_words === 'object' ? data.min_words : {};
  const minWords = {};
  for (const [key, value] of Object.entries(minWordsRaw)) {
    const num = Number(value);
    if (Number.isFinite(num)) minWords[key] = num;
  }

  const checks = data.checks && typeof data.checks === 'object' ? data.checks : {};

  return {
    name: String(data.name ?? '').trim(),
    description: String(data.description ?? '').trim(),
    version: data.version ?? '',
    model: String(data.model ?? '').trim(),
    minScore: Number.isFinite(Number(data.min_score)) ? Number(data.min_score) : null,
    requiredSections: asArray(data.required_sections),
    requiredFields: asArray(data.required_fields),
    forbiddenPlaceholders: asArray(data.forbidden_placeholders),
    forbiddenPhrases: asArray(data.forbidden_phrases),
    numericFields: asArray(data.numeric_fields),
    allowEmptyFields: asArray(data.allow_empty_fields),
    nonBlockingSections: [
      ...asArray(data.non_blocking_sections),
      ...asArray(data.soft_sections), // старый ключ, оставлен для совместимости
    ].filter((value, index, list) => list.indexOf(value) === index),
    minWords,
    minSectionWords: Number.isFinite(Number(checks.min_section_words))
      ? Number(checks.min_section_words)
      : 10,
    ageFromBirthYear: checks.age_from_birth_year !== false,
    bmi: checks.bmi !== false,
    idFromSteamId: checks.id_from_steamid === true,
    validUntil: String(checks.valid_until ?? '').trim(),
  };
}
