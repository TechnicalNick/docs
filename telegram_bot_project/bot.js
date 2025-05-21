const { Bot, session, InlineKeyboard, GrammyError, HttpError } = require('grammy');
const fs = require('fs').promises; // Для статистики

const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const ts = () => new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });

if (!LOG_CHANNEL_ID) {
  console.warn(`[${ts()}] [ЛОГ] Переменная окружения LOG_CHANNEL_ID не установлена. Логирование в Telegram канал будет отключено.`);
}

const bot = new Bot(process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN');

// --- СТАТИСТИКА ---
const STATS_FILE_PATH = 'bot_stats.json';
const defaultStats = { bansIssued: 0, mutesIssued: 0, warningsIssued: 0, captchaPassed: 0, captchaFailed: 0 };

async function readStats() {
  try {
    await fs.access(STATS_FILE_PATH);
    const data = await fs.readFile(STATS_FILE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`[${ts()}] [СТАТИСТИКА] Файл статистики не найден, будет создан новый.`);
      await writeStats(defaultStats); // Создаем файл с дефолтными значениями
      return { ...defaultStats };
    } else if (error instanceof SyntaxError) {
      console.error(`[${ts()}] [СТАТИСТИКА] Ошибка парсинга файла статистики. Будет использована статистика по умолчанию.`, error.message);
      return { ...defaultStats };
    }
    console.error(`[${ts()}] [СТАТИСТИКА] Ошибка чтения файла статистики:`, error.message);
    return { ...defaultStats }; // Возвращаем дефолт в случае других ошибок
  }
}

async function writeStats(statsObject) {
  try {
    await fs.writeFile(STATS_FILE_PATH, JSON.stringify(statsObject, null, 2));
    // console.log(`[${ts()}] [СТАТИСТИКА] Статистика успешно записана в файл.`);
  } catch (error) {
    console.error(`[${ts()}] [СТАТИСТИКА] Ошибка записи статистики в файл:`, error.message);
  }
}

async function incrementStat(statName) {
  console.log(`[${ts()}] [СТАТИСТИКА] Инкремент статы: ${statName}`);
  const stats = await readStats();
  stats[statName] = (stats[statName] || 0) + 1;
  await writeStats(stats);
}


bot.use(session({
  initial: () => ({
    warnings: {}, 
    mutes: {},    
    pendingCaptcha: {},
    pendingTestCaptcha: {},
    voiceMessagesDisabled: {} // { [chatId]: { [userId]: true/false } }
  })
}));

// Middleware для автоматического размута и обработки сообщений от заглушенных пользователей
bot.use(async (ctx, next) => {
  if (ctx.message && ctx.from && ctx.chat && ctx.chat.type !== 'private') {
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;

    const muteSession = ctx.session.mutes?.[chatId]?.[userId];
    if (muteSession) {
      if (Date.now() >= muteSession) { 
        try {
          await ctx.restrictChatMember(userId, {
            can_send_messages: true, can_send_audios: true, can_send_documents: true,
            can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
            can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
            can_add_web_page_previews: true, can_change_info: true, can_invite_users: true,
            can_pin_messages: true, can_manage_topics: true
          });
          delete ctx.session.mutes[chatId][userId];
          if (Object.keys(ctx.session.mutes[chatId]).length === 0) delete ctx.session.mutes[chatId];
          if (Object.keys(ctx.session.mutes).length === 0) delete ctx.session.mutes; // Удаляем пустой объект mutes
          
          console.log(`[${ts()}] [АВТО-РАЗМУТ] Пользователь ${ctx.from.first_name || userId} (${userId}) автоматически размучен в чате ${chatId}.`);
          await logAction(bot.api, "АВТО-РАЗМУТ", { id: "СИСТЕМА", first_name: "Бот" }, { id: userId, description: ctx.from.first_name || `ID ${userId}` });
          await replyAndDeleteAfter(ctx, `С вас сняты ограничения на отправку сообщений, ${ctx.from.first_name}.`);
          return next(); // Важно: вызываем next() после обработки, чтобы сообщение прошло дальше
        } catch (e) {
          console.error(`[${ts()}] [АВТО-РАЗМУТ] Ошибка при автоматическом размуте пользователя ${userId} в чате ${chatId}:`, e.message);
          return next(); 
        }
      } else { // Мут еще активен
        try {
          await ctx.deleteMessage();
          console.log(`[${ts()}] [МУТ] Сообщение от заглушенного пользователя ${userId} в чате ${chatId} удалено.`);
          // Не вызываем next() - сообщение удалено, обработка прекращена
          return; 
        } catch (e) {
          console.error(`[${ts()}] [МУТ] Ошибка при удалении сообщения от заглушенного пользователя ${userId} в чате ${chatId}:`, e.message);
          return next(); // Продолжаем, если не удалось удалить сообщение
        }
      }
    }
  }
  await next(); // Если не сообщение, или не от пользователя, или не в чате, или нет мута
});

// Middleware для обработки запрета голосовых сообщений
bot.on("message:voice", async (ctx, next) => {
    if (ctx.from && ctx.chat && ctx.chat.type !== 'private') {
        const userId = ctx.from.id;
        const chatId = ctx.chat.id;

        if (ctx.session.voiceMessagesDisabled?.[chatId]?.[userId] === true) {
            try {
                await ctx.deleteMessage();
                console.log(`[${ts()}] [VOICE_BLOCK] Удалено голосовое сообщение от пользователя ${userId} в чате ${chatId} (голосовые отключены).`);
                // Можно добавить временное уведомление для пользователя, если нужно
                // await replyAndDeleteAfter(ctx, "Отправка голосовых сообщений для вас отключена в этом чате.", 10000);
            } catch (e) {
                console.error(`[${ts()}] [VOICE_BLOCK] Ошибка при удалении голосового сообщения от ${userId} в чате ${chatId}:`, e.message);
                await next(); // Продолжаем, если не удалось удалить
            }
            return; // Важно: не вызываем next(), если сообщение удалено
        }
    }
    await next();
});


