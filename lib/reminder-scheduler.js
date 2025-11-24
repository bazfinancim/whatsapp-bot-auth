// Reminder scheduler for stupidBot
// Checks database for users needing reminders and sends them

const { getReminderMessage, getMaxStage } = require('./reminder-messages');
const { isWithinOperatingHours, isWithinTimeWindow } = require('./operating-hours');

// Environment-based timing configuration
const IS_TEST_MODE = process.env.REMINDER_TEST_MODE === 'true';

// Timing rules (in minutes)
const REMINDER_TIMING = {
    form: IS_TEST_MODE ? [
        { stage: 1, delayMinutes: 1, windowStart: null, windowEnd: null },
        { stage: 2, delayMinutes: 2, windowStart: null, windowEnd: null },
        { stage: 3, delayMinutes: 3, windowStart: null, windowEnd: null }
    ] : [
        { stage: 1, delayMinutes: 60, windowStart: null, windowEnd: null },        // 1 hour
        { stage: 2, delayMinutes: 1440, windowStart: 9, windowEnd: 12 },           // 1 day, 09:00-12:00
        { stage: 3, delayMinutes: 2880, windowStart: 18, windowEnd: 20 }           // 2 days, 18:00-20:00
    ],
    appointment: IS_TEST_MODE ? [
        { stage: 1, delayMinutes: 1, windowStart: null, windowEnd: null },
        { stage: 2, delayMinutes: 2, windowStart: null, windowEnd: null },
        { stage: 3, delayMinutes: 3, windowStart: null, windowEnd: null },
        { stage: 4, delayMinutes: 4, windowStart: null, windowEnd: null }
    ] : [
        { stage: 1, delayMinutes: 60, windowStart: null, windowEnd: null },        // 1 hour
        { stage: 2, delayMinutes: 1440, windowStart: null, windowEnd: null },      // 1 day
        { stage: 3, delayMinutes: 2880, windowStart: null, windowEnd: null },      // 2 days
        { stage: 4, delayMinutes: 4320, windowStart: null, windowEnd: null }       // 3 days
    ]
};

let dbPool = null;
let whatsappClient = null;
let logger = null;

/**
 * Initialize the reminder scheduler
 * @param {Object} pool - PostgreSQL pool
 * @param {Object} client - WhatsApp client
 * @param {Object} log - Logger instance
 */
function initializeScheduler(pool, client, log) {
    dbPool = pool;
    whatsappClient = client;
    logger = log;

    logger.info(`🤖 [REMINDER-SCHEDULER] Initialized (Test mode: ${IS_TEST_MODE})`);
}

/**
 * Check if a reminder should be sent based on timing rules
 * @param {Date} sentAt - When the original message was sent
 * @param {Array} alreadySent - Array of already sent reminder stages
 * @param {string} type - 'form' or 'appointment'
 * @returns {number|null} Next reminder stage to send, or null if none
 */
function getNextReminderStage(sentAt, alreadySent, type) {
    if (!sentAt) return null;

    const now = new Date();
    const minutesSince = (now - sentAt) / (1000 * 60);
    const timingRules = REMINDER_TIMING[type];

    for (const rule of timingRules) {
        // Skip if already sent
        if (alreadySent.includes(rule.stage)) {
            continue;
        }

        // Check if enough time has passed
        if (minutesSince < rule.delayMinutes) {
            continue;
        }

        // Check if there's a time window requirement
        if (rule.windowStart !== null && rule.windowEnd !== null) {
            if (!isWithinTimeWindow(rule.windowStart, rule.windowEnd)) {
                continue; // Not in required window, skip for now
            }
        }

        // This is the next reminder to send
        return rule.stage;
    }

    return null;
}

/**
 * Check and send form reminders
 */
