import {
  SlashCommandBuilder,
} from 'discord.js';

export const reviewCommand = new SlashCommandBuilder()
  .setName('review')
  .setDescription('Проверить гугл-документ из этого топика по чек-листу сервера')
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

export const infoCommand = new SlashCommandBuilder()
  .setName('info')
  .setDescription('Справка: какие команды есть и как читать отчёт');

export const commands = [reviewCommand, criteriaCommand, infoCommand];