async function logAction(ctxOrBotApiSource, action, moderator, targetUser, reason = "") {
  const source = ctxOrBotApiSource.api ? ctxOrBotApiSource.api : ctxOrBotApiSource; 
  if (!LOG_CHANNEL_ID) {
    return;
  }
  console.log(`[${ts()}] [ЛОГ] Попытка отправки лога в канал ${LOG_CHANNEL_ID}: ${action} модератором ${moderator?.id} к пользователю ${targetUser?.id}`);

  const dateTime = ts();
  let moderatorDescription = "СИСТЕМА"; 

  if (moderator && moderator.id) {
    moderatorDescription = `${moderator.first_name || 'Неизвестный модератор'} (${moderator.id})`;
    if (moderator.id === "СИСТЕМА") moderatorDescription = "СИСТЕМА";
  }

  const targetUserDescription = targetUser.description || `ID ${targetUser.id}`;
  
  const logMessageString = `[${dateTime}] [${action}]\nМодератор: ${moderatorDescription}\nПользователь: ${targetUserDescription} (ID: ${targetUser.id})${reason ? `\nПричина/Детали: ${reason}` : ''}`;

  try {
    await source.sendMessage(LOG_CHANNEL_ID, logMessageString);
  } catch (e) {
    console.error(`[${ts()}] [ЛОГ] Ошибка при отправке лога в канал (${LOG_CHANNEL_ID}):`, e.message);
  }
}

async function checkBotPermissions(ctx, permissionsArray) {
  const component = "[HELPER checkBotPermissions]";
  try {
    const botMember = await ctx.getChatMember(ctx.me.id);
    const missingPerms = [];
    if (botMember && botMember.status === 'administrator') {
      for (const perm of permissionsArray) {
        if (!botMember[perm]) {
          missingPerms.push(perm);
        }
      }
    } else {
      permissionsArray.forEach(perm => missingPerms.push(perm)); 
    }
    const result = missingPerms.length === 0;
    return result ? true : missingPerms;
  } catch (e) {
    console.error(`[${ts()}] ${component} Ошибка при проверке прав бота в чате ${ctx.chat.id}:`, e.message);
    return permissionsArray; 
  }
}

async function replyAndDeleteAfter(ctx, text, durationMs = 180000, options = {}) {
  const component = "[HELPER replyAndDeleteAfter]";
  try {
    const sentMessage = await ctx.reply(text, options);
    // console.log(`[${ts()}] ${component} Сообщение ID ${sentMessage.message_id} в чате ${sentMessage.chat.id} будет удалено через ${durationMs / 1000} сек.`);
    setTimeout(async () => {
      try {
        await ctx.api.deleteMessage(sentMessage.chat.id, sentMessage.message_id);
      } catch (e) {
        if (!(e instanceof GrammyError && (e.error_code === 400 && e.description.includes("message to delete not found")))) {
           console.error(`[${ts()}] ${component} Не удалось автоматически удалить сообщение ID ${sentMessage.message_id} в чате ${sentMessage.chat.id}:`, e.message);
        }
      }
    }, durationMs);
    return sentMessage;
  } catch (e) {
    console.error(`[${ts()}] ${component} Ошибка при отправке сообщения для автоудаления в чате ${ctx.chat?.id}:`, e.message);
  }
}


async function isAdmin(ctx, userId) {
  const component = "[HELPER isAdmin]";
  if (!ctx.chat || !ctx.chat.id || !userId) {
    return false;
  }
  try {
    const member = await ctx.getChatMember(userId);
    const isAdminResult = ['administrator', 'creator'].includes(member.status);
    return isAdminResult;
  } catch (e) {
    return false;
  }
}

async function getTargetUser(ctx, args) {
    const component = "[HELPER getTargetUser]";
    let method = "неизвестен";
    let result = null;
    let usernameToResolve = null;

    if (ctx.message?.reply_to_message?.from) {
        const user = ctx.message.reply_to_message.from;
        method = "ответ на сообщение";
        result = { id: user.id, description: user.first_name || `ID ${user.id}`, user: user };
    } else if (ctx.message?.entities) {
        for (const entity of ctx.message.entities) {
            if (entity.type === 'text_mention' && entity.user) {
                const user = entity.user;
                method = "упоминание (text_mention)";
                result = { id: user.id, description: user.first_name || `ID ${user.id}`, user: user };
                break;
            } else if (entity.type === 'mention') { // Обычное @упоминание без встроенного ID
                const offset = entity.offset;
                const length = entity.length;
                usernameToResolve = ctx.message.text.substring(offset + 1, offset + length); // +1 чтобы убрать @
                method = "упоминание (@username из entity)";
                break; 
            }
        }
    }

    if (!result && args) { // args - это ctx.match
        if (/^\d+$/.test(args)) {
            const userId = parseInt(args, 10);
            method = "ID из аргументов";
            try {
                const userChat = await ctx.api.getChat(userId);
                result = { id: userId, description: userChat.first_name || `ID ${userId}`, user: userChat };
            } catch (e) {
                console.warn(`[${ts()}] ${component} Не удалось получить детали чата для ID ${userId} (возможно, это не пользователь):`, e.message);
                result = { id: userId, description: `ID ${userId}` };
            }
        } else if (args.startsWith('@')) {
            usernameToResolve = args.substring(1);
            method = "упоминание (@username из аргумента)";
        }
    }
    
    if (!result && usernameToResolve && ctx.chat?.id) { // Пытаемся разрешить username только если есть chat.id
        console.log(`[${ts()}] ${component} Попытка разрешить @${usernameToResolve} через getChatMember в чате ${ctx.chat.id}`);
        try {
            const member = await ctx.api.getChatMember(ctx.chat.id, '@' + usernameToResolve);
            if (member && member.user) {
                console.log(`[${ts()}] ${component} @${usernameToResolve} успешно разрешен в ID ${member.user.id} через getChatMember.`);
                result = { id: member.user.id, description: member.user.first_name || `@${usernameToResolve}`, user: member.user };
            }
        } catch (e) {
            console.warn(`[${ts()}] ${component} Не удалось разрешить @${usernameToResolve} через getChatMember в чате ${ctx.chat.id}:`, e.message);
        }
    }
    return result;
}

bot.command('start', (ctx) => {
  const commandName = "/start";
  console.log(`[${ts()}] [КОМАНДА ${commandName}] Вызвана пользователем ${ctx.from.id} в чате ${ctx.chat.id}`);
  ctx.reply('Бот запущен! Команды модерации доступны. Используйте /mod для меню. /help для списка команд.');
});

