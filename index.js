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
  res.end('<h1>Yad Al-Awn Bot is Active</h1><p>Mission Control Running. 🏮</p>');
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
        { command: 'admin_hub', description: 'Admin Hub / የአስተዳዳሪ ማዕከል' },
        { command: 'my_links', description: 'My Invite Link / የኔ ሊንክ' },
        { command: 'my_stats', description: 'My Impact Stats / የእኔ ስታቲስቲክስ' },
        { command: 'history_all', description: 'Global History / አጠቃላይ ታሪክ' },
        { command: 'view', description: 'View Donation / ልገሳ ተመልከት' }
      );
    }
    
    if (role === 'superadmin') {
      commands.push(
        { command: 'admin_stats', description: 'Team Growth / የአስተዳዳሪ ስታቲስቲክስ' },
        { command: 'broadcast', description: 'Announcement / መልዕክት ላክ' },
        { command: 'generate_invite', description: 'Invite Admin / አድሚን ጋብዝ' },
        { command: 'demote', description: 'Demote Admin / አድሚን ሰርዝ' },
        { command: 'set_bank', description: 'Update Banks / ባንክ ቀይር' },
        { command: 'set_user_target', description: 'Set Amount per User / የነፍስ ወከፍ መጠን' },
        { command: 'set_group', description: 'Connect Group / ግሩፕ አገናኝ' },
        { command: 'set_public_channel', description: 'Connect Channel / ቻናል አገናኝ' },
        { command: 'hard_reset', description: 'WIPE ALL DATA / ሁሉንም ሰርዝ' }
      );
    }
    
    await tg.setMyCommands(commands, { scope: { type: 'chat', chat_id: userId } });
  } catch (e) { console.error('Menu Error:', e.message); }
}

// --- 🌍 CORE HANDLERS ---
const langHandler = async (ctx) => {
  await ctx.reply(locales.en.select_language + "\n" + locales.am.select_language, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🇺🇸 English', 'lang_en'), Markup.button.callback('🇪🇹 አማርኛ', 'lang_am')]
    ])
  });
};
bot.command('language', langHandler);

bot.action(/lang_(en|am)/, async (ctx) => {
  const lang = ctx.match[1]; const userId = ctx.from.id;
  await db.query(`INSERT INTO users (id, username, language) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET language = $3`, [userId, ctx.from.username || ctx.from.first_name, lang]);
  await ctx.answerCbQuery(lang === 'en' ? 'Language saved.' : 'ቋንቋ ተቀምጧል።');
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
    const adminNum = parseInt(activePayload);
    if (!isNaN(adminNum)) {
       const admin = await db.get('SELECT id FROM admins WHERE id = $1', [adminNum]);
       if (admin) await db.query('UPDATE users SET collector_id = $1 WHERE id = $2', [admin.id, userId]);
    }
  }
  ctx.session.startPayload = null;
  
  const adminEntry = await db.get('SELECT role FROM admins WHERE id = $1', [userId]);
  await updateCommands(ctx.telegram, userId, adminEntry?.role || 'user');
  await ctx.reply(locales[lang].welcome, { parse_mode: 'HTML', ...getMainKeyboard(lang) });
});

bot.command('cancel', async (ctx) => {
  const lang = await getUserLang(ctx);
  await ctx.reply(locales[lang].msg_cancel, { parse_mode: 'HTML', ...getMainKeyboard(lang) });
  return ctx.scene.leave();
});

// Features
const donateHandler = (ctx) => ctx.scene.enter('REPORT_DONATION_SCENE');
bot.command('donate', donateHandler);
bot.hears([locales.en.btn_donate, locales.am.btn_donate], donateHandler);

