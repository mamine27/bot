const { Scenes, Markup } = require('telegraf');
const { db } = require('../database');
const locales = require('../locales');
const { getSettings } = require('../utils');

const reportScene = new Scenes.WizardScene(
  'REPORT_DONATION_SCENE',
  async (ctx) => {
    const user = await db.get('SELECT language FROM users WHERE id = $1', [ctx.from.id]);
    ctx.wizard.state.lang = user?.language || 'en';
    const l = locales[ctx.wizard.state.lang];
    
    await ctx.reply(l.report_init, { parse_mode: 'HTML' });
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    const l = locales[ctx.wizard.state.lang];
    
    if (ctx.message.text.startsWith('/')) return ctx.reply(l.report_init);

    const amount = parseFloat(ctx.message.text.trim());
    if (isNaN(amount) || amount <= 0) return ctx.reply(l.report_init);
    
    ctx.wizard.state.amount = amount;
    await ctx.reply(l.report_receipt, { 
      parse_mode: 'HTML', 
      ...Markup.keyboard([l.btn_cancel.split(' / ')[0]]).oneTime().resize() 
    });
    return ctx.wizard.next();
  },
  async (ctx) => {
    const l = locales[ctx.wizard.state.lang];
    const text = ctx.message.text ? ctx.message.text.toLowerCase().trim() : null;

    if (ctx.message.photo) {
      ctx.wizard.state.proof_file_id = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    } else if (text && text.startsWith('/')) {
      return ctx.reply(l.report_receipt);
    } else {
      return ctx.reply(l.report_receipt);
    }

    const { amount, proof_file_id } = ctx.wizard.state;
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name;

    const user = await db.get('SELECT collector_id FROM users WHERE id = $1', [userId]);
    let collectorId = null;
    if (user?.collector_id) {
      const collector = await db.get('SELECT id FROM admins WHERE id = $1', [user.collector_id]);
      if (collector) collectorId = collector.id;
    }

    try {
      const res = await db.query(`INSERT INTO donations (user_id, amount, proof_file_id, status, collector_id) VALUES ($1, $2, $3, 'pending', $4) RETURNING id`, [userId, amount, proof_file_id, collectorId]);
      const donationId = res.rows[0].id;

      await ctx.reply(l.report_success, Markup.keyboard([
        [l.btn_donate],
        [l.btn_progress, l.btn_top_donors],
        [l.btn_my_history]
      ]).resize());

      const sendReport = async (targetId) => {
        const caption = `<b>🆕 Yad Al-Awn | Verification Required</b>\n` +
          `👤 <b>Donor:</b> ${username} (ID: ${userId})\n` +
          `💰 <b>Amount:</b> ${amount.toLocaleString()} ETB\n` +
          `🆔 <b>ID:</b> #${donationId}`;

        const buttons = Markup.inlineKeyboard([
          [Markup.button.callback('✅ Approve', `approve_${donationId}`), Markup.button.callback('❌ Reject', `reject_${donationId}`)]
        ]);

        if (proof_file_id) await ctx.telegram.sendPhoto(targetId, proof_file_id, { caption, parse_mode: 'HTML', ...buttons });
        else await ctx.telegram.sendMessage(targetId, caption, { parse_mode: 'HTML', ...buttons });
      };

      const groupId = await getSettings('REPORT_GROUP_ID');
      if (collectorId) await sendReport(collectorId).catch(()=>{});
      else if (groupId) await sendReport(groupId).catch(()=>{});

    } catch (err) {
      await ctx.reply('❌ System Error.');
    }

    return ctx.scene.leave();
  }
);

module.exports = reportScene;