bot.command("help", async (ctx) => {
  const commandName = "/help";
  console.log(`[${ts()}] [КОМАНДА ${commandName}] Вызвана пользователем ${ctx.from.id} в чате ${ctx.chat.id}`);

  const helpMessageText = `
<b>Список доступных команд:</b>

/start - <i>Начало работы с ботом, приветственное сообщение.</i>
/help - <i>Показать это справочное сообщение.</i>

<b>Команды модерации (только для администраторов группы):</b>
<code>/ban &lt;ID пользователя или ответ на сообщение&gt;</code> - <i>Перманентная блокировка пользователя.</i>
<code>/tempban &lt;ID пользователя или ответ на сообщение&gt; &lt;минуты&gt;</code> - <i>Временная блокировка пользователя на указанное количество минут.</i>
  Пример: <code>/tempban 123456789 60</code> или ответом на сообщение: <code>/tempban 60</code>
<code>/mute &lt;ID пользователя или ответ на сообщение&gt; [минуты]</code> - <i>Запрет на отправку сообщений (мут). По умолчанию 60 минут.</i>
  Пример: <code>/mute 123456789 30</code> или ответом на сообщение: <code>/mute 30</code>
<code>/unmute &lt;ID пользователя или ответ на сообщение&gt;</code> - <i>Снятие ограничений на отправку сообщений.</i>
<code>/warn &lt;ID пользователя или ответ на сообщение&gt;</code> - <i>Выдать предупреждение пользователю. При достижении 3-х предупреждений предлагается автоматический бан.</i>
<code>/warns &lt;ID пользователя или ответ на сообщение&gt;</code> - <i>Посмотреть количество предупреждений у пользователя.</i>
<code>/togglevoice &lt;ID пользователя или ответ на сообщение&gt;</code> - <i>Включить/отключить пользователю возможность отправлять голосовые сообщения.</i>
<code>/mod</code> - <i>Открыть интерактивное меню модерации с кнопками для основных действий.</i>

<b>Другие команды:</b>
<code>/testcaptcha</code> - <i>(Только в личных сообщениях с ботом) Проверить работу системы капчи для себя, без реальных последствий в группе.</i>
<code>/stats</code> - <i>Показать статистику работы бота.</i>

<i>Примечание: Для команд, работающих с пользователем, вы можете либо ответить на одно из его сообщений, либо указать его ID, либо упомянуть его через @username (если бот может его найти в данном чате).</i>
`;
  await ctx.reply(helpMessageText, { parse_mode: "HTML" });
});


// --- СИСТЕМА КАПЧИ ---
bot.on("chat_member", async (ctx) => {
  const component = "[CAPTCHA]";
  if (!ctx.chat || !ctx.chat.id || !ctx.chatMember || !ctx.chatMember.old_chat_member || !ctx.chatMember.new_chat_member) return;

  const oldStatus = ctx.chatMember.old_chat_member.status;
  const newStatus = ctx.chatMember.new_chat_member.status;
  const newUser = ctx.chatMember.new_chat_member.user;

  if (oldStatus === "left" && newStatus === "member") {
    if (newUser.is_bot || newUser.id === ctx.me.id) return;

    console.log(`[${ts()}] ${component} Новый участник ${newUser.first_name} (${newUser.id}) в чате ${ctx.chat.id}. Отправка капчи...`);

    const captchaKeyboard = new InlineKeyboard().text("✅ Я не бот", `pass_captcha_${newUser.id}`);
    try {
      const captchaMessage = await ctx.reply(
        `Привет, ${newUser.first_name} ([${newUser.id}](${`tg://user?id=${newUser.id}`}))! Пожалуйста, подтверди, что ты не бот, чтобы остаться в группе. У тебя 3 минуты (180 секунд).`,
        { reply_markup: captchaKeyboard, parse_mode: "Markdown" }
      );
      console.log(`[${ts()}] ${component} Капча (ID сообщения: ${captchaMessage.message_id}) отправлена пользователю ${newUser.id} в чате ${ctx.chat.id}.`);

      if (!ctx.session.pendingCaptcha) ctx.session.pendingCaptcha = {};
      if (!ctx.session.pendingCaptcha[ctx.chat.id]) ctx.session.pendingCaptcha[ctx.chat.id] = {};
      ctx.session.pendingCaptcha[ctx.chat.id][newUser.id] = { messageId: captchaMessage.message_id, timestamp: Date.now() };

      setTimeout(async () => {
        const captchaEntry = ctx.session.pendingCaptcha?.[ctx.chat.id]?.[newUser.id];
        if (captchaEntry) {
          const botCanBan = await checkBotPermissions(ctx, ['can_ban_users']);
          if (botCanBan !== true) {
            console.warn(`[${ts()}] ${component} Бот не имеет права блокировать пользователя (ID: ${newUser.id}) в чате ${ctx.chat.id} для авто-бана по капче. Пропущены права: ${Array.isArray(botCanBan) ? botCanBan.join(', ') : 'неизвестно'}`);
            return;
          }
          try {
            await ctx.banChatMember(newUser.id);
            const reason = "Не пройдена капча за 3 минуты.";
            await replyAndDeleteAfter(ctx, `Пользователь ${newUser.first_name} (${newUser.id}) не прошел капчу в течение 3 минут и был забанен.`);
            console.log(`[${ts()}] ${component} Пользователь ${newUser.id} забанен за провал капчи в чате ${ctx.chat.id}.`);
            await logAction(bot.api, "АВТО-БАН (капча)", { id: "СИСТЕМА", first_name: "Бот" }, { id: newUser.id, description: newUser.first_name || `ID ${newUser.id}` }, reason);
            await incrementStat('captchaFailed');
          } catch (e) {
            console.error(`[${ts()}] ${component} Ошибка при бане пользователя ${newUser.id} за провал капчи в чате ${ctx.chat.id}:`, e.message);
          }
          const botCanDelete = await checkBotPermissions(ctx, ['can_delete_messages']);
          if (botCanDelete !== true) {
             console.warn(`[${ts()}] ${component} Бот не имеет права удалять сообщения в чате ${ctx.chat.id} для очистки капчи. Пропущены права: ${Array.isArray(botCanDelete) ? botCanDelete.join(', ') : 'неизвестно'}`);
          } else {
            try {
              await ctx.api.deleteMessage(ctx.chat.id, captchaEntry.messageId);
            } catch (e) {
              if (!(e instanceof GrammyError && (e.error_code === 400 && e.description.includes("message to delete not found")))) {
                console.error(`[${ts()}] ${component} Ошибка при удалении сообщения капчи ${captchaEntry.messageId} в чате ${ctx.chat.id}:`, e.message);
              }
            }
          }
          delete ctx.session.pendingCaptcha[ctx.chat.id][newUser.id];
        }
      }, 180000); 
    } catch (e) {
      console.error(`[${ts()}] ${component} Ошибка при отправке сообщения капчи для пользователя ${newUser.id} в чате ${ctx.chat.id}:`, e.message);
    }
  }
});

