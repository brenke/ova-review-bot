/**
 * Собирает отчёт: короткий embed для Discord и подробный .md-файл.
 * Вердикт бот не выносит — только факты, оценка и замечания.
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

function scoreBar(score) {
  const filled = Math.max(0, Math.min(10, Math.round(score / 10)));
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
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

export function buildReport({ doc, parsed, criteria, detResult, llm, llmError }) {
  const detScore = detResult.score;
  const aiScore = llm?.score ?? null;
  const score = aiScore === null ? detScore : Math.round(detScore * 0.5 + aiScore * 0.5);

  const name = personName(parsed);

  const allIssues = [
    ...(llm?.issues ?? []),
    ...autoFindingsAsIssues(detResult.findings),
  ].sort((a, b) => {
    const order = { critical: 0, major: 1, minor: 2, info: 3 };
    return (order[a.severity] ?? 4) - (order[b.severity] ?? 4);
  });

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
    .setDescription(truncate(summaryText, 1200))
    .addFields(
      {
        name: 'Оценка',
        value: `\`${scoreBar(score)}\` **${score}/100**`,
        inline: true,
      },
      {
        name: 'Автопроверки',
        value: `${SEVERITY_ICON.critical} ${detResult.counts.critical} · ${SEVERITY_ICON.major} ${detResult.counts.major} · ${SEVERITY_ICON.minor} ${detResult.counts.minor}${detResult.counts.info ? ` · ${SEVERITY_ICON.info} ${detResult.counts.info}` : ''}`,
        inline: true,
      },
      {
        name: 'Чек-лист',
        value: truncate(
          `${criteria.name}\n\`${criteria.slug}\`${criteria.version ? ` · v${criteria.version}` : ''}`,
          100,
        ),
        inline: true,
      },
    );

  const criticalAndMajor = allIssues.filter((i) => i.severity === 'critical' || i.severity === 'major');
  if (criticalAndMajor.length) {
    embed.addFields({
      name: 'Главные замечания',
      value: truncate(
        criticalAndMajor
          .slice(0, 6)
          .map((i) => `${SEVERITY_ICON[i.severity] ?? '•'} **${i.where || 'Документ'}** — ${i.problem}`)
          .join('\n'),
        1000,
      ),
    });
  }

  const notes = allIssues.filter((i) => i.severity === 'info');
  if (notes.length) {
    embed.addFields({
      name: `${SEVERITY_ICON.info} К сведению (без штрафа)`,
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
      `Автопроверки: ${detScore}/100${aiScore !== null ? ` · ИИ (${llm?.model ?? criteria.config.model ?? 'модель'}): ${aiScore}/100` : ''}${criteriaStamp ? ` · чек-лист от ${criteriaStamp}` : ''}`,
      200,
    ),
  });
  embed.setTimestamp(new Date());

  // ── markdown ──────────────────────────────────────────────────────────────
  const lines = [];
  const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();

  lines.push('# Проверка документа');
  lines.push('');
  lines.push(`**Оценка:** ${score}/100${aiScore !== null ? ` (автопроверки ${detScore}, ИИ ${aiScore})` : ' (только автопроверки)'}`);
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

  if (allIssues.length) {
    lines.push('## Замечания');
    for (const severity of ['critical', 'major', 'minor', 'info']) {
      const group = allIssues.filter((i) => i.severity === severity);
      if (!group.length) continue;
      lines.push('');
      lines.push(`### ${SEVERITY_ICON[severity]} ${SEVERITY_TITLE[severity]} (${group.length})`);
      lines.push('');
      group.forEach((issue, index) => {
        const source = issue.auto ? ' _(автопроверка)_' : '';
        lines.push(`${index + 1}. **${issue.where || 'Документ'}** — ${issue.problem}${source}`);
        if (issue.fix) {
          for (const fixLine of String(issue.fix).split('\n')) {
            lines.push(`   - ${fixLine.trim()}`);
          }
        }
      });
    }
    lines.push('');
  } else {
    lines.push('## Замечания');
    lines.push('');
    lines.push('Замечаний нет.');
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

  return {
    color: REPORT_COLOR,
    score,
    detScore,
    aiScore,
    embed,
    markdown,
    fileName: `review-${safeName}.md`,
    issues: allIssues,
  };
}
