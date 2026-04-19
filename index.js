require('dotenv').config();
const { Telegraf, Scenes, session, Markup } = require('telegraf');
const { db, initDB } = require('./database');
const locales = require('./locales');
const reportScene = require('./scenes/report');
const { isAdmin, isSuperAdmin, setSetting, getSettings, updatePublicStatus } = require('./utils');
const { initScheduler } = require('./scheduler');

const bot = new Telegraf(process.env.BOT_TOKEN);

// Middleware
const stage = new Scenes.Stage([reportScene]);
bot.use(session());
bot.use(stage.middleware());

// Language Middleware (Helper to get user lang)
async function getUserLang(ctx) {
  const user = await db.get('SELECT language FROM users WHERE id = $1', [ctx.from.id]);
  return user?.language || 'en';
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
      commands.push({ command: 'admin_panel', description: 'Admin Hub / የአስተዳዳሪ ማዕከል' });
    }
    
    await tg.setMyCommands(commands, {
      scope: { type: 'chat', chat_id: userId }
    });
  } catch (e) {
    console.error(`Failed to set commands for ${userId}:`, e.message);
  }
}

// Language Toggle Command
bot.command('language', async (ctx) => {
  await ctx.reply(locales.en.select_language + "\n" + locales.am.select_language, Markup.inlineKeyboard([
    [Markup.button.callback('🇺🇸 English', 'lang_en'), Markup.button.callback('🇪🇹 አማርኛ', 'lang_am')]
  ]));
});

bot.action(/lang_(en|am)/, async (ctx) => {
  const lang = ctx.match[1];
  const userId = ctx.from.id;
  
  // Update or insert with language
  await db.query(`
    INSERT INTO users (id, username, language) 
    VALUES ($1, $2, $3) 
    ON CONFLICT (id) DO UPDATE SET language = $3
  `, [userId, ctx.from.username || ctx.from.first_name, lang]);
  
  await ctx.answerCbQuery(lang === 'en' ? 'Language optimized to English.' : 'ቋንቋ ወደ አማርኛ ተቀይሯል።');
  
  const l = locales[lang];
  const keyboard = Markup.keyboard([
    [l.btn_donate],
    [l.btn_progress, l.btn_top_donors],
    [l.btn_my_history]
  ]).resize();

  await ctx.reply(l.welcome, { parse_mode: 'HTML', ...keyboard });
  
  const admin = await db.get('SELECT role FROM admins WHERE id = $1', [userId]);
  await updateCommands(ctx.telegram, userId, admin?.role || 'user');
});

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name;
  const payload = ctx.startPayload;

  // Check if they need language selection
  const user = await db.get('SELECT language FROM users WHERE id = $1', [userId]);
  if (!user || !user.language) {
    if (payload) ctx.session.startPayload = payload;
    return ctx.reply(locales.en.select_language + "\n" + locales.am.select_language, Markup.inlineKeyboard([
      [Markup.button.callback('🇺🇸 English', 'lang_en'), Markup.button.callback('🇪🇹 አማርኛ', 'lang_am')]
    ]));
  }

  const lang = user.language || 'en';
  const l = locales[lang];

  // Post-Migration: Handle Referrals/Invites
  const activePayload = payload || ctx.session.startPayload;
  if (activePayload && activePayload.startsWith('invite_')) {
    const token = activePayload.replace('invite_', '');
    const invite = await db.get('SELECT * FROM admin_invites WHERE token = $1', [token]);
    if (invite) {
      await db.query('INSERT INTO admins (id, username, name, role) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET role = $4', 
          [userId, ctx.from.username, username, invite.role]);
      await updateCommands(ctx.telegram, userId, invite.role);
    }
  } else if (activePayload) {
    const admin = await db.get('SELECT id FROM admins WHERE id::text = $1 OR username = $1', [activePayload]);
    if (admin) await db.query('UPDATE users SET collector_id = $1 WHERE id = $2', [admin.id, userId]);
  }
  ctx.session.startPayload = null;

  const keyboard = Markup.keyboard([
    [l.btn_donate],
    [l.btn_progress, l.btn_top_donors],
    [l.btn_my_history]
  ]).resize();

  await ctx.reply(l.welcome, { parse_mode: 'HTML', ...keyboard });
});

// Dynamic Button Handlers + 🛡️ LEGACY SUPPORT
const donateButtons = [locales.en.btn_donate, locales.am.btn_donate, '💰 Report Contribution', '💰 Send Donation Receipt'];
bot.hears(donateButtons, (ctx) => ctx.scene.enter('REPORT_DONATION_SCENE'));

