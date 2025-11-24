// Operating hours and calendar validation for reminder system
// Based on BOT-FOLLOW-UP-RULES.md

// Jewish holidays 2025-2026 (approximate dates - should be updated annually)
// Format: 'YYYY-MM-DD'
const JEWISH_HOLIDAYS = [
    // 2025
    '2025-04-13', '2025-04-14', // Pesach (Passover) Days 1-2
    '2025-04-19', '2025-04-20', // Pesach Days 7-8
    '2025-06-02', '2025-06-03', // Shavuot
    '2025-09-23', '2025-09-24', // Rosh Hashanah
    '2025-10-02',               // Yom Kippur
    '2025-10-07', '2025-10-08', // Sukkot Days 1-2
    '2025-10-14', '2025-10-15', // Simchat Torah / Shmini Atzeret

    // 2026
    '2026-04-02', '2026-04-03', // Pesach Days 1-2
    '2026-04-08', '2026-04-09', // Pesach Days 7-8
    '2026-05-22', '2026-05-23', // Shavuot
    '2026-09-12', '2026-09-13', // Rosh Hashanah
    '2026-09-21',               // Yom Kippur
    '2026-09-26', '2026-09-27', // Sukkot Days 1-2
    '2026-10-03', '2026-10-04', // Simchat Torah / Shmini Atzeret
];

/**
 * Check if today is a Jewish holiday
 * @returns {boolean} True if today is a holiday
 */
function isJewishHoliday() {
    const today = new Date().toISOString().split('T')[0]; // 'YYYY-MM-DD'
    return JEWISH_HOLIDAYS.includes(today);
}

/**
 * Check if current time is within operating hours
 * Operating hours:
 * - Sunday-Thursday: 09:00-21:00
 * - Friday: 09:00-15:00
 * - Saturday: No messages (Shabbat)
 * - Jewish holidays: No messages
 *
 * @returns {boolean} True if within operating hours
 */
function isWithinOperatingHours() {
    const now = new Date();
    const day = now.getDay(); // 0 = Sunday, 6 = Saturday
    const hour = now.getHours();
    const minute = now.getMinutes();

    // Check if it's a Jewish holiday
    if (isJewishHoliday()) {
        return false;
    }

    // Saturday = Shabbat (no messages)
    if (day === 6) {
        return false;
    }

    // Friday: Only 09:00-15:00
    if (day === 5) {
        if (hour < 9 || hour >= 15) {
            return false;
        }
        return true;
    }

    // Sunday-Thursday: 09:00-21:00
    if (hour < 9 || hour >= 21) {
        return false;
    }

    return true;
}

/**
 * Check if current time is within a specific time window
 * @param {number} startHour - Start hour (0-23)
 * @param {number} endHour - End hour (0-23)
 * @returns {boolean} True if within the window
 */
function isWithinTimeWindow(startHour, endHour) {
    if (!isWithinOperatingHours()) {
        return false;
    }

    const now = new Date();
    const hour = now.getHours();

    return hour >= startHour && hour < endHour;
}

/**
 * Get next available operating time
 * @returns {Date} Next time when messages can be sent
 */
function getNextOperatingTime() {
    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();

    // If currently in operating hours, return now
    if (isWithinOperatingHours()) {
        return now;
    }

    // Calculate next available time
    const nextTime = new Date(now);

    // Saturday - wait until Sunday 09:00
    if (day === 6) {
        nextTime.setDate(nextTime.getDate() + 1); // Move to Sunday
        nextTime.setHours(9, 0, 0, 0);
        return nextTime;
    }

    // Friday after 15:00 - wait until Sunday 09:00
    if (day === 5 && hour >= 15) {
        nextTime.setDate(nextTime.getDate() + 2); // Move to Sunday
        nextTime.setHours(9, 0, 0, 0);
        return nextTime;
    }

    // Before 09:00 - wait until 09:00 today
    if (hour < 9) {
        nextTime.setHours(9, 0, 0, 0);
        return nextTime;
    }

    // After 21:00 - wait until 09:00 tomorrow
    if (hour >= 21) {
        nextTime.setDate(nextTime.getDate() + 1);
        nextTime.setHours(9, 0, 0, 0);
        return nextTime;
    }

    // Default: next morning at 09:00
    nextTime.setDate(nextTime.getDate() + 1);
    nextTime.setHours(9, 0, 0, 0);
    return nextTime;
}

/**
 * Format operating hours status for logging
 * @returns {string} Human-readable status
 */
function getOperatingHoursStatus() {
    const now = new Date();
    const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()];
    const time = now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });

    if (isJewishHoliday()) {
        return `🚫 Jewish Holiday - No messages`;
    }

    if (isWithinOperatingHours()) {
        return `✅ Within operating hours (${day} ${time})`;
    }

    const nextTime = getNextOperatingTime();
    return `🚫 Outside operating hours - Next: ${nextTime.toLocaleString('he-IL')}`;
}

module.exports = {
    isWithinOperatingHours,
    isWithinTimeWindow,
    isJewishHoliday,
    getNextOperatingTime,
    getOperatingHoursStatus,
    JEWISH_HOLIDAYS // Export for testing/updates
};
