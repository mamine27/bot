const cron = require('node-cron');
const { db } = require('./database');

async function initScheduler(tg) {
  // Daily Professional Progress Reminder at 10:00 AM
  cron.schedule('0 10 * * *', async () => {
    console.log('Running daily non-donor reminder...');
    
    try {
      const nonDonors = await db.all(`
        SELECT users.id 
        FROM users
        LEFT JOIN donations ON users.id = donations.user_id AND donations.status = 'approved'
        WHERE donations.id IS NULL
      `);
      
      for (const donor of nonDonors) {
        try {
          await tg.sendMessage(donor.id, 
            `☀️ <b>Morning Mission Update</b>\n\nWe are continuing our efforts to reach our strategic fundraising objective. Our records indicate your contribution is still pending. Every bit of support accelerates our collective impact! 🙏\n\nUse /donate to participate or /stats to view our live progress.`, 
            { parse_mode: 'HTML' }
          );
        } catch (err) {
          // Silently handle blocked users
        }
      }
    } catch (err) {
      console.error('Scheduler DB Error:', err.message);
    }
  });
}

module.exports = { initScheduler };
