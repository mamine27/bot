require('dotenv').config();
const { Telegraf, Scenes, session, Markup } = require('telegraf');
const http = require('http');
const { db, initDB } = require('./database');
const locales = require('./locales');
const reportScene = require('./scenes/report');
const { isAdmin, isSuperAdmin, setSetting, getSettings, updatePublicStatus } = require('./utils');
const { initScheduler } = require('./scheduler');

const bot = new Telegraf(process.env.BOT_TOKEN);

// 🏥 Render Heartbeat Server
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h1>Yad Al-Awn Bot is Operational</h1><p>Premium UI Active. 🏮</p>');
}).listen(PORT, () => {
  console.log(`🏥 Heartbeat Server listening on port ${PORT}`);
});

// Middleware
const stage = new Scenes.Stage([reportScene]);
bot.use(session());
bot.use(stage.middleware());

// --- 🏛️ UI FACTORY ---
async function getUserLang(ctx) {
  const user = await db.get('SELECT language FROM users WHERE id = $1', [ctx.from.id]);
  return user?.language || 'en';
}

function getMainKeyboard(lang) {
  const l = locales[lang];
  return Markup.keyboard([
    [l.btn_donate],
    [l.btn_progress, l.btn_top_donors],
    [l.btn_my_history]
  ]).resize();
}

async function updateCommands(tg, userId, role) {
  try {
    let commands = [
      { command: 'start', description: 'Re-initialize / ጀምር' },
      { command: 'donate', description: 'Send Receipt / ደረሰኝ ላክ' },
      { command: 'progress', description: 'Check Progress / አጠቃላይ ሁኔታ' },
      { command: 'top_donors', description: 'Top Contributors / ምርጥ ለጋሾች' },
      { command: 'my_history', description: 'My History / የልገሳ ታሪኬ' },
      { command: 'language', description: 'Change Language / ቋንቋ ቀይር' },
      { command: 'cancel', description: 'Cancel / ሰርዝ' }
    ];

    if (role === 'superadmin' || role === 'collector') {
      commands.push(
        { command: 'admin_hub', description: 'Admin Stats / የአስተዳዳሪ ሁኔታ' },
        { command: 'my_links', description: 'Referral Link / የእኔ ሊንክ' },
        { command: 'my_stats', description: 'My Impact Stats / የእኔ ስታቲስቲክስ' }
      );
    }
    
    if (role === 'superadmin') {
      commands.push(
        { command: 'broadcast', description: 'Announcement / መልዕክት ላክ' },
        { command: 'generate_invite', description: 'Invite Collector / ሰብሳቢ ጋብዝ' },
        { command: 'set_bank', description: 'Update Banks / ባንክ ቀይር' },
        { command: 'set_goal', description: 'Set Mission Goal / ግብ አስቀምጥ' },
        { command: 'set_group', description: 'Connect Group / ግሩፕ አገናኝ' },
        { command: 'set_public_channel', description: 'Connect Channel / ቻናል አገናኝ' }
      );
    }
    
    await tg.setMyCommands(commands, { scope: { type: 'chat', chat_id: userId } });
  } catch (e) { console.error(`Failed to set commands for ${userId}:`, e.message); }
}

// --- 🌍 CORE HANDLERS ---

const langHandler = async (ctx) => {
  await ctx.reply(locales.en.select_language + "\n" + locales.am.select_language, Markup.inlineKeyboard([
    [Markup.button.callback('🇺🇸 English', 'lang_en'), Markup.button.callback('🇪🇹 አማርኛ', 'lang_am')]
  ]));
};
bot.command('language', langHandler);

