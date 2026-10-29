/**
 * Детерминированные (без ИИ) проверки документа.
 * Дают воспроизводимый результат: «нет раздела», «поле пустое», «возраст не
 * бьётся с годом рождения» и т.п. ИИ дополняет их смысловыми замечаниями,
 * но не может «забыть» проверить обязательные пункты.
 */

import {
  extractNumber,
  findField,
  findSection,
  isEmptyValue,
  normalizeKey,
} from '../gdoc/parseDoc.js';

export const SEVERITY_LABEL = {
  critical: 'критично',
  major: 'важно',
  minor: 'мелочь',
};

const SEVERITY_WEIGHT = { critical: 25, major: 8, minor: 2 };

const TEMPLATE_MARKERS = [
  { re: /lorem\s+ipsum/i, text: '«Lorem ipsum» — заготовка вместо текста' },
  { re: /v{8,}/i, text: 'артефакт шаблона — дорожка из букв «v»' },
  { re: /x{5,}/i, text: 'артефакт шаблона — «xxxx»' },
  { re: /заполни(те)?\s+здесь/i, text: 'подсказка шаблона «заполните здесь»' },
  { re: /\[вставьте[^\]]*\]/i, text: 'подсказка шаблона «[вставьте …]»' },
];

function aliasList(spec) {
  return String(spec ?? '')
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
}

function push(findings, code, severity, title, detail, extra = {}) {
  findings.push({ code, severity, title, detail, ...extra });
}

/**
 * @param {{parsed: ReturnType<import('../gdoc/parseDoc.js').parseDocument>, criteria: object}} input
 */
