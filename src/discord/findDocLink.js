import { extractGoogleDocUrls } from '../gdoc/fetchDoc.js';
import { createLogger } from '../logger.js';

const log = createLogger('link-finder');

const STEAM_ID_RE = /STEAM_[01]:[01]:\d+/i;

/** Первый SteamID в тексте, если он есть. */
export function extractSteamId(text) {
  const match = String(text ?? '').match(STEAM_ID_RE);
  return match ? match[0].toUpperCase() : null;
}

/**
 * Ищет ссылку на Google Документ в топике (форумном посте) или в последних
 * сообщениях канала. Заодно достаёт SteamID из того же сообщения — он нужен
 * для проверки идентификационного номера в удостоверении.
 *
 * @returns {Promise<{url: string, source: string, steamId: string | null} | null>}
 */
export async function findDocLinkInChannel(channel) {
  if (!channel) return null;

  if (typeof channel.isThread === 'function' && channel.isThread()) {
    try {
      const starter = await channel.fetchStarterMessage();
      const urls = extractGoogleDocUrls(starter?.content);
      if (urls.length) {
        return {
          url: urls[0],
          source: 'стартовое сообщение топика',
          steamId: extractSteamId(starter.content),
        };
      }
    } catch (error) {
      log.warn('Не удалось прочитать стартовое сообщение топика:', error.message);
    }
  }

  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const ordered = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    for (const message of ordered) {
      if (message.author?.bot) continue;
      const urls = extractGoogleDocUrls(message.content);
      if (urls.length) {
        // SteamID может быть в том же сообщении или в соседних (анкета + ссылка)
        const steamId =
          extractSteamId(message.content) ??
          ordered.map((item) => extractSteamId(item.content)).find(Boolean) ??
          null;
        return { url: urls[0], source: `сообщение от ${message.author.username}`, steamId };
      }
    }
  } catch (error) {
    log.warn('Не удалось прочитать историю канала:', error.message);
  }

  return null;
}
