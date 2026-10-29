import fs from 'node:fs/promises';
import path from 'node:path';

import { paths } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('lore');

/** Сколько символов лора максимум подмешивать в промпт. */
const MAX_TOTAL_CHARS = 24_000;

/** Имена доступных файлов лора (для логов и диагностики). */
export async function listLoreFiles() {
  try {
    const files = await fs.readdir(paths.lore);
    return files.filter((name) => name.toLowerCase().endsWith('.md'));
  } catch {
    return [];
  }
}

/**
 * Загружает файлы лора, перечисленные в чек-листе (`lore:` в шапке).
 * Всё берётся из data/lore/. Отсутствующий файл — предупреждение, не ошибка.
 */
export async function loadLore(files = []) {
  if (!Array.isArray(files) || files.length === 0) return '';

  const parts = [];
  let total = 0;

  for (const name of files) {
    const safeName = path.basename(String(name));
    const file = path.join(paths.lore, safeName);

    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      log.warn(`Файл лора не найден: ${file}`);
      continue;
    }

    const trimmed = text.trim();
    if (!trimmed) continue;

    if (total + trimmed.length > MAX_TOTAL_CHARS) {
      const rest = MAX_TOTAL_CHARS - total;
      if (rest > 500) parts.push(`${trimmed.slice(0, rest).trimEnd()}\n\n[… лор обрезан]`);
      break;
    }

    parts.push(trimmed);
    total += trimmed.length;
  }

  return parts.join('\n\n---\n\n');
}
