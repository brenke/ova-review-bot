import fs from 'node:fs';
import path from 'node:path';

import { EmbedBuilder } from 'discord.js';

import { ROOT_DIR } from '../config.js';

let version = '';
try {
  version = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version ?? '';
} catch {
  version = '';
}

const REPO_URL = 'https://github.com/brenke/ova-review-bot';

export async function handleInfoCommand(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('OVA Review Bot — что умеет')
    .setDescription(
      'Проверяет гугл-документы (досье, заявки) по чек-листу `.md`: сначала жёсткие автопроверки, потом смысловой разбор ИИ. Результат — список замечаний и пометок для ревьюера. Оценок и вердиктов бот не ставит.',
    )
    .addFields(
      {
        name: '📄 /review — проверить документ',
        value: [
          '`/review` — в топике найдёт ссылку сам',
          '`/review url:<ссылка>` — явно указать документ',
          '`/review criteria:<имя>` — другой чек-лист',
          '`/review file:<файл.md>` — свой чек-лист на один раз',
          '`/review silent:true` — результат только вам',
        ].join('\n'),
      },
      {
        name: '🧾 /criteria — чек-листы (для проверяющих)',
        value: [
          '`/criteria upload file:<файл.md>` — загрузить или обновить',
          '`/criteria list` — список (⭐ — по умолчанию)',
          '`/criteria show name:<имя>` — скачать файлом',
          '`/criteria delete name:<имя>` — удалить',
        ].join('\n'),
      },
      {
        name: '🔁 Повторная проверка',
        value: 'Под каждым отчётом есть кнопка **«Перепроверить»** — жмите после правок документа.',
      },
      {
        name: '📊 Как читать отчёт',
        value: [
          'Бот не выносит вердикт и не ставит оценок: только замечания, решение принимаете вы.',
          '🔴 критично · 🟠 важно · 🟡 мелочи · ℹ️ к сведению (пометки для ревьюера).',
          'Подробности всегда в приложенном `.md`-файле.',
        ].join('\n'),
      },
      {
        name: '✍️ Свой чек-лист',
        value: [
          'Обычный `.md`: необязательная шапка между `---` (обязательные разделы и поля, лимиты слов, запрещённые фразы) и текст критериев для ИИ.',
          `Примеры и формат: ${REPO_URL}`,
        ].join('\n'),
      },
    )
    .setFooter({ text: version ? `ova-review-bot v${version}` : 'ova-review-bot' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
