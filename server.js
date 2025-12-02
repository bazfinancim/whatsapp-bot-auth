const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, jidNormalizedUser } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const cron = require('node-cron');
const axios = require('axios');
const stupidBot = require('./stupid-bot');
const { migrateReminderColumns } = require('./lib/database-migration');
const { initializeScheduler, checkAndSendReminders, getReminderStats } = require('./lib/reminder-scheduler');

// =============================================================================
// IMMEDIATE SESSION RESET (runs BEFORE server starts)
// This is critical for recovering from Baileys version upgrades
// =============================================================================
if (process.env.FORCE_SESSION_RESET === 'true') {
    const sessionPath = process.env.WHATSAPP_SESSION_PATH || './whatsapp-sessions';
    console.log('⚠️  [STARTUP] FORCE_SESSION_RESET is set - clearing session IMMEDIATELY');
    console.log(`📁 [STARTUP] Session path: ${sessionPath}`);
    try {
        if (fs.existsSync(sessionPath)) {
            // Don't delete the directory itself (it may be a mount point like /data)
            // Instead, delete all contents inside it
            const files = fs.readdirSync(sessionPath);
            console.log(`📂 [STARTUP] Found ${files.length} items to delete: ${files.join(', ')}`);
            for (const file of files) {
                const filePath = path.join(sessionPath, file);
                fs.rmSync(filePath, { recursive: true, force: true });
                console.log(`🗑️  [STARTUP] Deleted: ${file}`);
            }
            console.log('✅ [STARTUP] Session files cleared successfully');
        } else {
            console.log('ℹ️  [STARTUP] No session directory found');
        }
    } catch (e) {
        console.error('❌ [STARTUP] Failed to clear session:', e.message);
    }
}

const app = express();
const port = process.env.PORT || 10000;

// Sales phone numbers that should have bot enabled (comma-separated, support Israeli format)
// Example: "0548294343,972548294343" or just "972548294343"
const SALES_PHONE_NUMBERS = (process.env.SALES_PHONE_NUMBERS || process.env.SALES_PHONE_NUMBER || '')
    .split(',')
    .map(num => num.trim())
    .filter(num => num.length > 0)
    .map(num => {
        // Normalize Israeli numbers: 054XXXXXXX -> 972548XXXXXX
        if (num.startsWith('0')) {
            return '972' + num.substring(1);
        }
        return num;
    });

// Bot enabled flag - determined after WhatsApp authentication
let isBotEnabled = false;

// CORS configuration - environment-based origins
const getAllowedOrigins = () => {
    // Always include bot frontend URL
    const baseOrigins = [
        'https://whatsapp-bot-frontend-ujd6.onrender.com',
        process.env.ADDITIONAL_ORIGIN
    ].filter(Boolean);

    if (process.env.NODE_ENV === 'production') {
        // Production: Allow both production and test frontend URLs
        return [
            ...baseOrigins,
            'https://whatsapp-react-web-prod.onrender.com',
            'https://whatsapp-react-web-test.onrender.com',
            'https://whatsapp-dashboard-production.onrender.com'
        ];
    }

    // Development & Staging: Allow localhost and staging URLs
    return [
        ...baseOrigins,
        'http://localhost:5173',  // Vite dev server (web app)
        'http://localhost:3000',  // Next.js dev server (dashboard)
        'http://localhost:1100',
        'http://localhost:1001',
        'https://whatsapp-web-app-staging.onrender.com',
        'https://whatsapp-dashboard-staging.onrender.com',
        'https://whatsapp-react-web-test.onrender.com'
    ];
};

const corsOptions = {
  origin: getAllowedOrigins(),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
};

// Rate limiting configuration for message endpoints
const messageLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute window
    max: 30, // Max 30 messages per minute per IP
    message: {
        error: 'Too many messages sent. Please wait a moment before trying again.',
        retryAfter: '1 minute'
    },
    standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
    legacyHeaders: false, // Disable `X-RateLimit-*` headers
    // Skip rate limiting in development mode
    skip: (req) => process.env.NODE_ENV === 'development'
});

// Middleware
app.use(cors(corsOptions));
// Increase body size limit to 20MB to support large media files (images, videos)
// Base64 encoding adds ~33% overhead: 16MB file = ~21MB base64
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

// PRIVACY: PII-safe logger utility
const createLogger = () => {
    const isProd = process.env.NODE_ENV === 'production';

    return {
        info: (message, data = null) => {
            if (isProd && data) {
                // Production: no PII, only message
                console.log(message);
            } else {
                // Development/Staging: full details
                console.log(message, data || '');
            }
        },
        warn: (message, data = null) => {
            console.warn(message, data || '');
        },
        error: (message, error = null) => {
            console.error(message, error || '');
        },
        debug: (message, data = null) => {
            if (!isProd) {
                console.log(`[DEBUG] ${message}`, data || '');
            }
        }
    };
};

const logger = createLogger();

// PostgreSQL connection pool (if DATABASE_URL is set)
let dbPool = null;
if (process.env.DATABASE_URL) {
    dbPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });
    logger.info('📊 PostgreSQL connection pool initialized');
}

