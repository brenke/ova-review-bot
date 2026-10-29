import { config } from '../config.js';
import { getCriteria } from '../criteria/store.js';
import { fetchDocText } from '../gdoc/fetchDoc.js';
import { parseDocument } from '../gdoc/parseDoc.js';
import { loadLore } from '../lore/store.js';
import { runChecks } from './checks.js';
import { isLlmConfigured, reviewWithLlm } from './llm.js';
import { buildReport } from './report.js';

/**
 * Полный цикл проверки: скачать док → разобрать → автопроверки → ИИ → отчёт.
 */
export async function runReview({ docUrl, criteriaName, criteria: criteriaInput, model, steamId, onProgress } = {}) {
  const progress = onProgress ?? (() => {});

  progress('Читаю чек-лист…');
  const criteria = criteriaInput ?? (await getCriteria(criteriaName));

  progress('Скачиваю документ из Google…');
  const doc = await fetchDocText(docUrl);

  progress('Разбираю структуру документа…');
  const parsed = parseDocument(doc.text);

  progress('Выполняю автопроверки…');
  const detResult = runChecks({ parsed, criteria, steamId });

  const loreText = await loadLore(criteria.config.lore);

  let llm = null;
  let llmError = null;

  if (isLlmConfigured()) {
    progress(loreText ? 'Отправляю документ на проверку ИИ (с лором)…' : 'Отправляю документ на проверку ИИ…');
    const docText =
      doc.text.length > config.review.maxDocChars
        ? `${doc.text.slice(0, config.review.maxDocChars)}\n\n[… документ обрезан, показаны первые ${config.review.maxDocChars} символов]`
        : doc.text;

    try {
      llm = await reviewWithLlm({ docText, criteria, detResult, docMeta: doc, model, loreText, steamId });
      if (llm) llm.model = model || criteria.config.model || config.llm.model;
    } catch (error) {
      llmError = error?.message ?? String(error);
    }
  }

  const report = buildReport({ doc, parsed, criteria, detResult, llm, llmError });

  return { doc, parsed, criteria, detResult, llm, llmError, report, loreLoaded: Boolean(loreText) };
}
