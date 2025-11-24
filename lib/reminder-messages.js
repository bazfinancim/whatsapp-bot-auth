// Reminder message templates for stupidBot
// Based on BOT-FOLLOW-UP-RULES.md

const REMINDER_MESSAGES = {
    // ========== QUESTIONNAIRE FOLLOW-UP MESSAGES ==========

    formReminder1: (formLink) => `היי, כדי שנוכל להמשיך בתהליך, נבקש למלא את השאלון הקצר בלינק הבא.

${formLink}`,

    formReminder2: (formLink) => `היי, עדיין לא ענית על השאלון, זה ממש חצי דקה, שוב מניח את הלינק.

${formLink}`,

    formReminder3: (formLink) => `היי, עדיין ממתינים למילוי השאלון. הינה שוב הלינק לשאלון:

${formLink}`,

    // ========== APPOINTMENT SCHEDULING FOLLOW-UP MESSAGES ==========

    appointmentReminder1: (appointmentLink) => `ראיתי שטרם נקבעה פגישה. מניח את הלינק פה שוב, אשמח שנתאם.

${appointmentLink}`,

    appointmentReminder2: (appointmentLink) => `היי, עדיין לא נקבעה פגישה. אנחנו בהחלט יכולים לעזור בעלומות הפנסיונים והפיננסים.

בלינק הבא ישנן המלצות מלקוחות שכבר עברו תהליך וגם מכאן ניתן לתאם פגישה:

${appointmentLink}`,

    appointmentReminder3: (appointmentLink) => `היי שוב, אני לא נעים להציק לך. שלב ראשון של מילוי השאלון כבר מאחורינו, ולצורך בדיקת התאמה יש להיכנס ללינק לקביעת פגישה.

${appointmentLink}`,

    appointmentReminder4: (appointmentLink) => `היי, עדיין לא נקבעה פגישה. "חבל" - כבר קיבלנו תשובות לשאלון.

מתי תעדיפו שמנהל תיק שלנו יחזור אליכם?

🕘 בין השעות 9:00 עד 12:00
🕐 או 13:00 עד 15:00

${appointmentLink}`
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
