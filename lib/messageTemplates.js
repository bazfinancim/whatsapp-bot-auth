/**
 * WhatsApp Bot Message Templates
 *
 * This module contains all 11 message templates used by the WhatsApp bot.
 * Each template supports variable substitution for dynamic content.
 *
 * Source: /docs/bot-messages.md
 */

// Message type constants
const MESSAGE_TYPES = {
    INTRODUCTION: 'introduction',
    CHATBOT_LINK: 'chatbot_link',
    FORM_REMINDER_19PM: 'form_reminder_19pm',
    VIDEO_TESTIMONIAL: 'video_testimonial',
    FORM_SUMMARY: 'form_summary',
    APPOINTMENT_LINK: 'appointment_link',
    APPOINTMENT_REMINDER_1: 'appointment_reminder_1',
    APPOINTMENT_REMINDER_2: 'appointment_reminder_2',
    APPOINTMENT_REMINDER_3: 'appointment_reminder_3',
    APPOINTMENT_REMINDER_4: 'appointment_reminder_4',
    ACTIVE_SESSION_REMINDER: 'active_session_reminder'
};

// Static message templates (no variables)
const STATIC_MESSAGES = {
    [MESSAGE_TYPES.INTRODUCTION]: `*תודה שפנית, נעים מאוד שמי אבי ישי 😊*
בעלים של בז פיננסים, כלכלן בעל תואר B.A במנהל עסקים ומחזיק ברישיון פנסיוני עם ניסיון של מעל 20 שנה.

חברתנו מעניקה פתרונות במגוון תחומים:
*✅ ליווי וייעוץ עסקי*
*✅ בניית מודלים כלכליים*
*✅ ניתוח תיק פנסיוני*
*✅ תכנון פיננסי מקיף*
*✅ ייעוץ ותכנון פרישה*
*✅ ניהול השקעות*
*✅ פתרונות ביטוח*
*✅ ייעוץ משכנתאות*
*✅ פתרונות אשראי נוספים*`,

    [MESSAGE_TYPES.VIDEO_TESTIMONIAL]: `משתף אותכם בחוויה שעברו משפחת יוסף
ד"ר חזי מנכ"ל כפר הנוער כנות ורעייתו מיכל`,

    [MESSAGE_TYPES.APPOINTMENT_LINK]: `📅 *עכשיו נשאר רק לקבוע שיחה קצרה לעבור על הדברים.*

*ניתן לשריין זמן שנוח לך*

👇🏻👇🏻👇🏻👇🏻👇🏻👇🏻

*כנסו ללינק: https://lp.baz-f.co.il/*`,

    [MESSAGE_TYPES.APPOINTMENT_REMINDER_1]: `📅 ראיתי שטרם נקבעה פגישה. מניח את הלינק פה שוב אשמח שנתאם.

👇🏻👇🏻👇🏻👇🏻👇🏻👇🏻

כנסו ללינק: https://lp.baz-f.co.il/`,

    [MESSAGE_TYPES.APPOINTMENT_REMINDER_2]: `📅 היי עדיין לא נקבעה פגישה, אנחנו בהחלט יכולים לעזור בעולמות הפנסיוניים והפיננסים, בלינק הבא ישנן המלצות מלקוחות שכבר עברו תהליך וגם מכאן ניתן לתאם פגישה

👇🏻👇🏻👇🏻👇🏻👇🏻👇🏻

כנסו ללינק: https://lp.baz-f.co.il/`,

    [MESSAGE_TYPES.APPOINTMENT_REMINDER_3]: `היי שוב אני לא נעים להציק לך, שלב ראשון של מילוי השאלון כבר מאחורינו ולצורך בדיקת התאמה יש להיכנס ללינק לקביעת פגישה

👇🏻👇🏻👇🏻👇🏻👇🏻👇🏻

כנסו ללינק: https://lp.baz-f.co.il`,

    [MESSAGE_TYPES.APPOINTMENT_REMINDER_4]: `היי עדיין לא נקבע פגישה "חבל" כבר קיבלנו תשובות לשאלון.

מתי עדיפו שנחזר אליכם:  בבין השעות 9:00 עד 12:00  או 13:00 ל-15:00.

👇🏻👇🏻👇🏻👇🏻👇🏻👇🏻

כנסו ללינק: https://lp.baz-f.co.il/`
};

