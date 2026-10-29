import {
  AttachmentBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';

import { config } from '../config.js';
import { createLogger } from '../logger.js';
import {
  CriteriaError,
  deleteCriteria,
  getCriteria,
  listCriteria,
  saveCriteria,
  suggestSlug,
} from '../criteria/store.js';

const log = createLogger('criteria');

const MAX_UPLOAD_BYTES = 256 * 1024;

export function canManageCriteria(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const roleId = config.discord.reviewerRoleId;
  if (!roleId) return false;
  return Boolean(interaction.member?.roles?.cache?.has(roleId));
}

export async function handleCriteriaCommand(interaction) {
  if (!canManageCriteria(interaction)) {
    await interaction.reply({
      content:
        'Недостаточно прав. Менять чек-листы может тот, у кого есть право «Управление сервером», или роль из `REVIEWER_ROLE_ID`.',
      ephemeral: true,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  try {
    if (subcommand === 'upload') await handleUpload(interaction);
    else if (subcommand === 'list') await handleList(interaction);
    else if (subcommand === 'show') await handleShow(interaction);
    else if (subcommand === 'delete') await handleDelete(interaction);
  } catch (error) {
    const message = error instanceof CriteriaError ? error.message : `Ошибка: ${error.message}`;
    log.error('criteria:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: `❌ ${message}` }).catch(() => {});
    } else {
      await interaction.reply({ content: `❌ ${message}`, ephemeral: true }).catch(() => {});
    }
  }
}

async function handleUpload(interaction) {
  const attachment = interaction.options.getAttachment('file', true);
  const name = interaction.options.getString('name') ?? undefined;

  if (!/\.md$/i.test(attachment.name ?? '')) {
    throw new CriteriaError('Нужен файл с расширением .md (markdown).');
  }
  if (attachment.size > MAX_UPLOAD_BYTES) {
    throw new CriteriaError('Файл больше 256 КБ — так не пойдёт.');
  }

  await interaction.deferReply({ ephemeral: true });

  const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new CriteriaError('Не удалось скачать вложение из Discord.');
  const content = await response.text();

  const filename = name ? `${suggestSlug(name)}.md` : attachment.name;
  const saved = await saveCriteria({ filename, content });

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('Чек-лист сохранён')
    .setDescription(
      [
        `**Название:** ${saved.name}`,
        `**Имя (slug):** \`${saved.slug}\``,
        `**Версия:** ${saved.version || '—'}`,
        `**Файл:** \`data/criteria/${saved.slug}.md\``,
        `**Обновлён:** <t:${Math.floor(saved.updatedAt.getTime() / 1000)}:T>`,
        `**Обязательных разделов:** ${saved.config.requiredSections.length}`,
        `**Обязательных полей:** ${saved.config.requiredFields.length}`,
        `**Слов в критериях:** ${saved.words}`,
        '',
        `Проверка: \`/review criteria:${saved.slug}\``,
        saved.slug === (config.review.defaultCriteria || saved.slug)
          ? 'Этот чек-лист применяется по умолчанию.'
          : 'Чтобы этот чек-лист стал базовым, задай `DEFAULT_CRITERIA` в .env.',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .setTimestamp(new Date());

  await interaction.editReply({ embeds: [embed] });
}

async function handleList(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const list = await listCriteria();

  if (!list.length) {
    await interaction.editReply({ content: 'Чек-листов пока нет. Загрузи .md через `/criteria upload`.' });
    return;
  }

  const lines = list.map((item) => {
    const isDefault = item.slug === (config.review.defaultCriteria || list[0].slug);
    return `${isDefault ? '⭐ ' : '• '}**${item.name}** — \`${item.slug}\`\n   разделов: ${item.sections}, полей: ${item.fields}, обновлён: <t:${Math.floor(item.updatedAt.getTime() / 1000)}:R>`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`Чек-листы (${list.length})`)
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: '⭐ — применяется по умолчанию' });

  await interaction.editReply({ embeds: [embed] });
}

async function handleShow(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const criteria = await getCriteria(interaction.options.getString('name', true));

  const file = new AttachmentBuilder(Buffer.from(criteria.raw, 'utf8'), {
    name: `${criteria.slug}.md`,
  });

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(criteria.name)
    .setDescription(criteria.description || 'Без описания')
    .addFields(
      { name: 'Имя', value: `\`${criteria.slug}\``, inline: true },
      { name: 'Разделов', value: String(criteria.config.requiredSections.length), inline: true },
      { name: 'Полей', value: String(criteria.config.requiredFields.length), inline: true },
      {
        name: 'Модель',
        value: criteria.config.model ? `\`${criteria.config.model}\`` : 'из .env',
        inline: true,
      },
    )
    .setTimestamp(criteria.updatedAt);

  await interaction.editReply({ embeds: [embed], files: [file] });
}

async function handleDelete(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const removed = await deleteCriteria(interaction.options.getString('name', true));
  await interaction.editReply({ content: `🗑️ Чек-лист «${removed.name}» (\`${removed.slug}\`) удалён.` });
}
