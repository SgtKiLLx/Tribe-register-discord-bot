import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  type ModalActionRowComponentBuilder,
  Events,
  type Interaction,
  PermissionFlagsBits,
  EmbedBuilder,
  Colors,
} from "discord.js";
import { db, tribeRegistrationsTable, guildConfigTable } from "./db";
import { eq, desc } from "drizzle-orm";
import { logger } from "./lib/logger";

const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;

if (!token) throw new Error("DISCORD_BOT_TOKEN is required");
if (!applicationId) throw new Error("DISCORD_APPLICATION_ID is required");

// 1. Slash Command Definitions
const commands = [
  new SlashCommandBuilder()
    .setName("register")
    .setDescription("Register your tribe — submit your tribe name, IGN, and Xbox Gamertag"),

  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Initial setup: set the first admin role and staff-logs channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption((opt) =>
      opt.setName("admin_role").setDescription("First admin role allowed to use admin commands").setRequired(true)
    )
    .addChannelOption((opt) =>
      opt.setName("staff_channel").setDescription("Channel where registration logs will be posted").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Manage bot configuration (server admins only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("add-role")
        .setDescription("Add a role that can use admin commands")
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("Role to grant admin access").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove-role")
        .setDescription("Remove a role from admin access")
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("Role to remove from admin access").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("view").setDescription("View current admin roles and staff-logs channel")
    ),

  new SlashCommandBuilder()
    .setName("list-tribes")
    .setDescription("List all registered tribes (admin only)"),

  new SlashCommandBuilder()
    .setName("post-info")
    .setDescription("Post the tribe registration instructions embed in a channel (admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("Channel to post the instructions in (defaults to current channel)")
        .setRequired(false)
    ),
];

// 2. Helper Functions
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(token!);
  try {
    logger.info("Registering slash commands...");
    await rest.put(Routes.applicationCommands(applicationId!), {
      body: commands.map((c) => c.toJSON()),
    });
    logger.info("Slash commands registered.");
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err), "Failed to register slash commands");
  }
}

async function getGuildConfig(guildId: string) {
  const [config] = await db
    .select()
    .from(guildConfigTable)
    .where(eq(guildConfigTable.guildId, guildId));
  return config ?? null;
}

async function upsertGuildConfig(
  guildId: string,
  patch: Partial<{ adminRoleIds: string; staffLogChannelId: string }>
) {
  const existing = await getGuildConfig(guildId);
  const merged = {
    guildId,
    adminRoleIds: patch.adminRoleIds ?? existing?.adminRoleIds ?? "",
    staffLogChannelId: patch.staffLogChannelId ?? existing?.staffLogChannelId ?? "",
    updatedAt: new Date(),
  };
  await db
    .insert(guildConfigTable)
    .values(merged)
    .onConflictDoUpdate({
      target: guildConfigTable.guildId,
      set: { adminRoleIds: merged.adminRoleIds, staffLogChannelId: merged.staffLogChannelId, updatedAt: merged.updatedAt },
    });
  return merged;
}

async function isAdmin(interaction: Interaction, guildId: string): Promise<boolean> {
  if (!interaction.isCommand() && !interaction.isModalSubmit()) return false;
  const member =
    interaction.guild?.members.cache.get(interaction.user.id) ??
    (await interaction.guild?.members.fetch(interaction.user.id).catch(() => null));
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;

  const config = await getGuildConfig(guildId);
  if (!config?.adminRoleIds) return false;
  const adminRoles = config.adminRoleIds.split(",").filter(Boolean);
  return member.roles.cache.some((r) => adminRoles.includes(r.id));
}