bot.command('progress', async (ctx) => {
  const stats = await db.get("SELECT SUM(amount) as total, COUNT(*) as count FROM donations WHERE status = 'approved'");
  const l = locales[await getUserLang(ctx)];
  
  const userTargetRaw = await getSettings('USER_TARGET_AMOUNT', 0);
  const userTarget = parseFloat(userTargetRaw);
  const userCountStats = await db.get("SELECT COUNT(*) as count FROM users");
  const totalUsers = parseInt(userCountStats.count || 0);
  
  const goal = totalUsers * userTarget;
  const total = parseFloat(stats.total || 0);
  
  let text = `${l.stats_header}\n\n` +
             `💰 ${l.stats_total}: <b>${total.toLocaleString()} ETB</b>\n` +
             `🤝 ${l.stats_events}: <b>${stats.count}</b>\n` +
             `👥 Community: <b>${totalUsers} users</b>\n`;
             
  if (goal > 0) {
    const percent = Math.min(100, (total / goal) * 100);
    text += `🎯 Dynamic Goal: <b>${goal.toLocaleString()} ETB</b>\n` +
            `📈 ${l.stats_progress}: <b>${percent.toFixed(1)}%</b>`;
  }
  await ctx.reply(text, { parse_mode: 'HTML' });
});
bot.hears([locales.en.btn_progress, locales.am.btn_progress], (ctx) => bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/progress' } }));

bot.command('top_donors', async (ctx) => {
  const l = locales[await getUserLang(ctx)];
  const donors = await db.all(`SELECT SUM(amount) as total FROM donations WHERE status = 'approved' GROUP BY user_id ORDER BY total DESC LIMIT 10`);
  let text = l.leaderboard_header + '\n\n';
  if (donors.length === 0) text += l.leaderboard_empty;
  else donors.forEach((d, i) => { text += `${i < 3 ? ['🥇','🥈','🥉'][i] : '🔹'} <b>${parseFloat(d.total).toLocaleString()} ETB</b>\n`; });
  await ctx.reply(text, { parse_mode: 'HTML' });
});
bot.hears([locales.en.btn_top_donors, locales.am.btn_top_donors], (ctx) => bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/top_donors' } }));

bot.command('my_history', async (ctx) => {
  const l = locales[await getUserLang(ctx)];
  const stats = await db.get(`SELECT SUM(CASE WHEN status = 'approved' THEN amount ELSE 0 END) as approved, COUNT(*) as count FROM donations WHERE user_id = $1`, [ctx.from.id]);
  if (!stats || stats.count === '0') return ctx.reply(l.my_history_empty, { parse_mode: 'HTML' });
  const history = await db.all(`SELECT amount, status, created_at FROM donations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`, [ctx.from.id]);
  let text = `${l.my_history_header}\n\n${l.my_history_verified}: <b>${parseFloat(stats.approved || 0).toLocaleString()} ETB</b>\n\n`;
  history.forEach(d => { text += `${d.status === 'approved' ? '✅' : '⏳'} ${parseFloat(d.amount).toLocaleString()} ETB - <i>${new Date(d.created_at).toLocaleDateString()}</i>\n`; });
  await ctx.reply(text, { parse_mode: 'HTML' });
});
bot.hears([locales.en.btn_my_history, locales.am.btn_my_history], (ctx) => bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/my_history' } }));

// --- 💎 ADMIN PRODUCTIVITY ---
bot.command('admin_stats', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const stats = await db.all(`
    SELECT a.id, a.name, a.username, 
           (SELECT COUNT(*) FROM donations d WHERE d.approved_by = a.id AND d.status = 'approved') as verified_count,
           (SELECT SUM(amount) FROM donations d WHERE d.approved_by = a.id AND d.status = 'approved') as verified_value,
           (SELECT COUNT(*) FROM users u WHERE u.collector_id = a.id) as people_added,
           (SELECT COUNT(DISTINCT u.id) FROM users u JOIN donations ud ON u.id = ud.user_id WHERE u.collector_id = a.id AND ud.status = 'approved') as donors_converted
    FROM admins a ORDER BY verified_value DESC
  `);
  let text = `📈 <b>Team Analysis</b>\n\n`;
  stats.forEach(s => {
    const added = parseInt(s.people_added || 0); const converted = parseInt(s.donors_converted || 0);
    const percent = added > 0 ? ((converted / added) * 100).toFixed(1) : '0';
    text += `👤 <b>${s.name || s.username || 'System'}</b>\n` +
            `🛠 Approved: <b>${s.verified_count || 0}</b> (${parseFloat(s.verified_value || 0).toLocaleString()} ETB)\n` +
            `🤝 Recruited: <b>${added}</b> | 🎯 Conversion: <b>${percent}%</b>\n\n`;
  });
  await ctx.reply(text, { parse_mode: 'HTML' });
});

// --- 🤝 UPDATED COLLECTOR LINKS ---
bot.command('my_links', async (ctx) => {
  const userId = ctx.from.id;
  const admin = await db.get('SELECT name FROM admins WHERE id = $1', [userId]);
  if (!admin) return ctx.reply('Unauthorized.');
  
  const botInfo = await ctx.telegram.getMe();
  const link = `https://t.me/${botInfo.username}?start=${userId}`;
  
  const forwardableText = `🙏 <b>Support the Yad Al-Awn Charity Mission</b>\n\n` +
                          `We invite you to support our cause. Together we can make a difference! You can donate easily and securely using the official link below.\n\n` +
                          `የያድ አል-አውንን በጎ አድራጎት አላማ እንዲደግፉ በአክብሮት እንጠይቃለን። አብረን በመሆን ትልቅ ለውጥ ማምጣት እንችላለን! ከታች ያለውን ሊንክ በመጠቀም በቀላሉ ልገሳ ማድረግ ይችላሉ።\n\n` +
                          `👇 <b>Please tap here to start / ለመጀመር እዚህ ይጫኑ:</b>\n` +
                          `${link}`;

  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("🙏 Support the Yad Al-Awn Charity Mission / የያድ አል-አውንን በጎ አድራጎት አላማ ይደግፉ: ")}`;

  await ctx.reply('<i>Here is your shareable invite. Simply forward the message below to your contacts, or use the exact share button!</i> 👇', { parse_mode: 'HTML' });
  await ctx.reply(forwardableText, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.url('📲 Forward to Friends / ለጓደኞችዎ ያጋሩ', shareUrl)]])
  });
});

bot.command('my_stats', async (ctx) => {
  if (!await isAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  
  const recruits = await db.all(`
    SELECT u.username, u.first_name,
    (SELECT COUNT(*) FROM donations d WHERE d.user_id = u.id AND d.status = 'approved') as donated
    FROM users u WHERE u.collector_id = $1
  `, [ctx.from.id]);

  let text = `📊 <b>My Impact Details</b>\n\n`;
  if (recruits.length === 0) {
    text += `<i>You haven't recruited any donors yet. Use /my_links to start!</i>`;
  } else {
    text += `👤 <b>Recruited Members (${recruits.length}):</b>\n`;
    recruits.forEach(r => {
      const statusIcon = r.donated > 0 ? '✅ Donated' : '⏳ Waiting';
      text += `• ${r.username || r.first_name || 'User'}: ${statusIcon}\n`;
    });
  }
  
  const stats = await db.get(`SELECT SUM(amount) as total FROM donations WHERE collector_id = $1 AND status = 'approved'`, [ctx.from.id]);
  text += `\n💰 <b>Total Verified Capital:</b> ${parseFloat(stats.total || 0).toLocaleString()} ETB`;
  
  await ctx.reply(text, { parse_mode: 'HTML' });
});

