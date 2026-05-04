import { pgTable, text, varchar, timestamp, serial, boolean } from "drizzle-orm/pg-core";

export const tribeRegistrationsTable = pgTable("tribe_registrations", {
  id: serial("id").primaryKey(),
  tribeName: varchar("tribe_name", { length: 100 }).notNull(),
  ign: varchar("ign", { length: 100 }).notNull(),
  xboxGamertag: varchar("xbox_gamertag", { length: 100 }).notNull(),
  discordUserId: varchar("discord_user_id", { length: 50 }).notNull(),
  discordUsername: varchar("discord_username", { length: 100 }).notNull(),
  channelId: varchar("channel_id", { length: 50 }),
  isOwner: boolean("is_owner").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const guildConfigTable = pgTable("guild_config", {
  guildId: varchar("guild_id", { length: 50 }).primaryKey(),
  adminRoleIds: text("admin_role_ids").default(""),
  staffLogChannelId: varchar("staff_log_channel_id", { length: 50 }),
  tribeCategoryId: varchar("tribe_category_id", { length: 50 }), 
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