async function checkFormReminders() {
    if (!dbPool) {
        logger.warn('⚠️  [REMINDER-SCHEDULER] Database pool not initialized');
        return;
    }

    // In test mode, bypass operating hours check for testing purposes
    if (!IS_TEST_MODE && !isWithinOperatingHours()) {
        // logger.info('🚫 [REMINDER-SCHEDULER] Outside operating hours, skipping form reminders');
        return;
    }

    try {
        // Find users who need form reminders
        // Criteria: status = 'active', form_sent_at is not null, form_completed_at is null
        const query = `
            SELECT session_id, chat_id, phone_number, form_sent_at, reminders_sent
            FROM sessions
            WHERE status = 'active'
              AND form_sent_at IS NOT NULL
              AND form_completed_at IS NULL
              AND expires_at > NOW()
        `;

        const result = await dbPool.query(query);

        if (result.rows.length === 0) {
            // No users need reminders
            return;
        }

        logger.info(`🔍 [REMINDER-SCHEDULER] Checking ${result.rows.length} sessions for form reminders`);

        for (const session of result.rows) {
            const remindersSent = session.reminders_sent || { form: [], appointment: [] };
            const formRemindersSent = remindersSent.form || [];

            const nextStage = getNextReminderStage(
                new Date(session.form_sent_at),
                formRemindersSent,
                'form'
            );

            if (nextStage) {
                await sendFormReminder(session, nextStage);
            }
        }
    } catch (error) {
        logger.error('❌ [REMINDER-SCHEDULER] Error checking form reminders:', error);
    }
}

/**
 * Check and send appointment reminders
 */
async function checkAppointmentReminders() {
    if (!dbPool) {
        logger.warn('⚠️  [REMINDER-SCHEDULER] Database pool not initialized');
        return;
    }

    // In test mode, bypass operating hours check for testing purposes
    if (!IS_TEST_MODE && !isWithinOperatingHours()) {
        // logger.info('🚫 [REMINDER-SCHEDULER] Outside operating hours, skipping appointment reminders');
        return;
    }

    try {
        // Find users who need appointment reminders
        // Criteria: status = 'completed', appointment_sent_at is not null, appointment_scheduled_at is null
        const query = `
            SELECT session_id, chat_id, phone_number, appointment_sent_at, reminders_sent
            FROM sessions
            WHERE status = 'completed'
              AND appointment_sent_at IS NOT NULL
              AND appointment_scheduled_at IS NULL
              AND expires_at > NOW()
        `;

        const result = await dbPool.query(query);

        if (result.rows.length === 0) {
            // No users need reminders
            return;
        }

        logger.info(`🔍 [REMINDER-SCHEDULER] Checking ${result.rows.length} sessions for appointment reminders`);

        for (const session of result.rows) {
            const remindersSent = session.reminders_sent || { form: [], appointment: [] };
            const appointmentRemindersSent = remindersSent.appointment || [];

            const nextStage = getNextReminderStage(
                new Date(session.appointment_sent_at),
                appointmentRemindersSent,
                'appointment'
            );

            if (nextStage) {
                await sendAppointmentReminder(session, nextStage);
            }
        }
    } catch (error) {
        logger.error('❌ [REMINDER-SCHEDULER] Error checking appointment reminders:', error);
    }
}

/**
 * Send a form reminder to a user
 * @param {Object} session - Session object from database
 * @param {number} stage - Reminder stage (1, 2, 3)
 */
async function sendFormReminder(session, stage) {
    try {
        const formUrl = `${process.env.AVI_WEBSITE_API_URL || 'https://avi-website-frankfurt.onrender.com'}/chatbot?session=${session.session_id}`;
        const message = getReminderMessage('form', stage, formUrl);

        logger.info(`📤 [REMINDER-SCHEDULER] Sending form reminder ${stage} to ${session.phone_number}`);

        // Send via WhatsApp
        if (whatsappClient && session.chat_id) {
            await whatsappClient.sendMessage(session.chat_id, message);

            // Update database
            const remindersSent = session.reminders_sent || { form: [], appointment: [] };
            remindersSent.form = remindersSent.form || [];
            remindersSent.form.push(stage);

            await dbPool.query(
                `UPDATE sessions
                 SET reminders_sent = $1
                 WHERE session_id = $2`,
                [JSON.stringify(remindersSent), session.session_id]
            );

            logger.info(`✅ [REMINDER-SCHEDULER] Form reminder ${stage} sent to ${session.phone_number}`);
        } else {
            logger.warn(`⚠️  [REMINDER-SCHEDULER] WhatsApp client not ready, skipping reminder`);
        }
    } catch (error) {
        logger.error(`❌ [REMINDER-SCHEDULER] Error sending form reminder to ${session.phone_number}:`, error);
    }
}

