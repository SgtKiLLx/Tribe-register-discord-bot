import { pgTable, text, varchar, timestamp, serial } from "drizzle-orm/pg-core";

// Table for storing tribe registrations
export const tribeRegistrationsTable = pgTable("tribe_registrations", {
  id: serial("id").primaryKey(),
  tribeName: varchar("tribe_name", { length: 100 }).notNull(),
  ign: varchar("ign", { length: 100 }).notNull(),
  xboxGamertag: varchar("xbox_gamertag", { length: 100 }).notNull(),
  discordUserId: varchar("discord_user_id", { length: 50 }).notNull(),
  discordUsername: varchar("discord_username", { length: 100 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Table for storing server-specific settings (admin roles/logs)
export const guildConfigTable = pgTable("guild_config", {
  guildId: varchar("guild_id", { length: 50 }).primaryKey(),
  adminRoleIds: text("admin_role_ids").default(""), // Stored as comma-separated IDs
  staffLogChannelId: varchar("staff_log_channel_id", { length: 50 }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});