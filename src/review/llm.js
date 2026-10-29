/**
 * Обращение к LLM через любой OpenAI-совместимый /chat/completions.
 * Без ключа бот не падает: работает только на автопроверках.
 */

import { config, llmConfigured } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('llm');

const SYSTEM_PROMPT = `Ты — старший проверяющий анкет (личных дел) на ролевом сервере Garry's Mod во вселенной Half-Life 2: сектор-08, City 8, Альянс, Общественная Власть Альянса (ОВА), Гражданская Оборона (ГО), ГСР.

Твоя задача — проверить документ по чек-листу сервера и вернуть ТОЛЬКО валидный JSON, без markdown-обёрток и пояснений.

Принципы:
- Замечание уместно, если оно реально мешает игре, ломает лор или нарушает правило из чек-листа. Не придумывай придирок.
- Критично: пустые обязательные разделы, прочерки вместо биографии, богмод и «суперспособности», копипаста шаблона или чужих анкет, нарушения лора, метагейминг в описании.
- Важно: противоречия между разделами (возраст ↔ год рождения, должность ↔ опыт), отсутствие мотивации и слабостей, слишком общие формулировки («добрый, умный, смелый»).
- Мелочь: опечатки, стиль, оформление.
- Пиши по-русски, кратко и предметно: что не так и что конкретно исправить. Ссылайся на разделы документа.
- В запросе уже есть список того, что нашли автопроверки. Не повторяй эти пункты — дополняй их смысловыми замечаниями, которые нельзя проверить формально.

Формат ответа (строго):
{
  "verdict": "accept" | "rework" | "reject",
  "score": 0-100,
  "summary": "1-3 предложения с общим выводом",
  "criteria": [{ "name": "пункт чек-листа", "status": "pass" | "warn" | "fail", "comment": "коротко" }],
  "issues": [{ "severity": "critical" | "major" | "minor", "where": "раздел документа", "problem": "в чём проблема", "fix": "что сделать" }],
  "strengths": ["что получилось хорошо"],
  "questions": ["что стоит уточнить у автора"]
}
Правила вердикта: accept — можно принимать как есть, rework — нужны правки, reject — анкета не соответствует правилам по существу.`;

export function isLlmConfigured() {
  return llmConfigured;
}

export function llmInfo() {
  return { configured: llmConfigured, model: config.llm.model, baseUrl: config.llm.baseUrl };
}

