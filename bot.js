const TelegramBot = require('node-telegram-bot-api');
const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim().replace(/^["']|["']$/g, '');

// Инициализация бота происходит здесь. 
// В server.js мы будем импортировать этот объект, чтобы не создавать конфликт (одна инициализация на всё приложение)
let botInstance = null;
if (token) {
    botInstance = new TelegramBot(token, { polling: true });
    
    botInstance.on('polling_error', (error) => {
        if (error.code === 'ETELEGAM' || (error.message && error.message.includes('409 Conflict'))) {
            return;
        }
        console.error('[Bot Polling Error]', error);
    });
} else {
    console.error("TELEGRAM_BOT_TOKEN не найден в environment!");
}

async function checkUserSubscription(userId) {
    try {
        const channelUsername = process.env.CHANNEL_USERNAME;
        if (!channelUsername || !botInstance) return true; 
        const cleanUsername = channelUsername.replace('@', '').trim();
        const chatMember = await botInstance.getChatMember('@' + cleanUsername, userId);
        const activeStatuses = ['creator', 'administrator', 'member'];
        return activeStatuses.includes(chatMember.status);
    } catch (err) {
        console.error("Ошибка при проверке подписки:", err);
        return false;
    }
}

// Экспортируем готовый инстанс
module.exports = {
    bot: botInstance,
    checkUserSubscription
};
