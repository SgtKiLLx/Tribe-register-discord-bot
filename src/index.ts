import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, ActionRowBuilder, type ModalActionRowComponentBuilder,
  Events, type Interaction, PermissionFlagsBits, EmbedBuilder, Colors,
  ButtonBuilder, ButtonStyle, ChannelType, ActivityType, GuildMember
} from "discord.js";
import { db, tribeRegistrationsTable, guildConfigTable, tribeTasksTable } from "./db";
import { eq } from "drizzle-orm";
import { logger } from "./lib/logger";
import http from "http";

const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
const OVERSEER_COLOR = 0x00ffff; 

if (!token || !applicationId) process.exit(1);

// --- Helpers ---
async function refreshOverseerStatus(client: Client) {
    try {
        const tribes = await db.select({ name: tribeRegistrationsTable.tribeName }).from(tribeRegistrationsTable).groupBy(tribeRegistrationsTable.tribeName);
        const count = tribes.length;
        const statusText = count > 0 ? `over ${count} Tribes` : "over the server";
        client.user?.setActivity(statusText, { type: ActivityType.Watching });
    } catch (e) { logger.warn("Status update failed"); }
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
    .setTitle(`💠 OVERSEER | HQ: ${tribeName}`)
    .setDescription("Tribe Channel Active. Use buttons below for coordination.")
    .setColor(OVERSEER_COLOR)
    .addFields(
      { name: "🚨 RAID ALERT", value: "Emergency ping for all members.", inline: true },
      { name: "🎁 STARTER KIT", value: "Request one-time starter kit.", inline: true }
    );
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("raid_alert").setLabel("RAID ALERT").setStyle(ButtonStyle.Danger).setEmoji("🚨"),
    new ButtonBuilder().setCustomId("claim_kit").setLabel("Claim Kit").setStyle(ButtonStyle.Success).setEmoji("🎁")
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("view_roster").setLabel("Roster").setStyle(ButtonStyle.Secondary).setEmoji("📜"),
    new ButtonBuilder().setCustomId("add_task").setLabel("Add Task").setStyle(ButtonStyle.Primary).setEmoji("📋")
  );
  return { embeds: [embed], components: [row1, row2] };
}

// 1. Commands
const commands = [
  new SlashCommandBuilder().setName("help").setDescription("View the Overseer manual"),
  new SlashCommandBuilder().setName("post-info").setDescription("Deploy Registration Interface").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("lft").setDescription("Post a recruitment profile to find a tribe"),
  new SlashCommandBuilder().setName("my-tribe").setDescription("View your survivor profile"),
  new SlashCommandBuilder().setName("leave-tribe").setDescription("Exit current tribe and revoke access"),
  new SlashCommandBuilder().setName("list-tribes").setDescription("View global tribe database").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("kick-member").setDescription("Remove survivor from records (Staff)").addUserOption(o => o.setName("target").setDescription("User to kick").setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  new SlashCommandBuilder().setName("setup").setDescription("Configure Overseer protocols")
    .addRoleOption(o => o.setName("role").setDescription("Admin Role").setRequired(true))
    .addChannelOption(o => o.setName("logs").setDescription("Staff Logs").setRequired(true))
    .addChannelOption(o => o.setName("welcome").setDescription("Welcome Channel").setRequired(true))
    .addChannelOption(o => o.setName("rules").setDescription("Rules Channel").setRequired(true))
    .addChannelOption(o => o.setName("info").setDescription("Info Channel").setRequired(true))
    .addChannelOption(o => o.setName("recruitment").setDescription("Recruit-Channels").setRequired(true))
    .addChannelOption(o => o.setName("category").setDescription("Tribe Category").addChannelTypes(ChannelType.GuildCategory).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// 2. Client Setup
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages] });

client.once(Events.ClientReady, async (c) => {
  logger.info({ tag: c.user.tag }, "Overseer System Online");
  await refreshOverseerStatus(c);
});

// --- Welcome Event ---
client.on(Events.GuildMemberAdd, async (member) => {
    const [config] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, member.guild.id)).limit(1);
    if (!config || !config.welcomeChannelId) return;
    const welcomeChan: any = await member.guild.channels.fetch(config.welcomeChannelId).catch(() => null);
    if (welcomeChan) {
        const embed = new EmbedBuilder()
            .setTitle("🔵 OVERSEER | NEW SURVIVOR DETECTED")
            .setThumbnail(member.user.displayAvatarURL())
            .setColor(OVERSEER_COLOR)
            .setDescription(`Welcome to the Ark, <@${member.id}>.\nReview the directives below to begin integration.`)
            .addFields(
                { name: "📜 SERVER DIRECTIVES", value: `<#${config.rulesChannelId}> - Rules\n<#${config.infoChannelId}> - Info`, inline: false },
                { name: "🦖 TRIBE INTEGRATION", value: `Register/Join at <#1488536840263700580>`, inline: false },
                { name: "🤝 RECRUITMENT", value: `Post LFT at <#1492542485820477511>`, inline: false }
            ).setFooter({ text: `Survivor #${member.guild.memberCount}` }).setTimestamp();
        await welcomeChan.send({ content: `Welcome, <@${member.id}>`, embeds: [embed] });
    }
});

// 3. Interaction Listener
client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (interaction.isAutocomplete()) {
    const tribes = await db.select({ name: tribeRegistrationsTable.tribeName }).from(tribeRegistrationsTable).groupBy(tribeRegistrationsTable.tribeName);
    const filtered = tribes.map(t => t.name).filter(n => n.toLowerCase().includes(interaction.options.getFocused().toLowerCase())).slice(0, 25);
    return interaction.respond(filtered.map(n => ({ name: n, value: n })));
  }

  if (interaction.isButton()) {
    const [userReg] = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, interaction.user.id)).limit(1);
    if (interaction.customId === "btn_start_register") {
      const modal = new ModalBuilder().setCustomId("modal_reg").setTitle("Register New Tribe");
      modal.addComponents(
        new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe").setLabel("Tribe Name").setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("ign").setLabel("Your IGN").setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("xbox").setLabel("Xbox Gamertag").setStyle(TextInputStyle.Short).setRequired(true))
      );
      return interaction.showModal(modal);
    }
    if (interaction.customId === "btn_start_join") {
        const modal = new ModalBuilder().setCustomId("modal_join").setTitle("Join
