require('dotenv').config();
const { Telegraf, Scenes, session, Markup } = require('telegraf');
const { db, initDB } = require('./database');
const reportScene = require('./scenes/report');
const { isAdmin, isSuperAdmin, setSetting, getSettings, updatePublicStatus } = require('./utils');
const { initScheduler } = require('./scheduler');

const bot = new Telegraf(process.env.BOT_TOKEN);

// Middleware
const stage = new Scenes.Stage([reportScene]);
bot.use(session());
bot.use(stage.middleware());

// Command Sets
const COMMANDS_USER = [
  { command: 'start', description: 'Re-initialize interaction' },
  { command: 'donate', description: 'Begin contribution reporting' },
  { command: 'stats', description: 'View mission insights' },
  { command: 'leaderboard', description: 'View anonymous impact board' },
  { command: 'my_donations', description: 'Review your contribution history' },
  { command: 'cancel', description: 'Exit current interaction' }
];

const COMMANDS_ADMIN = [
  ...COMMANDS_USER,
  { command: 'admin_panel', description: '🛡️ Admin Control Center' },
  { command: 'my_link', description: '🔗 Get your referral link' },
  { command: 'my_leads', description: '📉 View pending leads' },
  { command: 'collector_stats', description: '🏁 Team performance metrics' },
  { command: 'list_admins', description: '👥 View full team roster' }
];

const COMMANDS_SUPER = [
  ...COMMANDS_ADMIN,
  { command: 'set_goal', description: '🎯 Update funding target' },
  { command: 'set_group', description: '🛰️ Connect Admin Group' },
  { command: 'set_public_channel', description: '📺 Connect Public Dashboard' },
  { command: 'unset_group', description: '🔌 Disconnect Admin Group' },
  { command: 'unset_public_channel', description: '🔌 Disconnect Dashboard' },
  { command: 'generate_invite', description: '🎟 Issue recruitment link' },
  { command: 'add_admin', description: '➕ Manually add admin' },
  { command: 'remove_admin', description: '➖ Remove an admin' },
  { command: 'conversion_stats', description: '💹 Strategic conversion data' },
  { command: 'broadcast', description: '📢 Send portal-wide announcement' },
  { command: 'test_notifications', description: '🛠 Audit & Test Diagnostics' },
  { command: 'reset_campaign', description: '♻️ Reset data (keep team)' },
  { command: 'hard_reset', description: '☢️ SYSTEM WIPE' }
];

async function updateCommands(tg, userId, role) {
  try {
    let commands = COMMANDS_USER;
    if (role === 'superadmin') commands = COMMANDS_SUPER;
    else if (role === 'collector') commands = COMMANDS_ADMIN;
    
    await tg.setMyCommands(commands, {
      scope: { type: 'chat', chat_id: userId }
    });
  } catch (e) {
    console.error(`Failed to set commands for ${userId}:`, e.message);
  }
}

function toCSV(data) {
  if (data.length === 0) return '';
  const headers = Object.keys(data[0]).join(',');
  const rows = data.map(row => 
    Object.values(row).map(val => `"${val !== null ? val.toString().replace(/"/g, '""') : ''}"`).join(',')
  ).join('\n');
  return `${headers}\n${rows}`;
}

