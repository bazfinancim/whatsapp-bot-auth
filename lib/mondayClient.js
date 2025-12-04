/**
 * Monday.com API Client
 *
 * Direct integration with Monday.com API to create leads.
 * Replaces the previous Make.com webhook integration.
 */

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;
const MONDAY_BOARD_ID = process.env.MONDAY_BOARD_ID || '1682160309';

// Column ID mapping for the leads board
const COLUMN_IDS = {
    phone: 'lead_phone',
    age: 'text_mky9mxvj',
    goal: 'text_mky9afk9',
    familyStatus: 'text_mky910dn',
    employment: 'text_mky922qm',
    pensionContributions: 'text_mky9z7kz',
    salary: 'text_mky9bspx',
    pensionCapital: 'text_mky9nmrp',
    savings: 'text_mky9m0h3',
    investments: 'text_mky9gpfx',
    knowsReturn: 'text_mky9qspa',
    returnRate: 'text_mky9sd34',
    mortgage: 'text_mky9pw11',
    leadStatus: 'color__1'
};

/**
 * Format phone number for Monday.com phone column
 * @param {string} phone - Phone number
 * @returns {object} Formatted phone object
 */
function formatPhone(phone) {
    if (!phone) return null;

    // Clean the phone number
    const cleaned = phone.replace(/\D/g, '');

    return {
        phone: cleaned,
        countryShortName: 'IL'
    };
}

/**
 * Build column values object for Monday.com
 * @param {object} formData - Form submission data
 * @param {string} phoneNumber - Customer phone number
 * @returns {string} JSON string of column values
 */
function buildColumnValues(formData, phoneNumber) {
    const columnValues = {};

    // Phone number
    if (phoneNumber) {
        columnValues[COLUMN_IDS.phone] = formatPhone(phoneNumber);
    }

    // Text fields - direct mapping
    if (formData.age) {
        columnValues[COLUMN_IDS.age] = formData.age;
    }

    if (formData.goal) {
        columnValues[COLUMN_IDS.goal] = formData.goal;
    }

    if (formData.status) {
        columnValues[COLUMN_IDS.familyStatus] = formData.status;
    }

    if (formData.employment) {
        columnValues[COLUMN_IDS.employment] = formData.employment;
    }

    if (formData.pension) {
        columnValues[COLUMN_IDS.pensionContributions] = formData.pension;
    }

    if (formData.salary) {
        columnValues[COLUMN_IDS.salary] = formData.salary;
    }

    if (formData.pensionAmount) {
        columnValues[COLUMN_IDS.pensionCapital] = formData.pensionAmount;
    }

    if (formData.savings) {
        columnValues[COLUMN_IDS.savings] = formData.savings;
    }

    if (formData.investments) {
        columnValues[COLUMN_IDS.investments] = formData.investments;
    }

    if (formData.knowsReturn) {
        columnValues[COLUMN_IDS.knowsReturn] = formData.knowsReturn;
    }

    if (formData.return) {
        columnValues[COLUMN_IDS.returnRate] = formData.return;
    }

    if (formData.mortgage) {
        columnValues[COLUMN_IDS.mortgage] = formData.mortgage;
    }

    // Set lead status to "ליד חדש" (index 0)
    columnValues[COLUMN_IDS.leadStatus] = { index: 0 };

    return JSON.stringify(columnValues);
}

/**
 * Create a new lead in Monday.com
 * @param {object} data - Lead data including formData, phone_number, name, etc.
 * @returns {Promise<object>} Monday.com API response
 */
async function createLead(data) {
    if (!MONDAY_API_TOKEN) {
        throw new Error('MONDAY_API_TOKEN environment variable is not set');
    }

    const { name, phone_number, ...formData } = data;
    const itemName = name || 'ליד חדש';
    const columnValues = buildColumnValues(formData, phone_number);

    const query = `
        mutation {
            create_item (
                board_id: ${MONDAY_BOARD_ID},
                item_name: "${itemName.replace(/"/g, '\\"')}",
                column_values: ${JSON.stringify(columnValues)}
            ) {
                id
                name
            }
        }
    `;

    console.log('📤 Creating lead in Monday.com:', itemName);

    try {
        const response = await fetch(MONDAY_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': MONDAY_API_TOKEN
            },
            body: JSON.stringify({ query })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Monday.com API error (${response.status}): ${errorText}`);
        }

        const result = await response.json();

        if (result.errors) {
            console.error('❌ Monday.com GraphQL errors:', result.errors);
            throw new Error(`Monday.com GraphQL error: ${result.errors[0]?.message || 'Unknown error'}`);
        }

        console.log('✅ Lead created in Monday.com:', result.data?.create_item);

        return {
            success: true,
            itemId: result.data?.create_item?.id,
            itemName: result.data?.create_item?.name
        };

    } catch (error) {
        console.error('❌ Error creating lead in Monday.com:', error);
        throw error;
    }
}

/**
 * Update an existing lead in Monday.com
 * @param {string} itemId - Monday.com item ID
 * @param {object} data - Lead data including formData, name, etc.
 * @returns {Promise<object>} Monday.com API response
 */
async function updateLead(itemId, data) {
    if (!MONDAY_API_TOKEN) {
        throw new Error('MONDAY_API_TOKEN environment variable is not set');
    }

    if (!itemId) {
        throw new Error('itemId is required to update lead');
    }

    const { name, phone_number, ...formData } = data;
    const columnValues = buildColumnValues(formData, phone_number);

    // Build mutation - update name and columns
    const query = `
        mutation {
            change_multiple_column_values (
                board_id: ${MONDAY_BOARD_ID},
                item_id: ${itemId},
                column_values: ${JSON.stringify(columnValues)}
            ) {
                id
                name
            }
            ${name ? `change_simple_column_value (
                board_id: ${MONDAY_BOARD_ID},
                item_id: ${itemId},
                column_id: "name",
                value: "${name.replace(/"/g, '\\"')}"
            ) {
                id
                name
            }` : ''}
        }
    `;

    console.log('📤 Updating lead in Monday.com:', itemId);

    try {
        const response = await fetch(MONDAY_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': MONDAY_API_TOKEN
            },
            body: JSON.stringify({ query })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Monday.com API error (${response.status}): ${errorText}`);
        }

        const result = await response.json();

        if (result.errors) {
            console.error('❌ Monday.com GraphQL errors:', result.errors);
            throw new Error(`Monday.com GraphQL error: ${result.errors[0]?.message || 'Unknown error'}`);
        }

        console.log('✅ Lead updated in Monday.com:', itemId);

        return {
            success: true,
            itemId: itemId
        };

    } catch (error) {
        console.error('❌ Error updating lead in Monday.com:', error);
        throw error;
    }
}

module.exports = {
    createLead,
    updateLead,
    COLUMN_IDS
};