bot.command('history_all', async (ctx) => {
  if (!await isAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const history = await db.all(`SELECT d.amount, d.status, u.username FROM donations d JOIN users u ON d.user_id = u.id ORDER BY d.created_at DESC LIMIT 20`);
  let text = `📋 <b>Global Log</b>\n\n`;
  history.forEach(d => { text += `${d.status === 'approved' ? '✅' : '⏳'} ${parseFloat(d.amount).toLocaleString()} ETB - ${d.username}\n`; });
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
  await ctx.reply(`🛠 <b>Admin Hub</b>\nPending: ${pending.count}`, { parse_mode: 'HTML' });
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

// --- 💣 SUPER ADMIN CONTROLS ---

bot.command('generate_invite', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const token = Math.random().toString(36).substring(2, 10);
  await db.query('INSERT INTO admin_invites (token, role) VALUES ($1, $2)', [token, 'collector']);
  const botInfo = await ctx.telegram.getMe();
  const link = `https://t.me/${botInfo.username}?start=invite_${token}`;
  await ctx.reply(`👑 <b>Admin Invite Generated</b>`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.url('🔓 Open Authorization Link', link)]]) });
});

bot.command('demote', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const id = ctx.message.text.split(' ')[1];
  if (!id) return ctx.reply('Usage: /demote <userId>');
  await db.query('DELETE FROM admins WHERE id::text = $1', [id]);
  await ctx.reply(`✅ <b>Access revoked</b> for ID: ${id}`, { parse_mode: 'HTML' });
});