export function runChecks({ parsed, criteria }) {
  const cfg = criteria?.config ?? criteria ?? {};
  /** @type {Array<{code: string, severity: 'critical'|'major'|'minor', title: string, detail: string, where?: string}>} */
  const findings = [];
  const placeholders = cfg.forbiddenPlaceholders ?? [];

  // ── разделы ───────────────────────────────────────────────────────────────
  for (const spec of cfg.requiredSections ?? []) {
    const aliases = aliasList(spec);
    const section = findSection(parsed, ...aliases);
    if (!section) {
      push(
        findings,
        'MISSING_SECTION',
        'critical',
        `Нет раздела «${aliases[0]}»`,
        `В документе не найден обязательный раздел. Искал: ${aliases.join(', ')}.`,
        { where: aliases[0] },
      );
      continue;
    }

    const minFromMap = Object.entries(cfg.minWords ?? {}).find(([key]) =>
      aliases.some((alias) => normalizeKey(alias) === normalizeKey(key)),
    )?.[1];
    const minWords = Math.max(minFromMap ?? 0, cfg.minSectionWords ?? 0);
    const dashLines = section.body
      .split('\n')
      .filter((line) => !line.includes(':') && isEmptyValue(line, placeholders)).length;

    if (minWords > 0 && section.words < minWords) {
      push(
        findings,
        'EMPTY_SECTION',
        section.words < Math.max(5, minWords * 0.5) ? 'critical' : 'major',
        `Раздел «${section.title}» почти пустой`,
        `Слов: ${section.words}, минимум по чек-листу: ${minWords}.${dashLines ? ` Прочерков вместо текста: ${dashLines}.` : ''}`,
        { where: section.title },
      );
    } else if (dashLines >= 2) {
      push(
        findings,
        'SECTION_DASHES',
        'critical',
        `Раздел «${section.title}» заполнен прочерками`,
        `Прочерков вместо содержания: ${dashLines}.`,
        { where: section.title },
      );
    }
  }

  // ── обязательные поля ─────────────────────────────────────────────────────
  const missingFields = [];
  const emptyFields = [];
  for (const spec of cfg.requiredFields ?? []) {
    const aliases = aliasList(spec);
    const field = findField(parsed, ...aliases);
    if (!field) {
      missingFields.push(aliases[0]);
      continue;
    }
    if (field.empty || isEmptyValue(field.value, placeholders)) {
      emptyFields.push(field.label);
    }
  }

  if (missingFields.length) {
    push(
      findings,
      'MISSING_FIELD',
      'major',
      `Нет обязательных полей (${missingFields.length})`,
      missingFields.map((f) => `• ${f}`).join('\n'),
    );
  }

  if (emptyFields.length) {
    push(
      findings,
      'EMPTY_FIELD',
      emptyFields.length >= 5 ? 'critical' : 'major',
      `Не заполнены обязательные поля (${emptyFields.length})`,
      emptyFields.map((f) => `• ${f}`).join('\n'),
    );
  }

  // ── прочерки и заглушки во всех полях ─────────────────────────────────────
  const allowEmpty = (cfg.allowEmptyFields ?? []).map(normalizeKey);
  const placeholderFields = parsed.fields.filter(
    (f) => isEmptyValue(f.value, placeholders) && !allowEmpty.some((allowed) => f.key.includes(allowed)),
  );
  if (placeholderFields.length) {
    const ratio = parsed.fields.length ? placeholderFields.length / parsed.fields.length : 0;
    const shown = placeholderFields.slice(0, 20).map((f) => `• ${f.label}`);
    if (placeholderFields.length > 20) shown.push(`…и ещё ${placeholderFields.length - 20}`);
    push(
      findings,
      'PLACEHOLDER',
      ratio >= 0.35 ? 'critical' : 'major',
      `Пустые поля и прочерки: ${placeholderFields.length} из ${parsed.fields.length}`,
      shown.join('\n'),
    );
  }

  // ── объём текста ──────────────────────────────────────────────────────────
  const minTotal = cfg.minWords?.total ?? 0;
  if (minTotal > 0 && parsed.stats.words < minTotal) {
    push(
      findings,
      'TOO_SHORT',
      'major',
      'Документ слишком короткий',
      `Слов: ${parsed.stats.words}, по чек-листу нужно минимум ${minTotal}.`,
    );
  }

  // ── числовые поля ─────────────────────────────────────────────────────────
  for (const spec of cfg.numericFields ?? []) {
    const aliases = aliasList(spec);
    const field = findField(parsed, ...aliases);
    if (!field || field.empty || isEmptyValue(field.value, placeholders)) continue;
    if (extractNumber(field.value) === null) {
      push(
        findings,
        'NOT_NUMERIC',
        'major',
        `«${field.label}» — не число`,
        `Значение: «${field.value}». Ожидалось число.`,
        { where: field.label },
      );
    }
  }

  // ── возраст ↔ год рождения ────────────────────────────────────────────────
  if (cfg.ageFromBirthYear) {
    const ageField = findField(parsed, 'ВОЗРАСТ', 'AGE');
    const age = ageField && !ageField.empty ? extractNumber(ageField.value) : null;
    const birthYear = findBirthYear(parsed.text);
    if (age !== null && birthYear) {
      const expected = new Date().getFullYear() - birthYear;
      if (Math.abs(expected - age) > 1) {
        push(
          findings,
          'AGE_MISMATCH',
          'major',
          'Возраст не сходится с годом рождения',
          `В поле «Возраст» — ${age}, а год рождения ${birthYear} даёт примерно ${expected}.`,
          { where: 'Основная информация' },
        );
      }
    }
    if (age !== null && (age < 16 || age > 80)) {
      push(
        findings,
        'AGE_RANGE',
        'minor',
        'Подозрительный возраст',
        `Указан возраст ${age}. Для сотрудника ОВА это нетипично — проверь вручную.`,
      );
    }
  }

  // ── рост/вес ──────────────────────────────────────────────────────────────
  if (cfg.bmi) {
    const heightField = findField(parsed, 'РОСТ', 'HEIGHT');
    const weightField = findField(parsed, 'ВЕС', 'WEIGHT');
    const height = heightField ? extractNumber(heightField.value) : null;
    const weight = weightField ? extractNumber(weightField.value) : null;
    if (height && weight) {
      const meters = height > 3 ? height / 100 : height;
      const bmi = weight / (meters * meters);
      if (bmi < 15 || bmi > 40) {
        push(
          findings,
          'BMI',
          'minor',
          'Странные пропорции рост/вес',
          `Рост ${height}, вес ${weight} → ИМТ ≈ ${bmi.toFixed(1)}. Проверь, нет ли опечатки.`,
        );
      }
    }
  }

  // ── запрещённые формулировки ──────────────────────────────────────────────
  const haystack = parsed.text.toLowerCase();
  const hits = [];
  for (const phrase of cfg.forbiddenPhrases ?? []) {
    const needle = String(phrase).trim().toLowerCase();
    if (needle && haystack.includes(needle)) hits.push(phrase);
  }
  if (hits.length) {
    push(
      findings,
      'FORBIDDEN_PHRASE',
      'major',
      'Запрещённые формулировки',
      `Найдено: ${hits.map((h) => `«${h}»`).join(', ')}.`,
    );
  }

  // ── артефакты шаблона ─────────────────────────────────────────────────────
  for (const marker of TEMPLATE_MARKERS) {
    if (marker.re.test(parsed.text)) {
      push(findings, 'TEMPLATE_MARKER', 'minor', 'Следы шаблона', marker.text);
    }
  }

  // ── титульная часть ───────────────────────────────────────────────────────
  const head = parsed.text.slice(0, 600).toLowerCase();
  if (head.includes('копия')) {
    push(
      findings,
      'TITLE_COPY',
      'minor',
      'Слово «копия» на титульном листе',
      'В начале документа встречается «копия». Обычно просят убрать.',
      { where: 'Титульный лист' },
    );
  }

  const nameField = findField(parsed, 'ИМЯ', 'ИМЯ ПЕРСОНАЖА');
  const surnameField = findField(parsed, 'ФАМИЛИЯ', 'ФАМИЛИЯ ПЕРСОНАЖА');
  if (nameField && surnameField && !nameField.empty && !surnameField.empty) {
    const name = `${nameField.value} ${surnameField.value}`.toLowerCase().replace(/ё/g, 'е');
    const headFull = parsed.text.slice(0, 1500).toLowerCase().replace(/ё/g, 'е');
    const surnameInHead = headFull.includes(String(surnameField.value).toLowerCase().replace(/ё/g, 'е'));
    if (!surnameInHead) {
      push(
        findings,
        'TITLE_NAME',
        'minor',
        'Имя на титуле не совпадает с полем «Фамилия»',
        `В документе указано «${name}», но в начале документа фамилии нет. Проверь титульный лист.`,
        { where: 'Титульный лист' },
      );
    }
  }

  // ── итоговый балл ─────────────────────────────────────────────────────────
  const penalty = findings.reduce((sum, item) => sum + (SEVERITY_WEIGHT[item.severity] ?? 0), 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));

  return {
    findings,
    score,
    counts: {
      critical: findings.filter((f) => f.severity === 'critical').length,
      major: findings.filter((f) => f.severity === 'major').length,
      minor: findings.filter((f) => f.severity === 'minor').length,
    },
    hasCritical: findings.some((f) => f.severity === 'critical'),
    stats: parsed.stats,
  };
}

function findBirthYear(text) {
  const patterns = [
    /год[^\d\n]{0,25}рождения[^\d\n]{0,15}((?:19|20)\d{2})/i,
    /дата[^\d\n]{0,20}рождения[^\d\n]{0,25}((?:19|20)\d{2})/i,
    /родил(?:ся|ась)[^\d\n]{0,30}((?:19|20)\d{2})/i,
  ];
  for (const re of patterns) {
    const match = text.match(re);
    if (match) return Number(match[1]);
  }
  return null;
}
