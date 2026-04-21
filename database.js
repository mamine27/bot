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
    // 1. Initialize Schema (Standard Tables)
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

    // 2. 🛡️ SAFE MIGRATIONS
    // Ensure 'language' exists in 'users'
    await client.query(`
      DO $$ BEGIN 
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='language') THEN 
          ALTER TABLE users ADD COLUMN language TEXT DEFAULT 'en'; 
        END IF; 
      END $$;
    `);
    
    // 3. 💣 SUPERADMIN HARDENING
    const sId = process.env.SUPER_ADMIN_ID;
    if (sId) {
      const superId = parseInt(sId);
      // Ensure in Admins table (Force role)
      await client.query(`
        INSERT INTO admins (id, role, name) VALUES ($1, 'superadmin', 'Primary Admin') 
        ON CONFLICT (id) DO UPDATE SET role = 'superadmin'
      `, [superId]);
      
      // Ensure in Users table (For broadcast/stats testing)
      await client.query(`
        INSERT INTO users (id, username, language) VALUES ($1, 'primary_admin', 'en') 
        ON CONFLICT (id) DO NOTHING
      `, [superId]);
    }

    console.log('🏛 Postgres Mission Database Initialized (Self-Healed).');
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
