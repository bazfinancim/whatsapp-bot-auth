/**
 * Message Scheduler Service
 *
 * Handles scheduling and sending of WhatsApp messages through the Bull job queue.
 * CONSOLIDATED VERSION: Sends messages directly via Baileys socket instead of HTTP.
 *
 * Integrates with:
 * - Bull queue (messageQueue.js)
 * - Message templates (messageTemplates.js)
 * - Timezone helper (timezoneHelper.js)
 * - PostgreSQL database
 * - Baileys WhatsApp client (direct)
 */

const { messageQueue } = require('./messageQueue');
const { getMessage, MESSAGE_TYPES, validateVariables } = require('./messageTemplates');
const {
    getNowInIsrael,
    toIsraelTime,
    scheduleWithDelay,
    calculate19pmReminderTime,
    calculateVideoTestimonialTime,
    calculateNextAppointmentReminderTime,
    getNextValidBusinessTime,
    toISOString,
    toDate,
    getScheduleDescription
} = require('./timezoneHelper');
const { Pool } = require('pg');

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? {
        rejectUnauthorized: false
    } : false
});

// Baileys socket client (injected via setSockClient)
let sockClient = null;

/**
 * Set the Baileys socket client for direct message sending
 * @param {Object} sock - Baileys socket instance
 */
function setSockClient(sock) {
    sockClient = sock;
    console.log('✅ Baileys socket client set for message scheduler');
}

/**
 * Get the current socket client
 * @returns {Object|null} Baileys socket instance
 */
function getSockClient() {
    return sockClient;
}

/**
 * Convert phone number to WhatsApp chat ID format
 * @param {string} phoneNumber - Phone number (e.g., +972509969977 or 972509969977)
 * @returns {string} WhatsApp chat ID (e.g., 972509969977@s.whatsapp.net)
 */
function phoneToWhatsAppId(phoneNumber) {
    if (!phoneNumber) return null;

    // If already in chat ID format, return as-is
    if (phoneNumber.includes('@')) {
        return phoneNumber;
    }

    // Remove all non-digit characters except leading +
    const cleaned = phoneNumber.replace(/[^\d+]/g, '');

    // Remove leading + if present
    const numberOnly = cleaned.replace(/^\+/, '');

    // Return in WhatsApp format (number@s.whatsapp.net for Baileys)
    return `${numberOnly}@s.whatsapp.net`;
}

/**
 * Schedule a message to be sent at a specific time
 * @param {Object} params - Scheduling parameters
 * @param {string} params.sessionId - Session ID
 * @param {string} params.phoneNumber - Recipient phone number (for logging/reference)
 * @param {string} params.chatId - WhatsApp chat ID - optional, will be retrieved from session if not provided
 * @param {string} params.messageType - One of MESSAGE_TYPES
 * @param {Object} params.variables - Variables for message template (optional)
 * @param {DateTime} params.scheduledFor - When to send (Luxon DateTime)
 * @param {string} params.mediaUrl - Optional media URL for attachments
 * @returns {Promise<Object>} Scheduled message record
 */
