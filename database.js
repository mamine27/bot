const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function initDB() {
  const client = await pool.connect();
  try {
    // Initialize Schema with Language support
    await client.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id BIGINT PRIMARY KEY,
        username TEXT,
        name TEXT,
        role TEXT DEFAULT 'collector'
      );

      CREATE TABLE IF NOT EXISTS users (
        id BIGINT PRIMARY KEY,
        username TEXT,
        collector_id BIGINT,
        language TEXT DEFAULT 'en',
        joined_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS donations (
        id SERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
        amount REAL,
        proof_file_id TEXT,
        status TEXT DEFAULT 'pending',
        collector_id BIGINT REFERENCES admins(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        approved_at TIMESTAMPTZ,
        approved_by BIGINT REFERENCES admins(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS admin_invites (
        token TEXT PRIMARY KEY,
        role TEXT DEFAULT 'collector',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // Auto-onboard SuperAdmin
    const superAdminId = process.env.SUPER_ADMIN_ID;
    if (superAdminId) {
      await client.query('INSERT INTO admins (id, role, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [superAdminId, 'superadmin', 'Primary Admin']);
    }

    console.log('🏛 Postgres Mission Database Initialized (Bilingual Support).');
  } finally {
    client.release();
  }
}

const db = {
  async query(text, params) { return pool.query(text, params); },
  async get(text, params) {
    const res = await pool.query(text, params);
    return res.rows[0];
  },
  async all(text, params) {
    const res = await pool.query(text, params);
    return res.rows;
  },
  async run(text, params) { return pool.query(text, params); },
  async exec(text) { return pool.query(text); }
};

module.exports = { db, pool, initDB };
