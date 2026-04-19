require('dotenv').config();
const { Telegraf, Scenes, session, Markup } = require('telegraf');
const http = require('http');
const { db, initDB } = require('./database');
const locales = require('./locales');
const reportScene = require('./scenes/report');
const { isAdmin, isSuperAdmin, setSetting, getSettings, updatePublicStatus } = require('./utils');
const { initScheduler } = require('./scheduler');

const bot = new Telegraf(process.env.BOT_TOKEN);

// 🏥 Heartbeat
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h1>Yad Al-Awn Bot is Active</h1><p>Growth Matrix Operational. 🏮</p>');
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
        { command: 'admin_hub', description: 'Admin Hub' },
        { command: 'my_links', description: 'My Invite Link' },
        { command: 'my_stats', description: 'My Stats' },
        { command: 'history_all', description: 'Global History' },
        { command: 'view', description: 'View Donation' }
      );
    }
    if (role === 'superadmin') {
      commands.push(
        { command: 'admin_stats', description: 'Team Growth Report' },
        { command: 'broadcast', description: 'Announcement' },
        { command: 'generate_invite', description: 'Add Admin' },
        { command: 'demote', description: 'Remove Access' },
        { command: 'set_bank', description: 'Bank Settings' },
        { command: 'set_goal', description: 'Set Goal' },
        { command: 'hard_reset', description: 'WIPE DATA' }
      );
    }
    await tg.setMyCommands(commands, { scope: { type: 'chat', chat_id: userId } });
  } catch (e) { console.error('Menu Error:', e.message); }
}

// --- 🌍 CORE HANDLERS ---
const langHandler = async (ctx) => {
  await ctx.reply(locales.en.select_language + "\n" + locales.am.select_language, Markup.inlineKeyboard([
    [Markup.button.callback('🇺🇸 English', 'lang_en'), Markup.button.callback('🇪🇹 አማርኛ', 'lang_am')]
  ]));
};
bot.command('language', langHandler);

bot.action(/lang_(en|am)/, async (ctx) => {
  const lang = ctx.match[1]; const userId = ctx.from.id;
  await db.query(`INSERT INTO users (id, username, language) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET language = $3`, [userId, ctx.from.username || ctx.from.first_name, lang]);
  await ctx.answerCbQuery('Saved.');
  await ctx.reply(locales[lang].welcome, { parse_mode: 'HTML', ...getMainKeyboard(lang) });
  const admin = await db.get('SELECT role FROM admins WHERE id = $1', [userId]);
  await updateCommands(ctx.telegram, userId, admin?.role || 'user');
});

bot.start(async (ctx) => {
  const userId = ctx.from.id; const username = ctx.from.username || ctx.from.first_name; const payload = ctx.startPayload;
  const user = await db.get('SELECT language FROM users WHERE id = $1', [userId]);
  if (!user || !user.language) { if (payload) ctx.session.startPayload = payload; return langHandler(ctx); }
  const lang = user.language || 'en'; const activePayload = payload || ctx.session.startPayload;
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

// Features
const donateHandler = (ctx) => ctx.scene.enter('REPORT_DONATION_SCENE');
bot.command('donate', donateHandler);
bot.hears([locales.en.btn_donate, locales.am.btn_donate], donateHandler);

bot.command('progress', async (ctx) => {
  const stats = await db.get("SELECT SUM(amount) as total, COUNT(*) as count FROM donations WHERE status = 'approved'");
  const l = locales[await getUserLang(ctx)];
  await ctx.reply(`${l.stats_header}\n\n${l.stats_total}: <b>${parseFloat(stats.total || 0).toLocaleString()} ETB</b>`, { parse_mode: 'HTML' });
});

bot.command('admin_stats', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const stats = await db.all(`
    SELECT a.id, a.name, a.username, 
           (SELECT COUNT(*) FROM donations d WHERE d.approved_by = a.id AND d.status = 'approved') as verified_count,
           (SELECT SUM(amount) FROM donations d WHERE d.approved_by = a.id AND d.status = 'approved') as verified_value,
           (SELECT COUNT(*) FROM users u WHERE u.collector_id = a.id) as people_added,
           (SELECT COUNT(DISTINCT u.id) FROM users u 
            JOIN donations ud ON u.id = ud.user_id 
            WHERE u.collector_id = a.id AND ud.status = 'approved') as donors_converted
    FROM admins a
    ORDER BY verified_value DESC
  `);

  let text = `📈 <b>Team Growth & Conversion Report</b>\n\n`;
  if (stats.length === 0) text += `<i>No admin activity.</i>`;
  else {
    stats.forEach(s => {
      const added = parseInt(s.people_added || 0);
      const converted = parseInt(s.donors_converted || 0);
      const percent = added > 0 ? ((converted / added) * 100).toFixed(1) : '0';
      
      text += `👤 <b>${s.name || s.username || 'System'}</b>\n` +
              `🛠 Verified: <b>${s.verified_count || 0}</b> (${parseFloat(s.verified_value || 0).toLocaleString()} ETB)\n` +
              `🤝 Recruited: <b>${added}</b> members\n` +
              `🎯 Converted: <b>${converted}</b> donors (<b>${percent}%</b>)\n\n`;
    });
  }
  await ctx.reply(text, { parse_mode: 'HTML' });
});

bot.command('view', async (ctx) => {
  if (!await isAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const id = ctx.message.text.split(' ')[1]?.replace('#', '');
  if (!id) return ctx.reply('Usage: /view #123');
  const d = await db.get('SELECT d.*, u.username FROM donations d JOIN users u ON d.user_id = u.id WHERE d.id = $1', [id]);
  if (!d) return ctx.reply('Not found.');
  const cap = `🆔 <b>#${d.id}</b>\n👤 Donor: ${d.username}\n💰 ${parseFloat(d.amount).toLocaleString()} ETB\n⚖️ ${d.status.toUpperCase()}`;
  if (d.proof_file_id) await ctx.replyWithPhoto(d.proof_file_id, { caption: cap, parse_mode: 'HTML' });
  else await ctx.reply(cap, { parse_mode: 'HTML' });
});

bot.command('admin_hub', async (ctx) => {
  if (!await isAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const pending = await db.get("SELECT COUNT(*) as count FROM donations WHERE status = 'pending'");
  await ctx.reply(`🛠 Admin Hub\nPending: ${pending.count}`);
});

bot.command('my_links', async (ctx) => {
  if (!await isAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const botInfo = await ctx.telegram.getMe();
  const link = `https://t.me/${botInfo.username}?start=${ctx.from.id}`;
  await ctx.reply(`🔗 <b>My Invite Link:</b>`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.url('🚀 Open Link', link)]]) });
});