const progressButtons = [locales.en.btn_progress, locales.am.btn_progress, '📊 Mission Progress', '📊 Check Progress'];
bot.hears(progressButtons, async (ctx) => {
  const lang = await getUserLang(ctx);
  const l = locales[lang];
  const stats = await db.get("SELECT SUM(amount) as total, COUNT(*) as count FROM donations WHERE status = 'approved'");
  const total = parseFloat(stats.total || 0);
  const goalVal = await getSettings('GOAL_AMOUNT', 0);
  const goal = parseFloat(goalVal);
  
  let text = `${l.stats_header}\n\n`;
  text += `${l.stats_total}: <b>${total.toLocaleString()} ETB</b>\n`;
  text += `${l.stats_events}: <b>${stats.count}</b>\n`;
  
  if (goal > 0) {
    const percent = Math.min(100, (total / goal) * 100);
    text += `${l.stats_target}: <b>${goal.toLocaleString()} ETB</b>\n`;
    text += `${l.stats_progress}: <b>${percent.toFixed(1)}%</b>`;
  }
  await ctx.reply(text, { parse_mode: 'HTML' });
});

const leaderboardButtons = [locales.en.btn_top_donors, locales.am.btn_top_donors, '🌟 Impact Board', '🌟 Top Donors'];
bot.hears(leaderboardButtons, async (ctx) => {
  const lang = await getUserLang(ctx);
  const l = locales[lang];
  const donors = await db.all(`
    SELECT SUM(amount) as total FROM donations
    WHERE status = 'approved' GROUP BY user_id
    ORDER BY total DESC LIMIT 10
  `);

  let text = l.leaderboard_header + '\n\n';
  if (donors.length === 0) {
    text += l.leaderboard_empty;
  } else {
    donors.forEach((d, i) => {
      const medal = i === 0 ? '🥇' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : '🔹'));
      text += `${medal} <b>${parseFloat(d.total).toLocaleString()} ETB</b>\n`;
    });
  }
  await ctx.reply(text, { parse_mode: 'HTML' });
});

bot.hears([locales.en.btn_my_history, locales.am.btn_my_history, '📦 My Donation Portfolio', '📦 My Contribution History'], async (ctx) => {
  const lang = await getUserLang(ctx);
  const l = locales[lang];
  const stats = await db.get(`SELECT SUM(CASE WHEN status = 'approved' THEN amount ELSE 0 END) as approved, COUNT(*) as count FROM donations WHERE user_id = $1`, [ctx.from.id]);
  
  if (!stats || stats.count === '0') return ctx.reply(l.my_history_empty);
  
  const history = await db.all(`SELECT amount, status, created_at FROM donations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`, [ctx.from.id]);
  let text = `${l.my_history_header}\n\n${l.my_history_verified}: <b>${parseFloat(stats.approved || 0).toLocaleString()} ETB</b>\n\n`;
  
  history.forEach(d => {
    const icon = d.status === 'approved' ? '✅' : '⏳';
    text += `${icon} ${parseFloat(d.amount).toLocaleString()} ETB - <i>${new Date(d.created_at).toLocaleDateString()}</i>\n`;
  });
  await ctx.reply(text, { parse_mode: 'HTML' });
});

// Admin Commands
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

bot.command('admin_panel', async (ctx) => {
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
  await ctx.telegram.sendMessage(donation.user_id, locales[lang].action_approved, { parse_mode: 'HTML' }).catch(()=>{});
  await ctx.editMessageText('✅ Approved');
});

bot.action(/reject_(\d+)/, async (ctx) => {
  if (!await isAdmin(ctx.from.id)) return ctx.answerCbQuery('Unauthorized.');
  const id = ctx.match[1];
  const donation = await db.get('SELECT * FROM donations WHERE id = $1', [id]);
  await db.query("UPDATE donations SET status = 'rejected', approved_by = $1 WHERE id = $2", [ctx.from.id, id]);
  
  const donor = await db.get('SELECT language FROM users WHERE id = $1', [donation.user_id]);
  const lang = donor?.language || 'en';
  await ctx.telegram.sendMessage(donation.user_id, locales[lang].action_rejected, { parse_mode: 'HTML' }).catch(()=>{});
  await ctx.editMessageText('❌ Rejected');
});

bot.command('cancel', async (ctx) => {
  const lang = await getUserLang(ctx);
  await ctx.reply(locales[lang].msg_cancel, Markup.removeKeyboard());
  return ctx.scene.leave();
});

// Broadcast
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

// Start Procedure
(async () => {
  try {
    await initDB();
    const sId = process.env.SUPER_ADMIN_ID;
    if (sId) await updateCommands(bot.telegram, parseInt(sId), 'superadmin');
    await initScheduler(bot.telegram);
    bot.launch();
    console.log('🏛 Yad Al-Awn Portal Active (Bilingual)');
  } catch (e) { console.error('Launch Failed:', e.message); }
})();
