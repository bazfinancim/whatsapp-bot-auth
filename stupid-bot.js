/**
 * Stupid Bot - Simple WhatsApp Bot with Predefined Messages
 *
 * This bot responds to trigger keywords with predefined messages
 * and tracks users awaiting form completion.
 */

// Configuration
const BOT_CONFIG = {
    // Trigger keywords (case-insensitive)
    triggerKeywords: (process.env.BOT_TRIGGER_KEYWORDS || 'start,reset,register,התחל,רישום,התחילו,אשמח לשמוע על ליווי לפרישה').split(',').map(k => k.trim().toLowerCase()),

    // Form URL to send to users
    formUrl: process.env.BOT_FORM_URL || 'https://baz-f.co.il/chatbot',

    // Video testimonial URL
    testimonialVideoUrl: process.env.BOT_TESTIMONIAL_VIDEO_URL || 'https://res.cloudinary.com/dp3upl52j/video/upload/v1763899797/testimonial_video_vdy3yt.mp4',

    // Messages (support Hebrew and English)
    messages: {
        // Message #1: Introduction (immediate)
        introduction: process.env.BOT_INTRODUCTION_MESSAGE ||
            'תודה שפנית, נעים מאוד אבי ישי! 😊\n\nככלכן בעל תואר B.A במנהל עסקים ובעל רישיון פנסיוני, מעל 20 שנה בתחום ובעלים של בז פיננסים חברה שמעניקה פתרונות במגוון תחומים:\n\n✅ ליווי ייעוץ עסקי ובנייית מודלים כלכליים\n✅ ניתוח תיק פנסיוני\n✅ תכנון פיננסי מקיף\n✅ ייעוץ ותכנון פרישה\n✅ ניהול השקעות\n✅ פתרונות ביטוח\n✅ ייעוץ משכנתאות ופתרונות אשראי נוספים',

        // Message #2: Chatbot link (2 seconds after introduction)
        chatbotLink: process.env.BOT_CHATBOT_LINK_MESSAGE ||
            '📝 הכנתי לכם 10 שאלות קצרות כדי שאוכל לתפוף את עולמכם הפיננסי בהתאמה אישית\n\nכנסו ללינק:\n👇🏻👇🏻👇🏻👇🏻👇🏻👇🏻\n\n{chatbotUrl}\n\n💥הקישור תקף ל-24 שעות💥',

        // Message #4: Video testimonial caption
        videoCaption: process.env.BOT_VIDEO_CAPTION ||
            'משתף אותכם בחוויה שעברו משפחת יוסף\nד"ר חזי מנכ"ל כפר הנוער כנות ורעייתו מיכל',

        // Message #5: Follow-up after video
        videoFollowup: process.env.BOT_VIDEO_FOLLOWUP_MESSAGE ||
            'היי\', עדיין ממתינים למילוי השאלון. הינה שוב הלינק לשאלון:\n\n👇🏻👇🏻👇🏻👇🏻👇🏻👇🏻\n\n{chatbotUrl}',

        success: process.env.BOT_SUCCESS_MESSAGE ||
            '✅ מעולה!\n\nהטופס התקבל בהצלחה.\n\nנחזור אליכם בהקדם.\n\nתודה! 🎉',

        alreadyRegistered: process.env.BOT_ALREADY_REGISTERED_MESSAGE ||
            'הטופס כבר התקבל! ✅\n\nאנחנו כבר מטפלים בפרטים שלכם.\n\nתודה על הסבלנות.'
    }
};

// In-memory storage for users awaiting form completion
// Format: { phoneNumber: { timestamp: Date, reminderSent: boolean } }
const pendingUsers = new Map();

// Session-based tracking: sessionId -> { chatId, phoneNumber, timestamp }
// This maps unique session IDs to the original WhatsApp sender
const sessionMap = new Map();

/**
 * Check if a message contains any trigger keywords
 */
