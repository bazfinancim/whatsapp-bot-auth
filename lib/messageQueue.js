const Queue = require('bull');

// Redis connection configuration
// Supports both REDIS_URL (Render format) and separate host/port/password
let redisConfig;

if (process.env.REDIS_URL) {
    // Render provides a full Redis URL
    redisConfig = process.env.REDIS_URL;
} else {
    redisConfig = {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: null, // Required for Bull
        enableReadyCheck: false,
        retryStrategy(times) {
            const delay = Math.min(times * 50, 2000);
            return delay;
        }
    };

    // Add TLS for production (Render Redis requires TLS)
    if (process.env.NODE_ENV === 'production' && process.env.REDIS_TLS === 'true') {
        redisConfig.tls = {
            rejectUnauthorized: false
        };
    }
}

// Create Bull queue for WhatsApp messages
const messageQueue = new Queue('whatsapp-messages', redisConfig, {
    defaultJobOptions: {
        attempts: 3, // Retry up to 3 times
        backoff: {
            type: 'exponential',
            delay: 60000 // Start with 1 minute, then 2min, 4min
        },
        removeOnComplete: false, // Keep completed jobs for audit trail
        removeOnFail: false // Keep failed jobs for debugging
    },
    settings: {
        stalledInterval: 30000, // Check for stalled jobs every 30 seconds
        maxStalledCount: 1 // Retry stalled jobs once
    }
});

// Event handlers for monitoring
messageQueue.on('error', (error) => {
    console.error('❌ Queue error:', error);
});

messageQueue.on('waiting', (jobId) => {
    console.log(`⏳ Job ${jobId} is waiting`);
});

messageQueue.on('active', (job) => {
    console.log(`🏃 Job ${job.id} started: ${job.data.messageType}`);
});

messageQueue.on('completed', (job, result) => {
    console.log(`✅ Job ${job.id} completed: ${job.data.messageType}`);
});

messageQueue.on('failed', (job, err) => {
    console.error(`❌ Job ${job.id} failed: ${job.data.messageType}`, err.message);
});

messageQueue.on('stalled', (job) => {
    console.warn(`⚠️  Job ${job.id} stalled: ${job.data.messageType}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🛑 SIGTERM received, closing message queue...');
    await messageQueue.close();
});

process.on('SIGINT', async () => {
    console.log('🛑 SIGINT received, closing message queue...');
    await messageQueue.close();
});

module.exports = {
    messageQueue,
    redisConfig
};