async function postToStaffLog(
  client: Client,
  guildId: string,
  embed: EmbedBuilder,
  pingAdmins = false
) {
  const config = await getGuildConfig(guildId);
  if (!config?.staffLogChannelId) return;
  try {
    const channel = await client.channels.fetch(config.staffLogChannelId);
    if (channel && "send" in channel && typeof channel.send === "function") {
      const send = channel as { send: (opts: unknown) => Promise<unknown> };
      let content: string | undefined;
      if (pingAdmins && config.adminRoleIds) {
        const roleMentions = config.adminRoleIds
          .split(",")
          .filter(Boolean)
          .map((id) => `<@&${id}>`)
          .join(" ");
        if (roleMentions) content = roleMentions;
      }
      await send.send({ content, embeds: [embed] });
    }
  } catch (err) {
    logger.warn(err instanceof Error ? err.message : String(err), "Could not post to staff log channel");
  }
}

// 3. Client Setup (Updated Intents)
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers // Required to check roles in isAdmin
    ] 
});

client.once(Events.ClientReady, (c) => {
  logger.info({ tag: c.user.tag }, "Discord bot is online");
});

// 4. Interaction Listener
client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  // --- /register ---
  if (interaction.isChatInputCommand() && interaction.commandName === "register") {
    const modal = new ModalBuilder()
      .setCustomId("tribe_register_modal")
      .setTitle("Tribe Registration");

    const tribeNameInput = new TextInputBuilder()
      .setCustomId("tribe_name")
      .setLabel("Tribe Name")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("Enter your tribe name")
      .setRequired(true)
      .setMaxLength(100);

    const ignInput = new TextInputBuilder()
      .setCustomId("ign")
      .setLabel("In-Game Name (IGN)")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("Enter your in-game name")
      .setRequired(true)
      .setMaxLength(100);

    const xboxInput = new TextInputBuilder()
      .setCustomId("xbox_gamertag")
      .setLabel("Xbox Gamertag")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("Enter your Xbox Gamertag")
      .setRequired(true)
      .setMaxLength(100);

    modal.addComponents(
      new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(tribeNameInput),
      new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(ignInput),
      new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(xboxInput)
    );

    await interaction.showModal(modal);
    return;
  }

  // --- Modal Submit ---
  if (interaction.isModalSubmit() && interaction.customId === "tribe_register_modal") {
    const tribeName = interaction.fields.getTextInputValue("tribe_name").trim();
    const ign = interaction.fields.getTextInputValue("ign").trim();
    const xboxGamertag = interaction.fields.getTextInputValue("xbox_gamertag").trim();

    await interaction.deferReply({ ephemeral: true });

    try {
      await db.insert(tribeRegistrationsTable).values({
        tribeName,
        ign,
        xboxGamertag,
        discordUserId: interaction.user.id,
        discordUsername: interaction.user.username,
      });

      await interaction.editReply({
        content: `✅ **Registration complete!**\n\n**Tribe:** ${tribeName}\n**IGN:** ${ign}\n**Xbox Gamertag:** ${xboxGamertag}`,
      });

      if (interaction.guildId) {
        const embed = new EmbedBuilder()
          .setTitle("New Tribe Registration")
          .setColor(Colors.Green)
          .addFields(
            { name: "Tribe Name", value: tribeName, inline: true },
            { name: "IGN", value: ign, inline: true },
            { name: "Xbox Gamertag", value: xboxGamertag, inline: true },
            { name: "Discord User", value: `<@${interaction.user.id}> (${interaction.user.username})`, inline: false }
          )
          .setTimestamp();
        await postToStaffLog(client, interaction.guildId, embed, true);
      }
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err), "Failed to save tribe registration");
      await interaction.editReply({ content: "❌ Something went wrong saving your registration. Please try again." });
    }
    return;
  }

  // --- /setup ---
  if (interaction.isChatInputCommand() && interaction.commandName === "setup") {
    if (!interaction.guildId) {
      await interaction.reply({ content: "❌ This command can only be used in a server.", ephemeral: true });
      return;
    }

    const role = interaction.options.getRole("admin_role", true);
    const channel = interaction.options.getChannel("staff_channel", true);

    const existing = await getGuildConfig(interaction.guildId);
    const existingRoles = existing?.adminRoleIds ? existing.adminRoleIds.split(",").filter(Boolean) : [];
    if (!existingRoles.includes(role.id)) existingRoles.push(role.id);

    await upsertGuildConfig(interaction.guildId, {
      adminRoleIds: existingRoles.join(","),
      staffLogChannelId: channel.id,
    });

    await interaction.reply({
      content: `✅ **Setup complete!**\n\n**Admin role:** <@&${role.id}>\n**Staff log channel:** <#${channel.id}>\n\nUse \`/admin add-role\` to add more roles anytime.`,
      ephemeral: true,
    });
    return;
  }

  // --- /admin ---
  if (interaction.isChatInputCommand() && interaction.commandName === "admin") {
    if (!interaction.guildId) return;

    const sub = interaction.options.getSubcommand();

    if (sub === "add-role") {
      const role = interaction.options.getRole("role", true);
      const existing = await getGuildConfig(interaction.guildId);
      const roles = existing?.adminRoleIds ? existing.adminRoleIds.split(",").filter(Boolean) : [];
      if (roles.includes(role.id)) {
        await interaction.reply({ content: `ℹ️ <@&${role.id}> already has admin access.`, ephemeral: true });
        return;
      }
      roles.push(role.id);
      await upsertGuildConfig(interaction.guildId, { adminRoleIds: roles.join(",") });
      await interaction.reply({
        content: `✅ <@&${role.id}> has been added as an admin role.`,
        ephemeral: true,
      });
      return;
    }

    if (sub === "remove-role") {
      const role = interaction.options.getRole("role", true);
      const existing = await getGuildConfig(interaction.guildId);
      const roles = existing?.adminRoleIds ? existing.adminRoleIds.split(",").filter(Boolean) : [];
      const updated = roles.filter((id) => id !== role.id);
      await upsertGuildConfig(interaction.guildId, { adminRoleIds: updated.join(",") });
      await interaction.reply({
        content: `✅ <@&${role.id}> has been removed.`,
        ephemeral: true,
      });
      return;
    }

    if (sub === "view") {
      const config = await getGuildConfig(interaction.guildId);
      const embed = new EmbedBuilder()
        .setTitle("Bot Configuration")
        .setColor(Colors.Blurple)
        .addFields(
          { name: "Admin Roles", value: config?.adminRoleIds || "None" },
          { name: "Staff Channel", value: config?.staffLogChannelId || "None" }
        );
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }

  // --- /post-info ---
  if (interaction.isChatInputCommand() && interaction.commandName === "post-info") {
    if (!interaction.guildId) return;
    const targetChannel = interaction.options.getChannel("channel") ?? interaction.channel;
    
    const embed = new EmbedBuilder()
      .setTitle("📋 Tribe Registration")
      .setColor(0x5865f2)
      .setDescription("Type `/register` to sign up!");

    const ch = targetChannel as any;
    await ch.send({ embeds: [embed] });
    await interaction.reply({ content: "Instructions posted!", ephemeral: true });
  }

  // --- /list-tribes ---
  if (interaction.isChatInputCommand() && interaction.commandName === "list-tribes") {
    if (!interaction.guildId) return;
    const allowed = await isAdmin(interaction, interaction.guildId);
    if (!allowed) return interaction.reply({ content: "Unauthorized.", ephemeral: true });

    const registrations = await db.select().from(tribeRegistrationsTable);
    if (registrations.length === 0) return interaction.reply({ content: "No registrations.", ephemeral: true });

    const embed = new EmbedBuilder().setTitle("Tribes List").setColor(Colors.Blue);
    registrations.forEach(r => embed.addFields({ name: r.tribeName, value: `IGN: ${r.ign}`, inline: true }));
    
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
});


// 5. Crash Prevention (Simplified for Railway build)
process.on("unhandledRejection", (error: any) => {
  console.error("Unhandled Rejection:", error);
});

process.on("uncaughtException", (error: any) => {
  console.error("Uncaught Exception:", error);
});

export async function startBot() {
  await registerCommands();
  await client.login(token);
}

// Start the bot
if (process.env.NODE_ENV !== 'test') {
  startBot();
}

import http from "http";

// This creates a tiny web server to keep Render happy
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Tribe Bot is Running!");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Web server listening on port ${PORT}`);
});