bot.callbackQuery(/^pass_captcha_(\d+)$/, async (ctx) => {
  const component = "[CALLBACK pass_captcha]";
  console.log(`[${ts()}] ${component} Получен callback от ${ctx.from.id} в чате ${ctx.chat.id} для ${ctx.callbackQuery.data}`);
  if (!ctx.from || !ctx.chat || !ctx.chat.id || !ctx.match) return ctx.answerCallbackQuery({ text: "Ошибка: Контекст не найден."});
  const userIdFromCallback = parseInt(ctx.match[1], 10);

  if (ctx.from.id !== userIdFromCallback) {
    return ctx.answerCallbackQuery({ text: "Эта капча не для тебя.", show_alert: true });
  }

  const captchaEntry = ctx.session.pendingCaptcha?.[ctx.chat.id]?.[userIdFromCallback];
  if (captchaEntry) {
    await ctx.answerCallbackQuery({ text: "Капча пройдена! Добро пожаловать." });
    const botCanDelete = await checkBotPermissions(ctx, ['can_delete_messages']);
    if (botCanDelete !== true) {
        console.warn(`[${ts()}] ${component} Бот не имеет права удалять сообщения в чате ${ctx.chat.id} для очистки капчи. Пропущены права: ${Array.isArray(botCanDelete) ? botCanDelete.join(', ') : 'неизвестно'}`);
    } else {
        try {
          await ctx.api.deleteMessage(ctx.chat.id, captchaEntry.messageId);
        } catch (e) {
            if (!(e instanceof GrammyError && (e.error_code === 400 && e.description.includes("message to delete not found")))) {
             console.error(`[${ts()}] ${component} Ошибка при удалении сообщения капчи ${captchaEntry.messageId} после прохождения в чате ${ctx.chat.id}:`, e.message);
            }
        }
    }
    delete ctx.session.pendingCaptcha[ctx.chat.id][userIdFromCallback];
    console.log(`[${ts()}] ${component} Пользователь ${userIdFromCallback} прошел капчу в чате ${ctx.chat.id}.`);
    await logAction(bot.api, "КАПЧА ПРОЙДЕНА", { id: "СИСТЕМА", first_name: "Бот" }, { id: userIdFromCallback, description: ctx.from.first_name || `ID ${userIdFromCallback}` });
    await incrementStat('captchaPassed');
  } else {
    await ctx.answerCallbackQuery({ text: "Капча уже пройдена, истекла или данные отсутствуют." });
    if (ctx.callbackQuery.message) {
      try { await ctx.editMessageReplyMarkup(undefined); } 
      catch(e) { 
          if (!(e instanceof GrammyError && (e.error_code === 400 && e.description.includes("message to edit not found")))){
            console.error(`[${ts()}] ${component} Ошибка при удалении разметки ответа для сообщения капчи в чате ${ctx.chat.id}:`, e.message); 
          }
      }
    }
  }
});

// --- КОМАНДЫ МОДЕРАЦИИ ---
const userNotFoundMessage = "Не удалось определить пользователя. Используйте ответ на сообщение, упоминание (с ID) или ID пользователя.";
const privateChatMessage = "Эта команда предназначена для использования в группах.";
const selfActionError = "Вы не можете применить эту команду к себе.";
const targetAdminError = "Нельзя применить эту команду к администратору.";

async function handleModerationCommand(ctx, commandName, requiredBotPerms, actionText, actionLogText, requiresDuration, defaultDuration = 60) {
  const component = `[КОМАНДА ${commandName}]`;
  console.log(`[${ts()}] ${component} Вызвана пользователем ${ctx.from.id} в чате ${ctx.chat.id} с текстом: ${ctx.message.text}`);

  if (ctx.chat.type === 'private') return replyAndDeleteAfter(ctx, privateChatMessage);
  if (!await isAdmin(ctx, ctx.from.id)) {
    console.warn(`[${ts()}] ${component} Отказ: ${ctx.from.id} не администратор в чате ${ctx.chat.id}.`);
    return replyAndDeleteAfter(ctx, 'Только администратор может использовать эту команду.');
  }

  const botPermsCheck = await checkBotPermissions(ctx, requiredBotPerms);
  if (botPermsCheck !== true) {
    const missingPermsText = Array.isArray(botPermsCheck) ? botPermsCheck.join(', ') : 'неизвестные права';
    console.warn(`[${ts()}] ${component} Отказ: У бота нет прав (${missingPermsText}) в чате ${ctx.chat.id}.`);
    return replyAndDeleteAfter(ctx, `Бот не имеет необходимых прав: ${missingPermsText}.`);
  }
  
  let targetInfo, durationInMinutes = defaultDuration;
  const args = ctx.match;

  if (requiresDuration) {
      if (ctx.message?.reply_to_message?.from) {
          targetInfo = await getTargetUser(ctx, ""); 
          if (args && /^\d+$/.test(args)) durationInMinutes = parseInt(args, 10);
          else if(commandName === '/tempban' || commandName === '/mute') { 
            if (commandName === '/tempban') return replyAndDeleteAfter(ctx, `Укажите длительность в минутах. Использование: ${commandName} <ID или ответ> <минуты>`);
            if (args && !/^\d+$/.test(args)) return replyAndDeleteAfter(ctx, `Неверный формат длительности. Укажите число.`);
          }
      } else {
          const parts = args ? args.split(/\s+/) : [];
          if (parts.length >= 1) { 
              targetInfo = await getTargetUser(ctx, parts[0]);
              if (parts.length >= 2 && /^\d+$/.test(parts[1])) durationInMinutes = parseInt(parts[1], 10);
              else if(commandName === '/tempban' || (commandName === '/mute' && parts.length > 1 && !/^\d+$/.test(parts[1]))) {
                 return replyAndDeleteAfter(ctx, `Неверный формат длительности. Использование: ${commandName} <ID или ответ> <минуты>`);
              } else if (commandName === '/tempban' && parts.length < 2) {
                 return replyAndDeleteAfter(ctx, `Укажите длительность. Использование: ${commandName} <ID> <минуты>`);
              }
          } else return replyAndDeleteAfter(ctx, `Неверное использование. ${commandName} <ID или ответ> [минуты]`);
      }
      if (isNaN(durationInMinutes) || durationInMinutes <= 0) return replyAndDeleteAfter(ctx, `Неверная длительность.`);
  } else {
      targetInfo = await getTargetUser(ctx, args);
  }

  if (!targetInfo) return replyAndDeleteAfter(ctx, userNotFoundMessage);
  const { id: targetUserId, description: targetUserDescription } = targetInfo;

  if (targetUserId === ctx.from.id) return replyAndDeleteAfter(ctx, selfActionError);
  if (await isAdmin(ctx, targetUserId)) return replyAndDeleteAfter(ctx, targetAdminError);

  const confirmationDataSuffix = requiresDuration ? `${targetUserId}_${durationInMinutes}` : `${targetUserId}_0`;
  const keyboard = new InlineKeyboard()
    .text("✅ Да", `confirm_${actionLogText.toLowerCase().replace(/\s+/g, '_')}_${confirmationDataSuffix}`)
    .text("❌ Нет", `cancel_action_${targetUserId}`);
  
  let confirmationMessage = `Вы уверены, что хотите ${actionText} пользователя ${targetUserDescription}`;
  if (requiresDuration && durationInMinutes > 0) confirmationMessage += ` на ${durationInMinutes} минут?`;
  else if(actionLogText === "БАН") confirmationMessage += ` навсегда?`;
  else confirmationMessage += `?`;
  
  await ctx.reply(confirmationMessage, { reply_markup: keyboard });
  console.log(`[${ts()}] ${component} Запрос подтверждения для действия "${actionText}" к пользователю ${targetUserDescription} (${targetUserId}) отправлен модератору ${ctx.from.id}.`);
}