async function scheduleMessage({
    sessionId,
    phoneNumber,
    chatId = null,
    messageType,
    variables = {},
    scheduledFor,
    mediaUrl = null
}) {
    try {
        // Validate variables if message requires them
        validateVariables(messageType, variables);

        // Generate message content
        const messageContent = getMessage(messageType, variables);

        // Convert scheduled time to JavaScript Date for Bull
        const scheduledDate = toDate(scheduledFor);

        // If chatId not provided, try to retrieve from session
        let effectiveChatId = chatId;
        if (!effectiveChatId && sessionId) {
            try {
                const sessionResult = await pool.query(
                    'SELECT chat_id FROM sessions WHERE session_id = $1',
                    [sessionId]
                );
                if (sessionResult.rows.length > 0) {
                    effectiveChatId = sessionResult.rows[0].chat_id;
                }
            } catch (err) {
                console.warn(`⚠️  Could not retrieve chat_id from session ${sessionId}:`, err.message);
            }
        }

        // Store in database first (including chat_id)
        const result = await pool.query(
            `INSERT INTO scheduled_messages
            (session_id, phone_number, chat_id, message_type, message_content, scheduled_for, status)
            VALUES ($1, $2, $3, $4, $5, $6, 'pending')
            RETURNING *`,
            [sessionId, phoneNumber, effectiveChatId, messageType, messageContent, toISOString(scheduledFor)]
        );

        const scheduledMessageRecord = result.rows[0];

        // Schedule job in Bull queue (include chatId)
        const job = await messageQueue.add(
            {
                scheduledMessageId: scheduledMessageRecord.id,
                sessionId,
                phoneNumber,
                chatId: effectiveChatId,
                messageType,
                messageContent,
                mediaUrl
            },
            {
                delay: scheduledDate.getTime() - Date.now(),
                jobId: `${messageType}_${sessionId}_${Date.now()}`
            }
        );

        // Update database with Bull job ID
        await pool.query(
            'UPDATE scheduled_messages SET job_id = $1 WHERE id = $2',
            [job.id.toString(), scheduledMessageRecord.id]
        );

        console.log(
            `📅 Scheduled ${messageType} for ${phoneNumber} ` +
            `(session: ${sessionId}) at ${scheduledFor.toLocaleString()} ` +
            `[${getScheduleDescription(scheduledFor)}]`
        );

        return {
            ...scheduledMessageRecord,
            job_id: job.id.toString()
        };

    } catch (error) {
        console.error(`❌ Error scheduling message:`, error);
        throw error;
    }
}

/**
 * Schedule Message #2: Chatbot Link (immediate - no delay)
 * @param {string} sessionId - Session ID
 * @param {string} phoneNumber - Phone number
 * @param {string} chatbotUrl - Chatbot URL
 * @returns {Promise<Object>} Scheduled message
 */
async function scheduleChatbotLink(sessionId, phoneNumber, chatbotUrl) {
    const now = getNowInIsrael();
    const scheduledFor = scheduleWithDelay(now, 0); // Immediate - no delay

    return scheduleMessage({
        sessionId,
        phoneNumber,
        messageType: MESSAGE_TYPES.CHATBOT_LINK,
        variables: { chatbotUrl },
        scheduledFor
    });
}

/**
 * Schedule Message #3: 19:00 Form Reminder (Sent ONCE)
 * Sends once at 19:00 Israel time if form not completed
 * Does not repeat to avoid appearing robotic
 * @param {string} sessionId - Session ID
 * @param {string} phoneNumber - Phone number
 * @param {string} chatbotUrl - Chatbot URL
 * @param {DateTime} firstMessageTime - When first message was sent
 * @returns {Promise<Object>} Scheduled message
 */
async function schedule19pmReminder(sessionId, phoneNumber, chatbotUrl, firstMessageTime) {
    const scheduledFor = calculate19pmReminderTime(firstMessageTime);

    // Only schedule if time is valid (weekday, business hours)
    const validScheduledFor = getNextValidBusinessTime(scheduledFor);

    return scheduleMessage({
        sessionId,
        phoneNumber,
        messageType: MESSAGE_TYPES.FORM_REMINDER_19PM,
        variables: { chatbotUrl },
        scheduledFor: validScheduledFor
    });
}

/**
 * Schedule Message #4: Video Testimonial (Sent ONCE at 20:00)
 * Sends once at 20:00 (8 PM) Israel time if form not completed
 * Does not repeat to avoid appearing robotic
 * @param {string} sessionId - Session ID
 * @param {string} phoneNumber - Phone number
 * @param {DateTime} firstMessageTime - When first message was sent
 * @param {string} videoUrl - URL to testimonial video
 * @returns {Promise<Object>} Scheduled message
 */
async function scheduleVideoTestimonial(sessionId, phoneNumber, firstMessageTime, videoUrl) {
    const scheduledFor = calculateVideoTestimonialTime(firstMessageTime);

    // Only schedule if time is valid (weekday, business hours)
    const validScheduledFor = getNextValidBusinessTime(scheduledFor);

    return scheduleMessage({
        sessionId,
        phoneNumber,
        messageType: MESSAGE_TYPES.VIDEO_TESTIMONIAL,
        scheduledFor: validScheduledFor,
        mediaUrl: videoUrl
    });
}

