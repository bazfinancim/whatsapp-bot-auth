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

async function migrateLidMappings(pool) {
    try {
        console.log('🔄 Running database migration for LID mappings table...');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS lid_mappings (
                lid VARCHAR(50) PRIMARY KEY,
                phone_number VARCHAR(20) NOT NULL,
                name VARCHAR(255),
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            );
        `);

        // Create index for reverse lookups (phone → LID)
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_lid_phone ON lid_mappings(phone_number);
        `);

        console.log('✅ LID mappings table migration completed successfully');
        return true;
    } catch (error) {
        console.error('❌ LID mappings migration failed:', error);
        return false;
    }
}

module.exports = {
    migrateReminderColumns,
    migrateLidMappings
};
