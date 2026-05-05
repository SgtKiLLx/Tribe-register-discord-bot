import { pgTable, text, varchar, timestamp, serial, boolean, integer } from "drizzle-orm/pg-core";

export const tribeRegistrationsTable = pgTable("tribe_registrations", {
  id: serial("id").primaryKey(),
  tribeName: varchar("tribe_name", { length: 100 }).notNull(),
  ign: varchar("ign", { length: 100 }).notNull(),
  xboxGamertag: varchar("xbox_gamertag", { length: 100 }).notNull(),
  discordUserId: varchar("discord_user_id", { length: 50 }).notNull(),
  discordUsername: varchar("discord_username", { length: 100 }).notNull(),
  channelId: varchar("channel_id", { length: 50 }),
  isOwner: boolean("is_owner").default(false),
  hasClaimedKit: boolean("has_claimed_kit").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// NEW: Alpha Claims Table
export const alphaClaimsTable = pgTable("alpha_claims", {
  id: serial("id").primaryKey(),
  tribeName: varchar("tribe_name", { length: 100 }).notNull(),
  discordUserId: varchar("discord_user_id", { length: 50 }).notNull(),
  coordinates: varchar("coordinates", { length: 50 }).notNull(),
  memberCount: integer("member_count").notNull(),
  status: varchar("status", { length: 20 }).default("pending"), // pending, approved, denied
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const guildConfigTable = pgTable("guild_config", {
  guildId: varchar("guild_id", { length: 50 }).primaryKey(),
  adminRoleIds: text("admin_role_ids").default(""),
  staffLogChannelId: varchar("staff_log_channel_id", { length: 50 }),
  tribeCategoryId: varchar("tribe_category_id", { length: 50 }),
  recruitmentChannelId: varchar("recruitment_channel_id", { length: 50 }),
  welcomeChannelId: varchar("welcome_channel_id", { length: 50 }),
  rulesChannelId: varchar("rules_channel_id", { length: 50 }),
  infoChannelId: varchar("info_channel_id", { length: 50 }),
  // NEW COLUMNS:
  supportChannelId: varchar("support_channel_id", { length: 50 }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// NEW: Support Tickets Table
export const supportTicketsTable = pgTable("support_tickets", {
  id: serial("id").primaryKey(),
  discordUserId: varchar("discord_user_id", { length: 50 }).notNull(),
  threadId: varchar("thread_id", { length: 50 }).notNull(),
  status: varchar("status", { length: 20 }).default("open"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export { tribeTasksTable, recruitmentTable } from "./schema"; // Ensure other tables stay