bot.action(/lang_(en|am)/, async (ctx) => {
  const lang = ctx.match[1];
  const userId = ctx.from.id;
  await db.query(`INSERT INTO users (id, username, language) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET language = $3`, [userId, ctx.from.username || ctx.from.first_name, lang]);
  await ctx.answerCbQuery(lang === 'en' ? 'Language saved.' : 'ቋንቋ ተቀምጧል።');
  const l = locales[lang];
  await ctx.reply(l.welcome, { parse_mode: 'HTML', ...getMainKeyboard(lang) });
  const admin = await db.get('SELECT role FROM admins WHERE id = $1', [userId]);
  await updateCommands(ctx.telegram, userId, admin?.role || 'user');
});

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name;
  const payload = ctx.startPayload;
  const user = await db.get('SELECT language FROM users WHERE id = $1', [userId]);
  
  if (!user || !user.language) {
    if (payload) ctx.session.startPayload = payload;
    return langHandler(ctx);
  }

  const lang = user.language || 'en';
  const l = locales[lang];
  const activePayload = payload || ctx.session.startPayload;

  if (activePayload?.startsWith('invite_')) {
    const token = activePayload.replace('invite_', '');
    const invite = await db.get('SELECT * FROM admin_invites WHERE token = $1', [token]);
    if (invite) await db.query('INSERT INTO admins (id, username, name, role) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET role = $4', [userId, ctx.from.username, username, invite.role]);
  } else if (activePayload) {
    const admin = await db.get('SELECT id FROM admins WHERE id::text = $1 OR username = $1', [activePayload]);
    if (admin) await db.query('UPDATE users SET collector_id = $1 WHERE id = $2', [admin.id, userId]);
  }
  ctx.session.startPayload = null;

  const adminEntry = await db.get('SELECT role FROM admins WHERE id = $1', [userId]);
  await updateCommands(ctx.telegram, userId, adminEntry?.role || 'user');
  await ctx.reply(locales[lang].welcome, { parse_mode: 'HTML', ...getMainKeyboard(lang) });
});

// Standard Features
const donateHandler = (ctx) => ctx.scene.enter('REPORT_DONATION_SCENE');
bot.command('donate', donateHandler);
bot.hears([locales.en.btn_donate, locales.am.btn_donate, '💰 Report Contribution', '💰 Send Donation Receipt'], donateHandler);

const progressHandler = async (ctx) => {
  const lang = await getUserLang(ctx);
  const l = locales[lang];
  const stats = await db.get("SELECT SUM(amount) as total, COUNT(*) as count FROM donations WHERE status = 'approved'");
  const total = parseFloat(stats.total || 0);
  const goalVal = await getSettings('GOAL_AMOUNT', 0);
  const goal = parseFloat(goalVal);
  let text = `${l.stats_header}\n\n${l.stats_total}: <b>${total.toLocaleString()} ETB</b>\n${l.stats_events}: <b>${stats.count}</b>\n`;
  if (goal > 0) {
    const percent = Math.min(100, (total / goal) * 100);
    text += `${l.stats_target}: <b>${goal.toLocaleString()} ETB</b>\n${l.stats_progress}: <b>${percent.toFixed(1)}%</b>`;
  }
  await ctx.reply(text, { parse_mode: 'HTML' });
};
bot.command('progress', progressHandler);
bot.hears([locales.en.btn_progress, locales.am.btn_progress, '📊 Mission Progress', '📊 Check Progress'], progressHandler);

const topDonorsHandler = async (ctx) => {
  const lang = await getUserLang(ctx);
  const l = locales[lang];
  const donors = await db.all(`SELECT SUM(amount) as total FROM donations WHERE status = 'approved' GROUP BY user_id ORDER BY total DESC LIMIT 10`);
  let text = l.leaderboard_header + '\n\n';
  if (donors.length === 0) text += l.leaderboard_empty;
  else donors.forEach((d, i) => {
    const medal = i === 0 ? '🥇' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : '🔹'));
    text += `${medal} <b>${parseFloat(d.total).toLocaleString()} ETB</b>\n`;
  });
  await ctx.reply(text, { parse_mode: 'HTML' });
};
bot.command('top_donors', topDonorsHandler);
bot.hears([locales.en.btn_top_donors, locales.am.btn_top_donors, '🌟 Impact Board', '🌟 Top Donors'], topDonorsHandler);

