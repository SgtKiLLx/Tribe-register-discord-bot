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
  GuildMember,
} from "discord.js";
import { db, tribeRegistrationsTable, guildConfigTable } from "./db";
import { eq, and } from "drizzle-orm";
import { logger } from "./lib/logger";
import http from "http";

const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
const OVERSEER_COLOR = 0x00ffff; 

if (!token || !applicationId) {
  console.error("CRITICAL ERROR: Missing Environment Variables");
  process.exit(1);
}

// --- Dynamic Status Helper ---
async function refreshOverseerStatus(client: Client) {
    try {
        const tribes = await db.select({ name: tribeRegistrationsTable.tribeName }).from(tribeRegistrationsTable).groupBy(tribeRegistrationsTable.tribeName);
        const count = tribes.length;
        const statusText = count > 0 ? `over ${count} Tribes` : "over the server";
        client.user?.setActivity(statusText, { type: ActivityType.Watching });
    } catch (e) { logger.error("Status update failed"); }
}

// --- Nickname Sync Helper ---
async function syncNickname(member: GuildMember, tribe: string, ign: string) {
    try {
        // Format: [TribeName] InGameName
        const newNick = `[${tribe}] ${ign}`.substring(0, 32); 
        await member.setNickname(newNick);
    } catch (e) {
        logger.warn(`Could not set nickname for ${member.user.tag}. Ensure bot role is higher than user role.`);
    }
}

// 1. Slash Command Definitions
const commands = [
  new SlashCommandBuilder().setName("help").setDescription("View the Overseer command manual"),
  new SlashCommandBuilder().setName("register").setDescription("Initialize a new tribe signature"),
  new SlashCommandBuilder().setName("my-tribe").setDescription("View your current survivor profile"),
  new SlashCommandBuilder().setName("leave-tribe").setDescription("Exit your current tribe and revoke access to the private channel"),
  
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Sync with an existing tribe signature")
    .addStringOption(opt => opt.setName("tribe_name").setDescription("Tribe to join").setAutocomplete(true).setRequired(true)),

  new SlashCommandBuilder()
    .setName("kick-member")
    .setDescription("Remove a survivor from their tribe (Admin Only)")
    .addUserOption(opt => opt.setName("target").setDescription("User to kick").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName("setup-category")
    .setDescription("Set the category for new tribe channels")
    .addChannelOption(opt => opt.setName("category").addChannelTypes(ChannelType.GuildCategory).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName("post-info").setDescription("Deploy Overseer Registration Interface").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Configure Overseer Intelligence Feed")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(o => o.setName("role").setRequired(true))
    .addChannelOption(o => o.setName("channel").setRequired(true)),

  new SlashCommandBuilder().setName("list-tribes").setDescription("View all registered tribes").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// 2. Helper Functions
async function postToStaffLog(guildId: string, embed: EmbedBuilder) {
  const [config] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, guildId)).limit(1);
  if (!config?.staffLogChannelId) return;
  const channel: any = await client.channels.fetch(config.staffLogChannelId);
  if (channel && typeof channel.send === 'function') await channel.send({ embeds: [embed] });
}

function getTribeDashboard(tribeName: string) {
  const embed = new EmbedBuilder()
    .setTitle(`💠 OVERSEER | Tribe: ${tribeName}`)
    .setDescription("Private Tribe Channel Initialized.\nUse the buttons below to manage your roster.")
    .setColor(OVERSEER_COLOR);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`view_roster:${tribeName}`).setLabel("View Roster").setStyle(ButtonStyle.Secondary).setEmoji("📜"),
    new ButtonBuilder().setCustomId(`leave_tribe_btn`).setLabel("Leave Tribe").setStyle(ButtonStyle.Danger).setEmoji("🚪")
  );
  return { embeds: [embed], components: [row] };
}

// 3. Client Setup
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once(Events.ClientReady, async (c) => {
  logger.info({ tag: c.user.tag }, "Overseer System Online");
  await refreshOverseerStatus(c);
});

