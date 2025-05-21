const { Bot, session, InlineKeyboard, GrammyError, HttpError } = require('grammy');

// Конфигурация ID канала для логов
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
if (!LOG_CHANNEL_ID) {
  console.warn("Переменная окружения LOG_CHANNEL_ID не установлена. Логирование в канал будет отключено.");
}

// Замените 'YOUR_TELEGRAM_BOT_TOKEN' на ваш актуальный токен бота
const bot = new Bot('YOUR_TELEGRAM_BOT_TOKEN');

// Middleware для сессий
bot.use(session({
  initial: () => ({
    warnings: {}, 
    mutes: {},    
    pendingCaptcha: {} 
  })
}));

// Вспомогательная функция для логирования действий
async function logAction(ctxOrBotApi, action, moderator, targetUser, reason = "") {
  if (!LOG_CHANNEL_ID) return;

  const dateTime = new Date().toLocaleString("ru-RU");
  let moderatorDescription = "СИСТЕМА"; // По умолчанию для системных действий

  if (moderator && moderator.id && moderator.first_name) {
      moderatorDescription = `${moderator.first_name} (${moderator.id})`;
  } else if (moderator && moderator.id) { // Если есть ID, но нет first_name
      moderatorDescription = `ID: ${moderator.id}`;
  }


  const targetUserDescription = targetUser.description || `ID: ${targetUser.id}`;
  
  const logMessageString = `[${dateTime}] [${action}]\nМодератор: ${moderatorDescription}\nПользователь: ${targetUserDescription} (ID: ${targetUser.id})${reason ? `\nПричина/Детали: ${reason}` : ''}`;

  try {
    // Используем bot.api напрямую, так как ctx может быть недоступен или нерелевантен (например, для системных логов)
    await bot.api.sendMessage(LOG_CHANNEL_ID, logMessageString);
  } catch (e) {
    console.error(`Ошибка при отправке лога в канал (${LOG_CHANNEL_ID}):`, e);
  }
}

// Вспомогательная функция для проверки прав администратора
async function isAdmin(ctx, userId) {
  if (!ctx.chat || !ctx.chat.id || !userId) return false;
  try {
    const member = await ctx.getChatMember(userId);
    return ['administrator', 'creator'].includes(member.status);
  } catch (e) {
    console.error(`Ошибка при проверке статуса администратора для пользователя ${userId} в чате ${ctx.chat.id}:`, e);
    return false;
  }
}

// Вспомогательная функция для определения целевого пользователя
async function getTargetUser(ctx, args) {
  if (ctx.message?.reply_to_message?.from) {
    const user = ctx.message.reply_to_message.from;
    return { id: user.id, description: user.first_name || `ID ${user.id}` };
  }
  if (ctx.message?.entities) {
    for (const entity of ctx.message.entities) {
      if (entity.type === 'text_mention' && entity.user) {
        const user = entity.user;
        return { id: user.id, description: user.first_name || `ID ${user.id}` };
      }
    }
  }
  if (args && /^\d+$/.test(args)) {
    const userId = parseInt(args, 10);
    // Попытаемся получить имя пользователя, если возможно, для более информативного лога
    try {
        const user = await ctx.api.getChat(userId); // Это может не сработать для пользователей, не взаимодействовавших с ботом
        return { id: userId, description: user.first_name || `ID ${userId}` };
    } catch (e) {
        return { id: userId, description: `ID ${userId}` }; // Возвращаем ID, если имя недоступно
    }
  }
  return null;
}


bot.command('start', (ctx) => {
  ctx.reply('Бот запущен! Команды модерации доступны. Используйте /mod для меню.');
});