function isTriggerMessage(messageText) {
    if (!messageText || typeof messageText !== 'string') {
        return false;
    }

    const lowerText = messageText.trim().toLowerCase();
    return BOT_CONFIG.triggerKeywords.some(keyword => lowerText.includes(keyword));
}

/**
 * Extract phone number from WhatsApp chat ID
 * Format: "972123456789@c.us" -> "972123456789"
 */
function extractPhoneNumber(chatId) {
    if (!chatId) return null;

    // Remove @c.us, @s.whatsapp.net, etc.
    return chatId.split('@')[0];
}

/**
 * Format phone number to match webhook format
 * Handles different formats (with/without country code, with/without plus sign)
 */
function formatPhoneNumber(phoneNumber) {
    if (!phoneNumber) return null;

    // Remove all non-digit characters
    const digitsOnly = phoneNumber.replace(/\D/g, '');

    // Return as-is (webhook should send the same format)
    return digitsOnly;
}

/**
 * Generate unique session ID
 */
function generateSessionId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 11);
    return `${timestamp}-${random}`;
}

/**
 * Database functions for persistent session storage
 */

// Get session expiry hours from env (default: 24 hours)
const SESSION_EXPIRY_HOURS = parseInt(process.env.BOT_SESSION_EXPIRY_HOURS) || 24;

/**
 * Save session to database
 */
async function saveSession(sessionId, chatId, phoneNumber, dbPool) {
    if (!dbPool) {
        // Fallback to in-memory if no database
        sessionMap.set(sessionId, { chatId, phoneNumber, timestamp: new Date() });
        return true;
    }

    try {
        await dbPool.query(
            `INSERT INTO sessions (session_id, chat_id, phone_number, created_at, expires_at, status)
             VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '${SESSION_EXPIRY_HOURS} hours', 'active')
             ON CONFLICT (session_id) DO UPDATE
             SET chat_id = $2, phone_number = $3, expires_at = NOW() + INTERVAL '${SESSION_EXPIRY_HOURS} hours'`,
            [sessionId, chatId, phoneNumber]
        );
        return true;
    } catch (error) {
        console.error('Error saving session to database:', error);
        // Fallback to in-memory
        sessionMap.set(sessionId, { chatId, phoneNumber, timestamp: new Date() });
        return false;
    }
}

/**
 * Get session from database
 */
async function getSession(sessionId, dbPool) {
    if (!dbPool) {
        // Fallback to in-memory
        return sessionMap.get(sessionId) || null;
    }

    try {
        const result = await dbPool.query(
            `SELECT session_id, chat_id, phone_number, created_at
             FROM sessions
             WHERE session_id = $1 AND expires_at > NOW()`,
            [sessionId]
        );

        if (result.rows.length === 0) {
            // Try in-memory fallback
            return sessionMap.get(sessionId) || null;
        }

        return {
            chatId: result.rows[0].chat_id,
            phoneNumber: result.rows[0].phone_number,
            timestamp: result.rows[0].created_at
        };
    } catch (error) {
        console.error('Error getting session from database:', error);
        // Fallback to in-memory
        return sessionMap.get(sessionId) || null;
    }
}

/**
 * Delete session from database
 */
async function deleteSession(sessionId, dbPool) {
    if (!dbPool) {
        // Fallback to in-memory
        sessionMap.delete(sessionId);
        return true;
    }

    try {
        await dbPool.query('DELETE FROM sessions WHERE session_id = $1', [sessionId]);
        // Also delete from in-memory cache
        sessionMap.delete(sessionId);
        return true;
    } catch (error) {
        console.error('Error deleting session from database:', error);
        sessionMap.delete(sessionId);
        return false;
    }
}

/**
 * Mark session as completed (for reminder system)
 * Sets form_completed_at and appointment_sent_at timestamps
 */