bot.command('ban', async (ctx) => handleModerationCommand(ctx, '/ban', ['can_ban_users'], 'забанить', 'БАН', false));
bot.command('tempban', async (ctx) => handleModerationCommand(ctx, '/tempban', ['can_ban_users'], 'временно забанить', 'ВРЕМЕННЫЙ БАН', true));
bot.command('mute', async (ctx) => handleModerationCommand(ctx, '/mute', ['can_restrict_members'], 'заглушить', 'МУТ', true));


// --- ОБРАБОТЧИКИ CALLBACK QUERY ---
async function handleConfirmationCallback(ctx, actionLogText, actionMessage, requiresDuration, actionFunction) {
  const component = `[CALLBACK confirm_${actionLogText.toLowerCase().replace(/\s+/g, '_')}]`;
  console.log(`[${ts()}] ${component} Получен callback от ${ctx.from.id} в чате ${ctx.chat.id} для ${ctx.callbackQuery.data}`);

  if (!ctx.from || !ctx.chat || !ctx.chat.id) return ctx.answerCallbackQuery({ text: "Ошибка: Контекст не найден." });
  if (!await isAdmin(ctx, ctx.from.id)) return ctx.answerCallbackQuery({ text: "Только администраторы могут подтверждать это действие." });

  const targetUserId = parseInt(ctx.match[1], 10);
  const durationMinutes = requiresDuration ? parseInt(ctx.match[2], 10) : 0;
  
  const targetUserForLog = { id: targetUserId, description: `ID ${targetUserId}` };
  try {
      const chatMember = await bot.api.getChatMember(ctx.chat.id, targetUserId); 
      targetUserForLog.description = chatMember.user.first_name || `ID ${targetUserId}`;
  } catch (e) { console.warn(`[${ts()}] ${component} Не удалось получить детали пользователя ${targetUserId} для лога:`, e.message); }

  try {
    await actionFunction(targetUserId, durationMinutes);
    let successMessage = `Пользователь ${targetUserForLog.description} был ${actionMessage}`;
    if (requiresDuration && durationMinutes > 0) successMessage += ` на ${durationMinutes} минут.`;
    else if (actionLogText === "БАН" || actionLogText === "АВТО-БАН (3 предупреждения)") successMessage += ` навсегда.`;
    
    await ctx.editMessageText(successMessage);
    const reason = requiresDuration && durationMinutes > 0 ? `Длительность: ${durationMinutes} минут.` : (actionLogText === "АВТО-БАН (3 предупреждения)" ? "Достигнуто 3 предупреждения." : "");
    await logAction(bot.api, actionLogText, ctx.from, targetUserForLog, reason);
    if (actionLogText === "БАН" || actionLogText === "ВРЕМЕННЫЙ БАН" || actionLogText === "АВТО-БАН (3 предупреждения)") await incrementStat('bansIssued');
    if (actionLogText === "МУТ") await incrementStat('mutesIssued');
    console.log(`[${ts()}] ${component} Успех: ${actionLogText} для ${targetUserForLog.description} (${targetUserId}) модератором ${ctx.from.id} в чате ${ctx.chat.id}.`);
  } catch (e) {
    console.error(`[${ts()}] ${component} Ошибка при ${actionLogText} пользователя ${targetUserId} в чате ${ctx.chat.id}:`, e.message, e);
    await ctx.editMessageText(`Не удалось ${actionText}. Возможно, у меня нет прав или пользователь не найден.`).catch(console.error);
  }
  await ctx.answerCallbackQuery();
}

bot.callbackQuery(/^confirm_бан_(\d+)_(\d+)$/, async (ctx) => handleConfirmationCallback(ctx, "БАН", "забанен", true, 
  async (targetUserId, durationMinutes) => {
    if (durationMinutes === 0) await ctx.banChatMember(targetUserId);
    else await ctx.banChatMember(targetUserId, { until_date: Math.floor(Date.now() / 1000) + durationMinutes * 60 });
  }
));

bot.callbackQuery(/^confirm_временный_бан_(\d+)_(\d+)$/, async (ctx) => handleConfirmationCallback(ctx, "ВРЕМЕННЫЙ БАН", "временно забанен", true,
  async (targetUserId, durationMinutes) => {
    await ctx.banChatMember(targetUserId, { until_date: Math.floor(Date.now() / 1000) + durationMinutes * 60 });
  }
));

bot.callbackQuery(/^confirm_мут_(\d+)_(\d+)$/, async (ctx) => handleConfirmationCallback(ctx, "МУТ", "заглушен", true,
  async (targetUserId, durationMinutes) => {
    const expiresAtTimestamp = Date.now() + durationMinutes * 60 * 1000;
    await ctx.restrictChatMember(targetUserId, { can_send_messages: false, until_date: Math.floor(expiresAtTimestamp / 1000) });
    if (!ctx.session.mutes) ctx.session.mutes = {};
    if (!ctx.session.mutes[ctx.chat.id]) ctx.session.mutes[ctx.chat.id] = {};
    ctx.session.mutes[ctx.chat.id][targetUserId] = expiresAtTimestamp;
  }
));

bot.callbackQuery(/^cancel_action_(\d+)$/, async (ctx) => {
  const component = "[CALLBACK cancel_action]";
  console.log(`[${ts()}] ${component} Получен callback от ${ctx.from.id} в чате ${ctx.chat.id} для ${ctx.callbackQuery.data}`);
  if (!ctx.from || !ctx.chat || !ctx.chat.id) return ctx.answerCallbackQuery({ text: "Ошибка: Контекст не найден." });
  if (!await isAdmin(ctx, ctx.from.id)) return ctx.answerCallbackQuery({ text: "Только администраторы могут отменять это действие." });
  try { 
    await ctx.editMessageText(`Действие отменено.`);
    console.log(`[${ts()}] ${component} Действие отменено модератором ${ctx.from.id} в чате ${ctx.chat.id}.`);
  } 
  catch (e) { console.error(`[${ts()}] ${component} Ошибка при отмене действия в чате ${ctx.chat.id}:`, e.message); }
  await ctx.answerCallbackQuery();
});

