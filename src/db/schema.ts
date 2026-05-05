import { pgTable, text, varchar, timestamp, serial, boolean, integer } from "drizzle-orm/pg-core";

// Existing Tribe/Survivor Table
export const tribeRegistrationsTable = pgTable("tribe_registrations", {
  id: serial("id").primaryKey(),
  tribeName: varchar("tribe_name", { length: 100 }).notNull(),
  ign: varchar("ign", { length: 100 }).notNull(),
  xboxGamertag: varchar("xbox_gamertag", { length: 100 }).notNull(),
  discordUserId: varchar("discord_user_id", { length: 50 }).notNull(),
  discordUsername: varchar("discord_username", { length: 100 }).notNull(),
  channelId: varchar("channel_id", { length: 50 }),
  isOwner: boolean("is_owner").default(false),
  hasClaimedKit: boolean("has_claimed_kit").default(false), // NEW: For Feature #5
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// NEW: Task Board Table (Feature #2)
export const tribeTasksTable = pgTable("tribe_tasks", {
  id: serial("id").primaryKey(),
  tribeName: varchar("tribe_name", { length: 100 }).notNull(),
  taskContent: text("task_content").notNull(),
  status: varchar("status", { length: 20 }).default("open"), // open, claimed, completed
  claimedBy: varchar("claimed_by", { length: 50 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// NEW: Recruitment Table (Feature #1)
export const recruitmentTable = pgTable("recruitment", {
  id: serial("id").primaryKey(),
  discordUserId: varchar("discord_user_id", { length: 50 }).notNull(),
  playstyle: varchar("playstyle", { length: 100 }).notNull(),
  hours: varchar("hours", { length: 50 }).notNull(),
  description: text("description").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const guildConfigTable = pgTable("guild_config", {
  guildId: varchar("guild_id", { length: 50 }).primaryKey(),
  adminRoleIds: text("admin_role_ids").default(""),
  staffLogChannelId: varchar("staff_log_channel_id", { length: 50 }),
  tribeCategoryId: varchar("tribe_category_id", { length: 50 }),
  recruitmentChannelId: varchar("recruitment_channel_id", { length: 50 }), // NEW: Where LFT posts go
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