/**
 * Schedule appointment reminders (Messages #7-10)
 * Each reminder sends ONCE in sequence (does not repeat)
 * All reminders send at 19:00 (7 PM) on subsequent business days
 * @param {string} sessionId - Session ID
 * @param {string} phoneNumber - Phone number
 * @param {DateTime} appointmentLinkSentTime - When appointment link was sent
 * @returns {Promise<Object[]>} Array of scheduled messages
 */
async function scheduleAppointmentReminders(sessionId, phoneNumber, appointmentLinkSentTime) {
    const scheduledMessages = [];

    // Message #7: First reminder (sent ONCE at 19:00 next business day)
    const reminder1Time = calculateNextAppointmentReminderTime(appointmentLinkSentTime);

    const reminder1 = await scheduleMessage({
        sessionId,
        phoneNumber,
        messageType: MESSAGE_TYPES.APPOINTMENT_REMINDER_1,
        scheduledFor: reminder1Time
    });
    scheduledMessages.push(reminder1);

    // Message #8: Second reminder (sent ONCE, next available slot after first)
    const reminder2Time = calculateNextAppointmentReminderTime(reminder1Time);
    const reminder2 = await scheduleMessage({
        sessionId,
        phoneNumber,
        messageType: MESSAGE_TYPES.APPOINTMENT_REMINDER_2,
        scheduledFor: reminder2Time
    });
    scheduledMessages.push(reminder2);

    // Message #9: Third reminder (sent ONCE, next available slot)
    const reminder3Time = calculateNextAppointmentReminderTime(reminder2Time);
    const reminder3 = await scheduleMessage({
        sessionId,
        phoneNumber,
        messageType: MESSAGE_TYPES.APPOINTMENT_REMINDER_3,
        scheduledFor: reminder3Time
    });
    scheduledMessages.push(reminder3);

    // Message #10: Fourth reminder (sent ONCE, final reminder)
    const reminder4Time = calculateNextAppointmentReminderTime(reminder3Time);
    const reminder4 = await scheduleMessage({
        sessionId,
        phoneNumber,
        messageType: MESSAGE_TYPES.APPOINTMENT_REMINDER_4,
        scheduledFor: reminder4Time
    });
    scheduledMessages.push(reminder4);

    return scheduledMessages;
}

/**
 * Cancel a scheduled message
 * @param {number} scheduledMessageId - ID of scheduled message
 * @returns {Promise<boolean>} True if cancelled successfully
 */
async function cancelScheduledMessage(scheduledMessageId) {
    try {
        // Get the job ID from database
        const result = await pool.query(
            'SELECT job_id, status FROM scheduled_messages WHERE id = $1',
            [scheduledMessageId]
        );

        if (result.rows.length === 0) {
            console.warn(`⚠️  Scheduled message ${scheduledMessageId} not found`);
            return false;
        }

        const { job_id, status } = result.rows[0];

        // Can't cancel if already sent or failed
        if (status !== 'pending') {
            console.warn(`⚠️  Cannot cancel message with status: ${status}`);
            return false;
        }

        // Remove job from Bull queue
        const job = await messageQueue.getJob(job_id);
        if (job) {
            await job.remove();
        }

        // Update database status
        await pool.query(
            'UPDATE scheduled_messages SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            ['cancelled', scheduledMessageId]
        );

        console.log(`✅ Cancelled scheduled message ${scheduledMessageId}`);
        return true;

    } catch (error) {
        console.error(`❌ Error cancelling scheduled message:`, error);
        return false;
    }
}

/**
 * Cancel all pending messages for a session (used when user completes form or schedules appointment)
 * @param {string} sessionId - Session ID
 * @param {string} messageTypePattern - Cancel messages matching this type pattern (e.g., 'form_reminder%' or 'appointment_reminder%')
 * @returns {Promise<number>} Number of messages cancelled
 */
