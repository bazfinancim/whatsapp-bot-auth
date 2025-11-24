# WhatsApp Bot Service

Full-featured WhatsApp bot with authentication, automation, and reminder scheduling.

## What This Is

A complete WhatsApp bot service that provides:

- WhatsApp Web.js client authentication & QR code generation
- Automated bot responses and message handling
- Reminder scheduling system with node-cron
- Health monitoring and periodic checks
- Form completion tracking
- Appointment scheduling
- Template management system
- Session persistence on disk
- LOGOUT issue fixes with proper client lifecycle management

## Features

### Authentication & Messaging
- `/api/auth/*` - Full authentication management
- `/api/send-message` - Send text messages
- `/api/send-media` - Send media with captions
- `/api/chats` - Get chat list
- `/api/messages/:chatId` - Get messages from specific chat
- `/qr` - HTML QR code viewer for device linking

### Bot Automation
- `/api/bot/form-completed` - Track form completions
- `/api/bot/send-message` - Bot-specific message sending
- `/api/bot/appointment-scheduled` - Handle appointment scheduling
- `/api/bot/status` - Check bot activation status
- `/api/bot/clear-pending` - Clear pending reminders

### Templates
- `/api/templates` - List all templates
- `POST /api/templates` - Create new template
- `PUT /api/templates/:id` - Update template
- `DELETE /api/templates/:id` - Delete template

## Bot Activation

The bot is activated for specific phone numbers via the `SALES_PHONE_NUMBERS` environment variable:

```bash
SALES_PHONE_NUMBERS=972501234567,972507654321
```

Only messages to these numbers will trigger bot automation and reminders.

## Architecture

### Core Files
- `server.js` - Main Express server with WhatsApp client (~67KB)
- `stupid-bot.js` - Bot response logic and message handling (~22KB)

### Bot Modules (`lib/`)
- `reminder-scheduler.js` - Manages scheduled reminders with node-cron
- `reminder-messages.js` - Message templates for reminders
- `operating-hours.js` - Business hours validation
- `database-migration.js` - Database schema setup

## LOGOUT Issue Fixes

This version includes critical fixes for the LOGOUT loop issue:

1. **Client Initialization Guard** - Prevents multiple client instances
2. **Proper Client Destruction** - Destroys old client before reconnect
3. **Session Clearing Endpoint** - `/api/auth/clear-session` to clear corrupted persistent disk

See `server.js:315-320` for initialization guard and `server.js:431-455` for disconnection handling.

## Deployment

**Target Service:** `whatsapp-bot-auth-production` on Render

**Environment Variables:**
```bash
PORT=3000
NODE_ENV=production
WHATSAPP_SESSION_PATH=/data
DATABASE_URL=postgresql://...
SALES_PHONE_NUMBERS=972501234567,972507654321
CHECK_INTERVAL=5
```

**Render Configuration:**
- Build Command: `npm install`
- Start Command: `npm start`
- Persistent Disk: Mount at `/data` for session storage

## Installation

```bash
npm install
npm start
```

## Dependencies

```json
{
  "cors": "^2.8.5",
  "express": "^4.18.2",
  "express-rate-limit": "^8.1.0",
  "node-cron": "^3.0.3",
  "pg": "^8.16.3",
  "puppeteer": "^18.2.1",
  "qrcode": "^1.5.3",
  "whatsapp-web.js": "^1.23.0"
}
```

## Related Repos

- **CSX Service:** `/Users/ayalla/Apps/whatsapp-csx-auth` (clean auth only, no bot features)
- **Website:** `/Users/ayalla/Apps/avi-website` (uses this service)

## Code Size

- **Lines:** ~2000+ (includes all bot features)
- **Dependencies:** 8 packages (includes node-cron)

## Version

**v2.0.0** - Full bot service with LOGOUT fixes

---

**Note:** For clean authentication without bot features, use the separate whatsapp-csx-auth repository.
