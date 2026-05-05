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
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ActivityType,
} from "discord.js";
import { db, tribeRegistrationsTable, guildConfigTable } from "./db";
import { eq } from "drizzle-orm";
import { logger } from "./lib/logger";
import http from "http";

const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
const OVERSEER_COLOR = 0x00ffff; // Cyan color to match your icon

if (!token || !applicationId) {
  console.error("CRITICAL ERROR: Missing Environment Variables");
  process.exit(1);
}

// 1. Slash Command Definitions
const commands = [
  new SlashCommandBuilder()
    .setName("setup-category")
    .setDescription("Set the category for new tribe channels")
    .addChannelOption(opt => opt.setName("category").setDescription("Target Category").addChannelTypes(ChannelType.GuildCategory).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName("register").setDescription("Initialize a new tribe signature"),

  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Sync with an existing tribe signature")
    .addStringOption(opt => opt.setName("tribe_name").setDescription("Search Tribe Database").setAutocomplete(true).setRequired(true)),

  new SlashCommandBuilder().setName("my-tribe").setDescription("View your survivor profile"),

  new SlashCommandBuilder().setName("post-info").setDescription("Deploy Overseer Registration Interface").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Configure Overseer Intelligence Feed")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(o => o.setName("role").setDescription("Admin Role").setRequired(true))
    .addChannelOption(o => o.setName("channel").setDescription("Staff Log Channel").setRequired(true)),

  new SlashCommandBuilder()
    .setName("list-tribes")
    .setDescription("View all registered tribes in the database")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// 2. Helper Functions
async function postToStaffLog(guildId: string, embed: EmbedBuilder) {
  try {
    const [config] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, guildId)).limit(1);
    if (!config?.staffLogChannelId) return;
    const channel: any = await client.channels.fetch(config.staffLogChannelId);
    if (channel && typeof channel.send === 'function') {
      await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    logger.warn("Staff log failed");
  }
}

function getTribeDashboard(tribeName: string) {
  const embed = new EmbedBuilder()
    .setTitle(`💠 OVERSEER | Tribe: ${tribeName}`)
    .setDescription("**Private Tribe Channel Initialized.**\nUse the buttons below to manage your roster. New members joining via the Overseer will be granted access automatically.")
    .setColor(OVERSEER_COLOR)
    .setFooter({ text: "Overseer v1.0 | Awaiting Roster Updates..." });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`view_roster:${tribeName}`).setLabel("View Roster").setStyle(ButtonStyle.Secondary).setEmoji("📜"),
    new ButtonBuilder().setCustomId(`leave_tribe`).setLabel("Leave Tribe").setStyle(ButtonStyle.Danger).setEmoji("🚪")
  );
  return { embeds: [embed], components: [row] };
}

// 3. Client Setup
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once(Events.ClientReady, (c) => {
  logger.info({ tag: c.user.tag }, "Overseer System Online");
  c.user.setActivity('the Arks', { type: ActivityType.Watching });
});