// --- ДРУГИЕ КОМАНДЫ ---
bot.command('unmute', async (ctx) => {
  const commandName = "/unmute";
  const component = `[КОМАНДА ${commandName}]`;
  console.log(`[${ts()}] ${component} Вызвана пользователем ${ctx.from.id} в чате ${ctx.chat.id}`);
  if (ctx.chat.type === 'private') return replyAndDeleteAfter(ctx, privateChatMessage);
  if (!await isAdmin(ctx, ctx.from.id)) {
    console.warn(`[${ts()}] ${component} Отказ: ${ctx.from.id} не администратор в чате ${ctx.chat.id}.`);
    return replyAndDeleteAfter(ctx, 'Только администратор может использовать эту команду.');
  }
  const botPermsCheck = await checkBotPermissions(ctx, ['can_restrict_members']);
  if (botPermsCheck !== true) {
    const missingPermsText = Array.isArray(botPermsCheck) ? botPermsCheck.join(', ') : 'неизвестные права';
    console.warn(`[${ts()}] ${component} Отказ: У бота нет прав (${missingPermsText}) в чате ${ctx.chat.id}.`);
    return replyAndDeleteAfter(ctx, `Бот не имеет необходимых прав: ${missingPermsText}.`);
  }
  const targetInfo = await getTargetUser(ctx, ctx.match);
  if (!targetInfo) return replyAndDeleteAfter(ctx, userNotFoundMessage);
  const { id: targetUserId, description: targetUserDescription } = targetInfo;
  if (!ctx.session.mutes) ctx.session.mutes = {};
  if (!ctx.session.mutes[ctx.chat.id]) ctx.session.mutes[ctx.chat.id] = {};
  try {
    await ctx.restrictChatMember(targetUserId, {
      can_send_messages: true, can_send_audios: true, can_send_documents: true,
      can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
      can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
      can_add_web_page_previews: true, can_change_info: true, can_invite_users: true,
      can_pin_messages: true, can_manage_topics: true
    });
    delete ctx.session.mutes[ctx.chat.id][targetUserId];
    if (Object.keys(ctx.session.mutes[ctx.chat.id]).length === 0) delete ctx.session.mutes[ctx.chat.id];
    if (Object.keys(ctx.session.mutes).length === 0) delete ctx.session.mutes;

    await replyAndDeleteAfter(ctx, `Пользователь ${targetUserDescription} был разглушен.`);
    await logAction(ctx, "РАЗМУТ", ctx.from, targetInfo);
    console.log(`[${ts()}] ${component} Успех: Пользователь ${targetUserDescription} (${targetUserId}) разглушен модератором ${ctx.from.id} в чате ${ctx.chat.id}.`);
  } catch (e) {
    console.error(`[${ts()}] ${component} Ошибка при разглушении пользователя ${targetUserDescription} (${targetUserId}) в чате ${ctx.chat.id}:`, e.message);
    await replyAndDeleteAfter(ctx, 'Не удалось разглушить пользователя. Возможно, у меня нет прав или пользователь не был заглушен мной.');
  }
});

bot.command('warn', async (ctx) => {
  const commandName = "/warn";
  const component = `[КОМАНДА ${commandName}]`;
  console.log(`[${ts()}] ${component} Вызвана пользователем ${ctx.from.id} в чате ${ctx.chat.id} с текстом: ${ctx.message.text}`);
  if (ctx.chat.type === 'private') return replyAndDeleteAfter(ctx, privateChatMessage);
  if (!await isAdmin(ctx, ctx.from.id)) {
     console.warn(`[${ts()}] ${component} Отказ: ${ctx.from.id} не администратор в чате ${ctx.chat.id}.`);
    return replyAndDeleteAfter(ctx, 'Только администратор может использовать эту команду.');
  }
  const targetInfo = await getTargetUser(ctx, ctx.match);
  if (!targetInfo) return replyAndDeleteAfter(ctx, userNotFoundMessage);
  const { id: targetUserId, description: targetUserDescription } = targetInfo;
  if (targetUserId === ctx.from.id) return replyAndDeleteAfter(ctx, selfActionError);
  if (await isAdmin(ctx, targetUserId)) return replyAndDeleteAfter(ctx, targetAdminError);
  if (!ctx.session.warnings) ctx.session.warnings = {};
  if (!ctx.session.warnings[ctx.chat.id]) ctx.session.warnings[ctx.chat.id] = {};
  if (!ctx.session.warnings[ctx.chat.id][targetUserId]) ctx.session.warnings[ctx.chat.id][targetUserId] = 0;
  ctx.session.warnings[ctx.chat.id][targetUserId]++;
  const userWarnings = ctx.session.warnings[ctx.chat.id][targetUserId];
  const reason = `Количество предупреждений: ${userWarnings}.`;
  await replyAndDeleteAfter(ctx, `Пользователю ${targetUserDescription} выдано предупреждение. Теперь у него ${userWarnings} предупреждений.`);
  await logAction(ctx, "ПРЕДУПРЕЖДЕНИЕ", ctx.from, targetInfo, reason);
  await incrementStat('warningsIssued');
  console.log(`[${ts()}] ${component} Успех: Пользователю ${targetUserDescription} (${targetUserId}) выдано предупреждение (${userWarnings}) модератором ${ctx.from.id} в чате ${ctx.chat.id}.`);

  if (userWarnings >= 3) {
    console.log(`[${ts()}] ${component} Пользователь ${targetUserDescription} (${targetUserId}) достиг 3 предупреждений в чате ${ctx.chat.id}. Отправка подтверждения на авто-бан.`);
    const keyboard = new InlineKeyboard().text("✅ Да, забанить", `confirm_ban_${targetUserId}_0_warn`).text("❌ Нет, отменить авто-бан", `cancel_action_${targetUserId}_autoban_resetwarn`);
    await ctx.reply(`Пользователь ${targetUserDescription} достиг 3 предупреждений. Забанить его навсегда?`, { reply_markup: keyboard });
  }
});

