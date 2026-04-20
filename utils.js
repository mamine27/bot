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
  const channelId = await getSettings('PUBLIC_CHANNEL_ID');
  if (!channelId) return;

  const userTargetRaw = await getSettings('USER_TARGET_AMOUNT', 0);
  const userTarget = parseFloat(userTargetRaw);
  
  const userCountStats = await db.get("SELECT COUNT(*) as count FROM users");
  const totalUsers = parseInt(userCountStats.count || 0);
  
  // Dynamic Goal Calculation
  const goal = totalUsers * userTarget;

  const stats = await db.get("SELECT SUM(amount) as total, COUNT(*) as count FROM donations WHERE status = 'approved'");
  const total = parseFloat(stats.total || 0);
  const numEvents = stats.count || 0;
  
  const percent = goal > 0 ? Math.min(100, (total / goal) * 100) : 0;
  const remaining = Math.max(0, goal - total);
  
  const topDonations = await db.all(`SELECT SUM(amount) as total FROM donations WHERE status = 'approved' GROUP BY user_id ORDER BY total DESC LIMIT 5`);

  let botUsername = 'your_bot_username';
  try {
     const me = await tg.getMe();
     botUsername = me.username;
  } catch(e) {}
  
  const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

  let text = `📊 <b>Yad Al-Awn | Live Progress / አጠቃላይ ሂደት</b>\n\n` +
             `<code>${getProgressBar(percent)}</code>\n\n` +
             `💰 <b>Total Donated / የተሰበሰበ:</b> ${total.toLocaleString()} ETB\n` +
             `👥 <b>Our Supporters / ደጋፊዎቻችን:</b> ${totalUsers} people\n` +
             `🎯 <b>Mission Target / የልገሳ ግባችን:</b> ${goal.toLocaleString()} ETB\n` +
             `⏳ <b>Remaining / የቀረው:</b> ${remaining.toLocaleString()} ETB\n` +
             `🤝 <b>Verified Donations / የተረጋገጡ ልገሳዎች:</b> ${numEvents}\n\n`;

  if (topDonations.length > 0) {
    text += `🌟 <b>Top Donors / ቀዳሚ ለጋሾች</b>\n`;
    text += `<i>May Allah reward our generous contributors / አላህ ለጋሾቻችንን ይመንዳል:</i>\n`;
    topDonations.forEach((d, i) => {
      const medal = i === 0 ? '🥇' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : '🔹'));
      text += `${medal} <b>${parseFloat(d.total).toLocaleString()} ETB</b>\n`;
    });
    text += `\n`;
  }

  text += `🕒 <i>Update: ${now}</i>\n` +
          `@${botUsername}`;

  const key = 'STATUS_MESSAGE_ID_COMBINED';
  const msgId = await getSettings(key);
  
  const sendNew = async () => {
    const sent = await tg.sendMessage(channelId, text, { parse_mode: 'HTML' });
    await setSetting(key, sent.message_id);
    await tg.pinChatMessage(channelId, sent.message_id).catch(() => {});
  };

  if (msgId) {
    try {
      await tg.editMessageText(channelId, parseInt(msgId), null, text, { parse_mode: 'HTML' });
    } catch (e) {
      await sendNew();
    }
  } else {
    await sendNew();
  }
}

module.exports = {
  isAdmin,
  isSuperAdmin,
  getSettings,
  setSetting,
  updatePublicStatus
};
