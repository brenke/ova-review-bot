/**
 * Достаёт текст Google-документа по публичной ссылке.
 *
 * Почему txt, а не html/docx: у «красивых» анкет html-экспорт весит 13-18 МБ
 * (внутри base64-картинки и встроенные шрифты), а txt-экспорт — 10-20 КБ и
 * сохраняет поля таблиц в виде "МЕТКА:\\n\\tзначение". Для проверки текста
 * этого достаточно.
 */

const RE_PUBLISHED = /docs\.google\.com\/document\/d\/e\/([A-Za-z0-9_-]{20,})/;
const RE_REGULAR = /docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,})/;
const RE_RAW_ID = /^[A-Za-z0-9_-]{25,}$/;

export class DocFetchError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DocFetchError';
    this.code = code;
  }
}

/**
 * Разбирает ссылку (или голый ID) на документ.
 * @returns {{docId: string, published: boolean, url: string, exportUrl: string} | null}
 */
export function parseGoogleDocUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  if (RE_RAW_ID.test(raw)) {
    return {
      docId: raw,
      published: false,
      url: `https://docs.google.com/document/d/${raw}/edit`,
      exportUrl: `https://docs.google.com/document/d/${raw}/export?format=txt`,
    };
  }

  const published = raw.match(RE_PUBLISHED);
  if (published) {
    const docId = published[1];
    return {
      docId,
      published: true,
      url: `https://docs.google.com/document/d/e/${docId}/pub`,
      exportUrl: `https://docs.google.com/document/d/e/${docId}/pub?embedded=true`,
    };
  }

  const regular = raw.match(RE_REGULAR);
  if (regular) {
    const docId = regular[1];
    return {
      docId,
      published: false,
      url: `https://docs.google.com/document/d/${docId}/edit`,
      exportUrl: `https://docs.google.com/document/d/${docId}/export?format=txt`,
    };
  }

  return null;
}

/** Быстрая проверка «похоже ли на ссылку на гугл-док». */
export function isGoogleDocUrl(text) {
  return Boolean(parseGoogleDocUrl(text));
}

/** Вытаскивает все уникальные ссылки на гугл-доки из произвольного текста. */
export function extractGoogleDocUrls(text) {
  const out = [];
  const re = /https?:\/\/docs\.google\.com\/document\/[^\s<>()"'\]]+/gi;
  for (const match of String(text ?? '').matchAll(re)) {
    const url = match[0].replace(/[.,;:]+$/, '');
    const parsed = parseGoogleDocUrl(url);
    if (parsed && !out.includes(parsed.url)) out.push(parsed.url);
  }
  return out;
}

async function httpGet(url, timeoutMs) {
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        // Иначе Google отдаёт страницу «войдите в аккаунт» вместо экспорта
        'User-Agent': 'Mozilla/5.0 (compatible; ova-review-bot/1.0)',
        'Accept-Language': 'ru,en;q=0.8',
      },
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new DocFetchError('Google не ответил за отведённое время. Попробуй ещё раз.', 'TIMEOUT');
    }
    throw new DocFetchError(`Не удалось скачать документ: ${error?.message ?? error}`, 'NETWORK');
  }

  if (!res.ok) throw mapStatus(res.status);
  return res;
}

function mapStatus(status) {
  if (status === 401 || status === 403) {
    return new DocFetchError(
      'Google закрыл доступ к документу. В настройках доступа выбери «Все, у кого есть ссылка» → «Читатель» и повтори.',
      'FORBIDDEN',
    );
  }
  if (status === 404) {
    return new DocFetchError('Документ не найден: возможно, ссылка битая или документ удалён.', 'NOT_FOUND');
  }
  if (status === 429) {
    return new DocFetchError('Google временно ограничил запросы. Подожди минуту и повтори.', 'RATE_LIMIT');
  }
  return new DocFetchError(`Google ответил ошибкой ${status}.`, 'HTTP');
}

/**
 * Скачивает документ и возвращает нормализованный текст.
 * @param {string} link
 * @param {{timeoutMs?: number}} [options]
 */
export async function fetchDocText(link, options = {}) {
  const parsed = parseGoogleDocUrl(link);
  if (!parsed) {
    throw new DocFetchError(
      'Это не похоже на ссылку на Google Документ. Нужна ссылка вида https://docs.google.com/document/d/…/edit',
      'BAD_URL',
    );
  }

  const timeoutMs = options.timeoutMs ?? 30_000;
  const res = await httpGet(parsed.exportUrl, timeoutMs);
  const buffer = Buffer.from(await res.arrayBuffer());

  let text;
  if (parsed.published) {
    text = htmlToText(buffer.toString('utf8'));
  } else {
    // txt-экспорт всегда UTF-8 с BOM
    text = new TextDecoder('utf-8').decode(buffer);
  }

  text = text.replace(/^\uFEFF/, '').replace(/\u0000/g, '');

  if (!text.trim()) {
    throw new DocFetchError('Документ пустой — в нём нет текста для проверки.', 'EMPTY');
  }

  return {
    docId: parsed.docId,
    published: parsed.published,
    url: parsed.url,
    exportUrl: parsed.exportUrl,
    text,
    chars: text.length,
    fetchedAt: new Date(),
  };
}

/** Грубое HTML → текст для опубликованных документов (d/e/…). */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/td>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}
