/**
 * Form Submission Handler
 * CONSOLIDATED VERSION: Runs in same app as WhatsApp bot.
 *
 * This endpoint receives form data from the chatbot and validates the session
 * before sending to Monday.com
 *
 * After form completion:
 * 1. Cancels pending form reminders (Messages #3, #4, #5)
 * 2. Sends Message #6 (form summary) immediately
 * 3. Sends Message #7 (appointment link) immediately
 * 4. Schedules Messages #8-11 (appointment reminders)
 */

const sessionManager = require('../lib/sessionManager');
const { getMessage, MESSAGE_TYPES } = require('../lib/messageTemplates');
const {
    sendWhatsAppMessage,
    scheduleAppointmentReminders,
    cancelSessionMessages
} = require('../lib/messageScheduler');
const { getNowInIsrael } = require('../lib/timezoneHelper');
const { createLead, updateLead } = require('../lib/mondayClient');

module.exports = async (req, res) => {
    try {
        const { session_id, ...formData } = req.body;

        // If no session_id provided, treat as anonymous submission
        if (!session_id) {
            console.log('⚠️  Anonymous form submission (no session_id)');
            // Accept and send to Monday.com without tracking
            await createLead({ ...formData, session_id: 'anonymous' });
            return res.json({ success: true, message: 'Form submitted successfully' });
        }

        // Check if session exists and is valid
        const session = await sessionManager.getSession(session_id);

        if (!session) {
            console.log(`❌ Invalid or expired session: ${session_id}`);
            return res.status(400).json({
                success: false,
                error: 'Invalid or expired session ID',
                message: 'הקישור לא תקף או פג תוקפו. אנא בקש/י קישור חדש מהבוט.'
            });
        }

        // Check if form already completed
        if (session.status === 'completed') {
            console.log(`❌ Form already completed for session: ${session_id}`);
            return res.status(400).json({
                success: false,
                error: 'Form already completed',
                message: 'הטופס כבר מולא! ✅\n\nאם ברצונך למלא אותו שוב, שלח/י "reset" לבוט בווטסאפ.'
            });
        }

        // Generate unique lead ID for CRM tracking
        const leadId = generateLeadId();

        // Session is valid - mark as completed (also clears pendingUsers internally)
        await sessionManager.markCompleted(session_id, formData);

        // Step 1: Cancel any pending form reminder messages (Messages #3, #4)
        // These are no longer needed since the form has been completed
        await cancelSessionMessages(session_id, 'form_reminder%');
        await cancelSessionMessages(session_id, 'video_testimonial');

        // Step 2: Send Message #6 (Form Summary) immediately to WhatsApp
        const formSummaryMessage = getMessage(MESSAGE_TYPES.FORM_SUMMARY, {
            name: formData.name || 'לקוח',
            ageGroup: formData.age || 'לא צוין',
            financialGoal: formData.goal || 'לא צוין',
            maritalStatus: formData.status || 'לא צוין',
            employmentStatus: formData.employment || 'לא צוין',
            pensionContributions: formData.pension || 'לא צוין',
            monthlySalary: formData.salary || 'לא צוין',
            pensionCapital: formData.pensionAmount || 'לא צוין',
            savingsAndInvestments: formData.savings || 'לא צוין',
            investmentLocation: formData.investments || 'לא צוין',
            mortgage: formData.mortgage || 'לא צוין'
        });

        // Send with chat_id if available, otherwise phone conversion will happen automatically
        await sendWhatsAppMessage(session.phone_number, formSummaryMessage, null, session.chat_id);

        // Step 3: Send Message #7 (Appointment Link) immediately
        const appointmentLinkMessage = getMessage(MESSAGE_TYPES.APPOINTMENT_LINK);
        await sendWhatsAppMessage(session.phone_number, appointmentLinkMessage, null, session.chat_id);

        // Step 4: Schedule appointment reminders (Messages #8-11)
        const appointmentLinkSentTime = getNowInIsrael();
        await scheduleAppointmentReminders(
            session_id,
            session.phone_number,
            appointmentLinkSentTime
        );

        // Update or Create lead in Monday.com with form data
        // Check if session has an existing Monday.com item ID (created during trigger)
        const existingMondayItemId = session.form_data?.monday_item_id;
        let mondayResponse;

        if (existingMondayItemId) {
            // Update existing lead with form data
            console.log(`📝 Updating existing Monday.com lead: ${existingMondayItemId}`);
            mondayResponse = await updateLead(existingMondayItemId, {
                name: formData.name,
                phone_number: session.phone_number,
                ...formData
            });
        } else {
            // No existing lead - create new one
            console.log(`📝 Creating new Monday.com lead (no existing item ID)`);
            mondayResponse = await createLead({
                name: formData.name,
                phone_number: session.phone_number,
                ...formData
            });
        }

        console.log(`✅ Form submitted successfully for session: ${session_id}, Lead ID: ${leadId}`);

        return res.json({
            success: true,
            message: 'Form submitted successfully',
            lead_id: leadId,
            monday_item_id: mondayResponse.itemId
        });

    } catch (error) {
        console.error('❌ Error submitting form:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: 'מצטער/ת, משהו השתבש. אנא נסה/י שוב.'
        });
    }
};

/**
 * Generate unique lead ID for CRM tracking
 * Format: LEAD-YYYYMMDDHHMMSS-XXX
 * Example: LEAD-20251027111419-A3F
 */
function generateLeadId() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    // Generate random 3-character suffix for extra uniqueness
    const suffix = Math.random().toString(36).substring(2, 5).toUpperCase();

    return `LEAD-${year}${month}${day}${hours}${minutes}${seconds}-${suffix}`;
}
