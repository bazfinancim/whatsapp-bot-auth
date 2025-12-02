require('dotenv').config();
const { Pool } = require('pg');

const phoneNumber = '972509969977';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function clearSession() {
    try {
        const result = await pool.query(
            'DELETE FROM whatsapp_sessions WHERE phone_number = $1',
            [phoneNumber]
        );
        
        console.log(`✅ Cleared session for ${phoneNumber}`);
        console.log(`   Rows deleted: ${result.rowCount}`);
        
        await pool.end();
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

clearSession();