// Dynamic message template functions (with variable substitution)
const DYNAMIC_MESSAGES = {
    /**
     * Message #2: Chatbot Link
     * Variables: {chatbotUrl}
     */
    [MESSAGE_TYPES.CHATBOT_LINK]: (variables) => {
        const { chatbotUrl } = variables;
        return `📝 *הכנתי לך 10 שאלות קצרות כדי שאוכל למפות את עולמכם הפיננסי בהתאמה אישית*

*כנסו ללינק:*
👇🏻👇🏻👇🏻👇🏻👇🏻👇🏻

${chatbotUrl}

*💥הקישור תקף ל-24 שעות💥*`;
    },

    /**
     * Message #3: Form Reminder at 19:00
     * Variables: {chatbotUrl}
     */
    [MESSAGE_TYPES.FORM_REMINDER_19PM]: (variables) => {
        const { chatbotUrl } = variables;
        return `שוב שלום 😊

כדי שנוכל להמשיך בתהליך, יש למלא את השאלון הקצר ממש דקה מזמנך.

👇🏻👇🏻👇🏻👇🏻👇🏻👇🏻

${chatbotUrl}`;
    },

    /**
     * Message #5: Form Summary
     * Variables: {name, ageGroup, financialGoal, maritalStatus, employmentStatus,
     *            pensionContributions, monthlySalary, pensionCapital,
     *            savingsAndInvestments, investmentLocation, mortgage}
     */
    [MESSAGE_TYPES.FORM_SUMMARY]: (variables) => {
        const {
            name,
            ageGroup,
            financialGoal,
            maritalStatus,
            employmentStatus,
            pensionContributions,
            monthlySalary,
            pensionCapital,
            savingsAndInvestments,
            investmentLocation,
            mortgage
        } = variables;

        return `*🙏🏻 תודה רבה על מילוי השאלון!*

*✍🏻 סיכום הפרטים שלך:*

✅ *שם* : ${name}
✅ *קבוצת גיל:* ${ageGroup}
✅ *מטרה פיננסית:* ${financialGoal}
✅ *מצב משפחתי :* ${maritalStatus}
✅ *סטטוס תעסוקה :* ${employmentStatus}
✅ *הפרשות פנסיוניות :* ${pensionContributions}
✅ *שכר ברוטו חודשי :* ${monthlySalary} ₪
✅ *הון פנסיוני :* ${pensionCapital}
✅ *חסכונות והשקעות :* ${savingsAndInvestments}
✅ *מיקום השקעות :* ${investmentLocation}
✅ *משכנתא :* ${mortgage}`;
    },

    /**
     * Message #13: Active Session Reminder
     * Variables: {chatbotUrl}
     */
    [MESSAGE_TYPES.ACTIVE_SESSION_REMINDER]: (variables) => {
        const { chatbotUrl } = variables;
        return `יש לך טופס פתוח! ⏳

המשך/י למלא כאן:
${chatbotUrl}`;
    }
};

/**
 * Get a message template by type
 * @param {string} messageType - One of MESSAGE_TYPES
 * @param {Object} variables - Variables for dynamic messages (optional)
 * @returns {string} Formatted message
 */
function getMessage(messageType, variables = {}) {
    // Check if it's a static message
    if (STATIC_MESSAGES[messageType]) {
        return STATIC_MESSAGES[messageType];
    }

    // Check if it's a dynamic message
    if (DYNAMIC_MESSAGES[messageType]) {
        return DYNAMIC_MESSAGES[messageType](variables);
    }

    throw new Error(`Unknown message type: ${messageType}`);
}

/**
 * Validate that all required variables are present
 * @param {string} messageType - One of MESSAGE_TYPES
 * @param {Object} variables - Variables to validate
 * @returns {boolean} True if valid, throws error if invalid
 */