// --- СИСТЕМА КАПЧИ ---
bot.on("chat_member", async (ctx) => {
  if (!ctx.chat || !ctx.chat.id || !ctx.chatMember || !ctx.chatMember.old_chat_member || !ctx.chatMember.new_chat_member) return;

  const oldStatus = ctx.chatMember.old_chat_member.status;
  const newStatus = ctx.chatMember.new_chat_member.status;
  const newUser = ctx.chatMember.new_chat_member.user;

  if (oldStatus === "left" && newStatus === "member") {
    if (newUser.is_bot || newUser.id === ctx.me.id) return;

    console.log(`Новый пользователь присоединился: ${newUser.first_name} (${newUser.id}) в чате ${ctx.chat.id}`);

    const captchaKeyboard = new InlineKeyboard().text("✅ Я не бот", `pass_captcha_${newUser.id}`);
    try {
      const captchaMessage = await ctx.reply(
        `Привет, ${newUser.first_name} ([${newUser.id}](${`tg://user?id=${newUser.id}`}))! Пожалуйста, подтверди, что ты не бот, чтобы остаться в группе. У тебя 3 минуты (180 секунд).`,
        { reply_markup: captchaKeyboard, parse_mode: "Markdown" }
      );

      if (!ctx.session.pendingCaptcha) ctx.session.pendingCaptcha = {};
      if (!ctx.session.pendingCaptcha[ctx.chat.id]) ctx.session.pendingCaptcha[ctx.chat.id] = {};
      ctx.session.pendingCaptcha[ctx.chat.id][newUser.id] = { messageId: captchaMessage.message_id, timestamp: Date.now() };

      setTimeout(async () => {
        const captchaEntry = ctx.session.pendingCaptcha?.[ctx.chat.id]?.[newUser.id];
        if (captchaEntry) {
          try {
            await ctx.banChatMember(newUser.id);
            const reason = "Не пройдена капча за 3 минуты.";
            await ctx.reply(`Пользователь ${newUser.first_name} (${newUser.id}) не прошел капчу в течение 3 минут и был забанен.`);
            console.log(`Пользователь ${newUser.id} забанен за провал капчи в чате ${ctx.chat.id}.`);
            await logAction(bot.api, "АВТО-БАН (капча)", { id: "СИСТЕМА", first_name: "СИСТЕМА" }, { id: newUser.id, description: newUser.first_name || `ID ${newUser.id}` }, reason);
          } catch (e) {
            console.error(`Ошибка при бане пользователя ${newUser.id} за провал капчи в чате ${ctx.chat.id}:`, e);
          }
          try {
            await ctx.api.deleteMessage(ctx.chat.id, captchaEntry.messageId);
          } catch (e) {
            console.error(`Ошибка при удалении сообщения капчи ${captchaEntry.messageId} в чате ${ctx.chat.id}:`, e);
          }
          delete ctx.session.pendingCaptcha[ctx.chat.id][newUser.id];
        }
      }, 180000); 
    } catch (e) {
      console.error(`Ошибка при отправке сообщения капчи для пользователя ${newUser.id} в чате ${ctx.chat.id}:`, e);
    }
  }
});

bot.callbackQuery(/^pass_captcha_(\d+)$/, async (ctx) => {
  if (!ctx.from || !ctx.chat || !ctx.chat.id || !ctx.match) return ctx.answerCallbackQuery({ text: "Ошибка: Контекст не найден."});
  const userIdFromCallback = parseInt(ctx.match[1], 10);

  if (ctx.from.id !== userIdFromCallback) {
    return ctx.answerCallbackQuery({ text: "Эта капча не для тебя.", show_alert: true });
  }

  const captchaEntry = ctx.session.pendingCaptcha?.[ctx.chat.id]?.[userIdFromCallback];
  if (captchaEntry) {
    await ctx.answerCallbackQuery({ text: "Капча пройдена! Добро пожаловать." });
    try {
      await ctx.api.deleteMessage(ctx.chat.id, captchaEntry.messageId);
    } catch (e) {
      console.error(`Ошибка при удалении сообщения капчи ${captchaEntry.messageId} после прохождения в чате ${ctx.chat.id}:`, e);
    }
    delete ctx.session.pendingCaptcha[ctx.chat.id][userIdFromCallback];
    console.log(`Пользователь ${userIdFromCallback} прошел капчу в чате ${ctx.chat.id}.`);
    await logAction(bot.api, "КАПЧА ПРОЙДЕНА", { id: "СИСТЕМА", first_name: "СИСТЕМА" }, { id: userIdFromCallback, description: ctx.from.first_name || `ID ${userIdFromCallback}` });
  } else {
    await ctx.answerCallbackQuery({ text: "Капча уже пройдена, истекла или данные отсутствуют." });
    if (ctx.callbackQuery.message) {
      try { await ctx.editMessageReplyMarkup(undefined); } 
      catch(e) { console.error(`Ошибка при удалении разметки ответа для сообщения капчи в чате ${ctx.chat.id}:`, e); }
    }
  }
});

