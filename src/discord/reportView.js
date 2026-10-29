/**
 * Сборка сообщения с отчётом на Discord Components V2:
 * контейнер с блоками вместо embed — заголовок, статус по разделам,
 * список проблем, пометки и кнопка «Перепроверить».
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder,
} from 'discord.js';

const ICON = { critical: '🔴', major: '🟠', minor: '🟡', info: 'ℹ️' };
const ACCENT = 0x5865f2;
const MAX_PROBLEM_CHARS = 220;

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/** Строка статуса: по 5 разделов в строке, чтобы не растягивалось на пол-экрана. */
export function statusLine(statuses) {
  const chunks = [];
  for (let i = 0; i < statuses.length; i += 5) {
    chunks.push(
      statuses
        .slice(i, i + 5)
        .map((item) => `${item.icon} ${item.short}`)
        .join('  ·  '),
    );
  }
  return chunks.join('\n');
}

export function problemLine(problem) {
  const head = `${ICON[problem.severity] ?? '•'} **${problem.section}** — ${clip(problem.problem, MAX_PROBLEM_CHARS)}`;
  const fix = problem.fix ? clip(problem.fix, 160) : '';
  return fix ? `${head}\n-# → ${fix}` : head;
}

/** Тело отчёта без кнопок — удобно проверять тестами. */
export function buildReportBody(view) {
  const blocks = [];

  blocks.push(`## ${view.title}\n${clip(view.summary, 900)}`);
  blocks.push(statusLine(view.statuses));

  if (view.problems.length) {
    blocks.push(view.problems.map(problemLine).join('\n'));
  } else {
    blocks.push('✅ Проблемных пунктов нет.');
  }

  if (view.notes.length) {
    blocks.push(`-# ℹ️ К сведению: ${view.notes.map((note) => clip(note, 120)).join(' · ')}`);
  }

  if (view.strengths.length) {
    blocks.push(`-# ✅ ${view.strengths.slice(0, 3).map((item) => clip(item, 120)).join(' · ')}`);
  }

  return blocks;
}

/** Готовое сообщение с отчётом. */
export function buildReportMessage(view, { docId, kind, disabled = false } = {}) {
  const container = new ContainerBuilder().setAccentColor(ACCENT);

  for (const block of buildReportBody(view)) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(block));
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(1));
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`-# [Открыть документ](${view.docUrl}) · чек-лист ${view.checklist}`),
  );

  if (docId) {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`review:again:${kind === 'published' ? 'e' : 'd'}:${docId}`)
          .setLabel('Перепроверить')
          .setEmoji('🔁')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled),
      ),
    );
  }

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

/** Простое сообщение-статус (прогресс, ошибки) в том же стиле. */
export function buildStatusMessage(text, accent = 0x2b2d31) {
  const container = new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}
