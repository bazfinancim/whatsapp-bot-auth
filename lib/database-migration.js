// Database migration for reminder system
// Adds reminder tracking columns to sessions table

const { Pool } = require('pg');

async function migrateReminderColumns(pool) {
    try {
        console.log('🔄 Running database migration for reminder columns...');

        await pool.query(`
            ALTER TABLE sessions
            ADD COLUMN IF NOT EXISTS form_sent_at TIMESTAMP,
            ADD COLUMN IF NOT EXISTS form_completed_at TIMESTAMP,
            ADD COLUMN IF NOT EXISTS appointment_sent_at TIMESTAMP,
            ADD COLUMN IF NOT EXISTS appointment_scheduled_at TIMESTAMP,
            ADD COLUMN IF NOT EXISTS reminders_sent JSONB DEFAULT '{"form": [], "appointment": []}'::jsonb;
        `);

        console.log('✅ Database migration completed successfully');
        return true;
    } catch (error) {
        console.error('❌ Database migration failed:', error);
        return false;
    }
}

module.exports = {
    migrateReminderColumns
};