// Initialize database schema
async function initializeDatabase() {
    if (!dbPool) return;

    try {
        // Create templates table
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS templates (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Note: sessions table is managed by avi-website and shared between services
        // No need to create it here - it already exists in the shared Frankfurt database

        // Migrate reminder columns to sessions table
        await migrateReminderColumns(dbPool);

        logger.info('✅ Database schema initialized (templates + reminder columns)');

        // Migrate from JSON file to database if templates exist in file but not in DB
        const result = await dbPool.query('SELECT COUNT(*) FROM templates');
        if (result.rows[0].count === '0') {
            const jsonTemplates = loadTemplatesFromFile();
            if (jsonTemplates.length > 0) {
                logger.info('📦 Migrating templates from JSON to database...');
                for (const template of jsonTemplates) {
                    await dbPool.query(
                        'INSERT INTO templates (id, name, content) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
                        [template.id, template.name, template.content]
                    );
                }
                logger.info(`✅ Migrated ${jsonTemplates.length} templates to database`);
            }
        }
    } catch (error) {
        logger.error('Error initializing database:', error);
    }
}

// WhatsApp client state
let client = null;
let qrString = null;
let isConnected = false;
let isAuthenticated = false;

// Note: makeInMemoryStore was removed from Baileys 6.7.x
// LID resolution now relies on message fields (remoteJidAlt, participant)

/**
 * Resolve LID (Linked ID) to real phone number
 * Meta uses LID format (XXXXXX@lid) for privacy, but we need the real phone number
 * @param {string} jid - The JID (can be phone@s.whatsapp.net or lid@lid)
 * @param {object} msg - The message object (may contain remoteJidAlt)
 * @returns {string} - Resolved JID with real phone number
 */
function resolveLidToPhone(jid, msg = null) {
    if (!jid) return jid;

    // Check if this is a LID format
    if (jid.includes('@lid')) {
        const lid = jid.split('@')[0];
        logger.info(`🔍 [LID-RESOLVE] Resolving LID: ${lid}`);

        // Method 1: Check message's remoteJidAlt field (alternate JID with real phone)
        if (msg?.key?.remoteJidAlt) {
            logger.info(`✅ [LID-RESOLVE] Found remoteJidAlt: ${msg.key.remoteJidAlt}`);
            return msg.key.remoteJidAlt;
        }

        // Method 2: Check if msg has participant field (contains real JID in groups)
        if (msg?.key?.participant) {
            logger.info(`✅ [LID-RESOLVE] Found participant: ${msg.key.participant}`);
            return msg.key.participant;
        }

        // Fallback: Return original LID (bot will use it as-is)
        logger.warn(`⚠️ [LID-RESOLVE] Could not resolve LID ${lid}, using as-is`);
        return jid;
    }

    // Not a LID, return as-is
    return jid;
}

// Health monitoring variables
let lastSuccessfulChatsFetch = null;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 3;
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
let connectionStatus = 'disconnected';

// Track pending background operations for graceful shutdown
const pendingOperations = new Set();

// Message templates storage - Load from JSON file
// Use persistent disk in production, local file in development
const TEMPLATES_FILE = process.env.TEMPLATES_PATH
  ? path.join(process.env.TEMPLATES_PATH, 'templates.json')
  : path.join(__dirname, 'templates.json');

// Helper functions for template management

// Load templates from JSON file (for migration and local dev)
const loadTemplatesFromFile = () => {
    try {
        if (fs.existsSync(TEMPLATES_FILE)) {
            const data = fs.readFileSync(TEMPLATES_FILE, 'utf8');
            return JSON.parse(data).templates || [];
        }
    } catch (error) {
        logger.error('Error loading templates from file:', error);
    }
    return [];
};

// Load templates from database or file
const loadTemplates = async () => {
    // Use PostgreSQL if available
    if (dbPool) {
        try {
            const result = await dbPool.query('SELECT id, name, content FROM templates ORDER BY id');
            return result.rows;
        } catch (error) {
            logger.error('Error loading templates from database:', error);
            return [];
        }
    }

    // Fallback to JSON file for local development
    return loadTemplatesFromFile();
};

// Save templates to JSON file (for local development only)
const saveTemplatesToFile = (templates) => {
    try {
        const dir = path.dirname(TEMPLATES_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(TEMPLATES_FILE, JSON.stringify({ templates }, null, 2), 'utf8');
        return true;
    } catch (error) {
        logger.error('Error saving templates to file:', error);
        return false;
    }
};

// Automatic recovery function - restarts WhatsApp client when hung
async function recoverWhatsAppClient() {
    logger.warn('🔄 [RECOVERY] Attempting to recover WhatsApp client...');

    try {
        if (client) {
            logger.info('🛑 [RECOVERY] Destroying existing client...');
            client.end(new Error('Client closed'));
            client = null;
        }

        // Reset state
        isConnected = false;
        isAuthenticated = false;
        connectionStatus = 'recovering';
        consecutiveFailures = 0;

        // Wait a bit before reinitializing
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Reinitialize
        logger.info('🚀 [RECOVERY] Reinitializing WhatsApp client...');
        initializeWhatsApp();

        logger.info('✅ [RECOVERY] Recovery initiated successfully');
    } catch (error) {
        logger.error(`❌ [RECOVERY] Recovery failed: ${error.message}`);
    }
}

// Periodic health check - monitors client health and triggers recovery if needed
async function performPeriodicHealthCheck() {
    // Only check if authenticated
    if (!isAuthenticated || !client) {
        return;
    }

    // Check if we've had too many consecutive failures
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        logger.error(`🚨 [HEALTH-MONITOR] Client appears hung (${consecutiveFailures} consecutive failures). Triggering recovery...`);
        await recoverWhatsAppClient();
        return;
    }

    // Check if last successful fetch was too long ago (10 minutes)
    if (lastSuccessfulChatsFetch) {
        const timeSinceLastSuccess = Date.now() - lastSuccessfulChatsFetch;
        const TEN_MINUTES = 10 * 60 * 1000;

        if (timeSinceLastSuccess > TEN_MINUTES) {
            logger.warn(`⚠️ [HEALTH-MONITOR] No successful chat fetch in ${Math.round(timeSinceLastSuccess / 60000)} minutes. Testing client...`);

            try {
                // Quick health test (5s timeout)
                await Promise.race([
                    client.getChats(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Health test timed out')), 5000)
                    )
                ]);

                logger.info('✅ [HEALTH-MONITOR] Client is responsive');
                lastSuccessfulChatsFetch = Date.now();
                consecutiveFailures = 0;
            } catch (error) {
                logger.error(`❌ [HEALTH-MONITOR] Client failed health test: ${error.message}`);
                consecutiveFailures++;

                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    logger.error('🚨 [HEALTH-MONITOR] Max failures reached. Triggering recovery...');
                    await recoverWhatsAppClient();
                }
            }
        }
    }
}

