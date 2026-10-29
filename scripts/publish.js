/**
 * Публикация: git push + дёрнуть вебхук автодеплоя (BotHost и подобные).
 *
 *   npm run publish            # push + вебхук
 *   npm run publish -- --no-push
 *
 * URL вебхука берётся из .env: DEPLOY_WEBHOOK_URL.
 * Если задан DEPLOY_WEBHOOK_TOKEN — он уйдёт как Authorization: Bearer.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const skipPush = args.includes('--no-push');

const webhookUrl = process.env.DEPLOY_WEBHOOK_URL?.trim();
const webhookToken = process.env.DEPLOY_WEBHOOK_TOKEN?.trim();

if (!skipPush) {
  console.log('→ git push');
  const push = spawnSync('git', ['push'], { stdio: 'inherit' });
  if (push.status !== 0) {
    console.error('git push завершился с ошибкой — вебхук не вызываю.');
    process.exit(push.status ?? 1);
  }
}

if (!webhookUrl) {
  console.log('DEPLOY_WEBHOOK_URL не задан — деплой на хостинге нужно запустить вручную.');
  process.exit(0);
}

const headers = {
  'Content-Type': 'application/json',
  'User-Agent': 'GitHub-Hookshot/ova-review-bot',
  'X-GitHub-Event': 'push',
  'X-GitHub-Delivery': randomUUID(),
};
if (webhookToken) headers.Authorization = `Bearer ${webhookToken}`;

const body = JSON.stringify({
  ref: 'refs/heads/main',
  repository: { full_name: 'brenke/ova-review-bot', default_branch: 'main' },
});

console.log('→ вебхук деплоя');

try {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = (await response.text()).slice(0, 300);
  console.log(`HTTP ${response.status}${text ? `: ${text}` : ''}`);

  if (!response.ok) {
    console.error(
      'Вебхук ответил ошибкой. Проверьте URL/токен в настройках автодеплоя (панель → Автоматическое обновление).',
    );
    process.exitCode = 1;
  } else {
    console.log('Деплой запущен — статус сборки смотрите в панели хостинга.');
  }
} catch (error) {
  console.error(`Не удалось вызвать вебхук: ${error.message}`);
  process.exitCode = 1;
}
