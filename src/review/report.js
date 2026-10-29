/**
 * Собирает отчёт: короткий embed для Discord и подробный .md-файл (для CLI).
 * Никаких оценок и вердиктов — только факты и замечания.
 */

import { EmbedBuilder } from 'discord.js';

import { findField } from '../gdoc/parseDoc.js';

const SEVERITY_ICON = { critical: '🔴', major: '🟠', minor: '🟡', info: 'ℹ️' };
const SEVERITY_TITLE = { critical: 'Критично', major: 'Важно', minor: 'Мелочи', info: 'К сведению' };
const STATUS_ICON = { pass: '✅', warn: '⚠️', fail: '❌' };
const REPORT_COLOR = 0x5865f2;

function truncate(text, max) {
  const value = String(text ?? '').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function personName(parsed) {
  const name = findField(parsed, 'ИМЯ', 'ИМЯ ПЕРСОНАЖА');
  const surname = findField(parsed, 'ФАМИЛИЯ', 'ФАМИЛИЯ ПЕРСОНАЖА');
  const parts = [name?.value, surname?.value].filter((v) => v && v.trim() && v.trim() !== '-');
  return parts.length ? parts.join(' ') : '';
}

function autoFindingsAsIssues(findings) {
  return findings.map((item) => ({
    severity: item.severity,
    where: item.where ?? 'Документ',
    problem: item.title,
    fix: item.detail,
    auto: true,
  }));
}

/**
 * Биография и психологический портрет — не блокеры. Если модель всё равно
 * пометила их как критичные/важные только за пустоту, понижаем до «к сведению».
 */
function isNonBlockingEmptyIssue(issue) {
  const where = String(issue.where ?? '').toLowerCase();
  const text = `${issue.problem ?? ''} ${issue.fix ?? ''}`.toLowerCase();
  const section = /биограф|психологическ/.test(where);
  const empty = /пуст|не заполн|нет информации|отсутств|не написан|нет текста|не указан/.test(text);
  return section && empty;
}

/**
 * Заведомо ложные срабатывания модели, которые нельзя объяснить лору.
 * «КАД без КПД» — норма: КПД нужен только для прав категории C.
 */
function isKnownFalsePositive(issue) {
  const text = `${issue.where ?? ''} ${issue.problem ?? ''}`.toLowerCase();
  return /кад/.test(text) && /кпд/.test(text) && !/права|категори/.test(text);
}

/** «Вкладки» документа: порядок и правила сопоставления по тексту замечания. */
const SECTIONS = [
  { title: 'Титульный лист', short: 'Титул', re: /титул/ },
  { title: 'Основная информация', short: 'Основное', re: /основн/ },
  { title: 'Физическая информация', short: 'Физика', re: /физическ/ },
  { title: 'Информация о семье', short: 'Семья', re: /семь/ },
  { title: 'Медицинская карта', short: 'Медкарта', re: /медицин|мед\s*карт|заметки для врача|заболеван|аллерг/ },
  { title: 'Имплантация', short: 'Импланты', re: /имплант/ },
  { title: 'Психологический портрет', short: 'Психо', re: /психолог/ },
  { title: 'Биография', short: 'Биография', re: /биограф|сводка деятельности/ },
  { title: 'Удостоверение', short: 'Удостоверение', re: /удостовер|кпд|подпис|выдано/ },
  { title: 'Лор и правила', short: 'Лор', re: /лор|нелорн|секретн|фракц|город/, hideInStatus: true },
];

function sectionFor(issue) {
  const text = `${issue.where ?? ''} ${issue.problem ?? ''}`.toLowerCase();
  const found = SECTIONS.find((section) => section.re.test(text));
  return found ? found.title : 'Прочее';
}

/** Группирует замечания по разделам в порядке вкладок документа. */
function groupBySection(issues) {
  const groups = new Map();
  for (const issue of issues) {
    const title = sectionFor(issue);
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push(issue);
  }

  const ordered = [];
  for (const section of SECTIONS) {
    if (groups.has(section.title)) ordered.push([section.title, groups.get(section.title)]);
  }
  if (groups.has('Прочее')) ordered.push(['Прочее', groups.get('Прочее')]);
  return ordered;
}

/** Схлопывает одинаковые замечания от автопроверки и ИИ. */
function dedupeIssues(issues) {
  const rank = { critical: 0, major: 1, minor: 2, info: 3 };
  const norm = (value) =>
    String(value ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const quoted = (value) =>
    [...String(value ?? '').matchAll(/«([^»]{3,})»/g)].map((match) => match[1].toLowerCase().trim());
  const emptyish = (value) => /не заполн|пуст|нет информац|отсутств/.test(String(value ?? '').toLowerCase());

  const result = [];
  for (const issue of issues) {
    const key = norm(issue.problem);
    const issueQuotes = quoted(issue.problem);

    const duplicate = result.find((existing) => {
      const other = norm(existing.problem);
      if (key.length > 10 && (other === key || (other.length > 12 && (other.includes(key) || key.includes(other))))) {
        return true;
      }
      // То же поле/сущность в кавычках — например, «действительно до»
      const existingQuotes = quoted(existing.problem);
      if (
        issueQuotes.some((quote) =>
          existingQuotes.some((otherQuote) => quote === otherQuote || quote.includes(otherQuote) || otherQuote.includes(quote)),
        )
      ) {
        return true;
      }
      // Один и тот же незаполненный раздел
      return emptyish(issue.problem) && emptyish(existing.problem) && sectionFor(existing) === sectionFor(issue);
    });

    if (!duplicate) {
      result.push(issue);
      continue;
    }
    if ((rank[issue.severity] ?? 9) < (rank[duplicate.severity] ?? 9)) Object.assign(duplicate, issue);
  }
  return result;
}

/** Иконка worst-severity для раздела. */
const SEVERITY_RANK = { critical: 0, major: 1, minor: 2, info: 3 };

function worstIcon(issues) {
  const worst = issues.reduce(
    (best, issue) => ((SEVERITY_RANK[issue.severity] ?? 9) < (SEVERITY_RANK[best] ?? 9) ? issue.severity : best),
    'info',
  );
  return { critical: '🔴', major: '🟠', minor: '🟡', info: 'ℹ️' }[worst] ?? 'ℹ️';
}

export function buildReport({ doc, parsed, criteria, detResult, llm, llmError }) {
  const name = personName(parsed);

  const llmIssues = (llm?.issues ?? [])
    .filter((issue) => !isKnownFalsePositive(issue))
    .map((issue) => (isNonBlockingEmptyIssue(issue) ? { ...issue, severity: 'info' } : issue));

  const allIssues = [
    ...llmIssues,
    ...autoFindingsAsIssues(detResult.findings),
  ].sort((a, b) => {
    const order = { critical: 0, major: 1, minor: 2, info: 3 };
    return (order[a.severity] ?? 4) - (order[b.severity] ?? 4);
  });

  // В «вкладки» попадают только проблемы: критично / важно / мелочи
  const problems = dedupeIssues(allIssues.filter((issue) => issue.severity !== 'info'));
  const notes = dedupeIssues(allIssues.filter((issue) => issue.severity === 'info'));

  // Строка статуса: по каждому разделу — worst-иконка или «нет проблем»
  const statuses = SECTIONS.filter((section) => !section.hideInStatus).map((section) => {
    const present = parsed.sections.some((item) => section.re.test(String(item.title ?? '').toLowerCase()));
    const sectionProblems = problems.filter((issue) => sectionFor(issue) === section.title);
    const sectionNotes = notes.filter((issue) => sectionFor(issue) === section.title);
    const icon = sectionProblems.length
      ? worstIcon(sectionProblems)
      : sectionNotes.length
        ? 'ℹ️'
        : present
          ? '✅'
          : '⚪';
    return { short: section.short, icon };
  });

  const otherProblems = problems.filter((issue) => sectionFor(issue) === 'Прочее');
  if (otherProblems.length) statuses.push({ short: 'Прочее', icon: worstIcon(otherProblems) });

  const blocking = detResult.counts.critical + detResult.counts.major;
  const summaryText =
    llm?.summary ||
    (blocking > 0
      ? `Автопроверки: ${detResult.counts.critical} критичных, ${detResult.counts.major} важных, ${detResult.counts.minor} мелочей, ${detResult.counts.info} пометок для ревьюера. ИИ-проверка не выполнялась.`
      : detResult.counts.info > 0
        ? `Блокирующих проблем нет. Пометок для ревьюера: ${detResult.counts.info}, мелочей: ${detResult.counts.minor}. ИИ-проверка не выполнялась.`
        : 'Автопроверки не нашли проблем. ИИ-проверка не выполнялась.');

  // ── embed ─────────────────────────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setColor(REPORT_COLOR)
    .setTitle(truncate(name ? `Проверка: ${name}` : 'Проверка документа', 250))
    .setURL(doc.url)
    .setDescription(truncate(summaryText, 1200));

  // Раздел = «вкладка» документа; внутри — только проблемы (🔴/🟠/🟡)
  const groups = groupBySection(problems);
  groups.forEach(([title, items], index) => {
    const lines = items.map((item) => {
      const icon = SEVERITY_ICON[item.severity] ?? '•';
      const head = `**${item.problem}**`;
      const fix = item.fix ? `\n   ↳ ${String(item.fix).replace(/\n/g, ' ')}` : '';
      return `${icon} ${head}${fix}`;
    });
    embed.addFields({
      name: truncate(`${index + 1} · ${title}`, 250),
      value: truncate(lines.join('\n'), 1000),
    });
  });

  if (!groups.length) {
    embed.addFields({
      name: 'Замечаний нет',
      value: 'Проблемных пунктов не найдено — остальное в пометках ниже.',
    });
  }

  if (notes.length) {
    embed.addFields({
      name: `${SEVERITY_ICON.info} К сведению`,
      value: truncate(
        notes.slice(0, 5).map((i) => `• **${i.where || 'Документ'}** — ${i.problem}`).join('\n'),
        1000,
      ),
    });
  }

  if (llm?.strengths?.length) {
    embed.addFields({
      name: 'Что хорошо',
      value: truncate(llm.strengths.slice(0, 4).map((s) => `• ${s}`).join('\n'), 1000),
    });
  }

  if (!llm) {
    embed.addFields({
      name: 'ИИ-проверка',
      value: llmError
        ? truncate(`Не выполнена: ${llmError}`, 1000)
        : 'Выключена (не задан LLM_API_KEY) — только автопроверки.',
    });
  }

  const criteriaStamp = criteria.updatedAt
    ? criteria.updatedAt.toISOString().replace('T', ' ').slice(0, 16)
    : '';
  embed.setFooter({
    text: truncate(
      [`${criteria.slug}${criteria.version ? ` · v${criteria.version}` : ''}`, criteriaStamp ? `обновлён ${criteriaStamp}` : '']
        .filter(Boolean)
        .join(' · '),
      200,
    ),
  });
  embed.setTimestamp(new Date());

  // ── markdown ──────────────────────────────────────────────────────────────
  const lines = [];
  const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();

  lines.push('# Проверка документа');
  lines.push('');
  lines.push(`**Чек-лист:** ${criteria.name} (\`${criteria.slug}\`${criteria.version ? `, v${criteria.version}` : ''})`);
  if (criteria.updatedAt) {
    lines.push(`**Файл чек-листа обновлён:** ${criteria.updatedAt.toISOString().replace('T', ' ').slice(0, 16)} UTC`);
  }
  lines.push(`**Документ:** ${doc.url}`);
  lines.push(`**Проверено:** ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`);
  if (llm?.model) lines.push(`**Модель:** ${llm.model}`);
  lines.push('');
  lines.push('## Кратко');
  lines.push('');
  lines.push(summaryText);
  lines.push('');

  lines.push('## Статистика документа');
  lines.push('');
  lines.push('| Показатель | Значение |');
  lines.push('| --- | --- |');
  lines.push(`| Символов | ${detResult.stats.chars} |`);
  lines.push(`| Слов | ${detResult.stats.words} |`);
  lines.push(`| Разделов | ${detResult.stats.sectionCount} |`);
  lines.push(`| Полей | ${detResult.stats.fieldCount} |`);
  lines.push(`| Пустых полей | ${detResult.stats.placeholderFields} |`);
  lines.push('');

  if (problems.length) {
    lines.push('## Замечания по разделам');
    groups.forEach(([title, items], index) => {
      lines.push('');
      lines.push(`### ${index + 1} · ${title} (${items.length})`);
      lines.push('');
      items.forEach((issue, itemIndex) => {
        const source = issue.auto ? ' _(автопроверка)_' : '';
        lines.push(`${itemIndex + 1}. ${SEVERITY_ICON[issue.severity] ?? '•'} ${issue.problem}${source}`);
        if (issue.fix) {
          for (const fixLine of String(issue.fix).split('\n')) {
            lines.push(`   - ${fixLine.trim()}`);
          }
        }
      });
    });
    lines.push('');
  } else {
    lines.push('## Замечания по разделам');
    lines.push('');
    lines.push('Проблемных пунктов нет.');
    lines.push('');
  }

  if (notes.length) {
    lines.push('## К сведению');
    lines.push('');
    for (const note of notes) {
      lines.push(`- **${note.where || 'Документ'}** — ${note.problem}`);
    }
    lines.push('');
  }

  if (detResult.findings.length) {
    lines.push('## Автопроверки (подробно)');
    lines.push('');
    lines.push('| Уровень | Код | Проверка | Детали |');
    lines.push('| --- | --- | --- | --- |');
    for (const finding of detResult.findings) {
      lines.push(
        `| ${SEVERITY_TITLE[finding.severity]} | \`${finding.code}\` | ${cell(finding.title)} | ${cell(finding.detail)} |`,
      );
    }
    lines.push('');
  }

  if (llm?.criteria?.length) {
    lines.push('## Чек-лист по пунктам');
    lines.push('');
    for (const item of llm.criteria) {
      lines.push(`- ${STATUS_ICON[item.status] ?? '•'} **${item.name}**${item.comment ? ` — ${item.comment}` : ''}`);
    }
    lines.push('');
  }

  if (llm?.strengths?.length) {
    lines.push('## Что хорошо');
    lines.push('');
    for (const item of llm.strengths) lines.push(`- ${item}`);
    lines.push('');
  }

  lines.push('---');
  lines.push(
    `Отчёт сгенерирован автоматически. Автопроверки — детерминированные правила из чек-листа; ИИ-часть — рекомендация, финальное решение за проверяющим.`,
  );

  const markdown = lines.join('\n');
  const safeName = (name || 'anketa').replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 40);

  const view = {
    title: name ? `Проверка: ${name}` : 'Проверка документа',
    summary: summaryText,
    docUrl: doc.url,
    checklist: `${criteria.slug}${criteria.version ? ` · v${criteria.version}` : ''}`,
    statuses,
    problems: problems.map((issue) => ({
      severity: issue.severity,
      section: sectionFor(issue),
      problem: issue.problem,
      fix: issue.fix ?? '',
    })),
    notes: notes.map((issue) => {
      const section = SECTIONS.find((item) => item.title === sectionFor(issue));
      const short = section?.short ?? 'Документ';
      let text = String(issue.problem ?? '')
        .replace(/^Раздел «[^»]+»\s*/i, '')
        .replace(/\s*—\s*на усмотрение ревьюера\.?$/i, '')
        .replace(/^почти не заполнен[оа]?$/i, 'почти пусто')
        .replace(/^не заполнен[оа]?$/i, 'пусто')
        .trim();
      text = text.charAt(0).toLowerCase() + text.slice(1);
      return text.toLowerCase().startsWith(short.toLowerCase()) ? text : `${short}: ${text}`;
    }),
    strengths: Array.isArray(llm?.strengths) ? llm.strengths : [],
  };

  return {
    color: REPORT_COLOR,
    embed,
    view,
    markdown,
    fileName: `review-${safeName}.md`,
    issues: allIssues,
  };
}