// Initialize WhatsApp client with Baileys (WebSocket-based, no browser needed!)
async function initializeWhatsApp() {
    // GUARD: Prevent creating multiple client instances
    if (client) {
        console.log('🛡️  Client already exists, skipping initialization');
        return;
    }

    console.log('Initializing WhatsApp client with Baileys...');

    // Use persistent storage if available (Render Disk), fallback to local
    const sessionPath = process.env.WHATSAPP_SESSION_PATH || './whatsapp-sessions';
    console.log(`Using session storage at: ${sessionPath}`);

    // Helper function to clear corrupted session
    const clearCorruptedSession = () => {
        console.log('🗑️  Clearing corrupted session files...');
        try {
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                console.log('✅ Corrupted session files cleared');
            }
        } catch (e) {
            console.error('Failed to clear session:', e.message);
        }
    };

    // Check for forced session reset (useful after Baileys version upgrade)
    if (process.env.FORCE_SESSION_RESET === 'true') {
        console.log('⚠️  FORCE_SESSION_RESET is set - clearing session before startup');
        clearCorruptedSession();
    }

    try {
        // Initialize auth state (replaces LocalAuth)
        let authResult;
        try {
            authResult = await useMultiFileAuthState(sessionPath);
        } catch (sessionError) {
            // Session files are corrupted (e.g., Bad MAC error after Baileys upgrade)
            console.error('⚠️  Session initialization failed:', sessionError.message);
            console.log('🔄 Attempting recovery by clearing corrupted session...');
            clearCorruptedSession();
            // Retry with fresh session
            authResult = await useMultiFileAuthState(sessionPath);
        }
        const { state, saveCreds } = authResult;

        // Get latest WhatsApp Web version
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

        // Create socket (Baileys client) - NO BROWSER NEEDED!
        client = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false, // We handle QR via API
            logger: P({ level: process.env.NODE_ENV === 'production' ? 'silent' : 'info' }),
            browser: ['WhatsApp Bot', 'Chrome', '110.0.0'],
            markOnlineOnConnect: true
        });

        // Event: Save credentials on update (CRITICAL for persistence)
        client.ev.on('creds.update', saveCreds);

        // Event: Connection updates (handles QR, ready, disconnected)
        client.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // QR Code received
            if (qr) {
                console.log('🔶 QR code received');
                qrString = qr;
                connectionStatus = 'qr_ready';
            }

            // Connection opened (ready)
            if (connection === 'open') {
                console.log('✅ WhatsApp client is ready!');
                isAuthenticated = true;
                isConnected = true;
                connectionStatus = 'authenticated';
                qrString = null;

                // Get authenticated number
                try {
                    const authenticatedNumber = client.user?.id?.split(':')[0];
                    if (authenticatedNumber) {
                        logger.info(`📱 Authenticated WhatsApp number: ${authenticatedNumber}`);

                        // Check if this number is in the sales phone numbers list
                        if (SALES_PHONE_NUMBERS.includes(authenticatedNumber)) {
                            isBotEnabled = true;
                            logger.info(`🤖 [BOT-ACTIVATION] Bot ENABLED for phone number ${authenticatedNumber}`);
                        } else {
                            isBotEnabled = false;
                            logger.info(`🤖 [BOT-ACTIVATION] Bot DISABLED - phone ${authenticatedNumber} not in sales numbers [${SALES_PHONE_NUMBERS.join(', ')}]`);
                        }
                    } else {
                        logger.warn('⚠️  Could not determine authenticated phone number, bot disabled');
                        isBotEnabled = false;
                    }
                } catch (error) {
                    logger.error('❌ Error checking phone number for bot activation:', error);
                    isBotEnabled = false;
                }

                // Initialize reminder scheduler if bot is enabled and database is available
                if (isBotEnabled && dbPool) {
                    initializeScheduler(dbPool, client, logger);

                    // Start cron job to check for reminders every 5 minutes
                    const checkInterval = process.env.REMINDER_CHECK_INTERVAL || '5';
                    cron.schedule(`*/${checkInterval} * * * *`, async () => {
                        await checkAndSendReminders();
                    });

                    logger.info(`⏰ Reminder scheduler started (checking every ${checkInterval} minutes)`);
                }

                // Start periodic health monitoring (every 5 minutes)
                cron.schedule('*/5 * * * *', async () => {
                    await performPeriodicHealthCheck();
                });
                logger.info('🏥 Health monitoring started (checking every 5 minutes)');
            }

            // Connection closed (disconnected)
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                    : true;

                console.log(`⚠️  Connection closed: ${lastDisconnect?.error?.message}`);
                connectionStatus = 'disconnected';
                isAuthenticated = false;
                isConnected = false;
                qrString = null;

                if (shouldReconnect) {
                    console.log('🔄 Preparing to reconnect...');

                    // Clean up
                    if (client) {
                        client.ev.removeAllListeners();
                        client = null;
                    }

                    // Reconnect after delay
                    setTimeout(() => {
                        console.log('🔄 Reinitializing WhatsApp client...');
                        initializeWhatsApp();
                    }, 5000);
                } else {
                    console.log('🛑 Logged out - not reconnecting');
                }
            }
        });

        // Event: Incoming messages (replaces 'message' event)
        client.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return; // Only handle new messages

            for (const msg of messages) {
                try {
                    // Skip group messages
                    if (msg.key.remoteJid?.includes('@g.us')) continue;

                    // Skip messages from self
                    if (msg.key.fromMe) continue;

                    // Skip if bot is disabled
                    if (!isBotEnabled) continue;

                    // Get message text
                    const messageText = msg.message?.conversation
                        || msg.message?.extendedTextMessage?.text
                        || '';

                    if (!messageText) continue;

                    // Resolve LID to real phone number if needed
                    const rawChatId = msg.key.remoteJid;
                    const chatId = resolveLidToPhone(rawChatId, msg);

                    // Log if LID was resolved
                    if (rawChatId !== chatId) {
                        logger.info(`📱 [LID-RESOLVED] ${rawChatId} -> ${chatId}`);
                    }

                    // Check for trigger message FIRST (stupid-bot has priority)
                    if (stupidBot.isTriggerMessage(messageText)) {
                        const senderName = msg.pushName || 'Unknown';
                        logger.info(`🤖 [STUPID-BOT] Trigger from ${chatId} (${senderName}): "${messageText}"`);
                        await stupidBot.handleTriggerMessage(client, chatId, logger, dbPool, senderName);
                        return; // Message handled by stupid-bot
                    }

                    // If not a trigger, forward to avi-website API (avi-chatbot)
                    const aviWebsiteUrl = process.env.AVI_WEBSITE_API_URL;

                    if (aviWebsiteUrl) {
                        try {
                            const phoneNumber = chatId.split('@')[0];

                            logger.info(`📨 [AVI-CHATBOT] Forwarding message from ${phoneNumber}: "${messageText}"`);

                            const response = await fetch(`${aviWebsiteUrl}/api/whatsapp/message`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    phone: phoneNumber,
                                    message: messageText,
                                    name: msg.pushName || phoneNumber,
                                    chat_id: chatId
                                })
                            });

                            if (!response.ok) {
                                throw new Error(`API returned ${response.status}`);
                            }

                            const data = await response.json();

                            if (data.success && data.message) {
                                await client.sendMessage(chatId, { text: data.message });
                                logger.info(`✅ [AVI-CHATBOT] Sent response to ${phoneNumber}`);
                            }

                            return; // Message handled by avi-chatbot
                        } catch (error) {
                            logger.error('❌ [AVI-CHATBOT] Error:', error);
                        }
                    }
                } catch (error) {
                    logger.error('🤖 Error processing message:', error);
                }
            }
        });

        console.log('✅ WhatsApp client initialized with Baileys');

    } catch (error) {
        console.error('❌ Failed to initialize WhatsApp client:', error);
        client = null;

        // Retry after 10 seconds
        setTimeout(() => {
            console.log('🔄 Retrying initialization...');
            initializeWhatsApp();
        }, 10000);
    }
}

// STABILITY: Wrap message sending to track pending operations
async function sendMessageAsync(client, chatId, message) {
    const operationId = `msg-${Date.now()}-${Math.random()}`;
    pendingOperations.add(operationId);

    try {
        // Baileys requires { text: message } format
        await client.sendMessage(chatId, { text: message });
        console.log(`✓ Message sent successfully (${operationId})`);
        return true;
    } catch (error) {
        console.error(`✗ Failed to send message (${operationId}):`, error.message);
        return false;
    } finally {
        pendingOperations.delete(operationId);
    }
}

// Send media message from URL - Baileys version (FIXES VIDEO CODEC ISSUES!)
async function sendMediaFromUrl(client, chatId, caption, mediaUrl) {
    const operationId = `media-${Date.now()}-${Math.random()}`;
    pendingOperations.add(operationId);

    try {
        console.log(`📥 [MEDIA] Sending from: ${mediaUrl} (${operationId})`);

        // Determine media type from URL
        const isVideo = mediaUrl.match(/\.(mp4|mov|avi|mkv|webm)($|\?)/i);
        const isImage = mediaUrl.match(/\.(jpg|jpeg|png|gif|webp)($|\?)/i);

        if (isVideo) {
            // VIDEO - Direct URL streaming (NO CHROMIUM CODEC ISSUES!)
            // Baileys streams directly via WebSocket, no browser needed
            await client.sendMessage(chatId, {
                video: { url: mediaUrl },
                caption: caption || '',
                gifPlayback: mediaUrl.includes('gif'), // For animated content
                mimetype: 'video/mp4'
            });

            console.log(`✓ [MEDIA] Video sent successfully (${operationId})`);
        } else if (isImage) {
            // IMAGE
            await client.sendMessage(chatId, {
                image: { url: mediaUrl },
                caption: caption || ''
            });

            console.log(`✓ [MEDIA] Image sent successfully (${operationId})`);
        } else {
            // DOCUMENT (fallback for other files)
            await client.sendMessage(chatId, {
                document: { url: mediaUrl },
                caption: caption || '',
                mimetype: 'application/octet-stream',
                fileName: mediaUrl.split('/').pop().split('?')[0]
            });

            console.log(`✓ [MEDIA] Document sent successfully (${operationId})`);
        }

        return true;

    } catch (error) {
        console.error(`❌ [MEDIA] Failed (${operationId}):`, error.message);

        // Fallback: text only
        try {
            await client.sendMessage(chatId, { text: `${caption}\n\n[Media: ${mediaUrl}]` });
            console.log(`✓ [MEDIA] Sent text fallback (${operationId})`);
        } catch (fallbackError) {
            console.error(`❌ [MEDIA] Text fallback failed (${operationId}):`, fallbackError.message);
        }

        return false;
    } finally {
        pendingOperations.delete(operationId);
    }
}

