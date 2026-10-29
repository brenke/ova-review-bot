import {
  SlashCommandBuilder,
} from 'discord.js';

export const reviewCommand = new SlashCommandBuilder()
  .setName('review')
  .setDescription('Проверить гугл-документ по чек-листу сервера')
  .addStringOption((option) =>
    option
      .setName('url')
      .setDescription('Ссылка на Google Документ. Пусто — бот поищет её в топике')
      .setRequired(false),
  )
  .addStringOption((option) =>
    option
      .setName('criteria')
      .setDescription('Какой чек-лист применить (по умолчанию — базовый)')
      .setAutocomplete(true)
      .setRequired(false),
  )
  .addAttachmentOption((option) =>
    option
      .setName('file')
      .setDescription('Свой .md-чек-лист на один раз (без сохранения)')
      .setRequired(false),
  )
  .addBooleanOption((option) =>
    option
      .setName('silent')
      .setDescription('Показать результат только мне')
      .setRequired(false),
  );

export const criteriaCommand = new SlashCommandBuilder()
  .setName('criteria')
  .setDescription('Чек-листы проверки (.md-файлы)')
  .addSubcommand((sub) =>
    sub
      .setName('upload')
      .setDescription('Загрузить или обновить чек-лист из .md-файла')
      .addAttachmentOption((option) =>
        option.setName('file').setDescription('Файл .md с критериями').setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Короткое имя (латиницей), если в файле не указано своё')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('Список загруженных чек-листов'))
  .addSubcommand((sub) =>
    sub
      .setName('show')
      .setDescription('Показать чек-лист файлом')
      .addStringOption((option) =>
        option.setName('name').setDescription('Имя чек-листа').setAutocomplete(true).setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('delete')
      .setDescription('Удалить чек-лист')
      .addStringOption((option) =>
        option.setName('name').setDescription('Имя чек-листа').setAutocomplete(true).setRequired(true),
      ),
  );

export const commands = [reviewCommand, criteriaCommand];