async function markSessionCompleted(sessionId, formData, dbPool) {
    if (!dbPool) {
        // Fallback to in-memory - just delete
        sessionMap.delete(sessionId);
        return true;
    }

    try {
        await dbPool.query(
            `UPDATE sessions
             SET status = 'completed',
                 completed_at = CURRENT_TIMESTAMP,
                 form_completed_at = CURRENT_TIMESTAMP,
                 appointment_sent_at = CURRENT_TIMESTAMP,
                 form_data = $2
             WHERE session_id = $1`,
            [sessionId, JSON.stringify(formData)]
        );

        // Remove from in-memory cache
        sessionMap.delete(sessionId);
        return true;
    } catch (error) {
        console.error('Error marking session as completed:', error);
        sessionMap.delete(sessionId);
        return false;
    }
}

/**
 * Check if user has pending session
 */
async function checkPendingUser(phoneNumber, dbPool) {
    if (!dbPool) {
        // Fallback to in-memory
        return pendingUsers.has(phoneNumber);
    }

    try {
        const result = await dbPool.query(
            `SELECT COUNT(*) as count FROM sessions
             WHERE phone_number = $1 AND expires_at > NOW() AND status = 'active'`,
            [phoneNumber]
        );
        return result.rows[0].count > 0 || pendingUsers.has(phoneNumber);
    } catch (error) {
        console.error('Error checking pending user:', error);
        return pendingUsers.has(phoneNumber);
    }
}

/**
 * Get pending user data
 */
async function getPendingUserData(phoneNumber, dbPool) {
    if (!dbPool) {
        // Fallback to in-memory
        return pendingUsers.get(phoneNumber) || null;
    }

    try {
        const result = await dbPool.query(
            `SELECT session_id, chat_id, created_at FROM sessions
             WHERE phone_number = $1 AND expires_at > NOW() AND status = 'active'
             ORDER BY created_at DESC LIMIT 1`,
            [phoneNumber]
        );

        if (result.rows.length === 0) {
            return pendingUsers.get(phoneNumber) || null;
        }

        return {
            sessionId: result.rows[0].session_id,
            chatId: result.rows[0].chat_id,
            timestamp: result.rows[0].created_at,
            reminderSent: false
        };
    } catch (error) {
        console.error('Error getting pending user data:', error);
        return pendingUsers.get(phoneNumber) || null;
    }
}

/**
 * Get count of active sessions
 */
async function getActiveSessionsCount(dbPool) {
    if (!dbPool) {
        return sessionMap.size;
    }

    try {
        const result = await dbPool.query(
            "SELECT COUNT(*) as count FROM sessions WHERE expires_at > NOW() AND status = 'active'"
        );
        return parseInt(result.rows[0].count) + sessionMap.size;
    } catch (error) {
        console.error('Error getting active sessions count:', error);
        return sessionMap.size;
    }
}

/**
 * Get all pending users
 */
async function getAllPendingUsers(dbPool) {
    if (!dbPool) {
        return Array.from(pendingUsers.entries()).map(([phone, data]) => ({
            phone,
            sessionId: data.sessionId,
            waitingSince: data.timestamp,
            reminderSent: data.reminderSent
        }));
    }

    try {
        const result = await dbPool.query(
            `SELECT phone_number, session_id, created_at
             FROM sessions
             WHERE expires_at > NOW() AND status = 'active'
             ORDER BY created_at DESC`
        );

        return result.rows.map(row => ({
            phone: row.phone_number,
            sessionId: row.session_id,
            waitingSince: row.created_at,
            reminderSent: false
        }));
    } catch (error) {
        console.error('Error getting all pending users:', error);
        return Array.from(pendingUsers.entries()).map(([phone, data]) => ({
            phone,
            sessionId: data.sessionId,
            waitingSince: data.timestamp,
            reminderSent: data.reminderSent
        }));
    }
}

/**
 * Cleanup expired sessions (older than SESSION_EXPIRY_HOURS)
 */
