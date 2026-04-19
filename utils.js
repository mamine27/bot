const { db } = require('./database');

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
  const messageId = await getSettings('STATUS_MESSAGE_ID');

  if (!goal || !channelId) return;

  const stats = await db.get("SELECT SUM(amount) as total FROM donations WHERE status = 'approved'");
  const total = parseFloat(stats.total || 0);
  const percent = Math.min(100, (total / goal) * 100);

  const topDonations = await db.all(`
    SELECT SUM(amount) as total FROM donations
    WHERE status = 'approved' GROUP BY user_id
    ORDER BY total DESC LIMIT 5
  `);

  let text = `🌟 <b>YAD AL-AWN | STRATEGIC IMPACT DASHBOARD</b>\n\n` +
             `Our collective objective is to fulfill our sacred mission. Every <i>Sadaqah</i> entrusted to us accelerates our community impact!\n\n` +
             `<code>${getProgressBar(percent)}</code>\n\n` +
             `💰 Capital Entrusted: <b>${total.toLocaleString()} ETB</b>\n` +
             `🎯 Mission Objective: <b>${goal.toLocaleString()} ETB</b>\n\n`;

  if (topDonations.length > 0) {
    text += `<b>🌟 Distinguished Impact Pioneers:</b>\n`;
    topDonations.forEach((d, i) => {
      const medal = i === 0 ? '🥇' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : '🔹'));
      text += `${medal} <b>${parseFloat(d.total).toLocaleString()} ETB</b>\n`;
    });
    text += `\n`;
  }

  const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  text += `🙏 Thank you for your commitment to the Yad Al-Awn mission.\n` +
          `🕒 <i>Operational Synchronization: ${now} [Live]</i>\n\n` +
          `Select @your_bot_username to contribute.`;

  if (messageId) {
    try {
      await tg.editMessageText(channelId, parseInt(messageId), null, text, { parse_mode: 'HTML' });
      return;
    } catch (e) {
      console.log('Failed to edit status message, posting new one...');
    }
  }

  try {
    const sent = await tg.sendMessage(channelId, text, { parse_mode: 'HTML' });
    await setSetting('STATUS_MESSAGE_ID', sent.message_id);
    await tg.pinChatMessage(channelId, sent.message_id).catch(() => {});
  } catch (e) {
    console.error('Failed to post public status:', e.message);
  }
}

module.exports = {
  isAdmin,
  isSuperAdmin,
  getSettings,
  setSetting,
  updatePublicStatus
};