async function cancelSessionMessages(sessionId, messageTypePattern = '%') {
    try {
        // Get all pending messages for this session matching the pattern
        const result = await pool.query(
            `SELECT id, job_id
             FROM scheduled_messages
             WHERE session_id = $1
               AND status = 'pending'
               AND message_type LIKE $2`,
            [sessionId, messageTypePattern]
        );

        let cancelledCount = 0;

        for (const row of result.rows) {
            const cancelled = await cancelScheduledMessage(row.id);
            if (cancelled) cancelledCount++;
        }

        console.log(`✅ Cancelled ${cancelledCount} messages for session ${sessionId} (pattern: ${messageTypePattern})`);
        return cancelledCount;

    } catch (error) {
        console.error(`❌ Error cancelling session messages:`, error);
        return 0;
    }
}

/**
 * Cancel ALL pending messages (including orphaned ones from old/expired sessions)
 * @returns {Promise<number>} Number of messages cancelled
 */
async function cancelAllPendingMessages() {
    try {
        // Get all pending messages
        const result = await pool.query(
            `SELECT id, job_id FROM scheduled_messages WHERE status = 'pending'`
        );

        let cancelledCount = 0;

        for (const row of result.rows) {
            const cancelled = await cancelScheduledMessage(row.id);
            if (cancelled) cancelledCount++;
        }

        console.log(`✅ Cancelled ${cancelledCount} pending messages (all sessions)`);
        return cancelledCount;

    } catch (error) {
        console.error(`❌ Error cancelling all pending messages:`, error);
        return 0;
    }
}

/**
 * Send a WhatsApp message directly via Baileys socket
 * CONSOLIDATED VERSION: No HTTP calls, direct Baileys integration
 * @param {string} phoneNumber - Recipient phone number (for logging/reference)
 * @param {string} message - Message text
 * @param {string} mediaUrl - Optional media URL
 * @param {string} chatId - WhatsApp chat ID - if not provided, will convert phoneNumber
 * @returns {Promise<Object>} Send result
 */
async function sendWhatsAppMessage(phoneNumber, message, mediaUrl = null, chatId = null) {
    const startTime = Date.now();
    try {
        if (!sockClient) {
            throw new Error('Baileys socket not initialized - call setSockClient first');
        }

        console.log(`⏱️  [TIMING] sendWhatsAppMessage START for ${phoneNumber}`);

        // Use chatId if provided, otherwise convert phoneNumber to WhatsApp format
        const whatsappId = chatId || phoneToWhatsAppId(phoneNumber);
        console.log(`📤 Sending WhatsApp message to ${whatsappId} (original: ${phoneNumber})${mediaUrl ? ' (with media)' : ''}`);

        let result;

        if (mediaUrl) {
            // Send media with caption
            // Detect media type from URL
            const isVideo = mediaUrl.includes('video') || mediaUrl.endsWith('.mp4') || mediaUrl.endsWith('.mov');

            if (isVideo) {
                result = await sockClient.sendMessage(whatsappId, {
                    video: { url: mediaUrl },
                    caption: message
                });
            } else {
                result = await sockClient.sendMessage(whatsappId, {
                    image: { url: mediaUrl },
                    caption: message
                });
            }
        } else {
            // Send text message
            result = await sockClient.sendMessage(whatsappId, { text: message });
        }

        const totalDuration = Date.now() - startTime;
        console.log(`✅ Message sent successfully to ${whatsappId}`);
        console.log(`⏱️  [TIMING] TOTAL sendWhatsAppMessage took ${totalDuration}ms`);

        return { success: true, messageId: result?.key?.id };

    } catch (error) {
        const totalDuration = Date.now() - startTime;
        console.error(`❌ Error sending WhatsApp message to ${phoneNumber} after ${totalDuration}ms:`, error.message);
        throw error;
    }
}

/**
 * Process a scheduled message job (called by Bull worker)
 * @param {Object} job - Bull job object
 * @returns {Promise<Object>} Job result
 */