bot.command('my_stats', async (ctx) => {
  if (!await isAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const stats = await db.get(`SELECT COUNT(*) as count, SUM(CASE WHEN status = 'approved' THEN amount ELSE 0 END) as total FROM donations WHERE collector_id = $1`, [ctx.from.id]);
  await ctx.reply(`📊 <b>My Impact:</b>\nApproved: <b>${parseFloat(stats.total || 0).toLocaleString()} ETB</b>\nEvents: <b>${stats.count}</b>`, { parse_mode: 'HTML' });
});

bot.action(/approve_(\d+)/, async (ctx) => {
  if (!await isAdmin(ctx.from.id)) return ctx.answerCbQuery('Denied.');
  const id = ctx.match[1];
  const d = await db.get('SELECT * FROM donations WHERE id = $1', [id]);
  if (!d || d.status !== 'pending') return ctx.answerCbQuery('Processed.');
  await db.query("UPDATE donations SET status = 'approved', approved_by = $1, approved_at = CURRENT_TIMESTAMP WHERE id = $2", [ctx.from.id, id]);
  await updatePublicStatus(ctx.telegram);
  const lang = (await db.get('SELECT language FROM users WHERE id = $1', [d.user_id]))?.language || 'en';
  await ctx.editMessageCaption((ctx.callbackQuery.message.caption || '') + '\n\n✅ <b>APPROVED</b>', { parse_mode: 'HTML' }).catch(()=>{});
  await ctx.telegram.sendMessage(d.user_id, locales[lang].action_approved, { parse_mode: 'HTML' }).catch(()=>{});
});

bot.action(/reject_(\d+)/, async (ctx) => {
  if (!await isAdmin(ctx.from.id)) return ctx.answerCbQuery('Denied.');
  const id = ctx.match[1];
  const d = await db.get('SELECT * FROM donations WHERE id = $1', [id]);
  await db.query("UPDATE donations SET status = 'rejected', approved_by = $1 WHERE id = $2", [ctx.from.id, id]);
  const lang = (await db.get('SELECT language FROM users WHERE id = $1', [d.user_id]))?.language || 'en';
  await ctx.editMessageCaption((ctx.callbackQuery.message.caption || '') + '\n\n❌ <b>REJECTED</b>', { parse_mode: 'HTML' }).catch(()=>{});
  await ctx.telegram.sendMessage(d.user_id, locales[lang].action_rejected, { parse_mode: 'HTML' }).catch(()=>{});
});

bot.command('set_bank', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const details = ctx.message.text.split('\n').slice(1).join('\n');
  if (!details) return ctx.reply('Usage: /set_bank\n[Text]');
  await setSetting('BANK_DETAILS', details);
  await ctx.reply('✅ Bank Details Updated.');
});

bot.command('broadcast', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Denied.');
  const msg = ctx.message.text.split(' ').slice(1).join(' ');
  if (!msg) return ctx.reply('Usage: /broadcast <msg>');
  const users = await db.all('SELECT id FROM users');
  for (const u of users) await ctx.telegram.sendMessage(u.id, `📢 <b>Announcement</b>\n\n${msg}`, { parse_mode: 'HTML' }).catch(()=>{});
  await ctx.reply(`✅ Sent.`);
});

(async () => {
  try {
    await initDB();
    const sId = process.env.SUPER_ADMIN_ID;
    if (sId) await updateCommands(bot.telegram, parseInt(sId), 'superadmin');
    await initScheduler(bot.telegram);
    bot.launch();
    console.log('🏛 Yad Al-Awn Portal Active (Growth Analysis Integrated)');
  } catch (e) { console.error('Launch!', e.message); }
})();
