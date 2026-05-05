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
import { eq } from "drizzle-orm";
import { logger } from "./lib/logger";
import http from "http";

const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
const OVERSEER_COLOR = 0x00ffff; 

if (!token || !applicationId) {
  console.error("CRITICAL: Missing environment variables.");
  process.exit(1);
}

// --- Helpers ---
async function refreshOverseerStatus(client: Client) {
    try {
        const tribes = await db.select({ name: tribeRegistrationsTable.tribeName }).from(tribeRegistrationsTable).groupBy(tribeRegistrationsTable.tribeName);
        const count = tribes.length;
        const statusText = count > 0 ? `over ${count} Tribes` : "over the server";
        client.user?.setActivity(statusText, { type: ActivityType.Watching });
    } catch (e) { logger.warn("Status update failed"); }
}

async function syncNickname(member: GuildMember, tribe: string, ign: string) {
    try {
        const newNick = `[${tribe}] ${ign}`.substring(0, 32); 
        if (member.manageable) {
            await member.setNickname(newNick);
        }
    } catch (e) { logger.warn(`Nick sync failed for ${member.user.tag}`); }
}

async function postToStaffLog(guildId: string, embed: EmbedBuilder) {
    try {
        const [config] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, guildId)).limit(1);
        if (!config?.staffLogChannelId) return;
        const channel: any = await client.channels.fetch(config.staffLogChannelId);
        if (channel && typeof channel.send === 'function') await channel.send({ embeds: [embed] });
    } catch (e) { logger.warn("Log failed"); }
}

function getTribeDashboard(tribeName: string) {
  const embed = new EmbedBuilder()
    .setTitle(`💠 OVERSEER | Tribe: ${tribeName}`)
    .setDescription("Private Tribe Channel Initialized.\nUse buttons below to manage roster.")
    .setColor(OVERSEER_COLOR)
    .setFooter({ text: "Overseer v1.0 | Awaiting Roster Updates" });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`view_roster:${tribeName}`).setLabel("View Roster").setStyle(ButtonStyle.Secondary).setEmoji("📜"),
    new ButtonBuilder().setCustomId(`leave_confirm`).setLabel("Leave Tribe").setStyle(ButtonStyle.Danger).setEmoji("🚪")
  );
  return { embeds: [embed], components: [row] };
}