// --- КОМАНДЫ МОДЕРАЦИИ С ПОДТВЕРЖДЕНИЕМ ---
const userNotFoundMessage = "Не удалось определить пользователя. Используйте ответ на сообщение, упоминание (с ID) или ID пользователя.";

bot.command('ban', async (ctx) => {
  if (!ctx.from || !ctx.chat || !ctx.chat.id) return;
  const commandIssuerId = ctx.from.id;
  if (!await isAdmin(ctx, commandIssuerId)) return ctx.reply('Только администратор может использовать эту команду.');
  const targetInfo = await getTargetUser(ctx, ctx.match);
  if (!targetInfo) return ctx.reply(userNotFoundMessage);
  const { id: targetUserId, description: targetUserDescription } = targetInfo;
  if (targetUserId === commandIssuerId) return ctx.reply('Вы не можете забанить самого себя.');
  if (await isAdmin(ctx, targetUserId)) return ctx.reply('Нельзя забанить администратора.');
  const keyboard = new InlineKeyboard().text("✅ Да", `confirm_ban_${targetUserId}_0`).text("❌ Нет", `cancel_action_${targetUserId}`);
  await ctx.reply(`Вы уверены, что хотите забанить пользователя ${targetUserDescription} навсегда?`, { reply_markup: keyboard });
});

bot.command('tempban', async (ctx) => {
  if (!ctx.from || !ctx.chat || !ctx.chat.id) return;
  const commandIssuerId = ctx.from.id;
  if (!await isAdmin(ctx, commandIssuerId)) return ctx.reply('Только администратор может использовать эту команду.');
  let targetInfo, durationInMinutes;
  const usageText = 'Использование: /tempban <userID> <минуты> или ответьте на сообщение: /tempban <минуты>.';
  if (ctx.message?.reply_to_message?.from) {
    targetInfo = await getTargetUser(ctx, "");
    if (ctx.match && /^\d+$/.test(ctx.match)) durationInMinutes = parseInt(ctx.match, 10);
    else return ctx.reply(`Укажите длительность в минутах. ${usageText}`);
  } else {
    const parts = ctx.match ? ctx.match.split(/\s+/) : [];
    if (parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
      targetInfo = await getTargetUser(ctx, parts[0]);
      durationInMinutes = parseInt(parts[1], 10);
    } else return ctx.reply(usageText);
  }
  if (!targetInfo) return ctx.reply(userNotFoundMessage);
  const { id: targetUserId, description: targetUserDescription } = targetInfo;
  if (!durationInMinutes || isNaN(durationInMinutes) || durationInMinutes <= 0) return ctx.reply(`Неверная длительность. ${usageText}`);
  if (targetUserId === commandIssuerId) return ctx.reply('Вы не можете временно забанить самого себя.');
  if (await isAdmin(ctx, targetUserId)) return ctx.reply('Нельзя временно забанить администратора.');
  const keyboard = new InlineKeyboard().text("✅ Да", `confirm_ban_${targetUserId}_${durationInMinutes}`).text("❌ Нет", `cancel_action_${targetUserId}`);
  await ctx.reply(`Вы уверены, что хотите забанить пользователя ${targetUserDescription} на ${durationInMinutes} минут?`, { reply_markup: keyboard });
});

