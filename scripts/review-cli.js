/**
 * Проверка документа без Discord — удобно для отладки чек-листа.
 *
 *   npm run review -- "https://docs.google.com/document/d/…/edit"
 *   npm run review -- "https://docs.google.com/document/d/…/edit" ova-anketa
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { paths } from '../src/config.js';
import { ensureDirs } from '../src/criteria/store.js';
import { runReview } from '../src/review/runReview.js';

const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const [url, criteriaSlug] = args;

if (!url) {
  console.error('Использование: npm run review -- "<ссылка на Google Документ>" [slug-чек-листа]');
  process.exitCode = 1;
}

try {
  const result = await runReview({
    docUrl: url,
    criteriaName: criteriaSlug,
    onProgress: (message) => console.log(`… ${message}`),
  });

  console.log(`\n${result.report.markdown}\n`);

  await ensureDirs();
  const file = path.join(paths.reports, result.report.fileName);
  await fs.writeFile(file, result.report.markdown, 'utf8');
  console.log(`Отчёт сохранён: ${file}`);

  if (result.llmError) {
    console.error(`\n[!] ИИ-проверка не выполнена: ${result.llmError}`);
  }
  if (!result.llm && !result.llmError) {
    console.log('\n[i] ИИ-проверка выключена (не задан LLM_API_KEY).');
  }
} catch (error) {
  console.error(`\n❌ ${error?.message ?? error}`);
  process.exitCode = 1;
}