/**
 * Send an appointment reminder to a user
 * @param {Object} session - Session object from database
 * @param {number} stage - Reminder stage (1, 2, 3, 4)
 */
async function sendAppointmentReminder(session, stage) {
    try {
        const appointmentUrl = process.env.APPOINTMENT_LINK || 'https://www.baz-f.co.il/appointment.html';
        const message = getReminderMessage('appointment', stage, appointmentUrl);

        logger.info(`📤 [REMINDER-SCHEDULER] Sending appointment reminder ${stage} to ${session.phone_number}`);

        // Send via WhatsApp
        if (whatsappClient && session.chat_id) {
            await whatsappClient.sendMessage(session.chat_id, message);

            // Update database
            const remindersSent = session.reminders_sent || { form: [], appointment: [] };
            remindersSent.appointment = remindersSent.appointment || [];
            remindersSent.appointment.push(stage);

            await dbPool.query(
                `UPDATE sessions
                 SET reminders_sent = $1
                 WHERE session_id = $2`,
                [JSON.stringify(remindersSent), session.session_id]
            );

            logger.info(`✅ [REMINDER-SCHEDULER] Appointment reminder ${stage} sent to ${session.phone_number}`);
        } else {
            logger.warn(`⚠️  [REMINDER-SCHEDULER] WhatsApp client not ready, skipping reminder`);
        }
    } catch (error) {
        logger.error(`❌ [REMINDER-SCHEDULER] Error sending appointment reminder to ${session.phone_number}:`, error);
    }
}

/**
 * Main function to check and send all reminders
 * Called by cron job every N minutes
 */
async function checkAndSendReminders() {
    try {
        logger.info('⏰ [REMINDER-SCHEDULER] Running reminder check...');

        await checkFormReminders();
        await checkAppointmentReminders();

        logger.info('✅ [REMINDER-SCHEDULER] Reminder check completed');
    } catch (error) {
        logger.error('❌ [REMINDER-SCHEDULER] Error in reminder check:', error);
    }
}

/**
 * Get reminder statistics for monitoring
 */
async function getReminderStats() {
    if (!dbPool) {
        return null;
    }

    try {
        // Count users awaiting form reminders
        const formQuery = `
            SELECT COUNT(*) as count
            FROM sessions
            WHERE status = 'active'
              AND form_sent_at IS NOT NULL
              AND form_completed_at IS NULL
              AND expires_at > NOW()
        `;

        // Count users awaiting appointment reminders
        const appointmentQuery = `
            SELECT COUNT(*) as count
            FROM sessions
            WHERE status = 'completed'
              AND appointment_sent_at IS NOT NULL
              AND appointment_scheduled_at IS NULL
              AND expires_at > NOW()
        `;

        const formResult = await dbPool.query(formQuery);
        const appointmentResult = await dbPool.query(appointmentQuery);

        return {
            testMode: IS_TEST_MODE,
            operatingHoursStatus: isWithinOperatingHours(),
            awaitingFormReminders: parseInt(formResult.rows[0].count),
            awaitingAppointmentReminders: parseInt(appointmentResult.rows[0].count),
            timingConfig: {
                form: REMINDER_TIMING.form.map(r => ({
                    stage: r.stage,
                    delayMinutes: r.delayMinutes,
                    window: r.windowStart ? `${r.windowStart}:00-${r.windowEnd}:00` : 'anytime'
                })),
                appointment: REMINDER_TIMING.appointment.map(r => ({
                    stage: r.stage,
                    delayMinutes: r.delayMinutes,
                    window: r.windowStart ? `${r.windowStart}:00-${r.windowEnd}:00` : 'anytime'
                }))
            }
        };
    } catch (error) {
        logger.error('❌ [REMINDER-SCHEDULER] Error getting stats:', error);
        return null;
    }
}

module.exports = {
    initializeScheduler,
    checkAndSendReminders,
    checkFormReminders,
    checkAppointmentReminders,
    getReminderStats
};
