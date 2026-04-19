const { db } = require('./database');
const locales = require('./locales');

async function isAdmin(userId) {
  const admin = await db.get('SELECT 1 FROM admins WHERE id = $1', [userId]);
  return !!admin;
}

async function isSuperAdmin(userId) {
  const envSuperId = process.env.SUPER_ADMIN_ID;
  if (envSuperId && userId.toString() === envSuperId.toString()) return true;

  const admin = await db.get("SELECT 1 FROM admins WHERE id = $1 AND role = 'superadmin'", [userId]);
  return !!admin;
}

async function getSettings(key, defaultValue = null) {
  const setting = await db.get('SELECT value FROM settings WHERE key = $1', [key]);
  return setting ? setting.value : defaultValue;
}

async function setSetting(key, value) {
  await db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [key, value?.toString()]);
}

function getProgressBar(percent) {
  const totalBlocks = 15;
  const filledBlocks = Math.min(totalBlocks, Math.max(0, Math.round((percent / 100) * totalBlocks)));
  const emptyBlocks = totalBlocks - filledBlocks;
  return `┃${'█'.repeat(filledBlocks)}${'░'.repeat(emptyBlocks)}┃ ${percent.toFixed(1)}%`;
}

async function updatePublicStatus(tg) {
  const goalVal = await getSettings('GOAL_AMOUNT', 0);
  const goal = parseFloat(goalVal);
  const channelId = await getSettings('PUBLIC_CHANNEL_ID');
  
  if (!goal || !channelId) return;

  const stats = await db.get("SELECT SUM(amount) as total FROM donations WHERE status = 'approved'");
  const total = parseFloat(stats.total || 0);
  const percent = Math.min(100, (total / goal) * 100);
  const topDonations = await db.all(`SELECT SUM(amount) as total FROM donations WHERE status = 'approved' GROUP BY user_id ORDER BY total DESC LIMIT 5`);

  const generatePost = (lang) => {
    const l = locales[lang];
    const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    
    let text = `${l.stats_header}\n\n` +
               `<code>${getProgressBar(percent)}</code>\n\n` +
               `${l.stats_total}: <b>${total.toLocaleString()} ETB</b>\n` +
               `${l.stats_target}: <b>${goal.toLocaleString()} ETB</b>\n\n`;

    if (topDonations.length > 0) {
      const headerTitle = l.leaderboard_header.split('\n')[0];
      text += `<b>${headerTitle}</b>\n`;
      topDonations.forEach((d, i) => {
        const medal = i === 0 ? '🥇' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : '🔹'));
        text += `${medal} <b>${parseFloat(d.total).toLocaleString()} ETB</b>\n`;
      });
      text += `\n`;
    }

    text += `🕒 <i>Update: ${now}</i>\n` +
            `@your_bot_username`;
    return text;
  };

  const syncPost = async (lang, key) => {
    const msgId = await getSettings(key);
    const text = generatePost(lang);
    if (msgId) {
      try {
        await tg.editMessageText(channelId, parseInt(msgId), null, text, { parse_mode: 'HTML' });
      } catch (e) {
        const sent = await tg.sendMessage(channelId, text, { parse_mode: 'HTML' });
        await setSetting(key, sent.message_id);
        await tg.pinChatMessage(channelId, sent.message_id).catch(() => {});
      }
    } else {
      const sent = await tg.sendMessage(channelId, text, { parse_mode: 'HTML' });
      await setSetting(key, sent.message_id);
      await tg.pinChatMessage(channelId, sent.message_id).catch(() => {});
    }
  };

  // Synchronize both English and Amharic posts
  await syncPost('en', 'STATUS_MESSAGE_ID_EN');
  await syncPost('am', 'STATUS_MESSAGE_ID_AM');
}

module.exports = {
  isAdmin,
  isSuperAdmin,
  getSettings,
  setSetting,
  updatePublicStatus
};
