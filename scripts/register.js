/**
 * Ручная регистрация слэш-команд (если не хочется перезапускать бота).
 *
 *   npm run register
 */
import { Client, Events, GatewayIntentBits } from 'discord.js';

import { config } from '../src/config.js';
import { commands } from '../src/discord/commands.js';

if (!config.discord.token) {
  console.error('Не задан DISCORD_TOKEN в .env');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  try {
    const body = commands.map((command) => command.toJSON());
    if (config.discord.guildId) {
      await client.application.commands.set(body, config.discord.guildId);
      console.log(`Команды зарегистрированы на сервере ${config.discord.guildId}`);
    } else {
      await client.application.commands.set(body);
      console.log('Команды зарегистрированы глобально (до часа на распространение)');
    }
  } catch (error) {
    console.error('Ошибка регистрации:', error.message);
    process.exitCode = 1;
  } finally {
    await client.destroy();
  }
});

await client.login(config.discord.token);
