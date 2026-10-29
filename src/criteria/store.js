import fs from 'node:fs/promises';
import path from 'node:path';

import { config, paths } from '../config.js';
import { normalizeKey } from '../gdoc/parseDoc.js';
import { normalizeCriteriaConfig, parseFrontmatter } from './frontmatter.js';

const MAX_FILE_BYTES = 256 * 1024;

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

export class CriteriaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CriteriaError';
  }
}

export async function ensureDirs() {
  await fs.mkdir(paths.criteria, { recursive: true });
  await fs.mkdir(paths.criteriaHistory, { recursive: true });
  await fs.mkdir(paths.reports, { recursive: true });
  await seedCriteria();
}

/**
 * На хостинге каталог /app/data — постоянный том, он перекрывает data/ из
 * репозитория. Поэтому базовые чек-листы лежат в content/criteria и при пустом
 * хранилище копируются в data/criteria. Если в репозитории версия выше —
 * обновляем, старую сохраняем в .history.
 */
async function seedCriteria() {
  try {
    const seeds = (await fs.readdir(paths.criteriaSeed)).filter((name) => name.toLowerCase().endsWith('.md'));

    for (const name of seeds) {
      const source = path.join(paths.criteriaSeed, name);
      const target = path.join(paths.criteria, name);

      let currentRaw = null;
      try {
        currentRaw = await fs.readFile(target, 'utf8');
      } catch {
        currentRaw = null;
      }

      if (currentRaw !== null && !isNewerVersion(await fs.readFile(source, 'utf8'), currentRaw)) continue;

      if (currentRaw !== null) {
        const historyDir = path.join(paths.criteriaHistory, name.replace(/\.md$/i, ''));
        await fs.mkdir(historyDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await fs.writeFile(path.join(historyDir, `${stamp}.md`), currentRaw, 'utf8');
      }

      await fs.copyFile(source, target);
    }
  } catch {
    // нет папки content/criteria — работаем без сидов
  }
}

/** Сравнивает поле version: true, если в сиде версия выше текущей. */
function isNewerVersion(seedRaw, currentRaw) {
  const seedVersion = Number(normalizeCriteriaConfig(parseFrontmatter(seedRaw).data).version);
  const currentVersion = Number(normalizeCriteriaConfig(parseFrontmatter(currentRaw).data).version);
  if (!Number.isFinite(seedVersion) || !Number.isFinite(currentVersion)) return false;
  return seedVersion > currentVersion;
}

export function suggestSlug(filename) {
  const base = String(filename ?? '')
    .replace(/\.md$/i, '')
    .toLowerCase()
    .trim();
  const transliterated = [...base]
    .map((char) => TRANSLIT[char] ?? char)
    .join('');
  const slug = transliterated
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 60);
  return slug || 'criteria';
}

async function readCriteriaFile(file) {
  const raw = await fs.readFile(file, 'utf8');
  const slug = path.basename(file, '.md');
  return buildCriteriaRecord({ raw, slug, file, updatedAt: (await fs.stat(file)).mtime });
}

/** Собирает запись чек-листа из сырого текста .md. */
export function buildCriteriaRecord({ raw, slug, file, updatedAt }) {
  const { data, body } = parseFrontmatter(raw);
  const cfg = normalizeCriteriaConfig(data);
  return {
    slug,
    file,
    name: cfg.name || slug,
    description: cfg.description,
    version: cfg.version,
    body,
    config: cfg,
    raw,
    words: body.split(/\s+/).filter(Boolean).length,
    updatedAt: updatedAt ?? new Date(),
  };
}

/**
 * Разбирает .md «на лету» — для одноразового чек-листа, приложенного к /review.
 * Ничего не сохраняет на диск.
 */
export function parseCriteriaContent(source, filename = 'criteria.md') {
  const text = String(source ?? '');
  if (!text.trim()) throw new CriteriaError('Файл с критериями пустой.');
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
    throw new CriteriaError('Файл слишком большой (максимум 256 КБ).');
  }
  const record = buildCriteriaRecord({ raw: text, slug: suggestSlug(filename) });
  if (!record.body.trim()) {
    throw new CriteriaError('В файле нет текста критериев — только шапка.');
  }
  return { ...record, temporary: true };
}

export async function listCriteria() {
  await ensureDirs();
  const entries = await fs.readdir(paths.criteria, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => path.join(paths.criteria, entry.name));

  const list = [];
  for (const file of files) {
    try {
      const item = await readCriteriaFile(file);
      list.push({
        slug: item.slug,
        name: item.name,
        description: item.description,
        words: item.words,
        sections: item.config.requiredSections.length,
        fields: item.config.requiredFields.length,
        updatedAt: item.updatedAt,
      });
    } catch {
      // битый файл не должен ронять список
    }
  }
  return list.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Возвращает чек-лист по имени (slug или название из шапки).
 * Без имени — чек-лист по умолчанию.
 */
export async function getCriteria(nameOrSlug) {
  await ensureDirs();
  const list = await listCriteria();
  if (!list.length) {
    throw new CriteriaError(
      'В data/criteria нет ни одного чек-листа. Загрузи .md командой /criteria upload.',
    );
  }

  const wanted = String(nameOrSlug ?? '').trim() || config.review.defaultCriteria;
  let found;

  if (wanted) {
    const key = normalizeKey(wanted);
    found =
      list.find((item) => item.slug === wanted) ??
      list.find((item) => normalizeKey(item.name) === key) ??
      list.find((item) => normalizeKey(item.slug) === key) ??
      list.find((item) => normalizeKey(item.name).includes(key));
    if (!found) {
      throw new CriteriaError(`Чек-лист «${wanted}» не найден. Доступные: ${list.map((i) => i.slug).join(', ')}`);
    }
  } else {
    found = list[0];
  }

  return readCriteriaFile(path.join(paths.criteria, `${found.slug}.md`));
}

/**
 * Сохраняет загруженный .md как новый чек-лист (или обновляет существующий).
 * Старая версия уезжает в .history — удобно смотреть, что менялось.
 */
export async function saveCriteria({ filename, content }) {
  await ensureDirs();

  const text = String(content ?? '');
  if (!text.trim()) throw new CriteriaError('Файл пустой.');
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
    throw new CriteriaError('Файл слишком большой (максимум 256 КБ).');
  }
  if (filename && !/\.md$/i.test(filename)) {
    throw new CriteriaError('Принимаются только файлы .md');
  }

  const { data, body } = parseFrontmatter(text);
  if (!body.trim()) throw new CriteriaError('Кроме шапки в файле ничего нет — добавь текст критериев.');

  const slug = suggestSlug(data.slug || path.basename(filename || 'criteria.md', '.md'));
  const file = path.join(paths.criteria, `${slug}.md`);

  let existed = false;
  try {
    await fs.access(file);
    existed = true;
  } catch {
    existed = false;
  }

  if (existed) {
    const historyDir = path.join(paths.criteriaHistory, slug);
    await fs.mkdir(historyDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.copyFile(file, path.join(historyDir, `${stamp}.md`));
  }

  await fs.writeFile(file, text, 'utf8');
  return readCriteriaFile(file);
}

export async function deleteCriteria(nameOrSlug) {
  await ensureDirs();
  const list = await listCriteria();
  const key = normalizeKey(nameOrSlug);
  const found = list.find((item) => item.slug === nameOrSlug) ?? list.find((item) => normalizeKey(item.name) === key);
  if (!found) throw new CriteriaError(`Чек-лист «${nameOrSlug}» не найден.`);

  const file = path.join(paths.criteria, `${found.slug}.md`);
  await fs.rm(file, { force: true });
  return found;
}