bot.command('set_bank', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const details = ctx.message.text.split('\n').slice(1).join('\n');
  if (!details) return ctx.reply('Usage: /set_bank\n[Text]');
  await setSetting('BANK_DETAILS', details);
  await ctx.reply('✅ <b>Bank Details Updated.</b>', { parse_mode: 'HTML' });
});

bot.command('set_user_target', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const val = ctx.message.text.split(' ')[1];
  if (!val) return ctx.reply('Usage: /set_user_target <amount>');
  await setSetting('USER_TARGET_AMOUNT', val);
  await ctx.reply(`🎯 <b>Target per User Set:</b> ${parseFloat(val).toLocaleString()} ETB`, { parse_mode: 'HTML' });
  await updatePublicStatus(ctx.telegram);
});

bot.command('set_group', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  await setSetting('REPORT_GROUP_ID', ctx.chat.id.toString());
  await ctx.reply(`✅ <b>Connected to this group.</b>`, { parse_mode: 'HTML' });
});

bot.command('set_public_channel', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  await setSetting('PUBLIC_CHANNEL_ID', ctx.chat.id.toString());
  await setSetting('STATUS_MESSAGE_ID_COMBINED', '');
  await ctx.reply(`📢 <b>Dashboard Connected.</b>`, { parse_mode: 'HTML' });
  await updatePublicStatus(ctx.telegram);
});

bot.command('broadcast', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Denied.');
  const msg = ctx.message.text.split(' ').slice(1).join(' ');
  if (!msg) return ctx.reply('Usage: /broadcast <msg>');
  const users = await db.all('SELECT id, language FROM users');
  for (const u of users) {
    const header = u.language === 'am' ? '📢 <b>መልዕክት</b>' : '📢 <b>Announcement</b>';
    await ctx.telegram.sendMessage(u.id, `${header}\n\n${msg}`, { parse_mode: 'HTML' }).catch(()=>{});
  }
  await ctx.reply(`✅ <b>Broadcast complete to ${users.length} users.</b>`, { parse_mode: 'HTML' });
});

bot.command('hard_reset', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  await ctx.reply('⚠️ <b>CRITICAL ACTION</b>\nThis will wipe ALL donation history. Are you sure?', {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('💣 YES, WIPE DATA', 'confirm_hard_reset'), Markup.button.callback('❌ CANCEL', 'cancel_reset')]])
  });
});

bot.action('confirm_hard_reset', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.answerCbQuery('Denied.');
  await db.query('DELETE FROM donations');
  await setSetting('STATUS_MESSAGE_ID_COMBINED', '');
  await ctx.editMessageText('✅ <b>DATABASE WIPED.</b> All donations cleared.', { parse_mode: 'HTML' });
});

bot.action('cancel_reset', (ctx) => ctx.editMessageText('❌ Reset Cancelled.'));

(async () => {
  try {
    await initDB();
    const sId = process.env.SUPER_ADMIN_ID;
    if (sId) await updateCommands(bot.telegram, parseInt(sId), 'superadmin');
    await initScheduler(bot.telegram);
    bot.launch();
    console.log('🏛 Yad Al-Awn Portal Active (Final Production Release)');
  } catch (e) { console.error('Launch!', e.message); }
})();
