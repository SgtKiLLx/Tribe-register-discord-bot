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
    // Declaring as 'any' to stop TypeScript from checking properties
    const channel: any = await client.channels.fetch(config.staffLogChannelId);
    if (channel && typeof channel.send === 'function') {
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

  // --- Handle Autocomplete ---
  if (interaction.isAutocomplete() && interaction.commandName === "join") {
    const focusedValue = interaction.options.getFocused();
    try {
        const tribes = await db.select({ name: tribeRegistrationsTable.tribeName }).from(tribeRegistrationsTable).groupBy(tribeRegistrationsTable.tribeName);
        const filtered = tribes.map(t => t.name).filter(name => name.toLowerCase().includes(focusedValue.toLowerCase())).slice(0, 25);
        await interaction.respond(filtered.map(name => ({ name: name, value: name })));
    } catch (e) {
        logger.error("Autocomplete error", String(e));
    }
    return;
  }

  // --- Handle Commands ---
  if (interaction.isChatInputCommand()) {
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

    if (interaction.commandName === "my-tribe") {
        const [reg] = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, interaction.user.id)).limit(1);
        if (!reg) return interaction.reply({ content: "You aren't registered!", ephemeral: true });
        const embed = new EmbedBuilder().setTitle(`👤 Profile: ${reg.ign}`).setColor(Colors.Blue).addFields({ name: "Tribe", value: reg.tribeName, inline: true }, { name: "Xbox", value: reg.xboxGamertag, inline: true });
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

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
        if (sub === "view") {
            const embed = new EmbedBuilder().setTitle("Config").addFields({ name: "Admins", value: roles.map(id => `<@&${id}>`).join(", ") || "None" });
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }

    if (interaction.commandName === "list-tribes") {
        if (!interaction.guildId) return;
        if (!(await isAdmin(interaction, interaction.guildId))) return interaction.reply({ content: "Unauthorized", ephemeral: true });
        const registrations = await db.select().from(tribeRegistrationsTable).orderBy(tribeRegistrationsTable.tribeName);
        const embed = new EmbedBuilder().setTitle("Tribe Registrations").setColor(Colors.Gold);
        registrations.slice(0, 25).forEach(r => embed.addFields({ name: `[${r.tribeName}] ${r.ign}`, value: `<@${r.discordUserId}>`, inline: false }));
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === "post-info") {
        // Declaring as 'any' to stop TypeScript from checking properties
        const targetChannel: any = interaction.options.getChannel("channel") ?? interaction.channel;
        const embed = new EmbedBuilder().setTitle("📋 Tribe Registration").setColor(Colors.Blurple).setDescription("Use `/register` or `/join`!");
        
        if (targetChannel && typeof targetChannel.send === 'function') {
            await targetChannel.send({ embeds: [embed] });
            return interaction.reply({ content: "Posted!", ephemeral: true });
        } else {
            return interaction.reply({ content: "I cannot send messages to that channel.", ephemeral: true });
        }
    }
  }

  // --- Handle Modals ---
  if (interaction.isModalSubmit()) {
    const isJoin = interaction.customId.startsWith("join_modal:");
    const tribeName = isJoin ? interaction.customId.split(":")[1] : interaction.fields.getTextInputValue("tribe_name").trim();
    const ign = interaction.fields.getTextInputValue("ign").trim();
    const xboxGamertag = interaction.fields.getTextInputValue("xbox_gamertag").trim();

    await interaction.deferReply({ ephemeral: true });
    try {
      await db.insert(tribeRegistrationsTable).values({ tribeName, ign, xboxGamertag, discordUserId: interaction.user.id, discordUsername: interaction.user.username });
      await interaction.editReply({ content: `✅ Successfully ${isJoin ? 'joined' : 'registered'} **${tribeName}**!` });
      if (interaction.guildId) {
        const embed = new EmbedBuilder().setTitle("Tribe Update").addFields({ name: "Tribe", value: tribeName, inline: true }, { name: "IGN", value: ign, inline: true }, { name: "User", value: `<@${interaction.user.id}>`, inline: false });
        await postToStaffLog(client, interaction.guildId, embed, !isJoin);
      }
    } catch (err) {
      await interaction.editReply({ content: "❌ Error saving. You may already be registered." });
    }
  }
});

// 5. Fake Web Server
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bot is running");
});
server.listen(process.env.PORT || 3000);

// 6. Start
async function startBot() {
  await registerCommands();
  await client.login(token);
}
startBot();