bot.callbackQuery(/^confirm_ban_(\d+)_0_warn$/, async (ctx) => handleConfirmationCallback(ctx, "АВТО-БАН (3 предупреждения)", "автоматически забанен после 3 предупреждений", false,
  async (targetUserId) => {
    const component = "[CALLBACK confirm_ban_warn]";
    const botCanBan = await checkBotPermissions(ctx, ['can_ban_users']);
    if (botCanBan !== true) {
        const missingPermsText = Array.isArray(botCanBan) ? botCanBan.join(', ') : 'неизвестные права';
        console.warn(`[${ts()}] ${component} Бот не имеет права блокировать пользователя (ID: ${targetUserId}) в чате ${ctx.chat.id} для авто-бана по предупреждениям. Пропущены права: ${missingPermsText}`);
        throw new Error(`Бот не имеет права блокировать пользователей. Отсутствуют: ${missingPermsText}`);
    }
    await ctx.banChatMember(targetUserId);
    if (ctx.session.warnings?.[ctx.chat.id]?.[targetUserId]) {
        delete ctx.session.warnings[ctx.chat.id][targetUserId];
         if (Object.keys(ctx.session.warnings[ctx.chat.id]).length === 0) delete ctx.session.warnings[ctx.chat.id];
         if (Object.keys(ctx.session.warnings).length === 0) delete ctx.session.warnings;
    }
    await incrementStat('bansIssued'); // Статистика для авто-бана
  }
));

bot.callbackQuery(/^cancel_action_(\d+)_autoban_resetwarn$/, async (ctx) => {
  const component = "[CALLBACK cancel_autoban_resetwarn]";
  console.log(`[${ts()}] ${component} Получен callback от ${ctx.from.id} в чате ${ctx.chat.id} для ${ctx.callbackQuery.data}`);
  if (!ctx.from || !ctx.chat || !ctx.chat.id) return ctx.answerCallbackQuery({ text: "Ошибка: Контекст не найден." });
  if (!await isAdmin(ctx, ctx.from.id)) return ctx.answerCallbackQuery({ text: "Только администраторы могут отменять это действие." });
  const targetUserId = parseInt(ctx.match[1], 10);
  if (ctx.session.warnings && ctx.session.warnings[ctx.chat.id] && ctx.session.warnings[ctx.chat.id][targetUserId]) {
    delete ctx.session.warnings[ctx.chat.id][targetUserId];
    if (Object.keys(ctx.session.warnings[ctx.chat.id]).length === 0) delete ctx.session.warnings[ctx.chat.id];
    if (Object.keys(ctx.session.warnings).length === 0) delete ctx.session.warnings;
    console.log(`[${ts()}] ${component} Предупреждения для пользователя ID: ${targetUserId} в чате ${ctx.chat.id} сброшены.`);
  }
  try {
    await ctx.editMessageText(`Авто-бан для пользователя ID: ${targetUserId} отменен. Предупреждения сброшены.`);
  } catch (e) {
    console.error(`[${ts()}] ${component} Ошибка при отмене авто-бана для пользователя ${targetUserId} в чате ${ctx.chat.id}:`, e.message);
  }
  await ctx.answerCallbackQuery();
});

bot.command('warns', async (ctx) => {
  const commandName = "/warns";
  const component = `[КОМАНДА ${commandName}]`;
  console.log(`[${ts()}] ${component} Вызвана пользователем ${ctx.from.id} в чате ${ctx.chat.id} с текстом: ${ctx.message.text}`);
  if (ctx.chat.type === 'private') return replyAndDeleteAfter(ctx, privateChatMessage);
  if (!await isAdmin(ctx, ctx.from.id)) {
    console.warn(`[${ts()}] ${component} Отказ: ${ctx.from.id} не администратор в чате ${ctx.chat.id}.`);
    return replyAndDeleteAfter(ctx, 'Только администратор может использовать эту команду.');
  }
  const targetInfo = await getTargetUser(ctx, ctx.match);
  if (!targetInfo) return replyAndDeleteAfter(ctx, userNotFoundMessage);
  const { id: targetUserId, description: targetUserDescription } = targetInfo;
  const userWarnings = (ctx.session.warnings && ctx.session.warnings[ctx.chat.id] && ctx.session.warnings[ctx.chat.id][targetUserId]) ? ctx.session.warnings[ctx.chat.id][targetUserId] : 0;
  await replyAndDeleteAfter(ctx, `У пользователя ${targetUserDescription} ${userWarnings} предупреждений.`);
  console.log(`[${ts()}] ${component} Успех: Показаны предупреждения для ${targetUserDescription} (${targetUserId}) по запросу ${ctx.from.id} в чате ${ctx.chat.id}.`);
});

// --- МЕНЮ МОДЕРАЦИИ ---
bot.command("mod", async (ctx) => {
  const commandName = "/mod";
  const component = `[КОМАНДА ${commandName}]`;
  console.log(`[${ts()}] ${component} Вызвана пользователем ${ctx.from.id} в чате ${ctx.chat.id}`);
  if (ctx.chat.type === 'private') return replyAndDeleteAfter(ctx, privateChatMessage);
  if (!await isAdmin(ctx, ctx.from.id)) {
    console.warn(`[${ts()}] ${component} Отказ: ${ctx.from.id} не администратор в чате ${ctx.chat.id}.`);
    return replyAndDeleteAfter(ctx, "Только администратор может использовать эту команду.");
  }
  const modMenuKeyboard = new InlineKeyboard()
    .text("Забанить", "mod_ban").text("Заглушить", "mod_mute").row()
    .text("Предупредить", "mod_warn").text("Временный бан", "mod_tempban").row()
    .text("Разглушить", "mod_unmute");
  await ctx.reply("Меню модерации: Выберите действие.", { reply_markup: modMenuKeyboard });
  console.log(`[${ts()}] ${component} Меню модерации отправлено пользователю ${ctx.from.id} в чате ${ctx.chat.id}.`);
});

const modCallbackActions = {
  "mod_ban": "Чтобы забанить, ответьте на сообщение командой /ban или /ban <ID>.",
  "mod_mute": "Заглушить: /mute <ID> [минуты] или ответом /mute [минуты].",
  "mod_warn": "Предупредить: /warn <ID> или ответом /warn.",
  "mod_tempban": "Временный бан: /tempban <ID> <минуты> или ответом /tempban <минуты>.",
  "mod_unmute": "Разглушить: /unmute <ID> или ответом /unmute."
};

