/**
 * Session Manager for WhatsApp Bot
 *
 * CONSOLIDATED VERSION: Runs in same app as WhatsApp bot.
 * No HTTP calls needed for bot cleanup - can access pendingUsers directly.
 */

const { Pool } = require('pg');
const { cancelSessionMessages } = require('./messageScheduler');

class SessionManager {
    constructor() {
        const connectionString = process.env.DATABASE_URL;

        const config = {
            connectionString: connectionString,
            connectionTimeoutMillis: 10000,
            idleTimeoutMillis: 30000,
            max: 10
        };

        // Always use SSL in production with rejectUnauthorized: false
        // Render's PostgreSQL requires SSL even for internal connections
        if (process.env.NODE_ENV === 'production') {
            config.ssl = {
                rejectUnauthorized: false
            };
            console.log('📊 PostgreSQL connection: SSL enabled (rejectUnauthorized: false)');
        } else {
            console.log('📊 PostgreSQL connection: Development mode (no SSL)');
        }

        this.pool = new Pool(config);

        this.pool.on('error', (err) => {
            console.error('Unexpected error on idle PostgreSQL client:', err);
        });

        // Reference to pendingUsers map from stupid-bot (set externally)
        this.pendingUsersMap = null;
    }

    /**
     * Set reference to the pendingUsers map from stupid-bot
     * This allows direct cleanup without HTTP calls
     * @param {Map} pendingUsers - Map of phone number to pending user data
     */
    setPendingUsersMap(pendingUsers) {
        this.pendingUsersMap = pendingUsers;
        console.log('✅ SessionManager: pendingUsers map reference set');
    }

    /**
     * Clear a user from the pending users map (direct, no HTTP)
     * @param {string} phoneNumber - Phone number to clear
     */
    clearPendingUser(phoneNumber) {
        if (!this.pendingUsersMap) {
            console.warn('⚠️  pendingUsersMap not set in SessionManager');
            return;
        }

        // Normalize phone number (remove +, spaces, etc.)
        const normalizedPhone = phoneNumber.replace(/[^\d]/g, '');

        if (this.pendingUsersMap.has(normalizedPhone)) {
            this.pendingUsersMap.delete(normalizedPhone);
            console.log(`🧹 Cleared ${normalizedPhone} from pendingUsers map`);
        }
    }

    /**
     * Initialize database - create tables if they don't exist
     */
    async initialize() {
        let client;
        try {
            console.log('🔌 Attempting to connect to database...');
            console.log('📍 DATABASE_URL configured:', !!process.env.DATABASE_URL);

            client = await this.pool.connect();
            console.log('✅ Database connection established');

            // Create sessions table if it doesn't exist (preserves existing data)
            await client.query(`
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id VARCHAR(255) PRIMARY KEY,
                    phone_number VARCHAR(20) NOT NULL,
                    chat_id VARCHAR(255),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    expires_at TIMESTAMP NOT NULL,
                    form_data JSONB DEFAULT '{}',
                    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'completed', 'expired')),
                    completed_at TIMESTAMP,
                    form_sent_at TIMESTAMP,
                    form_completed_at TIMESTAMP,
                    appointment_sent_at TIMESTAMP,
                    appointment_scheduled_at TIMESTAMP,
                    reminders_sent JSONB DEFAULT '{"form": [], "appointment": []}'
                )
            `);

            // Create scheduled_messages table for Bull queue tracking
            await client.query(`
                CREATE TABLE IF NOT EXISTS scheduled_messages (
                    id SERIAL PRIMARY KEY,
                    session_id VARCHAR(255) REFERENCES sessions(session_id),
                    phone_number VARCHAR(20) NOT NULL,
                    chat_id VARCHAR(255),
                    message_type VARCHAR(50) NOT NULL,
                    message_content TEXT NOT NULL,
                    scheduled_for TIMESTAMP NOT NULL,
                    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
                    job_id VARCHAR(255),
                    sent_at TIMESTAMP,
                    error_message TEXT,
                    retry_count INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Create calendar_events table for short URL redirects
            await client.query(`
                CREATE TABLE IF NOT EXISTS calendar_events (
                    id VARCHAR(10) PRIMARY KEY,
                    event_name VARCHAR(255) NOT NULL,
                    start_time TIMESTAMP NOT NULL,
                    end_time TIMESTAMP NOT NULL,
                    description TEXT,
                    location VARCHAR(500),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    expires_at TIMESTAMP NOT NULL
                )
            `);

            // Create indexes if they don't exist (using IF NOT EXISTS)
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_sessions_phone ON sessions(phone_number)
            `);

            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)
            `);

            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)
            `);