async function cleanupExpiredSessions(dbPool) {
    if (!dbPool) {
        // Clean up in-memory sessions older than expiry time
        const expiryTime = Date.now() - (SESSION_EXPIRY_HOURS * 60 * 60 * 1000);
        for (const [sessionId, data] of sessionMap.entries()) {
            if (data.timestamp.getTime() < expiryTime) {
                sessionMap.delete(sessionId);
            }
        }
        for (const [phone, data] of pendingUsers.entries()) {
            if (data.timestamp.getTime() < expiryTime) {
                pendingUsers.delete(phone);
            }
        }
        return { deleted: 0 };
    }

    try {
        const result = await dbPool.query("UPDATE sessions SET status = 'expired' WHERE expires_at < NOW() AND status = 'active'");
        return { deleted: result.rowCount };
    } catch (error) {
        console.error('Error cleaning up expired sessions:', error);
        return { deleted: 0, error: error.message };
    }
}

/**
 * Handle trigger message - send greeting and form link
 * Now integrates with avi-website API for session management
 */
async function handleTriggerMessage(client, chatId, logger, dbPool = null) {
    try {
        const phoneNumber = extractPhoneNumber(chatId);

        // Check if user is already pending (database + in-memory)
        const isPending = await checkPendingUser(phoneNumber, dbPool);
        if (isPending) {
            const userData = await getPendingUserData(phoneNumber, dbPool);
            logger.info(`🤖 [STUPID-BOT] User ${phoneNumber} already pending (since ${userData.timestamp})`);

            // Send "already registered" message
            await client.sendMessage(chatId, { text: BOT_CONFIG.messages.alreadyRegistered });
            logger.info(`🤖 [STUPID-BOT] Sent "already registered" message to ${phoneNumber}`);
            return;
        }

        // Generate session ID and construct chatbot URL locally
        const sessionId = `${phoneNumber}-${Date.now()}`;
        const chatbotUrl = `${BOT_CONFIG.formUrl}?session=${sessionId}`;
        logger.info(`🤖 [STUPID-BOT] Generated session ${sessionId} for ${phoneNumber}`);

        // Save session to local database for lookup when form completion webhook comes
        await saveSession(sessionId, chatId, phoneNumber, dbPool);

        // Message #1: Send introduction (immediate)
        await client.sendMessage(chatId, { text: BOT_CONFIG.messages.introduction });
        logger.info(`🤖 [STUPID-BOT] Sent introduction message to ${phoneNumber}`);

        // Also keep in memory for fast access (cache)
        pendingUsers.set(phoneNumber, {
            timestamp: new Date(),
            chatId: chatId,
            sessionId: sessionId,
            reminderSent: false
        });

        const totalSessions = await getActiveSessionsCount(dbPool);
        logger.info(`🤖 [STUPID-BOT] Session ${sessionId} saved to database (${totalSessions} active sessions)`);

        // Message #2: Send chatbot link after 2 seconds
        setTimeout(async () => {
            try {
                const chatbotLinkMessage = BOT_CONFIG.messages.chatbotLink.replace('{chatbotUrl}', chatbotUrl);
                await client.sendMessage(chatId, { text: chatbotLinkMessage });
                logger.info(`🤖 [STUPID-BOT] Sent chatbot link to ${phoneNumber} (2 seconds after introduction)`);
            } catch (error) {
                logger.error(`🤖 [STUPID-BOT] Error sending chatbot link:`, error);
            }
        }, 2000); // 2 seconds
    } catch (error) {
        logger.error('🤖 [STUPID-BOT] Error handling trigger message:', error);

        // Send error message to user
        try {
            await client.sendMessage(chatId, { text: 'מצטער/ת, משהו השתבש. אנא נסה/י שוב מאוחר יותר.' });
        } catch (sendError) {
            logger.error('🤖 [STUPID-BOT] Error sending error message:', sendError);
        }
    }
}

/**
 * Format form data into a Q&A summary message
 * Returns a nicely formatted Hebrew message with all the user's answers
 */
