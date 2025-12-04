/**
 * LID Mapping Helper
 * Stores and retrieves LID (Linked ID) to Phone Number mappings
 *
 * LID is Meta's privacy feature for Click-to-WhatsApp (CTWA) ad contacts.
 * This module captures phone numbers from Baileys contact events and stores them.
 */

let dbPool = null;

function setDbPool(pool) {
    dbPool = pool;
}

/**
 * Store a LID to Phone Number mapping
 * @param {string} lid - The LID (e.g., "203461241139302")
 * @param {string} phoneNumber - The phone number (e.g., "972509969977")
 * @param {string} name - Optional contact name
 */
async function storeLidMapping(lid, phoneNumber, name = null) {
    if (!dbPool) {
        console.error('❌ [LID-MAPPING] Database pool not initialized');
        return false;
    }

    if (!lid || !phoneNumber) {
        return false;
    }

    // Clean up the values
    const cleanLid = lid.split('@')[0]; // Remove @lid suffix if present
    const cleanPhone = phoneNumber.split('@')[0]; // Remove @s.whatsapp.net suffix if present

    try {
        await dbPool.query(`
            INSERT INTO lid_mappings (lid, phone_number, name, updated_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (lid) DO UPDATE SET
                phone_number = EXCLUDED.phone_number,
                name = COALESCE(EXCLUDED.name, lid_mappings.name),
                updated_at = NOW()
        `, [cleanLid, cleanPhone, name]);

        console.log(`📇 [LID-MAPPING] Stored: ${cleanLid} → ${cleanPhone}${name ? ` (${name})` : ''}`);
        return true;
    } catch (error) {
        console.error('❌ [LID-MAPPING] Error storing mapping:', error.message);
        return false;
    }
}

/**
 * Get phone number from LID
 * @param {string} lid - The LID to look up
 * @returns {string|null} - Phone number or null if not found
 */
async function getPhoneFromLid(lid) {
    if (!dbPool || !lid) {
        return null;
    }

    const cleanLid = lid.split('@')[0];

    try {
        const result = await dbPool.query(
            'SELECT phone_number FROM lid_mappings WHERE lid = $1',
            [cleanLid]
        );

        if (result.rows.length > 0) {
            return result.rows[0].phone_number;
        }
        return null;
    } catch (error) {
        console.error('❌ [LID-MAPPING] Error getting phone:', error.message);
        return null;
    }
}

/**
 * Get LID from phone number (reverse lookup)
 * @param {string} phoneNumber - The phone number to look up
 * @returns {string|null} - LID or null if not found
 */
async function getLidFromPhone(phoneNumber) {
    if (!dbPool || !phoneNumber) {
        return null;
    }

    const cleanPhone = phoneNumber.split('@')[0];

    try {
        const result = await dbPool.query(
            'SELECT lid FROM lid_mappings WHERE phone_number = $1',
            [cleanPhone]
        );

        if (result.rows.length > 0) {
            return result.rows[0].lid;
        }
        return null;
    } catch (error) {
        console.error('❌ [LID-MAPPING] Error getting LID:', error.message);
        return null;
    }
}

/**
 * Get all LID mappings (for debugging)
 * @returns {Array} - Array of all mappings
 */
async function getAllMappings() {
    if (!dbPool) {
        return [];
    }

    try {
        const result = await dbPool.query(
            'SELECT lid, phone_number, name, created_at, updated_at FROM lid_mappings ORDER BY updated_at DESC LIMIT 100'
        );
        return result.rows;
    } catch (error) {
        console.error('❌ [LID-MAPPING] Error getting all mappings:', error.message);
        return [];
    }
}

module.exports = {
    setDbPool,
    storeLidMapping,
    getPhoneFromLid,
    getLidFromPhone,
    getAllMappings
};
