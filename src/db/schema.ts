import { pgTable, text, varchar, timestamp, serial, boolean, integer } from "drizzle-orm/pg-core";

// --- SURVIVOR & TRIBE SIGNATURES ---
export const tribeRegistrationsTable = pgTable("tribe_registrations", {
  id: serial("id").primaryKey(),
  guildId: varchar("guild_id", { length: 50 }).notNull(),
  tribeName: varchar("tribe_name", { length: 100 }).notNull(),
  ign: varchar("ign", { length: 100 }).notNull(),
  xboxGamertag: varchar("xbox_gamertag", { length: 100 }).notNull(),
  discordUserId: varchar("discord_user_id", { length: 50 }).notNull(),
  discordUsername: varchar("discord_username", { length: 100 }).notNull(),
  channelId: varchar("channel_id", { length: 50 }),
  isOwner: boolean("is_owner").default(false),
  hasClaimedKit: boolean("has_claimed_kit").default(false),
  
  // NEW: Protocol Gatekeeper (Feature #7)
  // 'pending' = staff must approve, 'verified' = access granted
  status: varchar("status", { length: 20 }).default("pending"), 

  // NEW: Economy Sector (Feature #5)
  // Tracks the survivor's Tek Coin balance
  tekCoins: integer("tek_coins").default(0).notNull(), 
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// --- NEW: BOUNTY PROTOCOLS (Feature #6) ---
export const bountiesTable = pgTable("bounties", {
  id: serial("id").primaryKey(),
  guildId: varchar("guild_id", { length: 50 }).notNull(),
  targetTribe: varchar("target_tribe", { length: 100 }).notNull(),
  reward: integer("reward").notNull(),
  placedBy: varchar("placed_by", { length: 50 }).notNull(), // Discord ID of the poster
  status: varchar("status", { length: 20 }).default("active"), // active, claimed, completed
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// --- NEW: TEK-MARKET ITEMS (Feature #5) ---
export const shopItemsTable = pgTable("shop_items", {
  id: serial("id").primaryKey(),
  guildId: varchar("guild_id", { length: 50 }).notNull(),
  itemName: varchar("item_name", { length: 100 }).notNull(),
  price: integer("price").notNull(),
  description: text("description"),
});

// --- EXISTING TABLES (Must stay so other features don't break) ---
export const alphaClaimsTable = pgTable("alpha_claims", {
  id: serial("id").primaryKey(),
  guildId: varchar("guild_id", { length: 50 }).notNull(),
  tribeName: varchar("tribe_name", { length: 100 }).notNull(),
  discordUserId: varchar("discord_user_id", { length: 50 }).notNull(),
  coordinates: varchar("coordinates", { length: 50 }).notNull(),
  memberCount: integer("member_count").notNull(),
  status: varchar("status", { length: 20 }).default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const tribeTasksTable = pgTable("tribe_tasks", {
  id: serial("id").primaryKey(),
  guildId: varchar("guild_id", { length: 50 }).notNull(),
  tribeName: varchar("tribe_name", { length: 100 }).notNull(),
  taskContent: text("task_content").notNull(),
  status: varchar("status", { length: 20 }).default("open"),
  claimedBy: varchar("claimed_by", { length: 50 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const recruitmentTable = pgTable("recruitment", {
  id: serial("id").primaryKey(),
  guildId: varchar("guild_id", { length: 50 }).notNull(),
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
  recruitmentChannelId: varchar("recruitment_channel_id", { length: 50 }),
  welcomeChannelId: varchar("welcome_channel_id", { length: 50 }),
  rulesChannelId: varchar("rules_channel_id", { length: 50 }),
  infoChannelId: varchar("info_channel_id", { length: 50 }),
  supportChannelId: varchar("support_channel_id", { length: 50 }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
