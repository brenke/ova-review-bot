import { MessageFlags, PermissionFlagsBits } from 'discord.js';

import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { runReview } from '../review/runReview.js';
import { extractSteamId, findDocLinkInChannel } from './findDocLink.js';
import { buildReportMessage, buildStatusMessage } from './reportView.js';

const log = createLogger('review');

/** Не даём запустить две проверки одного документа одновременно. */
const inFlight = new Set();

/** Доступ к проверке: админы всегда, роли из REVIEW_ROLE_IDS — если список задан. */
function canRunReview(interaction) {
  const roleIds = config.discord.reviewRoleIds ?? [];
  if (!roleIds.length) return true; // список не задан — доступно всем
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  return roleIds.some((roleId) => interaction.member?.roles?.cache?.has(roleId));
}

/** Reply со статусом в формате Components V2 (+ эфемерность при необходимости). */
function statusReply(text, ephemeral = false) {
  const payload = buildStatusMessage(text);
  return {
    ...payload,
    flags: payload.flags | (ephemeral ? MessageFlags.Ephemeral : 0),
  };
}

export async function handleReviewCommand(interaction) {
  if (!canRunReview(interaction)) {
    await interaction.reply({
      content: 'Недостаточно прав для запуска проверки. Обратись к проверяющему или администратору.',
      ephemeral: true,
    });
    return;
  }

  const silent = interaction.options.getBoolean('silent') ?? false;
  const criteriaName = interaction.options.getString('criteria') ?? undefined;

  await interaction.reply(statusReply('⏳ Ищу ссылку на документ в этом канале…', silent));

  const target = await findDocLinkInChannel(interaction.channel);
  if (!target) {
    await interaction.editReply(
      buildStatusMessage(
        'Не нашёл ссылку на Google Документ. Пришли ссылку сообщением в этот топик (или отдельным сообщением в канал) и вызови `/review` снова.',
        0xed4245,
      ),
    );
    return;
  }

  await reviewAndReply({
    interaction,
    url: target.url,
    criteriaName,
    steamId: target.steamId,
    sourceNote: target.source,
  });
}

export async function handleReviewButton(interaction) {
  const [namespace, action, kind, docId] = interaction.customId.split(':');
  if (namespace !== 'review' || action !== 'again' || !docId) {
    log.warn('Неизвестная кнопка:', interaction.customId);
    return;
  }

  // Если исходный отчёт был «только для себя» — новый тоже делаем приватным
  const ephemeral = interaction.message?.flags?.has(MessageFlags.Ephemeral) ?? false;
  await interaction.reply(statusReply('⏳ Перепроверяю документ…', ephemeral));

  const url =
    kind === 'e'
      ? `https://docs.google.com/document/d/e/${docId}/pub`
      : `https://docs.google.com/document/d/${docId}/edit`;

  // SteamID берём из стартового сообщения топика — он нужен для сверки ID
  let steamId = null;
  try {
    if (interaction.channel?.isThread?.()) {
      const starter = await interaction.channel.fetchStarterMessage();
      steamId = extractSteamId(starter?.content);
    }
  } catch (error) {
    log.warn('Не удалось прочитать SteamID из топика:', error.message);
  }

  await reviewAndReply({
    interaction,
    url,
    steamId,
    sourceNote: 'кнопка «Перепроверить»',
    deletePrevious: interaction.message,
  });
}

async function reviewAndReply({ interaction, url, criteriaName, steamId, sourceNote, deletePrevious }) {
  const lockKey = `${interaction.guildId ?? 'dm'}:${url}`;
  if (inFlight.has(lockKey)) {
    await interaction.editReply(buildStatusMessage('Этот документ уже проверяется, подожди немного.', 0xf1c40f));
    return;
  }
  inFlight.add(lockKey);

  try {
    await interaction.editReply(buildStatusMessage(`⏳ Проверяю документ (${sourceNote})…`));

    let lastUpdate = 0;
    const onProgress = async (message) => {
      // не спамим правками: Discord разрешает ~5 правок одного сообщения за 5 секунд
      const now = Date.now();
      if (now - lastUpdate < 1200) return;
      lastUpdate = now;
      await interaction.editReply(buildStatusMessage(`⏳ ${message}`)).catch(() => {});
    };

    const result = await runReview({ docUrl: url, criteriaName, steamId, onProgress });
    const { report, doc, criteria, detResult, llm, llmError } = result;

    await interaction.editReply(
      buildReportMessage(report.view, {
        docId: doc.docId,
        kind: doc.published ? 'published' : 'regular',
      }),
    );

    // При перепроверке убираем старое сообщение — остаётся только свежий отчёт.
    if (deletePrevious) {
      await deletePrevious.delete().catch((error) => {
        log.warn('Не удалось удалить прошлый отчёт:', error.message);
      });
    }

    log.info(
      `Проверка ${doc.docId}: замечаний ${detResult.findings.length} (🔴 ${detResult.counts.critical}, 🟠 ${detResult.counts.major}, 🟡 ${detResult.counts.minor}, ℹ️ ${detResult.counts.info}), чек-лист ${criteria.slug} (${criteria.updatedAt?.toISOString().slice(0, 16) ?? '—'}), ИИ: ${llm ? 'да' : llmError ? 'ошибка' : 'нет'}`,
    );
  } catch (error) {
    log.error('Ошибка проверки:', error);
    await interaction
      .editReply(buildStatusMessage(`❌ ${error?.message ?? 'Не удалось проверить документ'}`, 0xed4245))
      .catch(() => {});
  } finally {
    inFlight.delete(lockKey);
  }
}
