const cron = require('node-cron');
const { db } = require('./database');
const locales = require('./locales');

async function initScheduler(tg) {
  // Daily Mission Reminder at 10:00 AM
  cron.schedule('0 10 * * *', async () => {
    console.log('Running daily non-donor reminder...');
    
    try {
      const nonDonors = await db.all(`
        SELECT users.id, users.language FROM users
        LEFT JOIN donations ON users.id = donations.user_id AND donations.status = 'approved'
        WHERE donations.id IS NULL
      `);
      
      for (const donor of nonDonors) {
        try {
          const lang = donor.language || 'en';
          const l = locales[lang];
          
          await tg.sendMessage(donor.id, l.daily_reminder, { parse_mode: 'HTML' });
        } catch (err) {}
      }
    } catch (err) {
      console.error('Scheduler DB Error:', err.message);
    }
  });
}

module.exports = { initScheduler };