for (const [action, text] of Object.entries(modCallbackActions)) {
  bot.callbackQuery(action, async (ctx) => {
    const component = `[CALLBACK ${action}]`;
    console.log(`[${ts()}] ${component} Нажата кнопка меню модерации пользователем ${ctx.from.id} в чате ${ctx.chat.id}`);
    if (!ctx.from || !ctx.chat || !ctx.chat.id) return ctx.answerCallbackQuery({ text: "Ошибка: Контекст не найден." });
    if (!await isAdmin(ctx, ctx.from.id)) {
      console.warn(`[${ts()}] ${component} Отказ: ${ctx.from.id} не администратор в чате ${ctx.chat.id}.`);
      return ctx.answerCallbackQuery({ text: "Только администраторы могут использовать это меню." });
    }
    await replyAndDeleteAfter(ctx, text, 60000); 
    await ctx.answerCallbackQuery();
  });
}

// --- ТЕСТОВАЯ КАПЧА (только в личных сообщениях) ---
bot.command("testcaptcha", async (ctx) => {
    const commandName = "/testcaptcha";
    const component = `[КОМАНДА ${commandName}]`;
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    console.log(`[${ts()}] ${component} Вызвана пользователем ${userId} в чате ${chatId}`);

    if (ctx.chat.type !== 'private') {
        console.warn(`[${ts()}] ${component} Команда использована не в личном чате (тип: ${ctx.chat.type}) пользователем ${userId}.`);
        return replyAndDeleteAfter(ctx, "Эта команда предназначена для использования только в личных сообщениях с ботом.");
    }

    const captchaKeyboard = new InlineKeyboard().text("✅ Я не бот (тест)", `test_pass_captcha_${userId}`);
    try {
        const testCaptchaMessage = await ctx.reply(
            `Это тестовая капча для вас, ${ctx.from.first_name}. Пожалуйста, нажмите кнопку ниже в течение 1 минуты.`,
            { reply_markup: captchaKeyboard }
        );
        console.log(`[${ts()}] ${component} Тестовая капча (ID сообщения: ${testCaptchaMessage.message_id}) отправлена пользователю ${userId}.`);

        if (!ctx.session.pendingTestCaptcha) ctx.session.pendingTestCaptcha = {};
        if (!ctx.session.pendingTestCaptcha[chatId]) ctx.session.pendingTestCaptcha[chatId] = {}; 
        ctx.session.pendingTestCaptcha[chatId][userId] = { messageId: testCaptchaMessage.message_id, timestamp: Date.now() };

        setTimeout(async () => {
            const entry = ctx.session.pendingTestCaptcha?.[chatId]?.[userId];
            if (entry) {
                try {
                    await ctx.api.deleteMessage(chatId, entry.messageId);
                } catch (e) {
                    if (!(e instanceof GrammyError && (e.error_code === 400 && e.description.includes("message to delete not found")))) {
                        console.error(`[${ts()}] ${component} Ошибка при удалении сообщения тестовой капчи (ID: ${entry.messageId}) по таймауту:`, e.message);
                    }
                }
                await replyAndDeleteAfter(ctx, `Время на прохождение тестовой капчи для ${ctx.from.first_name} истекло.`);
                delete ctx.session.pendingTestCaptcha[chatId][userId];
                if (Object.keys(ctx.session.pendingTestCaptcha[chatId]).length === 0) delete ctx.session.pendingTestCaptcha[chatId];
                if (Object.keys(ctx.session.pendingTestCaptcha).length === 0) delete ctx.session.pendingTestCaptcha;
                console.log(`[${ts()}] ${component} Тестовая капча истекла для пользователя ${userId}.`);
            }
        }, 60000); 
    } catch (e) {
        console.error(`[${ts()}] ${component} Ошибка при отправке тестовой капчи пользователю ${userId}:`, e.message);
    }
});

bot.callbackQuery(/^test_pass_captcha_(\d+)$/, async (ctx) => {
    const component = "[CALLBACK test_pass_captcha]";
    const clickerId = ctx.from.id;
    const chatId = ctx.chat.id; 
    const userIdFromCallback = parseInt(ctx.match[1], 10);
    console.log(`[${ts()}] ${component} Получен callback от ${clickerId} для ${ctx.callbackQuery.data}`);
    
    if (clickerId !== userIdFromCallback) {
        return ctx.answerCallbackQuery({ text: "Это тестовая капча не для вас.", show_alert: true });
    }

    const entry = ctx.session.pendingTestCaptcha?.[chatId]?.[userIdFromCallback];
    if (entry) {
        await ctx.answerCallbackQuery({ text: "Тестовая капча успешно пройдена!" });
        try {
            await ctx.api.deleteMessage(chatId, entry.messageId);
        } catch (e) {
             if (!(e instanceof GrammyError && (e.error_code === 400 && e.description.includes("message to delete not found")))) {
                console.error(`[${ts()}] ${component} Ошибка при удалении сообщения тестовой капчи (ID: ${entry.messageId}) после прохождения:`, e.message);
             }
        }
        await replyAndDeleteAfter(ctx, `Тестовая капча для ${ctx.from.first_name} успешно пройдена!`);
        delete ctx.session.pendingTestCaptcha[chatId][userIdFromCallback];
        if (Object.keys(ctx.session.pendingTestCaptcha[chatId]).length === 0) delete ctx.session.pendingTestCaptcha[chatId];
        if (Object.keys(ctx.session.pendingTestCaptcha).length === 0) delete ctx.session.pendingTestCaptcha;
        console.log(`[${ts()}] ${component} Тестовая капча пройдена пользователем ${userIdFromCallback}.`);
    } else {
        await ctx.answerCallbackQuery({ text: "Тестовая капча уже пройдена или время истекло." });
        if (ctx.callbackQuery.message) {
            try { await ctx.editMessageReplyMarkup(undefined); } 
            catch (e) { 
                if (!(e instanceof GrammyError && (e.error_code === 400 && e.description.includes("message to edit not found")))){
                    console.error(`[${ts()}] ${component} Ошибка при удалении разметки ответа для сообщения тестовой капчи:`, e.message); 
                }
            }
        }
    }
});


bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`[${ts()}] [ГЛОБАЛЬНАЯ ОШИБКА] Обнаружена ошибка при обработке обновления ID ${ctx.update.update_id}:`);
  const e = err.error;
  if (e instanceof GrammyError) {
    console.error(`[${ts()}] [GrammyError] Ошибка в запросе к Telegram API: ${e.description} (Код: ${e.error_code})`);
  } else if (e instanceof HttpError) {
    console.error(`[${ts()}] [HttpError] Не удалось связаться с Telegram:`, e);
  } else {
    console.error(`[${ts()}] [Неизвестная Ошибка] Тип: ${e?.constructor?.name || 'N/A'}, Сообщение:`, e?.message || e);
  }
  console.error(e); 
});

bot.start();
console.log(`[${ts()}] Бот запущен успешно!`);

[end of telegram_bot_project/bot.js]

[end of telegram_bot_project/bot.js]