// 4. Interaction Listener
client.on(Events.InteractionCreate, async (interaction: Interaction) => {

  // --- Autocomplete for /join ---
  if (interaction.isAutocomplete() && interaction.commandName === "join") {
    try {
      const tribes = await db.select({ name: tribeRegistrationsTable.tribeName }).from(tribeRegistrationsTable).groupBy(tribeRegistrationsTable.tribeName);
      const focusedValue = interaction.options.getFocused().toLowerCase();
      const filtered = tribes.map(t => t.name).filter(n => n.toLowerCase().includes(focusedValue)).slice(0, 25);
      await interaction.respond(filtered.map(n => ({ name: n, value: n })));
    } catch (e) { console.error(e); }
    return;
  }

  // --- Button Handlers ---
  if (interaction.isButton()) {
    if (interaction.customId === "btn_start_register") {
      const modal = new ModalBuilder().setCustomId("tribe_register_modal").setTitle("Register New Tribe Signature");
      modal.addComponents(
        new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe_name").setLabel("Tribe Name").setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("ign").setLabel("Your In-Game Name").setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("xbox").setLabel("Xbox Gamertag").setStyle(TextInputStyle.Short).setRequired(true))
      );
      return interaction.showModal(modal);
    }

    if (interaction.customId === "btn_start_join") {
      const modal = new ModalBuilder().setCustomId("btn_join_modal").setTitle("Join Existing Tribe Signature");
      modal.addComponents(
        new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe_name").setLabel("Exact Tribe Name").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("Must match registration exactly")),
        new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("ign").setLabel("Your In-Game Name").setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("xbox").setLabel("Xbox Gamertag").setStyle(TextInputStyle.Short).setRequired(true))
      );
      return interaction.showModal(modal);
    }

    if (interaction.customId.startsWith("view_roster:")) {
      const tribeName = interaction.customId.split(":")[1];
      const members = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.tribeName, tribeName));
      const list = members.map(m => `• **${m.ign}** (<@${m.discordUserId}>)`).join("\n") || "Database empty.";
      return interaction.reply({ content: `📜 **${tribeName} Roster:**\n${list}`, ephemeral: true });
    }

    if (interaction.customId === "leave_tribe") {
      await db.delete(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, interaction.user.id));
      return interaction.reply({ content: "Survivor signature removed from database. Request staff to revoke channel permissions.", ephemeral: true });
    }
  }

  // --- Slash Command Handlers ---
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "setup-category") {
      const category = interaction.options.getChannel("category", true);
      await db.insert(guildConfigTable).values({ guildId: interaction.guildId!, tribeCategoryId: category.id }).onConflictDoUpdate({ target: guildConfigTable.guildId, set: { tribeCategoryId: category.id } });
      return interaction.reply(`✅ **Overseer Updated.** Tribe channels will now spawn in **${category.name}**.`);
    }

    if (interaction.commandName === "post-info") {
      const embed = new EmbedBuilder()
        .setTitle("🔵 OVERSEER | Initialization Protocol")
        .setDescription("**System Online.** Welcome, Survivor. Select a protocol below to begin integration.")
        .setColor(OVERSEER_COLOR)
        .addFields(
          { name: "📝 Create Tribe", value: "Initialize a new tribe and private channel.", inline: true },
          { name: "🤝 Join Tribe", value: "Sync with an existing tribe roster.", inline: true }
        );
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("btn_start_register").setLabel("Create Tribe").setStyle(ButtonStyle.Success).setEmoji("📝"),
        new ButtonBuilder().setCustomId("btn_start_join").setLabel("Join Tribe").setStyle(ButtonStyle.Primary).setEmoji("🤝")
      );
      const target: any = interaction.channel;
      await target.send({ embeds: [embed], components: [row] });
      return interaction.reply({ content: "Overseer Interface Deployed.", ephemeral: true });
    }

    if (interaction.commandName === "my-tribe") {
      const [reg] = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, interaction.user.id)).limit(1);
      if (!reg) return interaction.reply({ content: "No signature found. Use `/register` or click a button.", ephemeral: true });
      const embed = new EmbedBuilder().setTitle(`👤 Survivor: ${reg.ign}`).setColor(OVERSEER_COLOR).addFields({ name: "Tribe", value: reg.tribeName, inline: true }, { name: "Xbox", value: reg.xboxGamertag, inline: true });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === "setup") {
      const role = interaction.options.getRole("role", true);
      const channel = interaction.options.getChannel("channel", true);
      await db.insert(guildConfigTable).values({ guildId: interaction.guildId!, adminRoleIds: role.id, staffLogChannelId: channel.id }).onConflictDoUpdate({ target: guildConfigTable.guildId, set: { adminRoleIds: role.id, staffLogChannelId: channel.id } });
      return interaction.reply("✅ Overseer Intelligence Feed configured.");
    }

    if (interaction.commandName === "list-tribes") {
        const regs = await db.select().from(tribeRegistrationsTable).orderBy(tribeRegistrationsTable.tribeName);
        if (regs.length === 0) return interaction.reply({ content: "Database empty.", ephemeral: true });
        const embed = new EmbedBuilder().setTitle("Global Tribe Database").setColor(OVERSEER_COLOR);
        regs.slice(0, 25).forEach(r => embed.addFields({ name: `[${r.tribeName}] ${r.ign}`, value: `Xbox: ${r.xboxGamertag} | <@${r.discordUserId}>`, inline: false }));
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }

  // --- Modal Submissions ---
  if (interaction.isModalSubmit()) {
    const isJoin = interaction.customId === "btn_join_modal";
    const tribeName = interaction.fields.getTextInputValue("tribe_name").trim();
    const ign = interaction.fields.getTextInputValue("ign").trim();
    const xbox = interaction.fields.getTextInputValue("xbox").trim();

    await interaction.deferReply({ ephemeral: true });

    try {
      let channelId: string | null = null;
      if (!isJoin) {
        const config = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, interaction.guildId!)).limit(1);
        const parentId = config[0]?.tribeCategoryId || undefined;
        const channel = await interaction.guild?.channels.create({
          name: `tribe-${tribeName.toLowerCase().replace(/\s+/g, '-')}`,
          type: ChannelType.GuildText,
          parent: parentId,
          permissionOverwrites: [
            { id: interaction.guild!.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
            { id: client.user!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
          ]
        });
        channelId = channel?.id || null;
        if (channel) await (channel as any).send(getTribeDashboard(tribeName));
      } else {
        const existing = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.tribeName, tribeName)).limit(1);
        channelId = existing[0]?.channelId || null;
        if (channelId) {
          const channel = await interaction.guild?.channels.fetch(channelId);
          if (channel && 'permissionOverwrites' in channel) {
            await (channel as any).permissionOverwrites.create(interaction.user.id, { ViewChannel: true, SendMessages: true });
          }
        }
      }

      await db.insert(tribeRegistrationsTable).values({ tribeName, ign, xboxGamertag: xbox, discordUserId: interaction.user.id, discordUsername: interaction.user.username, channelId, isOwner: !isJoin });
      await interaction.editReply(`✅ **Initializaton Successful.** Signature stored for **${tribeName}**. ${channelId ? `Check <#${channelId}>` : ''}`);
      
      const log = new EmbedBuilder().setTitle("Overseer Alert").setDescription(`<@${interaction.user.id}> ${isJoin ? 'synced with' : 'initialized'} **${tribeName}**`).setColor(OVERSEER_COLOR).setTimestamp();
      await postToStaffLog(interaction.guildId!, log);
    } catch (e) {
      console.error(e);
      await interaction.editReply("❌ **Protocol Failure.** Ensure you are not already registered.");
    }
  }
});

// 5. Keep Alive Web Server
http.createServer((_, res) => { res.writeHead(200); res.end("Overseer Online"); }).listen(process.env.PORT || 3000);

// 6. Startup
async function start() {
  const rest = new REST({ version: "10" }).setToken(token!);
  await rest.put(Routes.applicationCommands(applicationId!), { body: commands.map(c => c.toJSON()) });
  await client.login(token);
}
start();