bot.command('cancel', async (ctx) => {
  await ctx.reply('⚠️ Action cancelled.', Markup.removeKeyboard());
  return ctx.scene.leave();
});

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name;
  const payload = ctx.startPayload;

  if (payload && payload.startsWith('invite_')) {
    const token = payload.replace('invite_', '');
    const invite = await db.get('SELECT * FROM admin_invites WHERE token = $1', [token]);
    
    if (invite) {
      try {
        await db.query('INSERT INTO admins (id, username, name, role) VALUES ($1, $2, $3, $4)', 
          [userId, ctx.from.username, username, invite.role]);
        await updateCommands(ctx.telegram, userId, invite.role);
        await ctx.reply(`👑 <b>Welcome to the Team!</b>\n\nYou have been added as a <b>${invite.role}</b>. Your menu has been upgraded!`, { parse_mode: 'HTML' });
      } catch (e) {
        await ctx.reply('❌ You are already an admin.');
      }
    } else {
      await ctx.reply('❌ This invitation link is invalid.');
    }
  }

  let user = await db.get('SELECT * FROM users WHERE id = $1', [userId]);
  if (!user) {
    let collectorId = null;
    if (payload && !payload.startsWith('invite_')) {
      const admin = await db.get('SELECT id FROM admins WHERE id::text = $1 OR username = $1', [payload]);
      if (admin) collectorId = admin.id;
    }
    await db.query('INSERT INTO users (id, username, collector_id) VALUES ($1, $2, $3)', [userId, username, collectorId]);
  }

  await ctx.reply(
    `🙏 <b>Welcome to the Support Portal.</b>\n\n` +
    `Select an option below to begin:`,
    {
      parse_mode: 'HTML',
      ...Markup.keyboard([
        ['💰 Report Contribution'],
        ['📊 Mission Progress', '🌟 Impact Board']
      ]).resize()
    }
  );
});

bot.hears('💰 Report Contribution', (ctx) => ctx.scene.enter('REPORT_DONATION_SCENE'));
bot.command('donate', (ctx) => ctx.scene.enter('REPORT_DONATION_SCENE'));

bot.hears('📊 Mission Progress', async (ctx) => {
  const stats = await db.get("SELECT SUM(amount) as total, COUNT(*) as count FROM donations WHERE status = 'approved'");
  const total = parseFloat(stats.total || 0);
  const goalVal = await getSettings('GOAL_AMOUNT', 0);
  const goal = parseFloat(goalVal);
  
  let text = `📊 <b>Fundraising Insights</b>\n\n`;
  text += `Capital Raised: <b>${total.toLocaleString()} ETB</b>\n`;
  text += `Verified Contributions: <b>${stats.count}</b>\n`;
  
  if (goal > 0) {
    const percent = Math.min(100, (total / goal) * 100);
    text += `Target Objective: <b>${goal.toLocaleString()} ETB</b>\n`;
    text += `Progress: <b>${percent.toFixed(1)}%</b>`;
  }
  await ctx.reply(text, { parse_mode: 'HTML' });
});

async function sendLeaderboard(tg, chatId) {
  const donors = await db.all(`
    SELECT SUM(amount) as total FROM donations
    WHERE status = 'approved' GROUP BY user_id
    ORDER BY total DESC LIMIT 10
  `);

  let text = '🌟 <b>Mission Impact Board</b>\n\n';
  if (donors.length === 0) {
    text += 'No contributions recorded yet.';
  } else {
    donors.forEach((d, i) => {
      const medal = i === 0 ? '🥇' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : '🔹'));
      text += `${medal} <b>${parseFloat(d.total).toLocaleString()} ETB</b>\n`;
    });
  }
  await tg.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

async function showAdminList(ctx) {
  const admins = await db.all('SELECT * FROM admins');
  let text = '👥 <b>Admin Team</b>\n\n';
  admins.forEach(a => {
    const roleIcon = a.role === 'superadmin' ? '👑' : '👤';
    text += `${roleIcon} <b>${a.name}</b> (${a.role})\nID: <code>${a.id}</code>\n\n`;
  });
  await ctx.reply(text, { parse_mode: 'HTML' });
}

bot.hears('🌟 Impact Board', (ctx) => sendLeaderboard(ctx.telegram, ctx.chat.id));

bot.command('set_group', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  await setSetting('REPORT_GROUP_ID', ctx.chat.id.toString());
  await ctx.reply(`✅ Success! Reports connected to ${ctx.chat.title || 'this group'}.`);
});