            // Create partial unique index to ensure only one active session per phone number
            await client.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_phone_active
                ON sessions(phone_number)
                WHERE status = 'active'
            `);

            // Index for scheduled messages
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_scheduled_messages_session ON scheduled_messages(session_id)
            `);

            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_scheduled_messages_status ON scheduled_messages(status)
            `);

            console.log('✅ Database initialized (tables and indexes ready)');
        } catch (error) {
            console.error('❌ Error initializing database:', error.message);
            console.error('Error code:', error.code);
            console.error('Error details:', JSON.stringify(error, null, 2));
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    /**
     * Generate a unique session ID
     */
    generateSessionId() {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 15);
        return `session_${timestamp}_${random}`;
    }

    /**
     * Create a new session for a phone number
     * If an active session exists, it will be marked as expired
     */
    async createSession(phoneNumber, chatId = null) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // Get existing active sessions before marking as expired
            const existingSessions = await client.query(
                `SELECT session_id FROM sessions
                 WHERE phone_number = $1 AND status = 'active'`,
                [phoneNumber]
            );

            // Cancel all Bull jobs for existing sessions to prevent duplicate messages
            for (const row of existingSessions.rows) {
                console.log(`🗑️  Cancelling all scheduled messages for old session ${row.session_id}`);
                try {
                    await cancelSessionMessages(row.session_id);
                } catch (cancelError) {
                    console.error(`⚠️  Error cancelling messages for session ${row.session_id}:`, cancelError);
                    // Continue anyway - don't block new session creation
                }
            }

            // Mark any existing active sessions as expired
            await client.query(
                `UPDATE sessions
                 SET status = 'expired'
                 WHERE phone_number = $1 AND status = 'active'`,
                [phoneNumber]
            );

            // Create new session
            const sessionId = this.generateSessionId();
            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

            await client.query(
                `INSERT INTO sessions (session_id, phone_number, chat_id, expires_at, status, form_sent_at)
                 VALUES ($1, $2, $3, $4, 'active', NOW())`,
                [sessionId, phoneNumber, chatId, expiresAt]
            );

            await client.query('COMMIT');

            console.log(`✅ Created new session ${sessionId} for ${phoneNumber}`);
            return {
                sessionId,
                phoneNumber,
                expiresAt,
                chatbotUrl: `${process.env.BASE_URL || 'http://localhost:3000'}/chatbot?session=${sessionId}`
            };
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('❌ Error creating session:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Get session by session ID
     */
    async getSession(sessionId) {
        try {
            const result = await this.pool.query(
                `SELECT * FROM sessions WHERE session_id = $1`,
                [sessionId]
            );

            if (result.rows.length === 0) {
                return null;
            }

            const session = result.rows[0];

            // Check if session has expired
            if (new Date(session.expires_at) < new Date()) {
                await this.expireSession(sessionId);
                return null;
            }

            return session;
        } catch (error) {
            console.error('❌ Error getting session:', error);
            throw error;
        }
    }

    /**
     * Get active session by phone number
     */
    async getActiveSessionByPhone(phoneNumber) {
        try {
            const result = await this.pool.query(
                `SELECT * FROM sessions
                 WHERE phone_number = $1 AND status = 'active'
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [phoneNumber]
            );

            if (result.rows.length === 0) {
                return null;
            }

            const session = result.rows[0];

            // Check if session has expired
            if (new Date(session.expires_at) < new Date()) {
                await this.expireSession(session.session_id);
                return null;
            }

            return session;
        } catch (error) {
            console.error('❌ Error getting active session:', error);
            throw error;
        }
    }

    /**
     * Mark session as completed
     */
    async markCompleted(sessionId, formData = {}) {
        try {
            const result = await this.pool.query(
                `UPDATE sessions
                 SET status = 'completed',
                     completed_at = CURRENT_TIMESTAMP,
                     form_completed_at = CURRENT_TIMESTAMP,
                     appointment_sent_at = CURRENT_TIMESTAMP,
                     form_data = $2
                 WHERE session_id = $1
                 RETURNING *`,
                [sessionId, JSON.stringify(formData)]
            );

            if (result.rows.length === 0) {
                throw new Error('Session not found');
            }

            const session = result.rows[0];

            // Clear from pending users map (direct, no HTTP)
            this.clearPendingUser(session.phone_number);

            console.log(`✅ Marked session ${sessionId} as completed (form & appointment timestamps set)`);
            return session;
        } catch (error) {
            console.error('❌ Error marking session as completed:', error);
            throw error;
        }
    }

    /**
     * Store Monday.com item ID in session for later updates
     * @param {string} sessionId - Session ID
     * @param {string} mondayItemId - Monday.com item ID
     */
    async setMondayItemId(sessionId, mondayItemId) {
        try {
            // Store in form_data JSONB field
            await this.pool.query(
                `UPDATE sessions
                 SET form_data = form_data || $2::jsonb
                 WHERE session_id = $1`,
                [sessionId, JSON.stringify({ monday_item_id: mondayItemId })]
            );
            console.log(`✅ Stored Monday.com item ID ${mondayItemId} for session ${sessionId}`);
        } catch (error) {
            console.error('❌ Error storing Monday.com item ID:', error);
            throw error;
        }
    }

    /**
     * Expire a session
     */
    async expireSession(sessionId) {
        try {
            // Cancel all Bull jobs for this session to prevent orphaned reminders
            console.log(`🗑️  Cancelling all scheduled messages for expired session ${sessionId}`);
            try {
                await cancelSessionMessages(sessionId);
            } catch (cancelError) {
                console.error(`⚠️  Error cancelling messages for session ${sessionId}:`, cancelError);
                // Continue anyway - don't block expiration
            }

            // Get phone number before expiring (for bot cleanup)
            const sessionResult = await this.pool.query(
                `SELECT phone_number FROM sessions WHERE session_id = $1`,
                [sessionId]
            );
            const phoneNumber = sessionResult.rows[0]?.phone_number;

            await this.pool.query(
                `UPDATE sessions SET status = 'expired' WHERE session_id = $1`,
                [sessionId]
            );

            // Clear from pending users map (direct, no HTTP)
            if (phoneNumber) {
                this.clearPendingUser(phoneNumber);
            }

            console.log(`✅ Expired session ${sessionId}`);
        } catch (error) {
            console.error('❌ Error expiring session:', error);
            throw error;
        }
    }

    /**
     * Reset session for a phone number (called when user types "reset")
     */
    async resetSession(phoneNumber, chatId = null) {
        return await this.createSession(phoneNumber, chatId);
    }

    /**
     * Clean up expired sessions (run periodically)
     */
    async cleanupExpiredSessions() {
        try {
            const result = await this.pool.query(
                `UPDATE sessions
                 SET status = 'expired'
                 WHERE expires_at < CURRENT_TIMESTAMP
                 AND status = 'active'
                 RETURNING session_id, phone_number`
            );

            // Cancel Bull jobs and clear pending users for expired sessions
            for (const row of result.rows) {
                console.log(`🗑️  Cancelling all scheduled messages for expired session ${row.session_id}`);
                try {
                    await cancelSessionMessages(row.session_id);
                } catch (cancelError) {
                    console.error(`⚠️  Error cancelling messages for session ${row.session_id}:`, cancelError);
                    // Continue anyway - don't block cleanup
                }

                // Clear from pending users map (direct, no HTTP)
                if (row.phone_number) {
                    this.clearPendingUser(row.phone_number);
                }
            }

            console.log(`✅ Cleaned up ${result.rows.length} expired sessions`);
            return result.rows.length;
        } catch (error) {
            console.error('❌ Error cleaning up expired sessions:', error);
            throw error;
        }
    }

    /**
     * Get all active sessions
     */
    async getAllActiveSessions() {
        try {
            const result = await this.pool.query(
                `SELECT session_id, phone_number FROM sessions WHERE status = 'active'`
            );
            return result.rows;
        } catch (error) {
            console.error('❌ Error getting all active sessions:', error);
            throw error;
        }
    }

    /**
     * Expire all active sessions (bulk update)
     */
    async expireAllActiveSessions() {
        try {
            const result = await this.pool.query(
                `UPDATE sessions SET status = 'expired' WHERE status = 'active' RETURNING session_id`
            );
            console.log(`✅ Expired ${result.rowCount} active sessions`);
            return result.rowCount;
        } catch (error) {
            console.error('❌ Error expiring all active sessions:', error);
            throw error;
        }
    }

    /**
     * Get all unique phone numbers from scheduled_messages (for clearing bot memory)
     */
    async getAllPhoneNumbers() {
        try {
            const result = await this.pool.query(
                `SELECT DISTINCT phone_number FROM scheduled_messages WHERE status = 'pending'`
            );
            return result.rows.map(row => row.phone_number);
        } catch (error) {
            console.error('❌ Error getting all phone numbers:', error);
            return [];
        }
    }

    /**
     * Generate short random ID for calendar events (6 characters)
     */
    generateShortId() {
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        for (let i = 0; i < 6; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    /**
     * Create calendar event and return short ID
     */
    async createCalendarEvent(eventName, startTime, endTime, description, location) {
        try {
            // Generate unique short ID (retry if collision)
            let id;
            let attempts = 0;
            while (attempts < 5) {
                id = this.generateShortId();
                const existing = await this.pool.query(
                    'SELECT id FROM calendar_events WHERE id = $1',
                    [id]
                );
                if (existing.rows.length === 0) break;
                attempts++;
            }

            if (attempts === 5) {
                throw new Error('Failed to generate unique calendar event ID');
            }

            // Events expire after 30 days
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + 30);

            await this.pool.query(
                `INSERT INTO calendar_events (id, event_name, start_time, end_time, description, location, expires_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [id, eventName, startTime, endTime, description, location, expiresAt]
            );

            return id;
        } catch (error) {
            console.error('❌ Error creating calendar event:', error);
            throw error;
        }
    }

    /**
     * Get calendar event by ID
     */
    async getCalendarEvent(id) {
        try {
            const result = await this.pool.query(
                'SELECT * FROM calendar_events WHERE id = $1 AND expires_at > NOW()',
                [id]
            );

            if (result.rows.length === 0) {
                return null;
            }

            return result.rows[0];
        } catch (error) {
            console.error('❌ Error getting calendar event:', error);
            throw error;
        }
    }

    /**
     * Close database connection
     */
    async close() {
        await this.pool.end();
    }
}

module.exports = new SessionManager();