// 4. Interaction Listener
client.on(Events.InteractionCreate, async (interaction: Interaction) => {

  // --- Autocomplete ---
  if (interaction.isAutocomplete() && interaction.commandName === "join") {
    const tribes = await db.select({ name: tribeRegistrationsTable.tribeName }).from(tribeRegistrationsTable).groupBy(tribeRegistrationsTable.tribeName);
    const filtered = tribes.map(t => t.name).filter(n => n.toLowerCase().includes(interaction.options.getFocused().toLowerCase())).slice(0, 25);
    return interaction.respond(filtered.map(n => ({ name: n, value: n })));
  }

  // --- Buttons ---
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
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe_name").setLabel("Exact Tribe Name").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("ign").setLabel("Your In-Game Name").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("xbox").setLabel("Xbox Gamertag").setStyle(TextInputStyle.Short).setRequired(true))
        );
        return interaction.showModal(modal);
    }
    if (interaction.customId.startsWith("view_roster:")) {
        const tName = interaction.customId.split(":")[1];
        const mems = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.tribeName, tName));
        const list = mems.map(m => `• **${m.ign}** (<@${m.discordUserId}>)`).join("\n") || "No members.";
        return interaction.reply({ content: `📜 **${tName} Roster:**\n${list}`, ephemeral: true });
    }
    if (interaction.customId === "leave_tribe_btn") {
        // Just triggers the command-like behavior
        return interaction.reply({ content: "Please use the command `/leave-tribe` to confirm exit.", ephemeral: true });
    }
  }

  // --- Chat Commands ---
  if (interaction.isChatInputCommand()) {
    
    if (interaction.commandName === "help") {
        const embed = new EmbedBuilder()
            .setTitle("🔵 OVERSEER | Documentation")
            .setColor(OVERSEER_COLOR)
            .addFields(
                { name: "Survivor Commands", value: "`/register` - Create a new tribe\n`/join` - Join existing tribe\n`/my-tribe` - View your profile\n`/leave-tribe` - Exit current tribe" },
                { name: "Staff Commands", value: "`/kick-member` - Remove someone from a tribe\n`/list-tribes` - View global database\n`/post-info` - Post registration buttons\n`/setup` - Configure logs/roles" }
            )
            .setFooter({ text: "Overseer v1.0 | Automating Ark Tribes" });
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === "leave-tribe") {
        const [reg] = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, interaction.user.id)).limit(1);
        if (!reg) return interaction.reply({ content: "Signature not found in database.", ephemeral: true });

        await db.delete(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, interaction.user.id));
        if (reg.channelId) {
            const chan: any = await interaction.guild?.channels.fetch(reg.channelId).catch(() => null);
            if (chan?.permissionOverwrites) await chan.permissionOverwrites.delete(interaction.user.id);
        }
        await refreshOverseerStatus(client);
        return interaction.reply({ content: "✅ Protocol Complete. You have left the tribe and lost channel access.", ephemeral: true });
    }

    if (interaction.commandName === "kick-member") {
        const target = interaction.options.getUser("target", true);
        const [reg] = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, target.id)).limit(1);
        if (!reg) return interaction.reply({ content: "Survivor not found in tribe records.", ephemeral: true });

        await db.delete(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, target.id));
        if (reg.channelId) {
            const chan: any = await interaction.guild?.channels.fetch(reg.channelId).catch(() => null);
            if (chan?.permissionOverwrites) await chan.permissionOverwrites.delete(target.id);
        }
        await refreshOverseerStatus(client);
        return interaction.reply({ content: `✅ Successfully kicked <@${target.id}> from **${reg.tribeName}**.` });
    }

    if (interaction.commandName === "setup-category") {
        const cat = interaction.options.getChannel("category", true);
        await db.insert(guildConfigTable).values({ guildId: interaction.guildId!, tribeCategoryId: cat.id }).onConflictDoUpdate({ target: guildConfigTable.guildId, set: { tribeCategoryId: cat.id } });
        return interaction.reply(`✅ Tribe channels set to category: **${cat.name}**`);
    }

    if (interaction.commandName === "post-info") {
        const embed = new EmbedBuilder().setTitle("🔵 OVERSEER | Registration").setDescription("Select an initialization protocol below.").setColor(OVERSEER_COLOR);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("btn_start_register").setLabel("Create Tribe").setStyle(ButtonStyle.Success).setEmoji("📝"),
            new ButtonBuilder().setCustomId("btn_start_join").setLabel("Join Tribe").setStyle(ButtonStyle.Primary).setEmoji("🤝")
        );
        const target: any = interaction.channel;
        await target.send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: "Interface Deployed.", ephemeral: true });
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
        const embed = new EmbedBuilder().setTitle("Global Database").setColor(OVERSEER_COLOR);
        regs.slice(0, 25).forEach(r => embed.addFields({ name: `[${r.tribeName}] ${r.ign}`, value: `<@${r.discordUserId}>`, inline: false }));
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
                const chan: any = await interaction.guild?.channels.fetch(channelId).catch(() => null);
                if (chan?.permissionOverwrites) await chan.permissionOverwrites.create(interaction.user.id, { ViewChannel: true, SendMessages: true });
            }
        }

        await db.insert(tribeRegistrationsTable).values({ tribeName, ign, xboxGamertag: xbox, discordUserId: interaction.user.id, discordUsername: interaction.user.username, channelId, isOwner: !isJoin });
        
        // --- RUN NICKNAME SYNC ---
        const member = interaction.member as GuildMember;
        if (member) await syncNickname(member, tribeName, ign);

        await refreshOverseerStatus(client);
        await interaction.editReply(`✅ Protocol Success. Check <#${channelId}>`);
        
        const log = new EmbedBuilder().setTitle("Alert").setDescription(`<@${interaction.user.id}> joined **${tribeName}**`).setColor(OVERSEER_COLOR);
        await postToStaffLog(interaction.guildId!, log);
    } catch (e) {
        await interaction.editReply("❌ Protocol Failure. Signature already exists.");
    }
  }
});

http.createServer((_, res) => { res.writeHead(200); res.end("Alive"); }).listen(process.env.PORT || 3000);

async function start() {
  const rest = new REST({ version: "10" }).setToken(token!);
  await rest.put(Routes.applicationCommands(applicationId!), { body: commands.map(c => c.toJSON()) });
  await client.login(token);
}
start();
