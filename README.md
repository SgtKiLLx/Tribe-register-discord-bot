# Tribe Registration Discord Bot

A Discord bot for registering tribes with in-game names and Xbox Gamertags. Features admin management, logging, and database persistence.

## Features

- 📝 **Tribe Registration** - Users can register their tribe with `/register` command
- 🔐 **Admin Management** - Add/remove admin roles with `/admin` commands
- 📊 **Registration Logs** - Automatic logging of new registrations to a staff channel
- 💾 **Database Storage** - PostgreSQL database for persistent data
- ⚙️ **Per-Server Configuration** - Each server has its own admin roles and log channels

## Commands

### User Commands
- `/register` - Register your tribe (opens a modal form)

### Admin Commands
- `/setup <admin_role> <staff_channel>` - Initial setup (administrator only)
- `/admin add-role <role>` - Add an admin role (administrator only)
- `/admin remove-role <role>` - Remove an admin role (administrator only)
- `/admin view` - View current configuration (administrator only)
- `/list-tribes` - List all registered tribes (admin only)
- `/post-info [channel]` - Post registration instructions (administrator only)

## Setup

### Prerequisites
- Node.js 16+
- PostgreSQL database (or compatible service like Supabase, Neon)
- Discord bot token

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/SgtKiLLx/tribe-register-discord-bot.git
   cd tribe-register-discord-bot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   - Copy `.env` file and fill in your credentials:
     ```bash
     DISCORD_BOT_TOKEN=your_bot_token_here
     DISCORD_APPLICATION_ID=your_app_id_here
     DATABASE_URL=postgresql://user:password@localhost:5432/tribe_bot
     ```

4. **Build the TypeScript**
   ```bash
   npm run build
   ```

5. **Start the bot**
   ```bash
   npm start
   ```

   Or for development:
   ```bash
   npm run dev
   ```

## Getting Your Bot Token

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application"
3. Go to "Bot" tab and click "Add Bot"
4. Copy your bot token to `.env` file
5. Go to OAuth2 → URL Generator
6. Select `bot` scope and `applications.commands` scope
7. Select permissions: `Send Messages`, `Embed Links`, `Manage Messages`
8. Use the generated URL to invite the bot to your server

## Database Setup

The bot uses Drizzle ORM with PostgreSQL. Ensure your database has:
- `tribe_registrations` table
- `guild_config` table

Tables are created automatically on first run if you're using a migration system.

## Project Structure

```
tribe-register-discord-bot/
├── src/
│   ├── index.ts              # Main bot code
│   ├── db/
│   │   ├── index.ts          # Database connection
│   │   └── schema.ts         # Database schema
│   └── lib/
│       └── logger.ts         # Logger utility
├── dist/                     # Compiled JavaScript
├── .env                      # Environment variables (create from template)
├── .gitignore               # Git ignore rules
├── package.json             # Dependencies
├── tsconfig.json            # TypeScript configuration
└── README.md                # This file
```

## Security

⚠️ **IMPORTANT**: Never commit your `.env` file! The `.gitignore` file prevents this, but always:
- Keep bot tokens secret
- Never share your DATABASE_URL
- Use strong database passwords
- Regenerate tokens if they're ever exposed

## Troubleshooting

### Bot offline
- Check that `DISCORD_BOT_TOKEN` is correct in `.env`
- Verify the bot is invited to the server
- Check bot permissions

### Database connection errors
- Verify `DATABASE_URL` format
- Ensure PostgreSQL server is running
- Check database credentials

### Commands not showing
- Run `/` to refresh command list
- Ensure bot has `applications.commands` scope

## Contributing

Feel free to submit issues and enhancement requests!

## License

MIT