const historyHandler = async (ctx) => {
  const lang = await getUserLang(ctx);
  const l = locales[lang];
  const userId = ctx.from.id;
  const stats = await db.get(`SELECT SUM(CASE WHEN status = 'approved' THEN amount ELSE 0 END) as approved, COUNT(*) as count FROM donations WHERE user_id = $1`, [userId]);
  if (!stats || stats.count === '0') return ctx.reply(l.my_history_empty);
  const history = await db.all(`SELECT amount, status, created_at FROM donations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`, [userId]);
  let text = `${l.my_history_header}\n\n${l.my_history_verified}: <b>${parseFloat(stats.approved || 0).toLocaleString()} ETB</b>\n\n`;
  history.forEach(d => {
    const icon = d.status === 'approved' ? '✅' : '⏳';
    text += `${icon} ${parseFloat(d.amount).toLocaleString()} ETB - <i>${new Date(d.created_at).toLocaleDateString()}</i>\n`;
  });
  await ctx.reply(text, { parse_mode: 'HTML' });
};
bot.command('my_history', historyHandler);
bot.hears([locales.en.btn_my_history, locales.am.btn_my_history, '📦 My Donation Portfolio', '📦 My Contribution History'], historyHandler);

// --- 👑 COLLECTOR TOOLKIT ---

bot.command('my_links', async (ctx) => {
  if (!await isAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const botInfo = await ctx.telegram.getMe();
  const link = `https://t.me/${botInfo.username}?start=${ctx.from.id}`;
  await ctx.reply(`🔗 <b>My Donor Referral Link</b>\n\nShare this link with donors to track your impact:`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.url('🚀 Open Referral Link', link)]
    ])
  });
});

bot.command('my_stats', async (ctx) => {
  if (!await isAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const stats = await db.get(`
    SELECT COUNT(*) as count, 
           SUM(CASE WHEN status = 'approved' THEN amount ELSE 0 END) as approved_total,
           SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END) as pending_total
    FROM donations WHERE collector_id = $1
  `, [ctx.from.id]);

  let text = `📊 <b>My Collector Impact</b>\n\n` +
             `✅ Approved Cap: <b>${parseFloat(stats.approved_total || 0).toLocaleString()} ETB</b>\n` +
             `⏳ Pending Cap: <b>${parseFloat(stats.pending_total || 0).toLocaleString()} ETB</b>\n` +
             `🤝 Total Donor Events: <b>${stats.count}</b>`;
  await ctx.reply(text, { parse_mode: 'HTML' });
});

// --- 🏛 EXECUTIVE TOOLS ---

bot.command('set_goal', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const amount = parseFloat(ctx.message.text.split(' ')[1]);
  if (isNaN(amount)) return ctx.reply('Usage: /set_goal <amount>');
  await setSetting('GOAL_AMOUNT', amount);
  await ctx.reply(`🎯 <b>Mission Goal Updated:</b> <code>${amount.toLocaleString()} ETB</code>`, { parse_mode: 'HTML' });
  await updatePublicStatus(ctx.telegram);
});

bot.command('generate_invite', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const token = Math.random().toString(36).substring(2, 10);
  await db.query('INSERT INTO admin_invites (token, role) VALUES ($1, $2)', [token, 'collector']);
  const botInfo = await ctx.telegram.getMe();
  const link = `https://t.me/${botInfo.username}?start=invite_${token}`;
  await ctx.reply(`👑 <b>Collector Invite Generated</b>\n\nUse the link below to authorize a new collector:`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.url('🔓 Open Authorization Link', link)]
    ])
  });
});

bot.command('set_bank', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const details = ctx.message.text.split('\n').slice(1).join('\n');
  if (!details) return ctx.reply('Usage: /set_bank\n[Details]');
  await setSetting('BANK_DETAILS', details);
  await ctx.reply('✅ Bank Details Updated.');
});