function buildMessages({ docText, criteria, detResult, docMeta }) {
  const findings = detResult.findings.length
    ? detResult.findings
        .map((f) => `- [${f.severity}] ${f.title}: ${String(f.detail).replace(/\n/g, ' ')}`)
        .join('\n')
    : '- автопроверки ничего не нашли';

  const sections = detResult.stats.headings.length
    ? detResult.stats.headings.map((title, i) => `${i + 1}. ${title}`).join('\n')
    : '- заголовки не распознаны';

  const user = `## Чек-лист сервера: ${criteria.name}
${criteria.description ? `_${criteria.description}_\n` : ''}
${criteria.body}

## Что уже нашёл бот автопроверками
${findings}

## Статистика документа
Символов: ${detResult.stats.chars}, слов: ${detResult.stats.words}, разделов: ${detResult.stats.sectionCount}, полей: ${detResult.stats.fieldCount}, пустых полей: ${detResult.stats.placeholderFields}.

## Найденные разделы
${sections}

## Проверяемый документ
<<<ДОКУМЕНТ
${docText}
ДОКУМЕНТ>>>`;

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {{docText: string, criteria: object, detResult: object, docMeta: object, model?: string}} input
 */
export async function reviewWithLlm({ docText, criteria, detResult, docMeta, model }) {
  if (!llmConfigured) return null;

  const url = `${config.llm.baseUrl}/chat/completions`;
  const modelName = model || criteria.config.model || config.llm.model;
  const messages = buildMessages({ docText, criteria, detResult, docMeta });

  let useJsonMode = true;
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const body = {
        model: modelName,
        messages,
        temperature: config.llm.temperature,
        max_tokens: config.llm.maxTokens,
        stream: false,
      };
      if (useJsonMode) body.response_format = { type: 'json_object' };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.llm.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.llm.timeoutMs),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const detail = text.slice(0, 500);

        // некоторые провайдеры не умеют response_format
        if (response.status === 400 && useJsonMode && /response_format|json_object/i.test(detail)) {
          useJsonMode = false;
          log.warn('Провайдер не поддерживает JSON-режим, повторяю без него');
          continue;
        }

        const retryable = response.status === 429 || response.status >= 500;
        lastError = new Error(`LLM ${response.status}: ${detail || response.statusText}`);
        if (retryable && attempt < 3) {
          await sleep(2000 * attempt);
          continue;
        }
        throw lastError;
      }

      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      if (!content) throw new Error('Модель вернула пустой ответ');
      return normalizeResult(extractJson(content));
    } catch (error) {
      lastError = error;
      const retryable =
        error?.name === 'TimeoutError' ||
        error?.name === 'AbortError' ||
        /ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(error?.message ?? '');
      if (retryable && attempt < 3) {
        log.warn(`Сбой запроса к модели (попытка ${attempt}): ${error.message}`);
        await sleep(2000 * attempt);
        continue;
      }
      break;
    }
  }

  throw new Error(`Не удалось получить ответ модели: ${lastError?.message ?? 'неизвестная ошибка'}`);
}

export function extractJson(content) {
  const text = String(content ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error('Модель вернула ответ, который не удалось разобрать как JSON');
  }
}

const VERDICTS = ['accept', 'rework', 'reject'];
const STATUSES = ['pass', 'warn', 'fail'];

function asString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(asString).filter(Boolean).join('; ');
  if (typeof value === 'object') return Object.values(value).map(asString).filter(Boolean).join('; ');
  return String(value);
}

function normalizeVerdict(value) {
  const raw = asString(value).toLowerCase();
  if (VERDICTS.includes(raw)) return raw;
  if (/прин|accept|ok|годн/.test(raw)) return 'accept';
  if (/отклон|reject|не\s*соответ|запрет/.test(raw)) return 'reject';
  return 'rework';
}

function normalizeResult(raw) {
  const criteria = Array.isArray(raw?.criteria)
    ? raw.criteria
        .map((item) => ({
          name: asString(item?.name ?? item?.criterion ?? item?.title),
          status: STATUSES.includes(asString(item?.status).toLowerCase())
            ? asString(item.status).toLowerCase()
            : 'warn',
          comment: asString(item?.comment ?? item?.note ?? item?.details),
        }))
        .filter((item) => item.name)
    : [];

  const issues = Array.isArray(raw?.issues)
    ? raw.issues
        .map((item) => ({
          severity: ['critical', 'major', 'minor'].includes(asString(item?.severity).toLowerCase())
            ? asString(item.severity).toLowerCase()
            : 'major',
          where: asString(item?.where ?? item?.section ?? item?.location),
          problem: asString(item?.problem ?? item?.issue ?? item?.text),
          fix: asString(item?.fix ?? item?.recommendation ?? item?.solution),
        }))
        .filter((item) => item.problem)
    : [];

  const strengths = Array.isArray(raw?.strengths) ? raw.strengths.map(asString).filter(Boolean) : [];
  const questions = Array.isArray(raw?.questions) ? raw.questions.map(asString).filter(Boolean) : [];

  const scoreNumber = Number(raw?.score);
  const score = Number.isFinite(scoreNumber) ? Math.max(0, Math.min(100, Math.round(scoreNumber))) : 50;

  return {
    verdict: normalizeVerdict(raw?.verdict),
    score,
    summary: asString(raw?.summary),
    criteria,
    issues,
    strengths,
    questions,
  };
}