function formatFormSummary(formData = {}, name = 'User', leadId = '') {
    // Build the message parts
    const parts = ['✅ תודה רבה על מילוי הטופס!\n'];
    parts.push('📋 סיכום הפרטים שלך:\n');

    // Name
    if (name && name !== 'User') {
        parts.push(`👤 שם: ${name}`);
    }

    // Age group
    if (formData.age) {
        parts.push(`🎂 קבוצת גיל: ${formData.age}`);
    }

    // Financial goal
    if (formData.goal) {
        parts.push(`🎯 מטרה פיננסית: ${formData.goal}`);
    }

    // Marital status
    if (formData.status) {
        parts.push(`💍 מצב משפחתי: ${formData.status}`);
    }

    // Employment status
    if (formData.employment) {
        parts.push(`💼 סטטוס תעסוקה: ${formData.employment}`);
    }

    // Pension contributions
    if (formData.pension) {
        parts.push(`🏦 הפרשות פנסיוניות: ${formData.pension}`);
    }

    // Gross salary
    if (formData.salary) {
        parts.push(`💰 שכר ברוטו חודשי: ₪${formData.salary}`);
    }

    // Pension capital
    if (formData.pensionAmount) {
        parts.push(`💼 הון פנסיוני: ${formData.pensionAmount}`);
    }

    // Savings and investments
    if (formData.savings) {
        parts.push(`💵 חסכונות והשקעות: ${formData.savings}`);
    }

    // Investment location
    if (formData.investments) {
        parts.push(`📊 מיקום השקעות: ${formData.investments}`);
    }

    // Return knowledge and actual return
    if (formData.knowsReturn === 'כן' && formData.return) {
        parts.push(`📈 תשואה שנתית: ${formData.return}%`);
    } else if (formData.knowsReturn === 'לא' && formData.investmentType) {
        parts.push(`📈 סוג השקעה: ${formData.investmentType}`);
    }

    // Mortgage status
    if (formData.mortgage) {
        parts.push(`🏠 משכנתא: ${formData.mortgage}`);
    }

    // Add lead ID if provided
    if (leadId) {
        parts.push(`\n🔖 מספר ליד: ${leadId}`);
    }

    // Appointment link
    parts.push('\n📅 תרצו לקבוע פגישה? כנסו ללינק:');
    parts.push('https://www.baz-f.co.il/appointment.html');

    // Closing message
    parts.push('\n✨ נחזור אליך בהקדם האפשרי!\nתודה על האמון 🎉');

    return parts.join('\n');
}

/**
 * Handle form completion webhook - send success message
 * Uses session ID to ensure message goes to original WhatsApp sender
 * Now uses PostgreSQL for persistent session storage
 */
