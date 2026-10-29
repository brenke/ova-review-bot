import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Корень проекта (папка, где лежит package.json). */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

loadDotEnv(path.join(ROOT_DIR, '.env'));

/**
 * Минимальный загрузчик .env: не перетирает уже заданные переменные окружения.
 * Нужен, чтобы работал и `npm start`, и прямой `node src/index.js`.
 */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const env = (name, fallback = '') => (process.env[name] ?? fallback).toString().trim();
const envInt = (name, fallback) => {
  const n = Number.parseInt(env(name), 10);
  return Number.isFinite(n) ? n : fallback;
};
const envFloat = (name, fallback) => {
  const n = Number.parseFloat(env(name));
  return Number.isFinite(n) ? n : fallback;
};
const envBool = (name, fallback) => {
  const v = env(name).toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on', 'да'].includes(v);
};

/** Список ID из строки: разделители — запятая, точка с запятой, пробел, перенос. */
const envIdList = (name) =>
  env(name)
    .split(/[\s,;|]+/)
    .map((value) => value.trim())
    .filter((value) => /^\d{15,25}$/.test(value));

export const config = {
  discord: {
    token: env('DISCORD_TOKEN'),
    clientId: env('DISCORD_CLIENT_ID'),
    guildId: env('GUILD_ID'),
    // Роли, которым можно управлять чек-листами (/criteria ...)
    reviewerRoleIds: envIdList('REVIEWER_ROLE_ID'),
    // Роли, которым можно запускать проверку. Пусто — /review доступна всем
    reviewRoleIds: envIdList('REVIEW_ROLE_IDS'),
    deployCommands: envBool('DEPLOY_COMMANDS', true),
  },
  llm: {
    baseUrl: env('LLM_BASE_URL', 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    apiKey: env('LLM_API_KEY'),
    model: env('LLM_MODEL', 'deepseek-chat'),
    temperature: envFloat('LLM_TEMPERATURE', 0.2),
    maxTokens: envInt('LLM_MAX_TOKENS', 3000),
    timeoutMs: envInt('LLM_TIMEOUT_MS', 120_000),
  },
  review: {
    maxDocChars: envInt('MAX_DOC_CHARS', 60_000),
    defaultCriteria: env('DEFAULT_CRITERIA'),
    dataDir: path.join(ROOT_DIR, 'data'),
  },
};

export const paths = {
  data: config.review.dataDir,
  criteria: path.join(config.review.dataDir, 'criteria'),
  criteriaHistory: path.join(config.review.dataDir, 'criteria', '.history'),
  reports: path.join(config.review.dataDir, 'reports'),
};

/** Есть ли чем обращаться к модели. */
export const llmConfigured = Boolean(config.llm.apiKey && config.llm.baseUrl && config.llm.model);