// Routes
app.get('/', (req, res) => {
    res.json({
        message: 'WhatsApp Authentication Service',
        status: connectionStatus,
        authenticated: isAuthenticated,
        connected: isConnected
    });
});

app.get('/api/health', (req, res) => {
    const timeSinceLastSuccess = lastSuccessfulChatsFetch
        ? Date.now() - lastSuccessfulChatsFetch
        : null;

    res.json({
        status: 'healthy',
        whatsapp_status: connectionStatus,
        authenticated: isAuthenticated,
        connected: isConnected,
        last_successful_fetch: lastSuccessfulChatsFetch
            ? new Date(lastSuccessfulChatsFetch).toISOString()
            : 'never',
        time_since_last_success_ms: timeSinceLastSuccess,
        consecutive_failures: consecutiveFailures,
        client_responsive: consecutiveFailures < MAX_CONSECUTIVE_FAILURES
    });
});

// Deep health check - actually tests if client can fetch chats
app.get('/api/health/deep', async (req, res) => {
    if (!isAuthenticated || !client) {
        return res.json({
            status: 'unhealthy',
            reason: 'Not authenticated',
            authenticated: isAuthenticated,
            connected: isConnected
        });
    }

    try {
        // Test if client.getChats() is responsive (with 5s timeout for health check)
        await Promise.race([
            client.getChats(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Health check timed out')), 5000)
            )
        ]);

        return res.json({
            status: 'healthy',
            client_responsive: true,
            last_check: new Date().toISOString()
        });
    } catch (error) {
        logger.error(`❌ [HEALTH-CHECK] Deep health check failed: ${error.message}`);
        return res.json({
            status: 'unhealthy',
            reason: error.message,
            client_responsive: false,
            last_check: new Date().toISOString()
        });
    }
});

// Get message templates
app.get('/api/templates', async (req, res) => {
    try {
        logger.info('Fetching message templates');
        const templates = await loadTemplates();
        res.json({ templates });
    } catch (error) {
        logger.error('Error fetching templates:', error);
        res.status(500).json({ error: 'Failed to fetch templates' });
    }
});