// 1. Commands
const commands = [
  new SlashCommandBuilder().setName("help").setDescription("View Overseer manual"),
  new SlashCommandBuilder().setName("register").setDescription("Register a new tribe signature"),
  new SlashCommandBuilder().setName("my-tribe").setDescription("View your survivor profile"),
  new SlashCommandBuilder().setName("leave-tribe").setDescription("Exit current tribe and revoke access"),
  new SlashCommandBuilder().setName("join").setDescription("Sync with existing tribe").addStringOption(o => o.setName("tribe_name").setDescription("Search Tribe DB").setAutocomplete(true).setRequired(true)),
  new SlashCommandBuilder().setName("kick-member").setDescription("Remove player (Staff Only)").addUserOption(o => o.setName("target").setDescription("Target Survivor").setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  new SlashCommandBuilder().setName("setup-category").setDescription("Set tribe channel category").addChannelOption(o => o.setName("category").setDescription("Target Category").addChannelTypes(ChannelType.GuildCategory).setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("post-info").setDescription("Deploy Overseer Registration Interface").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("setup").setDescription("Setup logs and roles").setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addRoleOption(o => o.setName("role").setDescription("Admin Role").setRequired(true)).addChannelOption(o => o.setName("channel").setDescription("Staff Logs").setRequired(true)),
  new SlashCommandBuilder().setName("list-tribes").setDescription("View global tribe database").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// 2. Client Init
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once(Events.ClientReady, async (c) => {
  logger.info({ tag: c.user.tag }, "Overseer System Online");
  await refreshOverseerStatus(c);
});

// 3. Interaction Logic
client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  
  if (interaction.isAutocomplete() && interaction.commandName === "join") {
    const tribes = await db.select({ name: tribeRegistrationsTable.tribeName }).from(tribeRegistrationsTable).groupBy(tribeRegistrationsTable.tribeName);
    const focused = interaction.options.getFocused().toLowerCase();
    const filtered = tribes.map(t => t.name).filter(n => n.toLowerCase().includes(focused)).slice(0, 25);
    return interaction.respond(filtered.map(n => ({ name: n, value: n })));
  }

  if (interaction.isButton()) {
    if (interaction.customId === "btn_start_register") {
        const modal = new ModalBuilder().setCustomId("tribe_register_modal").setTitle("Register Tribe");
        modal.addComponents(
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe_name").setLabel("Tribe Name").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("ign").setLabel("IGN").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("xbox").setLabel("Xbox").setStyle(TextInputStyle.Short).setRequired(true))
        );
        return interaction.showModal(modal);
    }
    if (interaction.customId === "btn_start_join") {
        const modal = new ModalBuilder().setCustomId("btn_join_modal").setTitle("Join Existing Tribe");
        modal.addComponents(
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe_name").setLabel("Exact Tribe Name").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("ign").setLabel("IGN").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("xbox").setLabel("Xbox").setStyle(TextInputStyle.Short).setRequired(true))
        );
        return interaction.showModal(modal);
    }
    if (interaction.customId.startsWith("view_roster:")) {
        const tName = interaction.customId.split(":")[1];
        const mems = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.tribeName, tName));
        const list = mems.map(m => `• **${m.ign}** (<@${m.discordUserId}>)`).join("\n") || "No members.";
        return interaction.reply({ content: `📜 **${tName} Roster:**\n${list}`, ephemeral: true });
    }
    if (interaction.customId === "leave_confirm") return interaction.reply({ content: "Please use `/leave-tribe` to confirm exit.", ephemeral: true });
  }

  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "help") {
        const embed = new EmbedBuilder().setTitle("🔵 OVERSEER | Documentation").setColor(OVERSEER_COLOR).addFields({ name: "Survivor", value: "`/register`, `/join`, `/my-tribe`, `/leave-tribe`" }, { name: "Staff", value: "`/kick-member`, `/list-tribes`, `/post-info`, `/setup`" });
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === "post-info") {
        const target: any = interaction.options.getChannel("channel") ?? interaction.channel;
        const embed = new EmbedBuilder()
            .setTitle("🛡️ OVERSEER | TRIBE INITIALIZATION PROTOCOL")
            .setThumbnail(client.user?.displayAvatarURL() || null)
            .setColor(OVERSEER_COLOR)
            .setDescription("**System Online.** Welcome, Survivor. To access the private sectors of this server, you must initialize your tribe signature within the Overseer database.")
            .addFields(
                { name: "📝 CREATE NEW TRIBE", value: "Select this if you are the **Tribe Leader**. This protocol will spawn a private headquarters.", inline: false },
                { name: "🤝 JOIN EXISTING TRIBE", value: "Select this if your tribe is **already registered**. You will be synced to your team's roster.", inline: false },
                { name: "⚙️ AUTOMATED FEATURES", value: "• **Nickname Sync:** `[Tribe] Name` format.\n• **Private HQ:** Automated channel creation.\n• **Roster Tracking:** View members in one click.", inline: false }
            )
            .setFooter({ text: "Overseer v1.0 | Authorized Personnel Only" })
            .setTimestamp();
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("btn_start_register").setLabel("Create Tribe").setStyle(ButtonStyle.Success).setEmoji("📝"),
            new ButtonBuilder().setCustomId("btn_start_join").setLabel("Join Tribe").setStyle(ButtonStyle.Primary).setEmoji("🤝")
        );
        if (target && typeof target.send === 'function') {
            await target.send({ embeds: [embed], components: [row] });
            return interaction.reply({ content: "Overseer Interface successfully deployed.", ephemeral: true });
        }
    }

    if (interaction.commandName === "leave-tribe") {
        const [reg] = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, interaction.user.id)).limit(1);
        if (!reg) return interaction.reply({ content: "Record not found.", ephemeral: true });
        await db.delete(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, interaction.user.id));
        if (reg.channelId) {
            const chan: any = await interaction.guild?.channels.fetch(reg.channelId).catch(() => null);
            if (chan?.permissionOverwrites) await chan.permissionOverwrites.delete(interaction.user.id);
        }
        await refreshOverseerStatus(client);
        return interaction.reply({ content: "✅ Protocol Complete. Signature removed.", ephemeral: true });
    }

    if (interaction.commandName === "kick-member") {
        const target = interaction.options.getUser("target", true);
        const [reg] = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, target.id)).limit(1);
        if (!reg) return interaction.reply({ content: "Player not found.", ephemeral: true });
        await db.delete(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, target.id));
        if (reg.channelId) {
            const chan: any = await interaction.guild?.channels.fetch(reg.channelId).catch(() => null);
            if (chan?.permissionOverwrites) await chan.permissionOverwrites.delete(target.id);
        }
        await refreshOverseerStatus(client);
        return interaction.reply({ content: `✅ Kicked <@${target.id}> from **${reg.tribeName}**.` });
    }

    if (interaction.commandName === "setup-category") {
        const cat = interaction.options.getChannel("category", true);
        await db.insert(guildConfigTable).values({ guildId: interaction.guildId!, tribeCategoryId: cat.id }).onConflictDoUpdate({ target: guildConfigTable.guildId, set: { tribeCategoryId: cat.id } });
        return interaction.reply(`✅ Tribe category: **${cat.name}**`);
    }

    if (interaction.commandName === "setup") {
        const r = interaction.options.getRole("role", true);
        const c = interaction.options.getChannel("channel", true);
        await db.insert(guildConfigTable).values({ guildId: interaction.guildId!, adminRoleIds: r.id, staffLogChannelId: c.id }).onConflictDoUpdate({ target: guildConfigTable.guildId, set: { adminRoleIds: r.id, staffLogChannelId: c.id } });
        return interaction.reply("✅ Overseer feed configured.");
    }

    if (interaction.commandName === "list-tribes") {
        const regs = await db.select().from(tribeRegistrationsTable).orderBy(tribeRegistrationsTable.tribeName);
        const embed = new EmbedBuilder().setTitle("Global Database").setColor(OVERSEER_COLOR);
        regs.slice(0, 25).forEach(r => embed.addFields({ name: `[${r.tribeName}] ${r.ign}`, value: `<@${r.discordUserId}>`, inline: false }));
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === "my-tribe") {
        const [reg] = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, interaction.user.id)).limit(1);
        if (!reg) return interaction.reply({ content: "No record found.", ephemeral: true });
        const embed = new EmbedBuilder().setTitle(`👤 ${reg.ign}`).addFields({ name: "Tribe", value: reg.tribeName }).setColor(OVERSEER_COLOR);
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }

  if (interaction.isModalSubmit()) {
    const isBtnJoin = interaction.customId === "btn_join_modal";
    const isSlashJoin = interaction.customId.startsWith("join_modal:");
    const tribeName = isSlashJoin ? interaction.customId.split(":")[1] : interaction.fields.getTextInputValue("tribe_name").trim();
    const ign = interaction.fields.getTextInputValue("ign").trim();
    const xbox = interaction.fields.getTextInputValue("xbox").trim();

    await interaction.deferReply({ ephemeral: true });

    try {
        let channelId: string | null = null;
        if (!isBtnJoin && !isSlashJoin) {
            const config = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, interaction.guildId!)).limit(1);
            const parentId = config[0]?.tribeCategoryId || undefined;
            const chan = await interaction.guild?.channels.create({
                name: `tribe-${tribeName.toLowerCase().replace(/\s+/g, '-')}`,
                type: ChannelType.GuildText,
                parent: parentId,
                permissionOverwrites: [
                    { id: interaction.guild!.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                    { id: client.user!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
                ]
            });
            channelId = chan?.id || null;
            if (chan) await (chan as any).send(getTribeDashboard(tribeName));
        } else {
            const existing = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.tribeName, tribeName)).limit(1);
            channelId = existing[0]?.channelId || null;
            if (channelId) {
                const chan: any = await interaction.guild?.channels.fetch(channelId).catch(() => null);
                if (chan?.permissionOverwrites) await (chan as any).permissionOverwrites.create(interaction.user.id, { ViewChannel: true, SendMessages: true });
            }
        }

        await db.insert(tribeRegistrationsTable).values({ tribeName, ign, xboxGamertag: xbox, discordUserId: interaction.user.id, discordUsername: interaction.user.username, channelId, isOwner: (!isBtnJoin && !isSlashJoin) });
        const member = interaction.member as GuildMember;
        if (member) await syncNickname(member, tribeName, ign);
        await refreshOverseerStatus(client);
        await interaction.editReply(`✅ Protocol Success. Check <#${channelId}>`);
        await postToStaffLog(interaction.guildId!, new EmbedBuilder().setTitle("Update").setDescription(`<@${interaction.user.id}> initialized signature for **${tribeName}**`));
    } catch (e) {
        await interaction.editReply("❌ Already registered or protocol failure.");
    }
  }
});

// --- 5. HIGH-EFFICIENCY WEB SERVER ---
// Optimized for Cron-job.org and Render's free tier
http.createServer((req, res) => {
  const body = "OK";
  res.writeHead(200, {
    'Content-Type': 'text/plain',
    'Content-Length': Buffer.byteLength(body),
    'Connection': 'close'
  });
  res.end(body);
}).listen(process.env.PORT || 3000, () => {
  logger.info("Overseer Pinger Server ready on port " + (process.env.PORT || 3000));
});

async function start() {
    try {
        const rest = new REST({ version: "10" }).setToken(token!);
        await rest.put(Routes.applicationCommands(applicationId!), { body: commands.map(c => c.toJSON()) });
        await client.login(token);
    } catch (e) { console.error(e); }
}
start();
