// Reminder message templates for stupidBot
// Based on BOT-FOLLOW-UP-RULES.md

const REMINDER_MESSAGES = {
    // ========== QUESTIONNAIRE FOLLOW-UP MESSAGES ==========

    // Message #3: Scheduled Reminder (Sent at 19:00 Israel Time)
    formReminder1: (formLink) => `שוב שלום 😊

כדי שנוכל להמשיך בתהליך, יש למלא את השאלון הקצר ממש דקה מזמנך.

👇🏻👇🏻👇🏻👇🏻👇🏻👇🏻

${formLink}`,

    // Deprecated - kept for backwards compatibility
    formReminder2: (formLink) => `היי, עדיין לא ענית על השאלון, זה ממש חצי דקה, שוב מניח את הלינק.

${formLink}`,

    // Deprecated - kept for backwards compatibility
    formReminder3: (formLink) => `היי, עדיין ממתינים למילוי השאלון. הינה שוב הלינק לשאלון:

${formLink}`,

    // ========== APPOINTMENT SCHEDULING FOLLOW-UP MESSAGES ==========

    // Message #8: First Appointment Reminder (1 Hour After Appointment Link)
    appointmentReminder1: (appointmentLink) => `📅 ראיתי שטרם נקבעה פגישה. מניח את הלינק פה שוב אשמח שנתאם.

👇🏻👇🏻👇🏻👇🏻👇🏻👇🏻

כנסו ללינק: ${appointmentLink}`,

    // Message #9: Second Appointment Reminder
    appointmentReminder2: (appointmentLink) => `📅 היי עדיין לא נקבעה פגישה, אנחנו בהחלט יכולים לעזור בעלמות הפנסיוניים והפיננסים, בלינק הבא ישנן המלצות מלקוחות שכבר עברו תהליך וגם מכאן ניתן לתאם פגישה

👇🏻👇🏻👇🏻👇🏻👇🏻👇🏻

כנסו ללינק: ${appointmentLink}`,

    // Message #10: Third Appointment Reminder
    appointmentReminder3: (appointmentLink) => `היי שוב אני לא נעים לחצות לך, שלב ראשון של מילוי השאלון כבר מאחורינו ולאור בקירת התאמה יש להכנס ללינק לקביעת פגישה

👇🏻👇🏻👇🏻👇🏻👇🏻👇🏻

כנסו ללינק: ${appointmentLink}`,

    // Message #11: Fourth Appointment Reminder
    appointmentReminder4: (appointmentLink) => `היי עדיין לא נקבע פגישה "חבל" כבר קיבלנו תשובות לשאלון.

מתי עדיפו שנחזור אליכם:  בבין השעות 9:00 עד 12:00  או 13:00 ל-15:00.

👇🏻👇🏻👇🏻👇🏻👇🏻👇🏻

כנסו ללינק: ${appointmentLink}`
};

// Get reminder message by type and stage
function getReminderMessage(type, stage, link) {
    const messageKey = `${type}Reminder${stage}`;
    const messageFunc = REMINDER_MESSAGES[messageKey];

    if (!messageFunc) {
        throw new Error(`Invalid reminder type/stage: ${type}/${stage}`);
    }

    return messageFunc(link);
}

// Get all available reminder types
function getReminderTypes() {
    return ['form', 'appointment'];
}

// Get max stages for a reminder type
function getMaxStage(type) {
    if (type === 'form') return 3;
    if (type === 'appointment') return 4;
    return 0;
}

module.exports = {
    REMINDER_MESSAGES,
    getReminderMessage,
    getReminderTypes,
    getMaxStage
};
