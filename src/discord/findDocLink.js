import { extractGoogleDocUrls } from '../gdoc/fetchDoc.js';
import { createLogger } from '../logger.js';

const log = createLogger('link-finder');

/**
 * Ищет ссылку на Google Документ в топике (форумном посте) или в последних
 * сообщениях канала. Так /review можно вызывать без аргументов прямо в топике.
 *
 * @returns {Promise<{url: string, source: string} | null>}
 */
export async function findDocLinkInChannel(channel) {
  if (!channel) return null;

  if (typeof channel.isThread === 'function' && channel.isThread()) {
    try {
      const starter = await channel.fetchStarterMessage();
      const urls = extractGoogleDocUrls(starter?.content);
      if (urls.length) return { url: urls[0], source: 'стартовое сообщение топика' };
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
        return { url: urls[0], source: `сообщение от ${message.author.username}` };
      }
    }
  } catch (error) {
    log.warn('Не удалось прочитать историю канала:', error.message);
  }

  return null;
}
