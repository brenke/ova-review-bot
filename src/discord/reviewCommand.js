import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

import { createLogger } from '../logger.js';
import { parseCriteriaContent } from '../criteria/store.js';
import { runReview } from '../review/runReview.js';
import { findDocLinkInChannel } from './findDocLink.js';

const log = createLogger('review');

/** Не даём запустить две проверки одного документа одновременно. */
const inFlight = new Set();

export async function handleReviewCommand(interaction) {
  const silent = interaction.options.getBoolean('silent') ?? false;
  const criteriaName = interaction.options.getString('criteria') ?? undefined;
  const providedUrl = interaction.options.getString('url') ?? undefined;

  await interaction.deferReply({ ephemeral: silent });

  let criteriaOverride;
  try {
    criteriaOverride = await loadInlineCriteria(interaction);
  } catch (error) {
    await interaction.editReply({ content: `❌ ${error.message}` });
    return;
  }

  let target;
  if (providedUrl) {
    target = { url: providedUrl.trim(), source: 'аргумент команды' };
  } else {
    await interaction.editReply({ content: '⏳ Ищу ссылку на документ в этом канале…' });
    target = await findDocLinkInChannel(interaction.channel);
  }

  if (!target) {
    await interaction.editReply({
      content:
        'Не нашёл ссылку на Google Документ. Пришли ссылку сообщением в топик или укажи её в команде:\n`/review url:https://docs.google.com/document/d/…/edit`',
    });
    return;
  }

  await reviewAndReply({
    interaction,
    url: target.url,
    criteriaName,
    criteriaOverride,
    sourceNote: target.source,
  });
}

/** Одноразовый чек-лист, приложенный к команде: /review file:my.md */
async function loadInlineCriteria(interaction) {
  const attachment = interaction.options.getAttachment('file');
  if (!attachment) return undefined;

  if (!/\.md$/i.test(attachment.name ?? '')) {
    throw new Error('Нужен файл с расширением .md.');
  }
  if (attachment.size > 256 * 1024) {
    throw new Error('Файл с критериями больше 256 КБ.');
  }

  const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('Не удалось скачать вложенный .md из Discord.');
  return parseCriteriaContent(await response.text(), attachment.name);
}

export async function handleReviewButton(interaction) {
  const [namespace, action, kind, docId] = interaction.customId.split(':');
  if (namespace !== 'review' || action !== 'again' || !docId) {
    log.warn('Неизвестная кнопка:', interaction.customId);
    return;
  }

  await interaction.deferReply();

  const url =
    kind === 'e'
      ? `https://docs.google.com/document/d/e/${docId}/pub`
      : `https://docs.google.com/document/d/${docId}/edit`;

  await reviewAndReply({ interaction, url, sourceNote: 'кнопка «Перепроверить»' });
}

async function reviewAndReply({ interaction, url, criteriaName, criteriaOverride, sourceNote }) {
  const lockKey = `${interaction.guildId ?? 'dm'}:${url}`;
  if (inFlight.has(lockKey)) {
    await interaction.editReply({ content: 'Этот документ уже проверяется, подожди немного.' });
    return;
  }
  inFlight.add(lockKey);

  try {
    await interaction.editReply({ content: `⏳ Проверяю документ (${sourceNote})…` });

    let lastUpdate = 0;
    const onProgress = async (message) => {
      // не спамим правками: Discord разрешает ~5 правок одного сообщения за 5 секунд
      const now = Date.now();
      if (now - lastUpdate < 1200) return;
      lastUpdate = now;
      await interaction.editReply({ content: `⏳ ${message}` }).catch(() => {});
    };

    const result = await runReview({ docUrl: url, criteriaName, criteria: criteriaOverride, onProgress });
    const { report, doc, criteria, detResult, llm, llmError } = result;

    const attachment = new AttachmentBuilder(Buffer.from(report.markdown, 'utf8'), {
      name: report.fileName,
    });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`review:again:${doc.published ? 'e' : 'd'}:${doc.docId}`)
        .setLabel('Перепроверить')
        .setEmoji('🔁')
        .setStyle(ButtonStyle.Secondary),
    );

    await interaction.editReply({
      content: `📄 Документ: ${doc.url}\n🧾 Чек-лист: **${criteria.name}**`,
      embeds: [report.embed],
      files: [attachment],
      components: [row],
    });

    log.info(
      `Проверка ${doc.docId}: ${report.verdict} (${report.score}/100), замечаний: ${detResult.findings.length}, ИИ: ${llm ? 'да' : llmError ? 'ошибка' : 'нет'}`,
    );
  } catch (error) {
    log.error('Ошибка проверки:', error);
    await interaction
      .editReply({ content: `❌ ${error?.message ?? 'Не удалось проверить документ'}` })
      .catch(() => {});
  } finally {
    inFlight.delete(lockKey);
  }
}
