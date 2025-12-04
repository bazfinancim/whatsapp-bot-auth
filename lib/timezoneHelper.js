/**
 * Timezone Helper for WhatsApp Bot
 *
 * Handles all Israel timezone logic (Asia/Jerusalem) and business hours enforcement.
 * Implements the timing rules from /docs/bot-messages.md
 *
 * Business Hours:
 * - Sunday-Thursday: 9:00-20:00 (reminder messages)
 * - Friday-Saturday: NO reminder messages (Israeli weekend)
 */

const { DateTime } = require('luxon');

// Constants
const ISRAEL_TIMEZONE = 'Asia/Jerusalem';

// Business hours for reminder messages (Sunday-Thursday only)
const BUSINESS_HOURS = {
    start: 9, // 9:00
    end: 20   // 20:00
};

// Days of week (Sunday = 7 in Luxon, Monday = 1)
const WEEKDAYS = {
    SUNDAY: 7,
    MONDAY: 1,
    TUESDAY: 2,
    WEDNESDAY: 3,
    THURSDAY: 4,
    FRIDAY: 5,
    SATURDAY: 6
};

const ISRAELI_WEEKDAYS = [
    WEEKDAYS.SUNDAY,
    WEEKDAYS.MONDAY,
    WEEKDAYS.TUESDAY,
    WEEKDAYS.WEDNESDAY,
    WEEKDAYS.THURSDAY
];

/**
 * Get current time in Israel timezone
 * @returns {DateTime} Current Israel time
 */
function getNowInIsrael() {
    return DateTime.now().setZone(ISRAEL_TIMEZONE);
}

/**
 * Convert a timestamp to Israel timezone
 * @param {Date|string|number} timestamp - Timestamp to convert
 * @returns {DateTime} DateTime in Israel timezone
 */
function toIsraelTime(timestamp) {
    return DateTime.fromJSDate(new Date(timestamp)).setZone(ISRAEL_TIMEZONE);
}

/**
 * Check if a given time is during Israeli weekend (Friday or Saturday)
 * @param {DateTime} dateTime - DateTime to check
 * @returns {boolean} True if Friday or Saturday
 */
function isIsraeliWeekend(dateTime) {
    const dayOfWeek = dateTime.weekday;
    return dayOfWeek === WEEKDAYS.FRIDAY || dayOfWeek === WEEKDAYS.SATURDAY;
}

/**
 * Check if a given time is during Israeli weekday (Sunday-Thursday)
 * @param {DateTime} dateTime - DateTime to check
 * @returns {boolean} True if Sunday-Thursday
 */
function isIsraeliWeekday(dateTime) {
    return ISRAELI_WEEKDAYS.includes(dateTime.weekday);
}

/**
 * Check if a given time is within business hours (9:00-20:00)
 * @param {DateTime} dateTime - DateTime to check
 * @param {Object} customHours - Optional custom hours {start, end}
 * @returns {boolean} True if within business hours
 */
function isWithinBusinessHours(dateTime, customHours = null) {
    const hours = customHours || BUSINESS_HOURS;
    const hour = dateTime.hour;
    return hour >= hours.start && hour < hours.end;
}

/**
 * Check if a given time is valid for sending reminder messages
 * Must be: Israeli weekday (Sun-Thu) AND within business hours (9:00-20:00)
 * @param {DateTime} dateTime - DateTime to check
 * @param {Object} customHours - Optional custom hours {start, end}
 * @returns {boolean} True if valid time for reminders
 */
function isValidReminderTime(dateTime, customHours = null) {
    return isIsraeliWeekday(dateTime) && isWithinBusinessHours(dateTime, customHours);
}

/**
 * Get the next valid business hour from a given time
 * Skips weekends and enforces 9:00-20:00 window
 * @param {DateTime} fromTime - Starting time
 * @param {Object} customHours - Optional custom hours {start, end}
 * @returns {DateTime} Next valid business time
 */
function getNextValidBusinessTime(fromTime, customHours = null) {
    const hours = customHours || BUSINESS_HOURS;
    let nextTime = fromTime;

    // If already valid, return as-is
    if (isValidReminderTime(nextTime, customHours)) {
        return nextTime;
    }

    // If we're on a weekend, skip to next Sunday
    if (isIsraeliWeekend(nextTime)) {
        // Move to next Sunday at business start hour
        const daysUntilSunday = nextTime.weekday === WEEKDAYS.FRIDAY ? 2 : 1;
        nextTime = nextTime.plus({ days: daysUntilSunday })
            .set({ hour: hours.start, minute: 0, second: 0, millisecond: 0 });
        return nextTime;
    }

    // If we're outside business hours on a weekday
    if (!isWithinBusinessHours(nextTime, customHours)) {
        // If before start hour, move to start hour today
        if (nextTime.hour < hours.start) {
            nextTime = nextTime.set({ hour: hours.start, minute: 0, second: 0, millisecond: 0 });
        }
        // If after end hour, move to start hour next day
        else if (nextTime.hour >= hours.end) {
            nextTime = nextTime.plus({ days: 1 })
                .set({ hour: hours.start, minute: 0, second: 0, millisecond: 0 });

            // Check if next day is weekend, if so skip to Sunday
            if (isIsraeliWeekend(nextTime)) {
                return getNextValidBusinessTime(nextTime, customHours);
            }
        }
    }

    return nextTime;
}