bot.command('mute', async (ctx) => {
  if (!ctx.from || !ctx.chat || !ctx.chat.id) return;
  const commandIssuerId = ctx.from.id;
  if (!await isAdmin(ctx, commandIssuerId)) return ctx.reply('Только администратор может использовать эту команду.');
  let targetInfo, durationInMinutes = 60;
  const usageText = 'Использование: /mute <userID> [минуты] или ответьте на сообщение: /mute [минуты].';
  if (ctx.message?.reply_to_message?.from) {
    targetInfo = await getTargetUser(ctx, "");
    if (ctx.match && /^\d+$/.test(ctx.match)) durationInMinutes = parseInt(ctx.match, 10);
  } else {
    const parts = ctx.match ? ctx.match.split(/\s+/) : [];
    if (parts.length > 0 && /^\d+$/.test(parts[0])) {
      targetInfo = await getTargetUser(ctx, parts[0]);
      if (parts.length > 1 && /^\d+$/.test(parts[1])) durationInMinutes = parseInt(parts[1], 10);
    } else return ctx.reply(usageText);
  }
  if (!targetInfo) return ctx.reply(userNotFoundMessage);
  const { id: targetUserId, description: targetUserDescription } = targetInfo;
  if (isNaN(durationInMinutes) || durationInMinutes <= 0) return ctx.reply(`Неверная длительность. ${usageText}`);
  if (targetUserId === commandIssuerId) return ctx.reply('Вы не можете заглушить самого себя.');
  if (await isAdmin(ctx, targetUserId)) return ctx.reply('Нельзя заглушить администратора.');
  const keyboard = new InlineKeyboard().text("✅ Да", `confirm_mute_${targetUserId}_${durationInMinutes}`).text("❌ Нет", `cancel_action_${targetUserId}`);
  await ctx.reply(`Вы уверены, что хотите заглушить пользователя ${targetUserDescription} на ${durationInMinutes} минут?`, { reply_markup: keyboard });
});