bot.command('set_public_channel', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  await setSetting('PUBLIC_CHANNEL_ID', ctx.chat.id.toString());
  await setSetting('STATUS_MESSAGE_ID', '');
  await ctx.reply(`📢 Dashboard connected to ${ctx.chat.title}.`);
  await updatePublicStatus(ctx.telegram);
});

bot.command('unset_group', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  await db.query("DELETE FROM settings WHERE key = $1", ['REPORT_GROUP_ID']);
  await ctx.reply('🚫 Admin Group Disconnected.');
});

bot.command('unset_public_channel', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  await db.query("DELETE FROM settings WHERE key IN ($1, $2)", ['PUBLIC_CHANNEL_ID', 'STATUS_MESSAGE_ID']);
  await ctx.reply('🚫 Public Dashboard Disconnected.');
});

bot.command('set_goal', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const goal = parseFloat(ctx.message.text.split(' ')[1]);
  if (!goal || goal <= 0) return ctx.reply('Usage: /set_goal <amount>');
  await setSetting('TEMP_GOAL', goal.toString());
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🆕 New Mission (Wipe)', 'goal_wipe'), Markup.button.callback('📈 Continue Current', 'goal_continue')]
  ]);
  await ctx.reply(`🎯 <b>Objective Entry: ${goal.toLocaleString()} ETB</b>\nHow to apply?`, { parse_mode: 'HTML', ...keyboard });
});

bot.action('goal_wipe', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.answerCbQuery('Unauthorized.');
  const goal = await getSettings('TEMP_GOAL');
  if (!goal) return ctx.answerCbQuery('Expired.');

  try {
    const nonDonors = await db.all(`
      SELECT users.id FROM users
      LEFT JOIN donations ON users.id = donations.user_id AND donations.status = 'approved'
      WHERE donations.id IS NULL
    `);
    for (const donor of nonDonors) {
      await ctx.telegram.sendMessage(donor.id, `🆕 <b>New Mission Launch!</b> Target: <b>${parseFloat(goal).toLocaleString()} ETB</b>.`, { parse_mode: 'HTML' }).catch(()=>{});
    }
    await db.query('TRUNCATE donations CASCADE');
    await setSetting('STATUS_MESSAGE_ID', '');
    await setSetting('GOAL_AMOUNT', goal);
    await ctx.editMessageText(`✅ <b>Mission Refresh Complete.</b> Target: <b>${parseFloat(goal).toLocaleString()} ETB</b>.`, { parse_mode: 'HTML' });
    await updatePublicStatus(ctx.telegram);
  } catch (err) { await ctx.reply('❌ Error: ' + err.message); }
});

bot.action('goal_continue', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.answerCbQuery('Unauthorized.');
  const goal = await getSettings('TEMP_GOAL');
  if (!goal) return ctx.answerCbQuery('Expired.');
  await setSetting('GOAL_AMOUNT', goal);
  await ctx.editMessageText(`🎯 Goal updated to <b>${parseFloat(goal).toLocaleString()} ETB</b>.`, { parse_mode: 'HTML' });
  await updatePublicStatus(ctx.telegram);
});

bot.command('generate_invite', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const token = require('crypto').randomBytes(4).toString('hex');
  await db.query('INSERT INTO admin_invites (token, role) VALUES ($1, $2)', [token, 'collector']);
  const botInfo = await ctx.telegram.getMe();
  const link = `https://t.me/${botInfo.username}?start=invite_${token}`;
  await ctx.reply(`🚀 <a href="${link}">Direct Launch Link</a>\n<code>${link}</code>`, { parse_mode: 'HTML' });
});

bot.command('remove_admin', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const targetId = ctx.message.text.split(' ')[1];
  if (!targetId) return ctx.reply('Usage: /remove_admin <id>');
  await db.query('DELETE FROM admins WHERE id = $1', [targetId]);
  await ctx.reply('✅ Admin removed.');
});

