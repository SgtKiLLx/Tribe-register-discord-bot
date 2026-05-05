import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, ActionRowBuilder, type ModalActionRowComponentBuilder,
  Events, type Interaction, PermissionFlagsBits, EmbedBuilder, Colors,
  ButtonBuilder, ButtonStyle, ChannelType, ActivityType, GuildMember
} from "discord.js";
import { db, tribeRegistrationsTable, guildConfigTable } from "./db";
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
        const statusText = count > 0 ? "over " + count + " Tribes" : "over the server";
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
    .setTitle("💠 OVERSEER | HQ: " + tribeName)
    .setDescription("Tribe Channel Active. Use buttons below for coordination.")
    .setColor(OVERSEER_COLOR);
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
  new SlashCommandBuilder().setName("post-recruitment").setDescription("Deploy Recruitment Terminal").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("lft").setDescription("Post a recruitment profile to find a tribe"),
  new SlashCommandBuilder().setName("my-tribe").setDescription("View your survivor profile"),
  new SlashCommandBuilder().setName("leave-tribe").setDescription("Exit current tribe and revoke access"),
  new SlashCommandBuilder().setName("list-tribes").setDescription("View global tribe database").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
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
    try {
        const [config] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, member.guild.id)).limit(1);
        if (!config || !config.welcomeChannelId) return;
        const welcomeChan: any = await member.guild.channels.fetch(config.welcomeChannelId).catch(() => null);
        if (welcomeChan) {
            const embed = new EmbedBuilder()
                .setTitle("🔵 OVERSEER | NEW SURVIVOR DETECTED")
                .setThumbnail(member.user.displayAvatarURL())
                .setColor(OVERSEER_COLOR)
                .setDescription("Welcome to the Ark, <@" + member.id + ">.\nReview the directives below to begin integration.")
                .addFields(
                    { name: "📜 SERVER DIRECTIVES", value: "<#" + config.rulesChannelId + "> - Rules\n<#" + config.infoChannelId + "> - Info", inline: false },
                    { name: "🦖 TRIBE INTEGRATION", value: "Register/Join at <#1488536840263700580>", inline: false },
                    { name: "🤝 RECRUITMENT", value: "Post LFT at <#1492542485820477511>", inline: false }
                ).setFooter({ text: "Survivor #" + member.guild.memberCount }).setTimestamp();
            await welcomeChan.send({ content: "Welcome, <@" + member.id + ">", embeds: [embed] });
        }
    } catch (e) { logger.warn("Welcome event failed"); }
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
    
    // Trigger LFT Modal from Button
    if (interaction.customId === "btn_lft_start") {
        const modal = new ModalBuilder().setCustomId("modal_lft").setTitle("Survivor Recruitment");
        modal.addComponents(
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("style").setLabel("Playstyle (PVP/PVE/Hybrid)").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("hours").setLabel("Hours Played").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("desc").setLabel("Skills (Breeding, Raid, etc)").setStyle(TextInputStyle.Paragraph).setRequired(true))
        );
        return interaction.showModal(modal);
    }

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
        const modal = new ModalBuilder().setCustomId("modal_join").setTitle("Join Tribe Signature");
        modal.addComponents(
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe").setLabel("Exact Tribe Name").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("ign").setLabel("Your IGN").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("xbox").setLabel("Xbox Gamertag").setStyle(TextInputStyle.Short).setRequired(true))
        );
        return interaction.showModal(modal);
    }
    if (interaction.customId === "raid_alert" && userReg) {
      return interaction.reply({ content: "🚨 **RAID ALERT!** <@" + interaction.user.id + "> reports the tribe is under attack! @everyone", allowedMentions: { parse: ['everyone'] } });
    }
    if (interaction.customId === "claim_kit" && userReg) {
      if (userReg.hasClaimedKit) return interaction.reply({ content: "❌ Kit already claimed.", ephemeral: true });
      await postToStaffLog(interaction.guildId!, new EmbedBuilder().setTitle("🎁 Kit Request").setDescription("<@" + interaction.user.id + "> requested a kit for **" + userReg.tribeName + "**.").setColor(Colors.Green));
      await db.update(tribeRegistrationsTable).set({ hasClaimedKit: true }).where(eq(tribeRegistrationsTable.discordUserId, interaction.user.id));
      return interaction.reply({ content: "✅ Request sent to staff!", ephemeral: true });
    }
    if (interaction.customId === "add_task") {
      const modal = new ModalBuilder().setCustomId("modal_task").setTitle("Add Tribe Task");
      modal.addComponents(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("content").setLabel("Task Details").setStyle(TextInputStyle.Paragraph).setRequired(true)));
      return interaction.showModal(modal);
    }
    if (interaction.customId === "view_roster" && userReg) {
        const mems = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.tribeName, userReg.tribeName));
        const list = mems.map(m => "• **" + m.ign + "** (<@" + m.discordUserId + ">)").join("\n");
        return interaction.reply({ content: "📜 **" + userReg.tribeName + " Roster:**\n" + list, ephemeral: true });
    }
  }

  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "list-tribes") {
        await interaction.deferReply({ ephemeral: true });
        try {
            const regs = await db.select().from(tribeRegistrationsTable).orderBy(tribeRegistrationsTable.tribeName);
            if (regs.length === 0) return interaction.editReply("Database empty.");
            const embed = new EmbedBuilder().setTitle("🌐 GLOBAL TRIBE DATABASE").setColor(OVERSEER_COLOR);
            regs.slice(0, 25).forEach(r => embed.addFields({ name: "🛡️ [" + r.tribeName + "] " + r.ign, value: "User: <@" + r.discordUserId + "> | Xbox: " + r.xboxGamertag, inline: false }));
            await interaction.editReply({ embeds: [embed] });
        } catch (e) { await interaction.editReply("❌ DB Error."); }
    }

    if (interaction.commandName === "post-info") {
        const embed = new EmbedBuilder().setTitle("🛡️ OVERSEER | TRIBE INITIALIZATION").setThumbnail(client.user?.displayAvatarURL() || null).setColor(OVERSEER_COLOR)
            .setDescription("Welcome, Survivor. Initialize your signature below.")
            .addFields({ name: "📝 CREATE TRIBE", value: "Spawn private HQ.", inline: true }, { name: "🤝 JOIN TRIBE", value: "Sync with roster.", inline: true });
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("btn_start_register").setLabel("Create Tribe").setStyle(ButtonStyle.Success).setEmoji("📝"),
            new ButtonBuilder().setCustomId("btn_start_join").setLabel("Join Tribe").setStyle(ButtonStyle.Primary).setEmoji("🤝")
        );
        await (interaction.channel as any).send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: "Interface Deployed.", ephemeral: true });
    }

    // NEW: POST RECRUITMENT INTERFACE
    if (interaction.commandName === "post-recruitment") {
        const embed = new EmbedBuilder()
            .setTitle("📡 OVERSEER | RECRUITMENT TERMINAL")
            .setThumbnail(client.user?.displayAvatarURL() || null)
            .setColor(OVERSEER_COLOR)
            .setDescription("Looking for a tribe or looking to recruit? Use this terminal to broadcast your signature to the server.")
            .addFields(
                { name: "🙋‍♂️ FOR SURVIVORS", value: "Click the button below to post your playstyle, hours, and skills to this channel.", inline: false },
                { name: "🏰 FOR TRIBE LEADERS", value: "Browse the profiles in this channel. If you find a suitable survivor, send them a DM to begin recruitment.", inline: false }
            )
            .setFooter({ text: "Overseer v1.2 | Matchmaking Protocol Online" });

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId("btn_lft_start")
                .setLabel("Post LFT Profile")
                .setStyle(ButtonStyle.Primary)
                .setEmoji("📝")
        );

        await (interaction.channel as any).send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: "Recruitment Terminal Deployed.", ephemeral: true });
    }

    if (interaction.commandName === "setup") {
      const o = interaction.options;
      await db.insert(guildConfigTable).values({ 
          guildId: interaction.guildId!, adminRoleIds: o.getRole("role")!.id, staffLogChannelId: o.getChannel("logs")!.id, 
          welcomeChannelId: o.getChannel("welcome")!.id, rulesChannelId: o.getChannel("rules")!.id, 
          infoChannelId: o.getChannel("info")!.id, recruitmentChannelId: o.getChannel("recruitment")!.id, tribeCategoryId: o.getChannel("category")!.id 
      }).onConflictDoUpdate({ target: guildConfigTable.guildId, set: { adminRoleIds: o.getRole("role")!.id, staffLogChannelId: o.getChannel("logs")!.id, welcomeChannelId: o.getChannel("welcome")!.id, rulesChannelId: o.getChannel("rules")!.id, infoChannelId: o.getChannel("info")!.id, recruitmentChannelId: o.getChannel("recruitment")!.id, tribeCategoryId: o.getChannel("category")!.id } });
      return interaction.reply("✅ Overseer Protocol Configured.");
    }
    
    if (interaction.commandName === "my-tribe") {
        const [reg] = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, interaction.user.id)).limit(1);
        if (!reg) return interaction.reply({ content: "No record found.", ephemeral: true });
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle("👤 " + reg.ign).addFields({ name: "Tribe", value: reg.tribeName }, { name: "Xbox", value: reg.xboxGamertag }).setColor(OVERSEER_COLOR)], ephemeral: true });
    }

    if (interaction.commandName === "lft") {
        const modal = new ModalBuilder().setCustomId("modal_lft").setTitle("Survivor Recruitment");
        modal.addComponents(
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("style").setLabel("Playstyle").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("hours").setLabel("Hours").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("desc").setLabel("Skills").setStyle(TextInputStyle.Paragraph).setRequired(true))
        );
        return interaction.showModal(modal);
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === "modal_reg" || interaction.customId === "modal_join") {
        const isJoin = interaction.customId === "modal_join";
        const tribeName = interaction.fields.getTextInputValue("tribe").trim();
        const ign = interaction.fields.getTextInputValue("ign").trim();
        const xbox = interaction.fields.getTextInputValue("xbox").trim();
        await interaction.deferReply({ ephemeral: true });
        try {
            let chanId: string | null = null;
            if (!isJoin) {
                const [cfg] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, interaction.guildId!)).limit(1);
                const chan = await interaction.guild?.channels.create({ name: "tribe-" + tribeName.toLowerCase().replace(/\s+/g, '-'), type: ChannelType.GuildText, parent: cfg?.tribeCategoryId || undefined, permissionOverwrites: [{ id: interaction.guild!.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }, { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }, { id: client.user!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }] });
                chanId = chan?.id || null;
                if (chan) await (chan as any).send(getTribeDashboard(tribeName));
            } else {
                const [ex] = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.tribeName, tribeName)).limit(1);
                chanId = ex?.channelId || null;
                if (chanId) {
                    const c: any = await interaction.guild?.channels.fetch(chanId);
                    await c.permissionOverwrites.create(interaction.user.id, { ViewChannel: true, SendMessages: true });
                }
            }
            await db.insert(tribeRegistrationsTable).values({ tribeName, ign, xboxGamertag: xbox, discordUserId: interaction.user.id, discordUsername: interaction.user.username, channelId: chanId, isOwner: !isJoin });
            if (interaction.member instanceof GuildMember && interaction.member.manageable) await interaction.member.setNickname("[" + tribeName + "] " + ign);
            await refreshOverseerStatus(client);
            await interaction.editReply("✅ Protocol Success. HQ: <#" + chanId + ">");
        } catch (e) { await interaction.editReply("❌ Protocol Error."); }
    }

    if (interaction.customId === "modal_lft") {
      const [cfg] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, interaction.guildId!)).limit(1);
      if (cfg?.recruitmentChannelId) {
        const c: any = await client.channels.fetch(cfg.recruitmentChannelId);
        await c.send({ embeds: [new EmbedBuilder().setTitle("🔎 SURVIVOR LFT").setColor(OVERSEER_COLOR).addFields({ name: "Survivor", value: "<@" + interaction.user.id + ">", inline: true }, { name: "Playstyle", value: interaction.fields.getTextInputValue("style"), inline: true }, { name: "Hours", value: interaction.fields.getTextInputValue("hours"), inline: true }, { name: "Skills", value: interaction.fields.getTextInputValue("desc") })] });
        await interaction.reply({ content: "✅ Profile posted!", ephemeral: true });
      }
    }

    if (interaction.customId === "modal_task") {
        const [reg] = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, interaction.user.id)).limit(1);
        if (reg) {
            await (interaction.channel as any).send({ embeds: [new EmbedBuilder().setTitle("📋 NEW TASK").setDescription(interaction.fields.getTextInputValue("content")).setColor(Colors.Blue).setFooter({ text: "Posted by " + reg.ign })] });
            await interaction.reply({ content: "Task added!", ephemeral: true });
        }
    }
  }
});

http.createServer((_, res) => { res.writeHead(200); res.end("OK"); }).listen(process.env.PORT || 3000);
async function start() {
    const rest = new REST({ version: "10" }).setToken(token!);
    await rest.put(Routes.applicationCommands(applicationId!), { body: commands.map(c => c.toJSON()) });
    await client.login(token);
}
start();
