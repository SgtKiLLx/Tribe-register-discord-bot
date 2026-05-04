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
  AutocompleteInteraction,
} from "discord.js";
import { db, tribeRegistrationsTable, guildConfigTable } from "./db";
import { eq, desc, sql } from "drizzle-orm";
import { logger } from "./lib/logger";
import http from "http";

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
    .setName("join")
    .setDescription("Join an existing tribe that is already registered")
    .addStringOption((opt) =>
      opt
        .setName("tribe_name")
        .setDescription("The name of the tribe you want to join")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("my-tribe")
    .setDescription("View your current tribe registration details"),

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
  if (!interaction.guild) return false;
  const member =
    interaction.guild.members.cache.get(interaction.user.id) ??
    (await interaction.guild.members.fetch(interaction.user.id).catch(() => null));
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
    if (channel?.isTextBased()) {
      let content: string | undefined;
      if (pingAdmins && config.adminRoleIds) {
        const roleMentions = config.adminRoleIds
          .split(",")
          .filter(Boolean)
          .map((id) => `<@&${id}>`)
          .join(" ");
        if (roleMentions) content = roleMentions;
      }
      await channel.send({ content, embeds: [embed] });
    }
  } catch (err) {
    logger.warn(err instanceof Error ? err.message : String(err), "Could not post to staff log channel");
  }
}

// 3. Client Setup
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers 
    ] 
});

client.once(Events.ClientReady, (c) => {
  logger.info({ tag: c.user.tag }, "Discord bot is online");
});

