const { db } = require('./database');
const locales = require('./locales');

async function isAdmin(userId) {
  const admin = await db.get('SELECT 1 FROM admins WHERE id = $1', [userId]);
  return !!admin;
}

async function isSuperAdmin(userId) {
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
      text += `<b>${l.leaderboard_header.split('\n')[0]}</b>\n`;
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

  // 1. Update English Post
  const msgEnId = await getSettings('STATUS_MESSAGE_ID_EN');
  const textEn = generatePost('en');
  if (msgEnId) {
    try { await tg.editMessageText(channelId, parseInt(msgEnId), null, textEn, { parse_mode: 'HTML' }); }
    catch (e) {
      const sent = await tg.sendMessage(channelId, textEn, { parse_mode: 'HTML' });
      await setSetting('STATUS_MESSAGE_ID_EN', sent.message_id);
    }
  } else {
    const sent = await tg.sendMessage(channelId, textEn, { parse_mode: 'HTML' });
    await setSetting('STATUS_MESSAGE_ID_EN', sent.message_id);
  }

  // 2. Update Amharic Post
  const msgAmId = await getSettings('STATUS_MESSAGE_ID_AM');
  const textAm = generatePost('am');
  if (msgAmId) {
    try { await tg.editMessageText(channelId, parseInt(msgAmId), null, textAm, { parse_mode: 'HTML' }); }
    catch (e) {
      const sent = await tg.sendMessage(channelId, textAm, { parse_mode: 'HTML' });
      await setSetting('STATUS_MESSAGE_ID_AM', sent.message_id);
    }
  } else {
    const sent = await tg.sendMessage(channelId, textAm, { parse_mode: 'HTML' });
    await setSetting('STATUS_MESSAGE_ID_AM', sent.message_id);
  }
}

module.exports = {
  isAdmin,
  isSuperAdmin,
  getSettings,
  setSetting,
  updatePublicStatus
};