bot.command('collector_stats', async (ctx) => {
  if (!await isAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const stats = await db.all(`
    SELECT a.name, SUM(d.amount) as total_amount, COUNT(DISTINCT u.id) as total_invites, 
    COUNT(DISTINCT CASE WHEN d.status = 'approved' THEN u.id END) as total_donors
    FROM admins a LEFT JOIN users u ON a.id = u.collector_id
    LEFT JOIN donations d ON u.id = d.user_id AND d.status = 'approved'
    WHERE a.role = 'collector' GROUP BY a.id ORDER BY total_amount DESC
  `);
  let text = '🏁 <b>Collector Stats</b>\n\n';
  stats.forEach(s => {
    const rate = s.total_invites > 0 ? ((s.total_donors / s.total_invites) * 100).toFixed(1) : 0;
    text += `👤 <b>${s.name}</b>: ${parseFloat(s.total_amount || 0).toLocaleString()} ETB (${rate}%)\n`;
  });
  await ctx.reply(text, { parse_mode: 'HTML' });
});

bot.command('broadcast', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const msg = ctx.message.text.split(' ').slice(1).join(' ');
  const users = await db.all('SELECT id FROM users');
  for (const u of users) await ctx.telegram.sendMessage(u.id, `📢 ${msg}`, { parse_mode: 'HTML' }).catch(()=>{});
  await ctx.reply('✅ Sent.');
});

bot.command('hard_reset', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  if (!ctx.message.text.includes('CONFIRM')) return ctx.reply('Type /hard_reset CONFIRM');
  await db.query('TRUNCATE donations, users, admin_invites CASCADE');
  await db.query('DELETE FROM admins WHERE id != $1', [ctx.from.id]);
  await ctx.reply('☢️ Hard Reset Done.');
});

bot.command('test_notifications', async (ctx) => {
  if (!await isSuperAdmin(ctx.from.id)) return ctx.reply('Unauthorized.');
  const users = await db.all('SELECT id FROM users');
  await ctx.reply(`📋 Audience: ${users.length} users.`, {
    ...Markup.inlineKeyboard([[Markup.button.callback('🚀 Test Broadcast', 'test_broadcast_run')]])
  });
});

bot.action('test_broadcast_run', async (ctx) => {
  const users = await db.all('SELECT id FROM users');
  for (const u of users) await ctx.telegram.sendMessage(u.id, '🔔 System Test.').catch(()=>{});
  await ctx.editMessageText('✅ Done.');
});

bot.command('my_link', async (ctx) => {
  const botInfo = await ctx.telegram.getMe();
  const link = `https://t.me/${botInfo.username}?start=${ctx.from.id}`;
  await ctx.reply(`🚀 <a href="${link}">Your Link</a>\n<code>${link}</code>`, { parse_mode: 'HTML' });
});

bot.action(/approve_(\d+)/, async (ctx) => {
  if (!await isAdmin(ctx.from.id)) return ctx.answerCbQuery('No.');
  const id = ctx.match[1];
  await db.query("UPDATE donations SET status = 'approved', approved_by = $1, approved_at = CURRENT_TIMESTAMP WHERE id = $2", [ctx.from.id, id]);
  await updatePublicStatus(ctx.telegram);
  await ctx.editMessageText('✅ Approved');
});

bot.action(/reject_(\d+)/, async (ctx) => {
  if (!await isAdmin(ctx.from.id)) return ctx.answerCbQuery('No.');
  await db.query("UPDATE donations SET status = 'rejected', approved_by = $1 WHERE id = $2", [ctx.from.id, ctx.match[1]]);
  await ctx.editMessageText('❌ Rejected');
});

// Start Procedure
(async () => {
  try {
    await initDB();
    await bot.telegram.setMyCommands(COMMANDS_USER);
    const sId = process.env.SUPER_ADMIN_ID;
    if (sId) await updateCommands(bot.telegram, parseInt(sId), 'superadmin');
    await initScheduler(bot.telegram);
    bot.launch();
    console.log('🏛 Mission Portal Active (Postgres)');
  } catch (e) { console.error('Launch Failed:', e.message); }
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
