import { Client, Events, GatewayIntentBits } from 'discord.js';

import { config } from './config.js';
import { listCriteria, ensureDirs } from './criteria/store.js';
import { commands } from './discord/commands.js';
import { handleCriteriaCommand } from './discord/criteriaCommand.js';
import { handleInfoCommand } from './discord/infoCommand.js';
import { listLoreFiles } from './lore/store.js';
import { handleReviewButton, handleReviewCommand } from './discord/reviewCommand.js';
import { createLogger } from './logger.js';
import { llmInfo } from './review/llm.js';

const log = createLogger('main');

const INVITE_PERMISSIONS = 117_760; // ViewChannel, SendMessages, EmbedLinks, AttachFiles, ReadMessageHistory

function attachHandlers(client) {
  client.once(Events.ClientReady, async (readyClient) => {
    log.info(`Бот запущен как ${readyClient.user.tag}`);
    log.info(`Серверов: ${readyClient.guilds.cache.size}`);
    if (readyClient.guilds.cache.size > 0) {
      log.info(
        `Подключён к: ${readyClient.guilds.cache.map((guild) => `${guild.name} (${guild.id})`).join(', ')}`,
      );
    }
    const llm = llmInfo();
    log.info(
      llm.configured
        ? `ИИ-проверка: ${llm.model} (${llm.baseUrl})`
        : 'ИИ-проверка выключена: не задан LLM_API_KEY — работают только автопроверки',
    );
    log.info(
      `Ссылка-приглашение: https://discord.com/api/oauth2/authorize?client_id=${config.discord.clientId || readyClient.user.id}&permissions=${INVITE_PERMISSIONS}&scope=bot%20applications.commands`,
    );

    if (readyClient.guilds.cache.size === 0) {
      log.warn('Бот не добавлен ни на один сервер — открой ссылку-приглашение выше и выбери сервер.');
    }

    try {
      await ensureDirs();
      const list = await listCriteria();
      log.info(`Чек-листов в data/criteria: ${list.length}${list.length ? ` (${list.map((i) => i.slug).join(', ')})` : ''}`);
      if (list.length === 0) {
        log.warn('Чек-листов нет: загрузи чек-лист командой /criteria upload или проверь content/criteria.');
      }
    } catch (error) {
      log.warn('Не удалось прочитать чек-листы:', error.message);
    }

    try {
      const loreFiles = await listLoreFiles();
      log.info(
        `Файлов лора: ${loreFiles.length}${loreFiles.length ? ` (${loreFiles.join(', ')})` : ' — папка content/lore пуста'}`,
      );
    } catch (error) {
      log.warn('Не удалось прочитать лор:', error.message);
    }

    if (config.discord.deployCommands) await deployCommands(readyClient);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isAutocomplete()) {
        await handleAutocomplete(interaction);
        return;
      }

      if (interaction.isButton()) {
        if (interaction.customId.startsWith('review:')) await handleReviewButton(interaction);
        return;
      }

      if (!interaction.isChatInputCommand()) return;

      if (interaction.commandName === 'review') {
        await handleReviewCommand(interaction);
      } else if (interaction.commandName === 'criteria') {
        await handleCriteriaCommand(interaction);
      } else if (interaction.commandName === 'info') {
        await handleInfoCommand(interaction);
      }
    } catch (error) {
      log.error(`Ошибка обработки ${interaction.commandName ?? interaction.customId}:`, error);
      const payload = { content: `❌ Внутренняя ошибка: ${error?.message ?? error}`, ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  });

  client.on(Events.GuildCreate, (guild) => {
    log.info(`Бот добавлен на сервер: ${guild.name} (${guild.id}), участников: ${guild.memberCount}`);
    log.info(
      'Глобальные слэш-команды появятся там в течение часа. Нужно сразу — перезапусти бота с GUILD_ID этого сервера.',
    );
  });

  client.on(Events.GuildDelete, (guild) => {
    log.warn(`Бота удалили с сервера: ${guild.name} (${guild.id})`);
  });

  client.on(Events.Error, (error) => log.error('Discord client error:', error));
  client.on(Events.Warn, (message) => log.warn('Discord:', message));
}

async function deployCommands(client) {
  const body = commands.map((command) => command.toJSON());

  try {
    // Глобально — чтобы команды работали на любом сервере, куда добавят бота
    await client.application.commands.set(body);
    log.info('Слэш-команды обновлены глобально (на новом сервере могут появиться до часа)');

    // Дополнительно на конкретный сервер — там команды видны сразу
    if (config.discord.guildId) {
      if (client.guilds.cache.has(config.discord.guildId)) {
        await client.application.commands.set(body, config.discord.guildId);
        log.info(`Слэш-команды продублированы на сервер ${config.discord.guildId} (появятся сразу)`);
      } else {
        log.warn(
          `GUILD_ID=${config.discord.guildId}, но бот не состоит в этом сервере. ` +
            'Пригласи бота по ссылке выше — глобальные команды подтянутся сами, либо поправь GUILD_ID.',
        );
      }
    }
  } catch (error) {
    log.error('Не удалось зарегистрировать команды:', error.message);
  }
}

async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  let list = [];
  try {
    list = await listCriteria();
  } catch (error) {
    log.warn('autocomplete:', error.message);
  }

  const query = String(focused.value ?? '').toLowerCase();
  const choices = list
    .filter((item) => !query || item.slug.toLowerCase().includes(query) || item.name.toLowerCase().includes(query))
    .slice(0, 25)
    .map((item) => ({ name: `${item.name} (${item.slug})`.slice(0, 100), value: item.slug }));

  await interaction.respond(choices).catch(() => {});
}

function createClient({ withMessageContent }) {
  const intents = [GatewayIntentBits.Guilds];
  if (withMessageContent) {
    intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  }
  const client = new Client({ intents });
  attachHandlers(client);
  return client;
}

async function boot() {
  if (!config.discord.token) {
    console.error(
      '\n[!] Не задан DISCORD_TOKEN. Скопируй .env.example в .env и вставь токен из Discord Developer Portal.\n',
    );
    process.exitCode = 1;
    return;
  }

  let client = createClient({ withMessageContent: true });

  try {
    await client.login(config.discord.token);
  } catch (error) {
    if (/disallowed intents/i.test(error?.message ?? '')) {
      log.warn(
        'В Developer Portal выключен MESSAGE CONTENT INTENT. Работаю без него: /review будет требовать url вручную.',
      );
      client.destroy();
      client = createClient({ withMessageContent: false });
      await client.login(config.discord.token);
    } else {
      log.error('Не удалось подключиться к Discord:', error.message);
      process.exitCode = 1;
    }
  }

  const shutdown = async (signal) => {
    log.info(`Получен ${signal}, отключаюсь…`);
    await client.destroy();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => log.error('unhandledRejection:', reason));
process.on('uncaughtException', (error) => log.error('uncaughtException:', error));

boot();