bot.command('admin_hub', async (ctx) => {
  if (!await isAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const pending = await db.get("SELECT COUNT(*) as count FROM donations WHERE status = 'pending'");
  await ctx.reply(`🛠 Admin Hub\nPending: ${pending.count}`);
});

bot.action(/approve_(\d+)/, async (ctx) => {
  if (!await isAdmin(ctx.from.id)) return ctx.answerCbQuery('Unauthorized.');
  const id = ctx.match[1];
  const donation = await db.get('SELECT * FROM donations WHERE id = $1', [id]);
  if (!donation || donation.status !== 'pending') return ctx.answerCbQuery('Processed.');
  await db.query("UPDATE donations SET status = 'approved', approved_by = $1, approved_at = CURRENT_TIMESTAMP WHERE id = $2", [ctx.from.id, id]);
  await updatePublicStatus(ctx.telegram);
  const donor = await db.get('SELECT language FROM users WHERE id = $1', [donation.user_id]);
  const lang = donor?.language || 'en';
  const statusText = '\n\n✅ <b>APPROVED / ጸድቋል</b>';
  if (ctx.callbackQuery.message.photo) await ctx.editMessageCaption((ctx.callbackQuery.message.caption || '') + statusText, { parse_mode: 'HTML' }).catch(()=>{});
  else await ctx.editMessageText((ctx.callbackQuery.message.text || '') + statusText, { parse_mode: 'HTML' }).catch(()=>{});
  await ctx.telegram.sendMessage(donation.user_id, locales[lang].action_approved, { parse_mode: 'HTML' }).catch(()=>{});
});

bot.action(/reject_(\d+)/, async (ctx) => {
  if (!await isAdmin(ctx.from.id)) return ctx.answerCbQuery('Unauthorized.');
  const id = ctx.match[1];
  const donation = await db.get('SELECT * FROM donations WHERE id = $1', [id]);
  await db.query("UPDATE donations SET status = 'rejected', approved_by = $1 WHERE id = $2", [ctx.from.id, id]);
  const donor = await db.get('SELECT language FROM users WHERE id = $1', [donation.user_id]);
  const lang = donor?.language || 'en';
  const statusText = '\n\n❌ <b>REJECTED / ውድቅ ተደርጓል</b>';
  if (ctx.callbackQuery.message.photo) await ctx.editMessageCaption((ctx.callbackQuery.message.caption || '') + statusText, { parse_mode: 'HTML' }).catch(()=>{});
  else await ctx.editMessageText((ctx.callbackQuery.message.text || '') + statusText, { parse_mode: 'HTML' }).catch(()=>{});
  await ctx.telegram.sendMessage(donation.user_id, locales[lang].action_rejected, { parse_mode: 'HTML' }).catch(()=>{});
});

bot.command('cancel', async (ctx) => {
  const lang = await getUserLang(ctx);
  await ctx.reply(locales[lang].msg_cancel, { ...getMainKeyboard(lang) });
  return ctx.scene.leave();
});

bot.command('broadcast', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const msg = ctx.message.text.split(' ').slice(1).join(' ');
  if (!msg) return ctx.reply('Usage: /broadcast <message>');
  const users = await db.all('SELECT id, language FROM users');
  for (const u of users) {
    const header = u.language === 'am' ? '📢 <b>መልዕክት</b>' : '📢 <b>Announcement</b>';
    await ctx.telegram.sendMessage(u.id, `${header}\n\n${msg}`, { parse_mode: 'HTML' }).catch(()=>{});
  }
  await ctx.reply(`✅ Broadcast complete.`);
});

// Admin System
bot.command('set_group', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  await setSetting('REPORT_GROUP_ID', ctx.chat.id.toString());
  await ctx.reply(`✅ Connected to this group.`);
});
bot.command('set_public_channel', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  await setSetting('PUBLIC_CHANNEL_ID', ctx.chat.id.toString());
  await setSetting('STATUS_MESSAGE_ID_EN', '');
  await setSetting('STATUS_MESSAGE_ID_AM', '');
  await ctx.reply(`📢 Dashboard Connected.`);
  await updatePublicStatus(ctx.telegram);
});

// Start Procedure
(async () => {
  try {
    await initDB();
    const sId = process.env.SUPER_ADMIN_ID;
    if (sId) await updateCommands(bot.telegram, parseInt(sId), 'superadmin');
    await initScheduler(bot.telegram);
    bot.launch();
    console.log('🏛 Yad Al-Awn Portal Active (Premium UI Restored)');
  } catch (e) { console.error('Launch Failed:', e.message); }
})();