// Create new template
app.post('/api/templates', async (req, res) => {
    try {
        const { name, content } = req.body;

        if (!name || !content) {
            return res.status(400).json({ error: 'Name and content are required' });
        }

        if (dbPool) {
            // Use PostgreSQL
            const result = await dbPool.query(
                'INSERT INTO templates (name, content) VALUES ($1, $2) RETURNING id, name, content',
                [name.trim(), content.trim()]
            );
            const newTemplate = result.rows[0];
            logger.info('Created new template:', newTemplate.name);
            res.status(201).json({ template: newTemplate });
        } else {
            // Use JSON file for local development
            const templates = await loadTemplates();
            const newId = templates.length === 0 ? 1 : Math.max(...templates.map(t => t.id)) + 1;
            const newTemplate = {
                id: newId,
                name: name.trim(),
                content: content.trim()
            };
            templates.push(newTemplate);

            if (saveTemplatesToFile(templates)) {
                logger.info('Created new template:', newTemplate.name);
                res.status(201).json({ template: newTemplate });
            } else {
                res.status(500).json({ error: 'Failed to save template' });
            }
        }
    } catch (error) {
        logger.error('Error creating template:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update template
app.put('/api/templates/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { name, content } = req.body;

        if (!name || !content) {
            return res.status(400).json({ error: 'Name and content are required' });
        }

        if (dbPool) {
            // Use PostgreSQL
            const result = await dbPool.query(
                'UPDATE templates SET name = $1, content = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING id, name, content',
                [name.trim(), content.trim(), id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Template not found' });
            }

            const updatedTemplate = result.rows[0];
            logger.info('Updated template:', updatedTemplate.name);
            res.json({ template: updatedTemplate });
        } else {
            // Use JSON file for local development
            const templates = await loadTemplates();
            const index = templates.findIndex(t => t.id === id);

            if (index === -1) {
                return res.status(404).json({ error: 'Template not found' });
            }

            templates[index] = {
                id,
                name: name.trim(),
                content: content.trim()
            };

            if (saveTemplatesToFile(templates)) {
                logger.info('Updated template:', templates[index].name);
                res.json({ template: templates[index] });
            } else {
                res.status(500).json({ error: 'Failed to save template' });
            }
        }
    } catch (error) {
        logger.error('Error updating template:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete template
app.delete('/api/templates/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);

        if (dbPool) {
            // Use PostgreSQL
            const result = await dbPool.query(
                'DELETE FROM templates WHERE id = $1 RETURNING id, name, content',
                [id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Template not found' });
            }

            const deletedTemplate = result.rows[0];
            logger.info('Deleted template:', deletedTemplate.name);
            res.json({ success: true, template: deletedTemplate });
        } else {
            // Use JSON file for local development
            const templates = await loadTemplates();
            const index = templates.findIndex(t => t.id === id);

            if (index === -1) {
                return res.status(404).json({ error: 'Template not found' });
            }

            const deletedTemplate = templates.splice(index, 1)[0];

            if (saveTemplatesToFile(templates)) {
                logger.info('Deleted template:', deletedTemplate.name);
                res.json({ success: true, template: deletedTemplate });
            } else {
                res.status(500).json({ error: 'Failed to save templates' });
            }
        }
    } catch (error) {
        logger.error('Error deleting template:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/auth/status', (req, res) => {
    res.json({
        status: connectionStatus,
        authenticated: isAuthenticated,
        connected: isConnected,
        hasQR: !!qrString
    });
});

// QR Code HTML viewer page
app.get('/qr', (req, res) => {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp QR Code</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 20px;
            padding: 40px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 500px;
            width: 100%;
            text-align: center;
        }
        h1 { color: #333; margin-bottom: 30px; font-size: 28px; }
        #qrcode {
            background: #f5f5f5;
            border-radius: 15px;
            padding: 30px;
            margin: 20px 0;
            min-height: 300px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        #qrcode img { max-width: 100%; height: auto; border-radius: 10px; }
        .spinner {
            border: 4px solid #f3f3f3;
            border-top: 4px solid #667eea;
            border-radius: 50%;
            width: 50px;
            height: 50px;
            animation: spin 1s linear infinite;
        }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .instructions {
            background: #f8f9fa;
            border-radius: 10px;
            padding: 20px;
            margin-top: 20px;
            text-align: left;
        }
        .instructions h3 { color: #667eea; margin-bottom: 15px; font-size: 18px; }
        .instructions ol { padding-left: 20px; }
        .instructions li { margin: 8px 0; color: #555; line-height: 1.6; }
        .status { font-size: 14px; color: #666; margin-top: 15px; padding: 10px; background: #e8f5e9; border-radius: 8px; }
        .status.error { background: #ffebee; color: #c62828; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔐 WhatsApp Authentication</h1>
        <div id="qrcode">
            <div class="spinner"></div>
        </div>
        <div id="status" class="status">Loading...</div>
        <div class="instructions">
            <h3>📱 How to scan:</h3>
            <ol>
                <li>Open WhatsApp on your phone</li>
                <li>Tap Menu or Settings</li>
                <li>Tap Linked Devices</li>
                <li>Tap Link a Device</li>
                <li>Point your phone at this screen to scan the QR code</li>
            </ol>
        </div>
    </div>
    <script>
        async function checkStatus() {
            try {
                const response = await fetch('/api/auth/qr');
                const data = await response.json();
                const qrcodeDiv = document.getElementById('qrcode');
                const statusDiv = document.getElementById('status');

                if (data.qrImage) {
                    qrcodeDiv.innerHTML = \`<img src="\${data.qrImage}" alt="QR Code" />\`;
                    statusDiv.textContent = 'Ready to scan!';
                    statusDiv.className = 'status';
                } else if (data.error) {
                    qrcodeDiv.innerHTML = '<p style="color: #666;">Generating QR code...</p>';
                    statusDiv.textContent = data.error;
                    statusDiv.className = 'status error';
                }
            } catch (error) {
                console.error('Error:', error);
            }
        }

        // Check immediately and then every 2 seconds
        checkStatus();
        setInterval(checkStatus, 2000);
    </script>
</body>
</html>
    `;
    res.send(html);
});

app.get('/api/auth/qr', async (req, res) => {
    try {
        if (!qrString) {
            return res.status(404).json({
                error: 'No QR code available',
                status: connectionStatus
            });
        }

        const qrCodeImage = await QRCode.toDataURL(qrString);
        res.json({
            qr: qrString,
            qrImage: qrCodeImage,
            status: connectionStatus
        });
    } catch (error) {
        console.error('Error generating QR code:', error);
        res.status(500).json({ error: 'Failed to generate QR code' });
    }
});

app.post('/api/auth/connect', (req, res) => {
    try {
        if (isConnected) {
            return res.json({
                message: 'Already connected',
                status: connectionStatus
            });
        }

        if (!client) {
            initializeWhatsApp();
        }

        res.json({
            message: 'Connection initiated',
            status: connectionStatus
        });
    } catch (error) {
        console.error('Error initiating connection:', error);
        res.status(500).json({ error: 'Failed to initiate connection' });
    }
});

// Clear session storage (for corrupted persistent disk)
app.post('/api/auth/clear-session', async (req, res) => {
    try {
        console.log('🗑️  Clearing session storage...');

        // Close existing client (Baileys uses end(), not destroy())
        if (client) {
            client.end(new Error('Session cleared by admin'));
            client = null;
        }

        // Clear session directory
        const sessionPath = process.env.WHATSAPP_SESSION_PATH || './whatsapp-sessions';
        const sessionDir = path.join(sessionPath, 'session');

        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
            console.log('✅ Session storage cleared');
        }

        // Reset state
        isAuthenticated = false;
        isConnected = false;
        connectionStatus = 'disconnected';
        qrString = null;

        res.json({
            success: true,
            message: 'Session storage cleared. Please scan QR code again.'
        });
    } catch (error) {
        console.error('Error clearing session:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to clear session',
            details: error.message
        });
    }
});

app.post('/api/auth/disconnect', async (req, res) => {
    try {
        if (client) {
            client.end(new Error('Client closed'));
            client = null;
        }

        isConnected = false;
        isAuthenticated = false;
        connectionStatus = 'disconnected';
        qrString = null;

        res.json({
            message: 'Disconnected successfully',
            status: connectionStatus
        });
    } catch (error) {
        console.error('Error disconnecting:', error);
        res.status(500).json({ error: 'Failed to disconnect' });
    }
});

app.post('/api/auth/reset', async (req, res) => {
    try {
        // SECURITY: Require admin API key to reset session
        const apiKey = req.headers['x-api-key'];

        if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
            console.log('⚠️  [RESET] Unauthorized reset attempt - missing or invalid API key');
            return res.status(403).json({
                success: false,
                error: 'Unauthorized - Admin API key required'
            });
        }

        console.log('Resetting WhatsApp session...');

        // Destroy existing client
        if (client) {
            client.end(new Error('Client closed'));
            client = null;
        }

        // Reset state
        isConnected = false;
        isAuthenticated = false;
        connectionStatus = 'disconnected';
        qrString = null;

        // Backup and delete session files
        const fs = require('fs');
        const path = require('path');
        const sessionPath = process.env.WHATSAPP_SESSION_PATH || './whatsapp-sessions';

        console.log(`Processing session files at: ${sessionPath}`);

        if (fs.existsSync(sessionPath)) {
            // SECURITY: Backup session before deletion (prevents data loss)
            const backupDir = path.join(__dirname, 'session-backups');
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir, { recursive: true });
                console.log(`Created backup directory: ${backupDir}`);
            }

            // Create timestamped backup
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupPath = path.join(backupDir, `session-backup-${timestamp}`);

            try {
                fs.cpSync(sessionPath, backupPath, { recursive: true });
                console.log(`✓ Session backed up to: ${backupPath}`);
            } catch (error) {
                console.error('⚠️  Failed to backup session:', error.message);
                // Continue with deletion anyway, but log warning
            }

            // Now safe to delete
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log('✓ Session files deleted successfully');
        }

        // Re-initialize WhatsApp after a short delay
        setTimeout(() => {
            console.log('Re-initializing WhatsApp client...');
            initializeWhatsApp();
        }, 1000);

        res.json({
            success: true,
            message: 'WhatsApp session reset successfully. New QR code will be generated shortly.',
            status: connectionStatus
        });
    } catch (error) {
        console.error('Error resetting session:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to reset session',
            details: error.message
        });
    }
});

app.get('/api/auth/chats', async (req, res) => {
    try {
        if (!isAuthenticated || !client) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const chats = await client.getChats();

        // Fetch contact info for each chat (including pushname)
        const chatList = await Promise.all(chats.map(async (chat) => {
            let contactInfo = null;

            // For non-group chats, get contact details
            if (!chat.isGroup) {
                try {
                    const contact = await chat.getContact();
                    contactInfo = {
                        pushname: contact.pushname || null,
                        savedName: contact.name || null,
                        isMyContact: contact.isMyContact || false
                    };
                } catch (error) {
                    console.error(`Failed to get contact for ${chat.id}:`, error.message);
                }
            }

            return {
                id: chat.id._serialized,
                name: chat.name || 'Unknown',
                pushname: contactInfo?.pushname || null,
                savedName: contactInfo?.savedName || null,
                isMyContact: contactInfo?.isMyContact || false,
                isGroup: chat.isGroup,
                unreadCount: chat.unreadCount,
                lastMessage: chat.lastMessage ? {
                    body: chat.lastMessage.body,
                    timestamp: chat.lastMessage.timestamp,
                    from: chat.lastMessage.from
                } : null
            };
        }));

        res.json(chatList);
    } catch (error) {
        console.error('Error fetching chats:', error);
        res.status(500).json({ error: 'Failed to fetch chats' });
    }
});

// OPTIMIZED: Returns immediately (202 Accepted), sends message in background
app.post('/api/auth/send', messageLimiter, async (req, res) => {
    try {
        if (!isAuthenticated || !client) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const { chatId, message } = req.body;

        if (!chatId || !message) {
            return res.status(400).json({ error: 'chatId and message are required' });
        }

        // Return 202 Accepted immediately - don't wait for WhatsApp
        res.status(202).json({
            success: true,
            status: 'accepted',
            message: 'Message queued for sending',
            chatId: chatId,
            timestamp: new Date().toISOString()
        });

        // Send message in background (tracked for graceful shutdown)
        setImmediate(() => {
            sendMessageAsync(client, chatId, message);
        });
    } catch (error) {
        console.error('Error processing send request:', error);
        res.status(500).json({ error: 'Failed to process send request' });
    }
});

// Bridge-compatible endpoints for web app integration
// NOTE: This bot uses Baileys which doesn't support getChats() like whatsapp-web.js
// Chat history viewing is not available in this service
app.get('/api/chats', async (req, res) => {
    try {
        if (!isAuthenticated || !client) {
            return res.json({ success: true, data: [] });
        }

        // Baileys doesn't have getChats() - return empty with message
        logger.info('📊 [GET-CHATS] Chat listing not available (Baileys limitation)');

        res.json({
            success: true,
            data: [],
            message: 'Chat history viewing is not available in this bot service. Use the CSX frontend for chat viewing.'
        });
    } catch (error) {
        logger.error(`❌ [GET-CHATS] Error: ${error.message}`);
        res.json({ success: false, data: [], error: error.message });
    }
});

// NOTE: Baileys doesn't support getChatById/fetchMessages like whatsapp-web.js
app.get('/api/messages', async (req, res) => {
    res.json({
        success: true,
        data: [],
        message: 'Message history viewing is not available in this bot service.'
    });
});

// NOTE: Baileys doesn't support getChatById/fetchMessages like whatsapp-web.js
app.get('/api/messages/:chatId', async (req, res) => {
    res.json({
        success: true,
        data: [],
        message: 'Message history viewing is not available in this bot service.'
    });
});

// Download media for a specific message
app.get('/api/media/:chatId/:messageId', async (req, res) => {
    try {
        if (!isAuthenticated || !client) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const { chatId, messageId } = req.params;
        const decodedChatId = decodeURIComponent(chatId);

        // Get the chat and fetch messages to find the specific message
        const chat = await client.getChatById(decodedChatId);
        const messages = await chat.fetchMessages({ limit: 500 });

        // Find the message by ID
        const message = messages.find(msg => msg.id._serialized === messageId);

        if (!message) {
            return res.status(404).json({ error: 'Message not found' });
        }

        if (!message.hasMedia) {
            return res.status(404).json({ error: 'Message has no media' });
        }

        // Download the media
        const media = await message.downloadMedia();

        if (!media) {
            return res.status(500).json({ error: 'Failed to download media' });
        }

        // Return media as data URL
        const dataUrl = `data:${media.mimetype};base64,${media.data}`;

        res.json({
            success: true,
            data: {
                mimetype: media.mimetype,
                filename: media.filename || 'media',
                data: dataUrl
            }
        });

    } catch (error) {
        console.error('Error downloading media:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to download media',
            details: error.message
        });
    }
});

app.get('/api/typing-states', (req, res) => {
    // Return empty array for typing states (bridge compatibility)
    res.json({ success: true, data: [] });
});

// Add typing indicator endpoint
app.post('/api/typing', async (req, res) => {
    try {
        const { chatJid, isTyping } = req.body;

        if (!chatJid || typeof isTyping !== 'boolean') {
            return res.status(400).json({
                success: false,
                error: 'chatJid and isTyping are required'
            });
        }

        // For now, just return success (typing indicators are not essential)
        // In a full implementation, you would use client.sendPresenceUpdate()
        res.json({ success: true, message: 'Typing indicator processed' });
    } catch (error) {
        console.error('Error processing typing indicator:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Admin endpoint to clear user session (for testing)
app.post('/api/admin/clear-session', async (req, res) => {
    try {
        const { phone } = req.body;

        if (!phone) {
            return res.status(400).json({
                success: false,
                error: 'Phone number is required'
            });
        }

        // Clear from database
        const result = await dbPool.query(
            'DELETE FROM sessions WHERE phone_number = $1',
            [phone]
        );

        // Clear from in-memory pendingUsers map
        const wasInMemory = stupidBot.clearPendingUser(phone);

        res.json({
            success: true,
            message: `Session cleared for ${phone}`,
            rowsDeleted: result.rowCount,
            clearedFromMemory: wasInMemory
        });
    } catch (error) {
        logger.error('Error clearing session:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/status', (req, res) => {
    res.json({
        status: connectionStatus,
        authenticated: isAuthenticated,
        connected: isConnected
    });
});

// Mark messages as read in a chat
app.post('/api/chats/:chatId/mark-read', async (req, res) => {
    try {
        if (!isAuthenticated || !client) {
            console.log('❌ [MARK-READ] Not authenticated');
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const { chatId } = req.params;
        if (!chatId) {
            console.log('❌ [MARK-READ] No chatId provided');
            return res.status(400).json({ error: 'chatId is required' });
        }

        const decodedChatId = decodeURIComponent(chatId);
        console.log(`🔵 [MARK-READ] Request received for chat: ${decodedChatId}`);

        const chat = await client.getChatById(decodedChatId);
        console.log(`🔵 [MARK-READ] Chat found, unreadCount BEFORE: ${chat.unreadCount}`);

        // Fetch messages first to ensure they're fully loaded (helps with race conditions)
        console.log(`🔵 [MARK-READ] Fetching messages to ensure sync...`);
        const messages = await chat.fetchMessages({ limit: 50 });
        console.log(`🔵 [MARK-READ] Fetched ${messages.length} messages`);

        // Add a small delay to let new messages fully sync (200ms)
        // This prevents race condition when message just arrived
        await new Promise(resolve => setTimeout(resolve, 200));
        console.log(`🔵 [MARK-READ] Waited 200ms for message sync`);

        // Mark messages as read (send "seen" status)
        await chat.sendSeen();
        console.log(`✅ [MARK-READ] chat.sendSeen() completed`);

        // Wait a moment for WhatsApp to process
        await new Promise(resolve => setTimeout(resolve, 100));

        // Check unread count after marking as read
        const updatedChat = await client.getChatById(decodedChatId);
        console.log(`🔵 [MARK-READ] Chat unreadCount AFTER: ${updatedChat.unreadCount}`);

        res.json({
            success: true,
            message: 'Messages marked as read',
            chatId: decodedChatId,
            unreadCountBefore: chat.unreadCount,
            unreadCountAfter: updatedChat.unreadCount
        });
    } catch (error) {
        console.error('❌ [MARK-READ] Error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to mark messages as read',
            details: error.message
        });
    }
});

// OPTIMIZED: Returns immediately (202 Accepted), sends message in background
app.post('/api/send', messageLimiter, async (req, res) => {
    try {
        if (!isAuthenticated || !client) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        // Handle both parameter formats for compatibility
        const { chatId, message, recipient } = req.body;
        const targetChatId = chatId || recipient;

        if (!targetChatId || !message) {
            return res.status(400).json({ error: 'chatId/recipient and message are required' });
        }

        // Return 202 Accepted immediately - don't wait for WhatsApp
        res.status(202).json({
            success: true,
            status: 'accepted',
            message: 'Message queued for sending',
            chatId: targetChatId,
            timestamp: new Date().toISOString()
        });

        // Send message in background (tracked for graceful shutdown)
        setImmediate(() => {
            sendMessageAsync(client, targetChatId, message);
        });
    } catch (error) {
        console.error('Error processing send request:', error);
        res.status(500).json({ error: 'Failed to process send request' });
    }
});

// Send media (images, videos, documents) with optional caption
app.post('/api/send-media', messageLimiter, async (req, res) => {
    try {
        if (!isAuthenticated || !client) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const { chatId, media, caption } = req.body;

        // Validate required fields
        if (!chatId) {
            return res.status(400).json({ error: 'chatId is required' });
        }

        if (!media || !media.mimetype || !media.data) {
            return res.status(400).json({ error: 'media object with mimetype and data is required' });
        }

        // Validate file size (16MB limit - WhatsApp limitation)
        const base64Size = media.data.length * 0.75; // Rough estimate of decoded size
        const maxSize = 16 * 1024 * 1024; // 16MB
        if (base64Size > maxSize) {
            return res.status(400).json({ error: 'File size exceeds 16MB limit' });
        }

        // Return 202 Accepted immediately - don't wait for WhatsApp
        res.status(202).json({
            success: true,
            status: 'accepted',
            message: 'Media message queued for sending',
            chatId: chatId,
            timestamp: new Date().toISOString()
        });

        // Send media in background (tracked for graceful shutdown)
        setImmediate(async () => {
            const operationId = `media-${Date.now()}-${Math.random()}`;
            pendingOperations.add(operationId);

            try {
                // Create MessageMedia object
                const messageMedia = new MessageMedia(
                    media.mimetype,
                    media.data,
                    media.filename || 'file'
                );

                // Send media with optional caption
                const options = caption ? { caption } : {};
                await client.sendMessage(chatId, messageMedia, options);

                console.log(`✓ Media sent successfully (${operationId})`);
            } catch (error) {
                console.error(`✗ Failed to send media (${operationId}):`, error.message);
            } finally {
                pendingOperations.delete(operationId);
            }
        });
    } catch (error) {
        console.error('Error processing send-media request:', error);
        res.status(500).json({ error: 'Failed to process send-media request' });
    }
});

// =============================================================================
// STUPID BOT ENDPOINTS
// =============================================================================

// Webhook endpoint for form completion (receives notifications from Make.com)
app.post('/api/bot/form-completed', async (req, res) => {
    try {
        // Check if bot is enabled (phone-based)
        if (!isBotEnabled) {
            logger.info('🤖 [STUPID-BOT] Webhook received but bot is disabled (phone number not in sales list)');
            return res.status(403).json({
                success: false,
                error: 'Bot is disabled - not a sales number'
            });
        }

        logger.info('🤖 [STUPID-BOT] Webhook received:', req.body);

        if (!isAuthenticated || !client) {
            logger.error('🤖 [STUPID-BOT] WhatsApp not authenticated');
            return res.status(503).json({
                success: false,
                error: 'WhatsApp not authenticated'
            });
        }

        // Handle form completion with persistent storage
        const result = await stupidBot.handleFormCompletion(client, req.body, logger, dbPool);

        if (result.success) {
            res.json({
                success: true,
                message: 'Success message sent',
                phoneNumber: result.phoneNumber
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        logger.error('🤖 [STUPID-BOT] Webhook error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            details: error.message
        });
    }
});

// Send message endpoint (for Calendly webhook and other external services)
app.post('/api/bot/send-message', messageLimiter, async (req, res) => {
    try {
        if (!isAuthenticated || !client) {
            logger.error('🤖 [SEND-MESSAGE] WhatsApp not authenticated');
            return res.status(503).json({
                success: false,
                error: 'WhatsApp not authenticated'
            });
        }

        const { phone, message, mediaUrl } = req.body;

        if (!phone || !message) {
            return res.status(400).json({
                success: false,
                error: 'phone and message are required'
            });
        }

        // Normalize phone number to WhatsApp format
        const normalizedPhone = phone.replace(/[^\d+]/g, '');
        const chatId = normalizedPhone.includes('@') ? normalizedPhone : `${normalizedPhone}@c.us`;

        logger.info(`📨 [SEND-MESSAGE] Sending message to ${normalizedPhone}${mediaUrl ? ' (with media)' : ''}`);

        // Return 202 Accepted immediately
        res.status(202).json({
            success: true,
            status: 'accepted',
            message: 'Message queued for sending',
            phone: normalizedPhone,
            timestamp: new Date().toISOString()
        });

        // Send message in background (with or without media)
        setImmediate(async () => {
            const operationId = `msg-${Date.now()}-${Math.random()}`;
            pendingOperations.add(operationId);

            try {
                if (mediaUrl) {
                    // Send media message
                    await sendMediaFromUrl(client, chatId, message, mediaUrl);
                } else {
                    // Send text-only message
                    await sendMessageAsync(client, chatId, message);
                }
            } catch (error) {
                logger.error(`✗ Failed to send message (${operationId}):`, error.message);
            } finally {
                pendingOperations.delete(operationId);
            }
        });
    } catch (error) {
        logger.error('🤖 [SEND-MESSAGE] Error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            details: error.message
        });
    }
});

// Appointment scheduled webhook (for Calendly and other booking services)
app.post('/api/bot/appointment-scheduled', async (req, res) => {
    try {
        logger.info('📅 [APPOINTMENT-SCHEDULED] Webhook received:', req.body);

        const { phone, session_id } = req.body;

        if (!phone && !session_id) {
            return res.status(400).json({
                success: false,
                error: 'Either phone or session_id is required'
            });
        }

        // Update session in database to mark appointment as scheduled
        if (dbPool) {
            try {
                let query, params;

                if (session_id) {
                    // Update by session ID (preferred)
                    query = `
                        UPDATE sessions
                        SET appointment_scheduled_at = NOW(),
                            status = 'completed'
                        WHERE session_id = $1
                        RETURNING session_id, phone_number
                    `;
                    params = [session_id];
                } else {
                    // Update by phone number (fallback)
                    const normalizedPhone = phone.replace(/[^\d+]/g, '');
                    query = `
                        UPDATE sessions
                        SET appointment_scheduled_at = NOW(),
                            status = 'completed'
                        WHERE phone_number = $1
                          AND appointment_scheduled_at IS NULL
                        ORDER BY created_at DESC
                        LIMIT 1
                        RETURNING session_id, phone_number
                    `;
                    params = [normalizedPhone];
                }

                const result = await dbPool.query(query, params);

                if (result.rows.length > 0) {
                    const session = result.rows[0];
                    logger.info(`✅ [APPOINTMENT-SCHEDULED] Updated session ${session.session_id} for ${session.phone_number}`);

                    res.json({
                        success: true,
                        message: 'Appointment marked as scheduled',
                        session_id: session.session_id,
                        phone_number: session.phone_number
                    });
                } else {
                    logger.warn(`⚠️  [APPOINTMENT-SCHEDULED] No matching session found for ${session_id || phone}`);
                    res.status(404).json({
                        success: false,
                        error: 'No matching session found'
                    });
                }
            } catch (dbError) {
                logger.error('❌ [APPOINTMENT-SCHEDULED] Database error:', dbError);
                res.status(500).json({
                    success: false,
                    error: 'Database error',
                    details: dbError.message
                });
            }
        } else {
            res.status(503).json({
                success: false,
                error: 'Database not available'
            });
        }
    } catch (error) {
        logger.error('❌ [APPOINTMENT-SCHEDULED] Error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            details: error.message
        });
    }
});

// Get bot status (for monitoring and debugging)
app.get('/api/bot/status', async (req, res) => {
    try {
        // If bot is disabled (phone-based check), return minimal status
        if (!isBotEnabled) {
            return res.json({
                success: true,
                bot: {
                    enabled: false,
                    message: 'Bot is disabled - not a sales number'
                },
                whatsapp: {
                    authenticated: isAuthenticated,
                    connected: isConnected,
                    status: connectionStatus
                }
            });
        }

        const status = await stupidBot.getBotStatus(dbPool);

        // Add reminder statistics if available
        const reminderStats = dbPool ? await getReminderStats() : null;

        res.json({
            success: true,
            bot: status,
            whatsapp: {
                authenticated: isAuthenticated,
                connected: isConnected,
                status: connectionStatus
            },
            reminders: reminderStats
        });
    } catch (error) {
        logger.error('🤖 [STUPID-BOT] Status error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Clear pending users (admin endpoint - requires API key)
app.post('/api/bot/clear-pending', async (req, res) => {
    try {
        // Check if bot is enabled (phone-based)
        if (!isBotEnabled) {
            return res.status(403).json({
                success: false,
                error: 'Bot is disabled - not a sales number'
            });
        }

        // SECURITY: Require admin API key
        const apiKey = req.headers['x-api-key'];

        if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
            logger.info('⚠️  [STUPID-BOT] Unauthorized clear-pending attempt');
            return res.status(403).json({
                success: false,
                error: 'Unauthorized - Admin API key required'
            });
        }

        const result = await stupidBot.clearPendingUsers(dbPool);
        const totalCleared = result.clearedMemory + result.clearedDatabase;
        logger.info(`🤖 [STUPID-BOT] Cleared ${totalCleared} pending users (memory: ${result.clearedMemory}, db: ${result.clearedDatabase})`);

        res.json({
            success: true,
            message: `Cleared ${totalCleared} pending users`,
            details: result
        });
    } catch (error) {
        logger.error('🤖 [STUPID-BOT] Clear-pending error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Lookup contact info (name, status) for a JID or phone number
app.get('/api/contact/:jid', async (req, res) => {
    try {
        if (!isAuthenticated || !client) {
            return res.status(503).json({ error: 'WhatsApp not authenticated' });
        }

        let { jid } = req.params;

        // Normalize JID format
        if (!jid.includes('@')) {
            jid = `${jid}@s.whatsapp.net`;
        }

        const result = { jid };

        // Try to get status (about text)
        try {
            const status = await client.fetchStatus(jid);
            if (status) {
                result.status = status.status;
                result.setAt = status.setAt;
            }
        } catch (e) {
            result.statusError = e.message;
        }

        // Try to get profile picture URL
        try {
            const ppUrl = await client.profilePictureUrl(jid, 'image');
            result.profilePicture = ppUrl;
        } catch (e) {
            result.profilePictureError = e.message;
        }

        // Try onWhatsApp check (only works with phone numbers, not LIDs)
        if (jid.includes('@s.whatsapp.net')) {
            try {
                const [exists] = await client.onWhatsApp(jid.replace('@s.whatsapp.net', ''));
                if (exists) {
                    result.exists = true;
                    result.verifiedName = exists.verifiedName;
                }
            } catch (e) {
                result.onWhatsAppError = e.message;
            }
        }

        res.json(result);
    } catch (error) {
        console.error('Error fetching contact info:', error);
        res.status(500).json({ error: error.message });
    }
});

// Bulk lookup contacts - get info for multiple JIDs
app.post('/api/contacts/lookup', async (req, res) => {
    try {
        if (!isAuthenticated || !client) {
            return res.status(503).json({ error: 'WhatsApp not authenticated' });
        }

        const { jids } = req.body;
        if (!jids || !Array.isArray(jids)) {
            return res.status(400).json({ error: 'jids array required' });
        }

        const results = [];
        for (const jid of jids) {
            try {
                const normalizedJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
                const info = { jid: normalizedJid };

                // Try to get status
                try {
                    const status = await client.fetchStatus(normalizedJid);
                    if (status) info.status = status.status;
                } catch (e) {}

                results.push(info);
            } catch (e) {
                results.push({ jid, error: e.message });
            }
        }

        res.json({ results });
    } catch (error) {
        console.error('Error bulk lookup:', error);
        res.status(500).json({ error: error.message });
    }
});

// Query sessions by chat_id pattern (for finding LID users who completed forms)
app.get('/api/sessions/search', async (req, res) => {
    try {
        if (!dbPool) {
            return res.status(503).json({ error: 'Database not available' });
        }

        const { chat_id, phone, status } = req.query;
        let query = 'SELECT session_id, phone_number, chat_id, status, created_at, form_data FROM sessions WHERE 1=1';
        const params = [];

        if (chat_id) {
            params.push(`%${chat_id}%`);
            query += ` AND chat_id LIKE $${params.length}`;
        }
        if (phone) {
            params.push(`%${phone}%`);
            query += ` AND phone_number LIKE $${params.length}`;
        }
        if (status) {
            params.push(status);
            query += ` AND status = $${params.length}`;
        }

        query += ' ORDER BY created_at DESC LIMIT 50';

        const result = await dbPool.query(query, params);
        res.json({ count: result.rows.length, sessions: result.rows });
    } catch (error) {
        console.error('Error searching sessions:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start server
app.listen(port, async () => {
    console.log(`WhatsApp Auth Service running on port ${port}`);

    // Initialize database if PostgreSQL is available
    if (dbPool) {
        await initializeDatabase();
    }

    // Auto-initialize WhatsApp client on startup
    setTimeout(() => {
        initializeWhatsApp();
    }, 2000);
});

// STABILITY: Graceful shutdown with pending operations handling
const gracefulShutdown = async (signal) => {
    console.log(`\n${signal} received. Starting graceful shutdown...`);

    // Stop accepting new requests (server already stopped by this point)

    // Wait for pending message operations (max 5 seconds)
    const maxWait = 5000;
    const startTime = Date.now();

    while (pendingOperations.size > 0) {
        const elapsed = Date.now() - startTime;
        if (elapsed > maxWait) {
            console.log(`⚠️  Forcing shutdown with ${pendingOperations.size} pending operations`);
            break;
        }
        console.log(`Waiting for ${pendingOperations.size} pending operations...`);
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (pendingOperations.size === 0) {
        console.log('✓ All pending operations completed');
    }

    // Cleanup WhatsApp client
    if (client) {
        console.log('Destroying WhatsApp client...');
        try {
            client.end(new Error('Client closed'));
            console.log('✓ WhatsApp client destroyed');
        } catch (error) {
            console.error('Error destroying client:', error.message);
        }
    }

    // Cleanup database connection pool
    if (dbPool) {
        console.log('Closing database connection pool...');
        try {
            await dbPool.end();
            console.log('✓ Database connection pool closed');
        } catch (error) {
            console.error('Error closing database pool:', error.message);
        }
    }

    console.log('Graceful shutdown complete');
    process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));