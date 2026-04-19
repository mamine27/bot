const cron = require('node-cron');
const { db } = require('./database');

async function initScheduler(tg) {
  // Daily Mission Reminder at 10:00 AM
  cron.schedule('0 10 * * *', async () => {
    console.log('Running daily non-donor reminder...');
    
    try {
      const nonDonors = await db.all(`
        SELECT users.id FROM users
        LEFT JOIN donations ON users.id = donations.user_id AND donations.status = 'approved'
        WHERE donations.id IS NULL
      `);
      
      for (const donor of nonDonors) {
        try {
          await tg.sendMessage(donor.id, 
            `☀️ <b>Yad Al-Awn | Morning Mission Update</b>\n\n` +
            `We are continuing our collective effort to reach our strategic fundraising objective. Remember the Prophetic wisdom: <i>"Charity does not decrease wealth."</i>\n\n` +
            `We invite you to be part of this legacy. Use /donate to participate or /stats to view our live progress. 🙏`, 
            { parse_mode: 'HTML' }
          );
        } catch (err) {}
      }
    } catch (err) {
      console.error('Scheduler DB Error:', err.message);
    }
  });
}

module.exports = { initScheduler };
