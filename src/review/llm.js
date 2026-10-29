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
- Технические артефакты разметки (дорожки из одинаковых букв, служебные символы) — не содержимое документа, не комментируй их.
- Текущую дату бери только из задания. Не полагайся на свои знания о «сегодня» и не считай прошедшие даты будущими.
- Специализации ОВА не зависят от должности. КАД не требует КПД — КПД нужен только для прав категории C.
- Критично: пустые обязательные разделы, прочерки вместо биографии, богмод и «суперспособности», копипаста шаблона или чужих анкет, нарушения лора, метагейминг в описании.
- Важно: противоречия между разделами (возраст ↔ год рождения, должность ↔ опыт), отсутствие мотивации и слабостей, слишком общие формулировки («добрый, умный, смелый»).
- Мелочь: опечатки, стиль, оформление.
- Если биография или психологический портрет не заполнены — это не замечание:
  помечай такие пункты как "info" (к сведению), чтобы ревьюер обратил внимание.
  Но если биография написана плохо (бред, микро-текст на три строки, нелорные
  события, противоречия) — это уже "major".
- Пиши по-русски, кратко и предметно: что не так и что конкретно исправить. Ссылайся на разделы документа.
- В запросе уже есть список того, что нашли автопроверки. Не повторяй эти пункты — дополняй их смысловыми замечаниями, которые нельзя проверить формально.

Формат ответа (строго):
{
  "summary": "1-3 предложения с общим выводом",
  "criteria": [{ "name": "пункт чек-листа", "status": "pass" | "warn" | "fail", "comment": "коротко" }],
  "issues": [{ "severity": "critical" | "major" | "minor" | "info", "where": "раздел документа", "problem": "в чём проблема", "fix": "что сделать" }],
  "strengths": ["что получилось хорошо"]
}
Не выставляй числовых оценок и не выноси вердикт («принять / отклонить») — только факты и замечания. Решение принимает проверяющий.`;

export function isLlmConfigured() {
  return llmConfigured;
}

export function llmInfo() {
  return { configured: llmConfigured, model: config.llm.model, baseUrl: config.llm.baseUrl };
}

/**
 * Текущая дата в формате ДД.ММ.ГГГГ. Модель не знает сегодняшнюю дату, поэтому
 * её надо передавать явно — иначе она считает прошлые события будущими.
 */
export function todayRu() {
  const now = new Date();
  const day = String(now.getUTCDate()).padStart(2, '0');
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${now.getUTCFullYear()}`;
}

export function buildMessages({ docText, criteria, detResult, docMeta, loreText, steamId }) {
  const today = todayRu();
  const findings = detResult.findings.length
    ? detResult.findings
        .map((f) => `- [${f.severity}] ${f.title}: ${String(f.detail).replace(/\n/g, ' ')}`)
        .join('\n')
    : '- автопроверки ничего не нашли';

  const sections = detResult.stats.headings.length
    ? detResult.stats.headings.map((title, i) => `${i + 1}. ${title}`).join('\n')
    : '- заголовки не распознаны';

  const user = `## Текущая дата
Сегодня — ${today} (UTC). Всё, что раньше этой даты, уже произошло; позже — будущее.
Поле «Действительно до» по шаблону сервера — 01.08.2035: дата в будущем там нормальна, это не ошибка.

## Чек-лист сервера: ${criteria.name}
${criteria.description ? `_${criteria.description}_\n` : ''}
${criteria.body}

## Что уже нашёл бот автопроверками
${findings}

## Статистика документа
Символов: ${detResult.stats.chars}, слов: ${detResult.stats.words}, разделов: ${detResult.stats.sectionCount}, полей: ${detResult.stats.fieldCount}, пустых полей: ${detResult.stats.placeholderFields}.
${steamId ? `\n## Данные из сообщения с анкетой\nSteamID: ${steamId}. Последние 3 цифры — ${String(steamId).match(/(\d+)\s*$/)?.[1]?.slice(-3) ?? '—'}: столько же должно быть в поле «Идентификационный номер».\n` : ''}

## Найденные разделы
${sections}

${loreText ? `## Лор проекта (краткая справка)
Сверяй факты из досье с этим лором. Если персонаж, событие, город или
подразделение противоречат лору — замечание severity "major" с указанием, что
именно не сходится. Если в досье упомянута структура из раздела «Секретные
структуры» — severity "critical": сотрудник не может о ней знать.

${loreText}

` : ''}## Проверяемый документ
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
export async function reviewWithLlm({ docText, criteria, detResult, docMeta, model, loreText, steamId }) {
  if (!llmConfigured) return null;

  const url = `${config.llm.baseUrl}/chat/completions`;
  const modelName = model || criteria.config.model || config.llm.model;
  const messages = buildMessages({ docText, criteria, detResult, docMeta, loreText, steamId });

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

const STATUSES = ['pass', 'warn', 'fail'];

function asString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(asString).filter(Boolean).join('; ');
  if (typeof value === 'object') return Object.values(value).map(asString).filter(Boolean).join('; ');
  return String(value);
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
          severity: ['critical', 'major', 'minor', 'info'].includes(asString(item?.severity).toLowerCase())
            ? asString(item.severity).toLowerCase()
            : 'major',
          where: asString(item?.where ?? item?.section ?? item?.location),
          problem: asString(item?.problem ?? item?.issue ?? item?.text),
          fix: asString(item?.fix ?? item?.recommendation ?? item?.solution),
        }))
        .filter((item) => item.problem)
    : [];

  const strengths = Array.isArray(raw?.strengths) ? raw.strengths.map(asString).filter(Boolean) : [];

  return {
    summary: asString(raw?.summary),
    criteria,
    issues,
    strengths,
  };
}
