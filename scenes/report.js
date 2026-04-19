const { Scenes, Markup } = require('telegraf');
const { db } = require('../database');
const { getSettings } = require('../utils');

const reportScene = new Scenes.WizardScene(
  'REPORT_DONATION_SCENE',
  async (ctx) => {
    await ctx.reply('🙏 <b>Yad Al-Awn | Mission Support Initiation</b>\n\nPlease specify the total amount of your contribution in **ETB**:', { parse_mode: 'HTML' });
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    if (ctx.message.text.startsWith('/')) return ctx.reply('⚠️ Report in progress. Please enter an amount or /cancel.');

    const amount = parseFloat(ctx.message.text.trim());
    if (isNaN(amount) || amount <= 0) return ctx.reply('⚠️ Please provide a valid numerical figure.');
    
    ctx.wizard.state.amount = amount;
    await ctx.reply(
      '✅ <b>Contribution Registered.</b>\n\nAt Yad Al-Awn, we treat every donation as a specific trust (<i>Amanah</i>). To maintain our strict standards of accountability, please upload your transfer confirmation below.\n\n(Alternatively, type "none" if documentation is unavailable.)',
      { parse_mode: 'HTML', ...Markup.keyboard(['none']).oneTime().resize() }
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    const text = ctx.message.text ? ctx.message.text.toLowerCase().trim() : null;

    if (ctx.message.photo) {
      ctx.wizard.state.proof_file_id = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    } else if (text === 'none') {
      ctx.wizard.state.proof_file_id = null;
    } else if (text && text.startsWith('/')) {
      return ctx.reply('⚠️ Report in progress. Please upload an image or type "none".');
    } else {
      return ctx.reply('⚠️ Action required: Please upload an image or type "none".');
    }

    const { amount, proof_file_id } = ctx.wizard.state;
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name;

    let user = await db.get('SELECT collector_id FROM users WHERE id = $1', [userId]);
    if (!user) {
      await db.query('INSERT INTO users (id, username) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [userId, username]);
      user = { collector_id: null };
    }
    
    let collectorId = null;
    if (user.collector_id) {
      const collector = await db.get('SELECT id FROM admins WHERE id = $1', [user.collector_id]);
      if (collector) collectorId = collector.id;
    }

    try {
      const res = await db.query(`
        INSERT INTO donations (user_id, amount, proof_file_id, status, collector_id)
        VALUES ($1, $2, $3, 'pending', $4)
        RETURNING id
      `, [userId, amount, proof_file_id, collectorId]);
      
      const donationId = res.rows[0].id;

      await ctx.reply(
        '✅ <b>Yad Al-Awn | Report Submitted.</b>\n\nYour contribution has been queued for administrative verification. You will receive a notification once the <i>Amanah</i> is confirmed. Jazakallah Khair for your generosity. 🙏',
        Markup.removeKeyboard()
      );

      const sendReport = async (targetId) => {
        const caption = `<b>🆕 Yad Al-Awn | Verification Required</b>\n\n` +
          `👤 <b>Donor:</b> ${username} (ID: ${userId})\n` +
          `💰 <b>Principal Amount:</b> ${amount.toLocaleString()} ETB\n` +
          `🆔 <b>Tracking ID:</b> #${donationId}`;

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
      await ctx.reply('❌ <b>Mission Submission Error.</b> Please try again or contact a SuperAdmin.', { parse_mode: 'HTML' });
    }

    return ctx.scene.leave();
  }
);

module.exports = reportScene;