async function handleFormCompletion(client, webhookData, logger, dbPool = null) {
    try {
        const sessionId = webhookData.session_id || webhookData.sessionId || webhookData.session;

        let chatId, phoneNumber;

        if (sessionId) {
            // SESSION-BASED: Look up original WhatsApp sender by session ID (database + in-memory)
            const session = await getSession(sessionId, dbPool);

            if (!session) {
                logger.error(`🤖 [STUPID-BOT] Invalid or expired session ID: ${sessionId}`);
                return { success: false, error: 'Invalid or expired session ID' };
            }

            chatId = session.chatId;
            phoneNumber = session.phoneNumber;

            logger.info(`🤖 [STUPID-BOT] Session ${sessionId} matched to original sender: ${phoneNumber}`);
        } else {
            // FALLBACK (LEGACY): Use phone number from form (less secure)
            const formPhone = webhookData.phone || webhookData.phoneNumber || webhookData.tel || webhookData.mobile;

            if (!formPhone) {
                logger.error('🤖 [STUPID-BOT] Webhook missing both session_id and phone number:', webhookData);
                return { success: false, error: 'Missing session_id or phone number in webhook data' };
            }

            phoneNumber = formatPhoneNumber(formPhone);
            chatId = `${phoneNumber}@c.us`;

            logger.warn(`🤖 [STUPID-BOT] No session ID provided, using phone from form (less secure): ${phoneNumber}`);
        }

        // Check if user is in pending list
        const isPending = await checkPendingUser(phoneNumber, dbPool);
        if (!isPending) {
            logger.info(`🤖 [STUPID-BOT] Form completed by ${phoneNumber}, but not in pending list (may have completed earlier)`);
            // Still send success message even if not in pending list
        }

        // Format and send Q&A summary message to ORIGINAL WhatsApp sender
        const summaryMessage = formatFormSummary(
            webhookData.formData || {},
            webhookData.name || 'User',
            webhookData.lead_id || ''
        );
        await client.sendMessage(chatId, { text: summaryMessage });

        logger.info(`🤖 [STUPID-BOT] Sent Q&A summary to ${phoneNumber}`);

        // Mark session as completed (instead of deleting) to enable appointment reminders
        if (sessionId) {
            await markSessionCompleted(sessionId, webhookData.formData || {}, dbPool);
            logger.info(`🤖 [STUPID-BOT] Marked session ${sessionId} as completed - appointment reminders will now start`);
        }
        pendingUsers.delete(phoneNumber);

        const remainingSessions = await getActiveSessionsCount(dbPool);
        logger.info(`🤖 [STUPID-BOT] Session for ${phoneNumber} marked as completed (${remainingSessions} active sessions remaining)`);

        return { success: true, phoneNumber: phoneNumber, sessionId: sessionId };
    } catch (error) {
        logger.error('🤖 [STUPID-BOT] Error handling form completion:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Get bot status and statistics
 * Now uses database for accurate counts
 */
async function getBotStatus(dbPool = null) {
    const activeSessions = await getActiveSessionsCount(dbPool);
    const pendingUsersList = await getAllPendingUsers(dbPool);

    return {
        enabled: true,
        triggerKeywords: BOT_CONFIG.triggerKeywords,
        formUrl: BOT_CONFIG.formUrl,
        sessionTracking: true,
        sessionExpiry: `${SESSION_EXPIRY_HOURS} hours`,
        persistentStorage: !!dbPool,
        activeSessions: activeSessions,
        pendingUsers: pendingUsersList.length,
        pendingUsersList: pendingUsersList
    };
}

/**
 * Clear pending users and sessions (for testing/admin purposes)
 * Now also clears database
 */
/**
 * Clear a single pending user from memory
 */
function clearPendingUser(phoneNumber) {
    const wasPresent = pendingUsers.has(phoneNumber);
    pendingUsers.delete(phoneNumber);
    return wasPresent;
}

async function clearPendingUsers(dbPool = null) {
    const pendingCount = pendingUsers.size;
    const sessionCount = sessionMap.size;
    pendingUsers.clear();
    sessionMap.clear();

    // Also clear database
    if (dbPool) {
        try {
            const result = await dbPool.query("UPDATE sessions SET status = 'expired' WHERE status = 'active'");
            return {
                clearedMemory: pendingCount + sessionCount,
                clearedDatabase: result.rowCount,
                total: pendingCount + sessionCount + result.rowCount
            };
        } catch (error) {
            console.error('Error clearing database sessions:', error);
            return {
                clearedMemory: pendingCount + sessionCount,
                clearedDatabase: 0,
                error: error.message
            };
        }
    }

    return {
        clearedMemory: pendingCount + sessionCount,
        clearedDatabase: 0
    };
}

module.exports = {
    isTriggerMessage,
    handleTriggerMessage,
    handleFormCompletion,
    getBotStatus,
    clearPendingUser,      // Clear single pending user
    clearPendingUsers,
    cleanupExpiredSessions,  // New: for automatic cleanup
    extractPhoneNumber,
    formatPhoneNumber,
    saveSession  // Export for server.js to save sessions from avi-website API
};