/**
 * Calculate when to send the 19:00 (7 PM) form reminder
 * Sent ONCE at 19:00 Israel time if form is not completed
 * Rules:
 * - If first message sent between 00:00-17:59 → send at 19:00 same day
 * - If first message sent at 18:00 or later → send at 19:00 next day
 * Does not repeat (to avoid appearing robotic)
 * @param {DateTime} firstMessageTime - When first message was sent
 * @returns {DateTime} Scheduled time for 19:00 reminder
 */
function calculate19pmReminderTime(firstMessageTime) {
    const israelTime = firstMessageTime.setZone(ISRAEL_TIMEZONE);

    // If before 18:00 (6 PM), schedule for 19:00 today
    if (israelTime.hour < 18) {
        return israelTime.set({ hour: 19, minute: 0, second: 0, millisecond: 0 });
    }

    // Otherwise, schedule for 19:00 next day
    return israelTime.plus({ days: 1 })
        .set({ hour: 19, minute: 0, second: 0, millisecond: 0 });
}

/**
 * Calculate when to send the video testimonial (20:00 / 8 PM)
 * Sent ONCE at 20:00 the same day as the first reminder if form not completed
 * @param {DateTime} firstMessageTime - When first message was sent
 * @returns {DateTime} Scheduled time for video testimonial
 */
function calculateVideoTestimonialTime(firstMessageTime) {
    const reminderTime = calculate19pmReminderTime(firstMessageTime);
    // Video is sent at 20:00 (8 PM), same day as the 19:00 text reminder
    return reminderTime.set({ hour: 20, minute: 0, second: 0, millisecond: 0 });
}

/**
 * Calculate next appointment reminder time slot
 * All appointment reminders are sent at 19:00 (7 PM) on subsequent business days
 * @param {DateTime} lastReminderTime - When previous reminder was sent
 * @returns {DateTime} Next scheduled reminder time (always 19:00 next business day)
 */
function calculateNextAppointmentReminderTime(lastReminderTime) {
    const israelTime = lastReminderTime.setZone(ISRAEL_TIMEZONE);

    // Schedule for 19:00 (7 PM) the next day
    const nextTime = israelTime.plus({ days: 1 })
        .set({ hour: 19, minute: 0, second: 0, millisecond: 0 });

    // Ensure next time is on a valid business day
    return getNextValidBusinessTime(nextTime);
}

/**
 * Schedule a message with delay (in seconds)
 * @param {DateTime} fromTime - Starting time
 * @param {number} delaySeconds - Delay in seconds
 * @returns {DateTime} Scheduled time
 */
function scheduleWithDelay(fromTime, delaySeconds) {
    return fromTime.plus({ seconds: delaySeconds });
}

/**
 * Format a DateTime for database storage (ISO string)
 * @param {DateTime} dateTime - DateTime to format
 * @returns {string} ISO timestamp string
 */
function toISOString(dateTime) {
    return dateTime.toISO();
}

/**
 * Format a DateTime for Bull job scheduling (JavaScript Date)
 * @param {DateTime} dateTime - DateTime to format
 * @returns {Date} JavaScript Date object
 */
function toDate(dateTime) {
    return dateTime.toJSDate();
}

/**
 * Get human-readable description of when a message will be sent
 * @param {DateTime} scheduledTime - Scheduled time
 * @returns {string} Human-readable description
 */
function getScheduleDescription(scheduledTime) {
    const now = getNowInIsrael();
    const diff = scheduledTime.diff(now, ['days', 'hours', 'minutes']).toObject();

    if (diff.days >= 1) {
        return `in ${Math.floor(diff.days)} day(s)`;
    } else if (diff.hours >= 1) {
        return `in ${Math.floor(diff.hours)} hour(s)`;
    } else if (diff.minutes >= 1) {
        return `in ${Math.floor(diff.minutes)} minute(s)`;
    } else {
        return 'shortly';
    }
}

/**
 * Check if current time is past a scheduled time
 * @param {DateTime} scheduledTime - Scheduled time to check
 * @returns {boolean} True if scheduled time has passed
 */
function isPastScheduledTime(scheduledTime) {
    const now = getNowInIsrael();
    return now > scheduledTime;
}

module.exports = {
    // Core functions
    getNowInIsrael,
    toIsraelTime,

    // Validation functions
    isIsraeliWeekend,
    isIsraeliWeekday,
    isWithinBusinessHours,
    isValidReminderTime,

    // Scheduling functions
    getNextValidBusinessTime,
    calculate19pmReminderTime,
    calculateVideoTestimonialTime,
    calculateNextAppointmentReminderTime,
    scheduleWithDelay,

    // Utility functions
    toISOString,
    toDate,
    getScheduleDescription,
    isPastScheduledTime,

    // Constants (exported for testing)
    ISRAEL_TIMEZONE,
    BUSINESS_HOURS,
    WEEKDAYS
};