function validateVariables(messageType, variables) {
    const requiredVariables = {
        [MESSAGE_TYPES.CHATBOT_LINK]: ['chatbotUrl'],
        [MESSAGE_TYPES.FORM_REMINDER_19PM]: ['chatbotUrl'],
        [MESSAGE_TYPES.ACTIVE_SESSION_REMINDER]: ['chatbotUrl'],
        [MESSAGE_TYPES.FORM_SUMMARY]: [
            'name',
            'ageGroup',
            'financialGoal',
            'maritalStatus',
            'employmentStatus',
            'pensionContributions',
            'monthlySalary',
            'pensionCapital',
            'savingsAndInvestments',
            'investmentLocation',
            'mortgage'
        ]
    };

    const required = requiredVariables[messageType];
    if (!required) {
        // No required variables for this message type
        return true;
    }

    const missing = required.filter(key => !(key in variables));
    if (missing.length > 0) {
        throw new Error(`Missing required variables for ${messageType}: ${missing.join(', ')}`);
    }

    return true;
}

/**
 * Get metadata about a message type
 * @param {string} messageType - One of MESSAGE_TYPES
 * @returns {Object} Metadata including timing, trigger conditions, etc.
 */
function getMessageMetadata(messageType) {
    const metadata = {
        [MESSAGE_TYPES.INTRODUCTION]: {
            timing: 'immediate',
            trigger: 'first_message',
            requiresVariables: false,
            schedulable: false
        },
        [MESSAGE_TYPES.CHATBOT_LINK]: {
            timing: 'immediate',
            trigger: 'after_message_1',
            requiresVariables: true,
            schedulable: true,
            delay: 0 // no delay
        },
        [MESSAGE_TYPES.FORM_REMINDER_19PM]: {
            timing: '19:00_israel_time',
            trigger: 'form_not_completed',
            requiresVariables: true,
            schedulable: true,
            timeWindow: '19:00',
            respectsWeekend: true
        },
        [MESSAGE_TYPES.VIDEO_TESTIMONIAL]: {
            timing: '20:00_israel_time',
            trigger: 'form_not_completed',
            requiresVariables: false,
            schedulable: true,
            hasAttachment: true,
            attachmentType: 'video',
            respectsWeekend: true
        },
        [MESSAGE_TYPES.FORM_SUMMARY]: {
            timing: 'immediate',
            trigger: 'form_completed',
            requiresVariables: true,
            schedulable: false
        },
        [MESSAGE_TYPES.APPOINTMENT_LINK]: {
            timing: 'immediate_after_summary',
            trigger: 'after_message_6',
            requiresVariables: false,
            schedulable: false
        },
        [MESSAGE_TYPES.APPOINTMENT_REMINDER_1]: {
            timing: '19:00_next_business_day',
            trigger: 'appointment_not_scheduled',
            requiresVariables: false,
            schedulable: true,
            respectsWeekend: true,
            businessHours: '9:00-20:00'
        },
        [MESSAGE_TYPES.APPOINTMENT_REMINDER_2]: {
            timing: 'next_available_slot_after_reminder_1',
            trigger: 'appointment_not_scheduled',
            requiresVariables: false,
            schedulable: true,
            respectsWeekend: true,
            businessHours: '9:00-20:00'
        },
        [MESSAGE_TYPES.APPOINTMENT_REMINDER_3]: {
            timing: 'next_available_slot_after_reminder_2',
            trigger: 'appointment_not_scheduled',
            requiresVariables: false,
            schedulable: true,
            respectsWeekend: true,
            businessHours: '9:00-20:00'
        },
        [MESSAGE_TYPES.APPOINTMENT_REMINDER_4]: {
            timing: 'next_available_slot_after_reminder_3',
            trigger: 'appointment_not_scheduled',
            requiresVariables: false,
            schedulable: true,
            respectsWeekend: true,
            businessHours: '9:00-15:00'
        },
        [MESSAGE_TYPES.ACTIVE_SESSION_REMINDER]: {
            timing: 'immediate',
            trigger: 'user_message_when_session_active',
            requiresVariables: true,
            schedulable: false
        }
    };

    return metadata[messageType] || null;
}

module.exports = {
    MESSAGE_TYPES,
    getMessage,
    validateVariables,
    getMessageMetadata
};