// --- ОБРАБОТЧИКИ CALLBACK QUERY ---
bot.callbackQuery(/^confirm_ban_(\d+)_(\d+)$/, async (ctx) => {
  if (!ctx.from || !ctx.chat || !ctx.chat.id) return ctx.answerCallbackQuery({ text: "Ошибка: Контекст не найден." });
  if (!await isAdmin(ctx, ctx.from.id)) return ctx.answerCallbackQuery({ text: "Только администраторы могут подтверждать это действие." });
  const targetUserId = parseInt(ctx.match[1], 10);
  const durationMinutes = parseInt(ctx.match[2], 10);
  const targetUserForLog = { id: targetUserId, description: `ID ${targetUserId}` }; // Пробуем получить описание, если возможно
  try {
      const chatMember = await bot.api.getChatMember(ctx.chat.id, targetUserId);
      targetUserForLog.description = chatMember.user.first_name || `ID ${targetUserId}`;
  } catch (e) { /* останется ID */ }


  try {
    if (durationMinutes === 0) {
      await ctx.banChatMember(targetUserId);
      await ctx.editMessageText(`Пользователь ${targetUserForLog.description} был забанен навсегда.`);
      await logAction(bot.api, "БАН", ctx.from, targetUserForLog);
    } else {
      const banUntilTimestamp = Math.floor(Date.now() / 1000) + durationMinutes * 60;
      await ctx.banChatMember(targetUserId, { until_date: banUntilTimestamp });
      const reason = `Длительность: ${durationMinutes} минут.`;
      await ctx.editMessageText(`Пользователь ${targetUserForLog.description} был забанен на ${durationMinutes} минут.`);
      await logAction(bot.api, "ВРЕМЕННЫЙ БАН", ctx.from, targetUserForLog, reason);
    }
  } catch (e) {
    console.error(`Ошибка в callback confirm_ban для пользователя ${targetUserId} в чате ${ctx.chat.id}:`, e);
    await ctx.editMessageText('Не удалось забанить пользователя. Возможно, у меня нет прав или пользователь не найден.').catch(console.error);
  }
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^confirm_mute_(\d+)_(\d+)$/, async (ctx) => {
  if (!ctx.from || !ctx.chat || !ctx.chat.id) return ctx.answerCallbackQuery({ text: "Ошибка: Контекст не найден." });
  if (!await isAdmin(ctx, ctx.from.id)) return ctx.answerCallbackQuery({ text: "Только администраторы могут подтверждать это действие." });
  const targetUserId = parseInt(ctx.match[1], 10);
  const durationMinutes = parseInt(ctx.match[2], 10);
  const expiresAtTimestamp = Date.now() + durationMinutes * 60 * 1000;
  const targetUserForLog = { id: targetUserId, description: `ID ${targetUserId}` };
   try {
      const chatMember = await bot.api.getChatMember(ctx.chat.id, targetUserId);
      targetUserForLog.description = chatMember.user.first_name || `ID ${targetUserId}`;
  } catch (e) { /* останется ID */ }

  if (!ctx.session.mutes) ctx.session.mutes = {};
  if (!ctx.session.mutes[ctx.chat.id]) ctx.session.mutes[ctx.chat.id] = {};
  try {
    await ctx.restrictChatMember(targetUserId, { can_send_messages: false, until_date: Math.floor(expiresAtTimestamp / 1000) });
    ctx.session.mutes[ctx.chat.id][targetUserId] = expiresAtTimestamp;
    const reason = `Длительность: ${durationMinutes} минут.`;
    await ctx.editMessageText(`Пользователь ${targetUserForLog.description} был заглушен на ${durationMinutes} минут.`);
    await logAction(bot.api, "МУТ", ctx.from, targetUserForLog, reason);
  } catch (e) {
    console.error(`Ошибка в callback confirm_mute для пользователя ${targetUserId} в чате ${ctx.chat.id}:`, e);
    await ctx.editMessageText('Не удалось заглушить пользователя. Возможно, у меня нет прав.').catch(console.error);
  }
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^cancel_action_(\d+)$/, async (ctx) => {
  if (!ctx.from || !ctx.chat || !ctx.chat.id) return ctx.answerCallbackQuery({ text: "Ошибка: Контекст не найден." });
  if (!await isAdmin(ctx, ctx.from.id)) return ctx.answerCallbackQuery({ text: "Только администраторы могут отменять это действие." });
  try { await ctx.editMessageText(`Действие отменено.`); } 
  catch (e) { console.error(`Ошибка при отмене действия в чате ${ctx.chat.id}:`, e); }
  await ctx.answerCallbackQuery();
});

// --- ДРУГИЕ КОМАНДЫ ---
bot.command('unmute', async (ctx) => {
  if (!ctx.from || !ctx.chat || !ctx.chat.id) return;
  const commandIssuerId = ctx.from.id;
  if (!await isAdmin(ctx, commandIssuerId)) return ctx.reply('Только администратор может использовать эту команду.');
  const targetInfo = await getTargetUser(ctx, ctx.match);
  if (!targetInfo) return ctx.reply(userNotFoundMessage);
  const { id: targetUserId, description: targetUserDescription } = targetInfo;
  if (!ctx.session.mutes) ctx.session.mutes = {};
  if (!ctx.session.mutes[ctx.chat.id]) ctx.session.mutes[ctx.chat.id] = {};
  try {
    await ctx.restrictChatMember(targetUserId, {
      can_send_messages: true, can_send_media_messages: true, can_send_polls: true,
      can_send_other_messages: true, can_add_web_page_previews: true,
      can_change_info: true, can_invite_users: true, can_pin_messages: true,
    });
    delete ctx.session.mutes[ctx.chat.id][targetUserId];
    ctx.reply(`Пользователь ${targetUserDescription} был разглушен.`);
    await logAction(ctx, "РАЗМУТ", ctx.from, targetInfo);
  } catch (e) {
    console.error(`Ошибка при разглушении пользователя ${targetUserDescription} (${targetUserId}) в чате ${ctx.chat.id}:`, e);
    ctx.reply('Не удалось разглушить пользователя. Возможно, у меня нет прав или пользователь не был заглушен мной.');
  }
});

bot.command('warn', async (ctx) => {
  if (!ctx.from || !ctx.chat || !ctx.chat.id) return;
  const commandIssuerId = ctx.from.id;
  if (!await isAdmin(ctx, commandIssuerId)) return ctx.reply('Только администратор может использовать эту команду.');
  const targetInfo = await getTargetUser(ctx, ctx.match);
  if (!targetInfo) return ctx.reply(userNotFoundMessage);
  const { id: targetUserId, description: targetUserDescription } = targetInfo;
  if (targetUserId === commandIssuerId) return ctx.reply('Вы не можете выдать предупреждение самому себе.');
  if (await isAdmin(ctx, targetUserId)) return ctx.reply('Нельзя выдать предупреждение администратору.');
  if (!ctx.session.warnings) ctx.session.warnings = {};
  if (!ctx.session.warnings[ctx.chat.id]) ctx.session.warnings[ctx.chat.id] = {};
  if (!ctx.session.warnings[ctx.chat.id][targetUserId]) ctx.session.warnings[ctx.chat.id][targetUserId] = 0;
  ctx.session.warnings[ctx.chat.id][targetUserId]++;
  const userWarnings = ctx.session.warnings[ctx.chat.id][targetUserId];
  const reason = `Количество предупреждений: ${userWarnings}.`;
  await ctx.reply(`Пользователю ${targetUserDescription} выдано предупреждение. Теперь у него ${userWarnings} предупреждений.`);
  await logAction(ctx, "ПРЕДУПРЕЖДЕНИЕ", ctx.from, targetInfo, reason);
  if (userWarnings >= 3) {
    const keyboard = new InlineKeyboard().text("✅ Да, забанить", `confirm_ban_${targetUserId}_0_warn`).text("❌ Нет, отменить авто-бан", `cancel_action_${targetUserId}_autoban_resetwarn`);
    await ctx.reply(`Пользователь ${targetUserDescription} достиг 3 предупреждений. Забанить его навсегда?`, { reply_markup: keyboard });
  }
});

// Обновленный callback для бана после предупреждения
bot.callbackQuery(/^confirm_ban_(\d+)_0_warn$/, async (ctx) => {
    if (!ctx.from || !ctx.chat || !ctx.chat.id) return ctx.answerCallbackQuery({ text: "Ошибка: Контекст не найден." });
    if (!await isAdmin(ctx, ctx.from.id)) return ctx.answerCallbackQuery({ text: "Только администраторы могут подтверждать это действие." });
    const targetUserId = parseInt(ctx.match[1], 10);
    const targetUserForLog = { id: targetUserId, description: `ID ${targetUserId}` };
    try {
        const chatMember = await bot.api.getChatMember(ctx.chat.id, targetUserId);
        targetUserForLog.description = chatMember.user.first_name || `ID ${targetUserId}`;
    } catch (e) { /* останется ID */ }

    try {
        await ctx.banChatMember(targetUserId);
        await ctx.editMessageText(`Пользователь ${targetUserForLog.description} был автоматически забанен после 3 предупреждений.`);
        await logAction(bot.api, "АВТО-БАН (3 предупреждения)", ctx.from, targetUserForLog, "Достигнуто 3 предупреждения.");
        if (ctx.session.warnings?.[ctx.chat.id]?.[targetUserId]) {
            delete ctx.session.warnings[ctx.chat.id][targetUserId];
        }
    } catch (e) {
        console.error(`Ошибка в callback confirm_ban_warn для пользователя ${targetUserId} в чате ${ctx.chat.id}:`, e);
        await ctx.editMessageText('Не удалось забанить пользователя. Возможно, у меня нет прав или пользователь не найден.').catch(console.error);
    }
    await ctx.answerCallbackQuery();
});


bot.callbackQuery(/^cancel_action_(\d+)_autoban_resetwarn$/, async (ctx) => {
  if (!ctx.from || !ctx.chat || !ctx.chat.id) return ctx.answerCallbackQuery({ text: "Ошибка: Контекст не найден." });
  if (!await isAdmin(ctx, ctx.from.id)) return ctx.answerCallbackQuery({ text: "Только администраторы могут отменять это действие." });
  const targetUserId = parseInt(ctx.match[1], 10);
  if (ctx.session.warnings && ctx.session.warnings[ctx.chat.id] && ctx.session.warnings[ctx.chat.id][targetUserId]) {
    delete ctx.session.warnings[ctx.chat.id][targetUserId];
  }
  try {
    await ctx.editMessageText(`Авто-бан для пользователя ID: ${targetUserId} отменен. Предупреждения сброшены.`);
  } catch (e) {
    console.error(`Ошибка при отмене авто-бана для пользователя ${targetUserId} в чате ${ctx.chat.id}:`, e);
  }
  await ctx.answerCallbackQuery();
});

bot.command('warns', async (ctx) => {
  if (!ctx.from || !ctx.chat || !ctx.chat.id) return;
  if (!await isAdmin(ctx, ctx.from.id)) return ctx.reply('Только администратор может использовать эту команду.');
  const targetInfo = await getTargetUser(ctx, ctx.match);
  if (!targetInfo) return ctx.reply(userNotFoundMessage);
  const { id: targetUserId, description: targetUserDescription } = targetInfo;
  const userWarnings = (ctx.session.warnings && ctx.session.warnings[ctx.chat.id] && ctx.session.warnings[ctx.chat.id][targetUserId]) ? ctx.session.warnings[ctx.chat.id][targetUserId] : 0;
  ctx.reply(`У пользователя ${targetUserDescription} ${userWarnings} предупреждений.`);
});

// --- МЕНЮ МОДЕРАЦИИ ---
bot.command("mod", async (ctx) => {
  if (!ctx.from || !ctx.chat || !ctx.chat.id) return;
  if (!await isAdmin(ctx, ctx.from.id)) return ctx.reply("Только администратор может использовать эту команду.");
  const modMenuKeyboard = new InlineKeyboard()
    .text("Забанить", "mod_ban").text("Заглушить", "mod_mute").row()
    .text("Предупредить", "mod_warn").text("Временный бан", "mod_tempban").row()
    .text("Разглушить", "mod_unmute");
  await ctx.reply("Меню модерации: Выберите действие.", { reply_markup: modMenuKeyboard });
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
    if (!ctx.from || !ctx.chat || !ctx.chat.id) return ctx.answerCallbackQuery({ text: "Ошибка: Контекст не найден." });
    if (!await isAdmin(ctx, ctx.from.id)) return ctx.answerCallbackQuery({ text: "Только администраторы могут использовать это меню." });
    await ctx.reply(text);
    await ctx.answerCallbackQuery();
  });
}

bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Ошибка при обработке обновления ${ctx.update.update_id}:`, err.error);
  const e = err.error;
  if (e instanceof GrammyError) {
    console.error("Ошибка в запросе:", e.description);
  } else if (e instanceof HttpError) {
    console.error("Не удалось связаться с Telegram:", e);
  } else {
    console.error("Неизвестная ошибка:", e);
  }
});

bot.start();
console.log('Бот запущен с логированием действий, подтверждениями, меню /mod, капчей и русским языком!');
