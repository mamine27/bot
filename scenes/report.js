const { Scenes, Markup } = require('telegraf');
const { db } = require('../database');
const { getSettings } = require('../utils');

const reportScene = new Scenes.WizardScene(
  'REPORT_DONATION_SCENE',
  // Step 1: Ask for amount
  async (ctx) => {
    await ctx.reply('🙏 <b>Mission Support Initiation</b>\n\nPlease specify the total amount of your contribution in **ETB**:', { parse_mode: 'HTML' });
    return ctx.wizard.next();
  },
  // Step 2: Handle amount and ask for proof
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    
    if (ctx.message.text.startsWith('/')) {
      return ctx.reply('⚠️ Report in progress. Please enter a numerical amount or type /cancel to stop.');
    }

    const amount = parseFloat(ctx.message.text.trim());
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply('⚠️ Please provide a valid numerical figure for the contribution amount.');
    }
    ctx.wizard.state.amount = amount;
    await ctx.reply(
      '✅ <b>Contribution Registered.</b>\n\nPlease upload a clear image of your transaction receipt or transfer confirmation to facilitate the verification process.\n\n(Alternatively, type "none" if documentation is currently unavailable.)',
      { parse_mode: 'HTML', ...Markup.keyboard(['none']).oneTime().resize() }
    );
    return ctx.wizard.next();
  },
  // Step 3: Handle proof and finalize
  async (ctx) => {
    const text = ctx.message.text ? ctx.message.text.toLowerCase().trim() : null;

    if (ctx.message.photo) {
      ctx.wizard.state.proof_file_id = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    } else if (text === 'none') {
      ctx.wizard.state.proof_file_id = null;
    } else if (text && text.startsWith('/')) {
      return ctx.reply('⚠️ Report in progress. Please upload an image or type "none" to proceed.');
    } else {
      return ctx.reply('⚠️ Action required: Please upload an image or type "none" to proceed.');
    }

    const { amount, proof_file_id } = ctx.wizard.state;
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name;

    // 🛡️ CRITICAL: Ensure user exists in DB
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
      // Save to database with Postgres RETURNING syntax
      const res = await db.query(`
        INSERT INTO donations (user_id, amount, proof_file_id, status, collector_id)
        VALUES ($1, $2, $3, 'pending', $4)
        RETURNING id
      `, [userId, amount, proof_file_id, collectorId]);
      
      const donationId = res.rows[0].id;

      await ctx.reply(
        '✅ <b>Report Submitted Successfully.</b>\n\nYour contribution has been queued for administrative verification. You will receive a notification once the capital is secured. Your generosity is deeply valued. 🙏',
        Markup.removeKeyboard()
      );

      const sendReport = async (targetId) => {
        const caption = `<b>🆕 Contribution Verification Required</b>\n\n` +
          `👤 <b>Donor:</b> ${username} (ID: ${userId})\n` +
          `💰 <b>Principal Amount:</b> ${amount.toLocaleString()} ETB\n` +
          `🆔 <b>Tracking ID:</b> #${donationId}\n` +
          `${collectorId ? `🚩 <b>Affiliated Collector ID:</b> ${collectorId}` : ''}`;

        const buttons = Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Approve', `approve_${donationId}`),
            Markup.button.callback('❌ Reject', `reject_${donationId}`)
          ]
        ]);

        if (proof_file_id) {
          await ctx.telegram.sendPhoto(targetId, proof_file_id, { caption, parse_mode: 'HTML', ...buttons });
        } else {
          await ctx.telegram.sendMessage(targetId, caption, { parse_mode: 'HTML', ...buttons });
        }
      };

      const groupId = await getSettings('REPORT_GROUP_ID');
      
      if (collectorId) {
        await sendReport(collectorId).catch(e => console.error('Collector notify failed:', e.message));
      } else if (groupId) {
        await sendReport(groupId).catch(e => console.error('Group notify failed:', e.message));
      }
    } catch (err) {
      console.error('Submission Error:', err.message);
      await ctx.reply('❌ <b>Mission Submission Error.</b>\n\nAn internal error occurred while processing your report. Please try again or contact a SuperAdmin.', { parse_mode: 'HTML' });
    }

    return ctx.scene.leave();
  }
);

module.exports = reportScene;