async function processScheduledMessage(job) {
    const {
        scheduledMessageId,
        sessionId,
        phoneNumber,
        chatId,
        messageType,
        messageContent,
        mediaUrl
    } = job.data;

    console.log(`🏃 Processing job ${job.id}: ${messageType} for session ${sessionId}`);

    try {
        // Check if message should still be sent and retrieve chatId if not in job data
        const result = await pool.query(
            'SELECT status, chat_id FROM scheduled_messages WHERE id = $1',
            [scheduledMessageId]
        );

        if (result.rows.length === 0) {
            throw new Error(`Scheduled message ${scheduledMessageId} not found in database`);
        }

        const { status, chat_id } = result.rows[0];

        // Don't send if cancelled
        if (status === 'cancelled') {
            console.log(`⏭️  Skipping cancelled message ${scheduledMessageId}`);
            return { skipped: true, reason: 'cancelled' };
        }

        // Verify session status before sending (safety net)
        const sessionResult = await pool.query(
            'SELECT status FROM sessions WHERE session_id = $1',
            [sessionId]
        );
        const sessionStatus = sessionResult.rows[0]?.status;

        // For appointment reminders - require completed session (form was filled)
        if (messageType.startsWith('appointment_reminder')) {
            if (sessionStatus !== 'completed') {
                console.log(`⏭️  Skipping ${messageType} - session not completed (status: ${sessionStatus})`);
                await pool.query(
                    `UPDATE scheduled_messages SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                    [scheduledMessageId]
                );
                return { skipped: true, reason: 'session_not_completed' };
            }
        }

        // For form reminders - require active session (form not yet completed)
        if (messageType === 'form_reminder_19pm' || messageType === 'video_testimonial') {
            if (sessionStatus !== 'active') {
                console.log(`⏭️  Skipping ${messageType} - session not active (status: ${sessionStatus})`);
                await pool.query(
                    `UPDATE scheduled_messages SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                    [scheduledMessageId]
                );
                return { skipped: true, reason: 'session_not_active' };
            }
        }

        // Use chatId from job data, or from database, or convert phone number
        const effectiveChatId = chatId || chat_id;

        // Send the message directly via Baileys
        await sendWhatsAppMessage(phoneNumber, messageContent, mediaUrl, effectiveChatId);

        // Update database status
        await pool.query(
            `UPDATE scheduled_messages
             SET status = 'sent',
                 sent_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [scheduledMessageId]
        );

        console.log(`✅ Successfully sent ${messageType} to ${phoneNumber}`);

        return {
            success: true,
            scheduledMessageId,
            messageType,
            sentAt: new Date().toISOString()
        };

    } catch (error) {
        console.error(`❌ Error processing scheduled message ${scheduledMessageId}:`, error);

        // Update database with error
        await pool.query(
            `UPDATE scheduled_messages
             SET status = 'failed',
                 error_message = $1,
                 retry_count = retry_count + 1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [error.message, scheduledMessageId]
        );

        throw error; // Re-throw so Bull can handle retry
    }
}

/**
 * Initialize the message queue worker
 * This should be called once when the server starts
 */
function initializeWorker() {
    messageQueue.process(async (job) => {
        return await processScheduledMessage(job);
    });

    console.log('✅ Message queue worker initialized');
}

/**
 * Get queue statistics for monitoring
 * @returns {Promise<Object>} Queue statistics
 */
async function getQueueStats() {
    try {
        const [waiting, active, completed, failed, delayed] = await Promise.all([
            messageQueue.getWaitingCount(),
            messageQueue.getActiveCount(),
            messageQueue.getCompletedCount(),
            messageQueue.getFailedCount(),
            messageQueue.getDelayedCount()
        ]);

        // Get database stats
        const dbStats = await pool.query(`
            SELECT status, COUNT(*) as count
            FROM scheduled_messages
            GROUP BY status
        `);

        const dbStatusCounts = {};
        for (const row of dbStats.rows) {
            dbStatusCounts[row.status] = parseInt(row.count);
        }

        return {
            queue: {
                waiting,
                active,
                completed,
                failed,
                delayed
            },
            database: dbStatusCounts,
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        console.error('❌ Error getting queue stats:', error);
        return null;
    }
}

module.exports = {
    // Socket client management
    setSockClient,
    getSockClient,

    // Scheduling functions
    scheduleMessage,
    scheduleChatbotLink,
    schedule19pmReminder,
    scheduleVideoTestimonial,
    scheduleAppointmentReminders,

    // Cancellation functions
    cancelScheduledMessage,
    cancelSessionMessages,
    cancelAllPendingMessages,

    // Sending functions
    sendWhatsAppMessage,
    phoneToWhatsAppId,

    // Worker functions
    initializeWorker,
    processScheduledMessage,

    // Monitoring functions
    getQueueStats
};