// 4. Interaction Listener
client.on(Events.InteractionCreate, async (interaction: Interaction) => {

  // --- Handle Autocomplete for /join ---
  if (interaction.isAutocomplete() && interaction.commandName === "join") {
    const focusedValue = interaction.options.getFocused();
    
    try {
        // Fetch unique tribe names from the database
        const tribes = await db
            .select({ name: tribeRegistrationsTable.tribeName })
            .from(tribeRegistrationsTable)
            .groupBy(tribeRegistrationsTable.tribeName);

        const filtered = tribes
            .map(t => t.name)
            .filter(name => name.toLowerCase().includes(focusedValue.toLowerCase()))
            .slice(0, 25);

        await interaction.respond(filtered.map(name => ({ name: name, value: name })));
    } catch (e) {
        logger.error("Autocomplete error", String(e));
    }
    return;
  }

  // --- Handle Slash Commands ---
  if (interaction.isChatInputCommand()) {
    
    // /register
    if (interaction.commandName === "register") {
        const modal = new ModalBuilder().setCustomId("tribe_register_modal").setTitle("Tribe Registration");
        const tribeNameInput = new TextInputBuilder().setCustomId("tribe_name").setLabel("Tribe Name").setStyle(TextInputStyle.Short).setRequired(true);
        const ignInput = new TextInputBuilder().setCustomId("ign").setLabel("In-Game Name (IGN)").setStyle(TextInputStyle.Short).setRequired(true);
        const xboxInput = new TextInputBuilder().setCustomId("xbox_gamertag").setLabel("Xbox Gamertag").setStyle(TextInputStyle.Short).setRequired(true);

        modal.addComponents(
          new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(tribeNameInput),
          new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(ignInput),
          new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(xboxInput)
        );
        return interaction.showModal(modal);
    }

    // /join
    if (interaction.commandName === "join") {
        const tribeName = interaction.options.getString("tribe_name", true);
        const modal = new ModalBuilder().setCustomId(`join_modal:${tribeName}`).setTitle(`Joining Tribe: ${tribeName}`);
        const ignInput = new TextInputBuilder().setCustomId("ign").setLabel("Your In-Game Name").setStyle(TextInputStyle.Short).setRequired(true);
        const xboxInput = new TextInputBuilder().setCustomId("xbox_gamertag").setLabel("Your Xbox Gamertag").setStyle(TextInputStyle.Short).setRequired(true);

        modal.addComponents(
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(ignInput),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(xboxInput)
        );
        return interaction.showModal(modal);
    }

    // /my-tribe
    if (interaction.commandName === "my-tribe") {
        const [reg] = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, interaction.user.id)).limit(1);
        if (!reg) return interaction.reply({ content: "You aren't registered! Use `/register` or `/join`", ephemeral: true });

        const embed = new EmbedBuilder()
            .setTitle(`👤 Profile: ${reg.ign}`)
            .setColor(Colors.Blue)
            .addFields(
                { name: "Tribe", value: reg.tribeName, inline: true },
                { name: "Xbox", value: reg.xboxGamertag, inline: true },
                { name: "Registered On", value: reg.createdAt.toLocaleDateString(), inline: true }
            );
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // /setup
    if (interaction.commandName === "setup") {
        if (!interaction.guildId) return;
        const role = interaction.options.getRole("admin_role", true);
        const channel = interaction.options.getChannel("staff_channel", true);
        const existing = await getGuildConfig(interaction.guildId);
        const existingRoles = existing?.adminRoleIds ? existing.adminRoleIds.split(",").filter(Boolean) : [];
        if (!existingRoles.includes(role.id)) existingRoles.push(role.id);

        await upsertGuildConfig(interaction.guildId, { adminRoleIds: existingRoles.join(","), staffLogChannelId: channel.id });
        return interaction.reply({ content: "✅ Setup complete!", ephemeral: true });
    }

    // /admin commands
    if (interaction.commandName === "admin") {
        if (!interaction.guildId) return;
        const sub = interaction.options.getSubcommand();
        const existing = await getGuildConfig(interaction.guildId);
        let roles = existing?.adminRoleIds ? existing.adminRoleIds.split(",").filter(Boolean) : [];

        if (sub === "add-role") {
            const role = interaction.options.getRole("role", true);
            if (!roles.includes(role.id)) roles.push(role.id);
            await upsertGuildConfig(interaction.guildId, { adminRoleIds: roles.join(",") });
            return interaction.reply({ content: `✅ Added <@&${role.id}>`, ephemeral: true });
        }
        if (sub === "remove-role") {
            const role = interaction.options.getRole("role", true);
            roles = roles.filter(id => id !== role.id);
            await upsertGuildConfig(interaction.guildId, { adminRoleIds: roles.join(",") });
            return interaction.reply({ content: `✅ Removed <@&${role.id}>`, ephemeral: true });
        }
        if (sub === "view") {
            const embed = new EmbedBuilder().setTitle("Config").addFields({ name: "Admins", value: roles.map(id => `<@&${id}>`).join(", ") || "None" });
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }

    // /list-tribes
    if (interaction.commandName === "list-tribes") {
        if (!interaction.guildId) return;
        if (!(await isAdmin(interaction, interaction.guildId))) return interaction.reply({ content: "Unauthorized", ephemeral: true });

        const registrations = await db.select().from(tribeRegistrationsTable).orderBy(tribeRegistrationsTable.tribeName);
        if (registrations.length === 0) return interaction.reply({ content: "No registrations.", ephemeral: true });

        const embed = new EmbedBuilder().setTitle("All Tribe Registrations").setColor(Colors.Gold);
        // Chunking because of embed limits
        registrations.slice(0, 25).forEach(r => {
            embed.addFields({ name: `[${r.tribeName}] ${r.ign}`, value: `Xbox: ${r.xboxGamertag} | <@${r.discordUserId}>`, inline: false });
        });
        
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // /post-info
    if (interaction.commandName === "post-info") {
        const targetChannel = interaction.options.getChannel("channel") ?? interaction.channel;
        const embed = new EmbedBuilder().setTitle("📋 Tribe Registration").setColor(Colors.Blurple).setDescription("Use `/register` to create a tribe or `/join` to join an existing one!");
        if (targetChannel?.isTextBased()) {
            await targetChannel.send({ embeds: [embed] });
            return interaction.reply({ content: "Posted!", ephemeral: true });
        }
    }
  }

  // --- Handle Modal Submissions ---
  if (interaction.isModalSubmit()) {
    
    // Register OR Join logic
    const isJoin = interaction.customId.startsWith("join_modal:");
    const tribeName = isJoin ? interaction.customId.split(":")[1] : interaction.fields.getTextInputValue("tribe_name").trim();
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

      await interaction.editReply({ content: `✅ Successfully ${isJoin ? 'joined' : 'registered'} **${tribeName}** as **${ign}**!` });

      if (interaction.guildId) {
        const embed = new EmbedBuilder()
          .setTitle(isJoin ? "Member Joined Tribe" : "New Tribe Registered")
          .setColor(isJoin ? Colors.Blue : Colors.Green)
          .addFields(
            { name: "Tribe", value: tribeName, inline: true },
            { name: "IGN", value: ign, inline: true },
            { name: "Xbox", value: xboxGamertag, inline: true },
            { name: "User", value: `<@${interaction.user.id}>`, inline: false }
          ).setTimestamp();
        await postToStaffLog(client, interaction.guildId, embed, !isJoin);
      }
    } catch (err) {
      logger.error(String(err), "Save failed");
      await interaction.editReply({ content: "❌ Error saving to database. You may already be registered." });
    }
  }
});

// 5. Fake Web Server for Render
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running");
});
const PORT = process.env.PORT || 3000;
server.listen(PORT);

// 6. Start Bot
async function startBot() {
  await registerCommands();
  await client.login(token);
}

if (process.env.NODE_ENV !== 'test') {
  startBot();
}        .setDescription("Add a role that can use admin commands")
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
  if (interaction.isChatInputCommand() && interaction.commandName === "my-tribe") {
    const [reg] = await db
      .select()
      .from(tribeRegistrationsTable)
      .where(eq(tribeRegistrationsTable.discordUserId, interaction.user.id));

    if (!reg) {
      return interaction.reply({ 
        content: "You aren't registered yet! Use `/register` to create a tribe or `/join` to join one.", 
        ephemeral: true 
      });
    }

    const embed = new EmbedBuilder()
      .setTitle(`🪖 Your Profile: ${reg.ign}`)
      .setColor(Colors.Blue)
      .addFields(
        { name: "Tribe", value: reg.tribeName, inline: true },
        { name: "Xbox Gamertag", value: reg.xboxGamertag, inline: true },
        { name: "Joined At", value: reg.createdAt.toLocaleDateString(), inline: true }
      )
      .setThumbnail(interaction.user.displayAvatarURL());

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
  
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
