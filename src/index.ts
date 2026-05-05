import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, ActionRowBuilder, type ModalActionRowComponentBuilder,
  Events, type Interaction, PermissionFlagsBits, EmbedBuilder, Colors,
  ButtonBuilder, ButtonStyle, ChannelType, ActivityType, GuildMember
} from "discord.js";
import { db, tribeRegistrationsTable, guildConfigTable, tribeTasksTable } from "./db";
import { eq, and } from "drizzle-orm";
import { logger } from "./lib/logger";
import http from "http";

const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
const OVERSEER_COLOR = 0x00ffff; 

if (!token || !applicationId) process.exit(1);

// 1. Commands
const commands = [
  new SlashCommandBuilder().setName("help").setDescription("View the Overseer manual"),
  new SlashCommandBuilder().setName("post-info").setDescription("Deploy Registration Interface").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("lft").setDescription("Post a recruitment profile to find a tribe"),
  new SlashCommandBuilder().setName("setup").setDescription("Configure Overseer Intelligence Feed")
    .addRoleOption(o => o.setName("role").setDescription("Admin Role").setRequired(true))
    .addChannelOption(o => o.setName("logs").setDescription("Staff Log Channel").setRequired(true))
    .addChannelOption(o => o.setName("recruitment").setDescription("Recruit-Channels (LFT)").setRequired(true))
    .addChannelOption(o => o.setName("category").setDescription("Tribe Category").addChannelTypes(ChannelType.GuildCategory).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("list-tribes").setDescription("View global database").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// 2. Dashboards
function getTribeDashboard(tribeName: string) {
  const embed = new EmbedBuilder()
    .setTitle(`💠 OVERSEER | HQ: ${tribeName}`)
    .setDescription("Tribe Channel Active. Access granted to registered survivors.")
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

// 3. Client Setup
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

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
        const modal = new ModalBuilder().setCustomId("modal_join").setTitle("Join Tribe Signature");
        modal.addComponents(
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe").setLabel("Exact Tribe Name").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("ign").setLabel("Your IGN").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("xbox").setLabel("Xbox Gamertag").setStyle(TextInputStyle.Short).setRequired(true))
        );
        return interaction.showModal(modal);
    }

    if (interaction.customId === "raid_alert" && userReg) {
      return interaction.reply({ content: `🚨 **RAID ALERT!** <@${interaction.user.id}> reports the tribe is under attack! @everyone`, allowedMentions: { parse: ['everyone'] } });
    }

    if (interaction.customId === "claim_kit" && userReg) {
      if (userReg.hasClaimedKit) return interaction.reply({ content: "❌ Kit already claimed.", ephemeral: true });
      const [config] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, interaction.guildId!)).limit(1);
      if (config?.staffLogChannelId) {
        const logChan: any = await client.channels.fetch(config.staffLogChannelId);
        await logChan.send({ embeds: [new EmbedBuilder().setTitle("🎁 Kit Request").setDescription(`<@${interaction.user.id}> (Tribe: ${userReg.tribeName}) requested a starter kit.`).setColor(Colors.Green)] });
      }
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
        const list = mems.map(m => `• **${m.ign}** (<@${m.discordUserId}>)`).join("\n");
        return interaction.reply({ content: `📜 **${userReg.tribeName} Roster:**\n${list}`, ephemeral: true });
    }
  }

  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "setup") {
      const role = interaction.options.getRole("role", true);
      const logs = interaction.options.getChannel("logs", true);
      const rec = interaction.options.getChannel("recruitment", true);
      const cat = interaction.options.getChannel("category", true);
      await db.insert(guildConfigTable).values({ guildId: interaction.guildId!, adminRoleIds: role.id, staffLogChannelId: logs.id, recruitmentChannelId: rec.id, tribeCategoryId: cat.id }).onConflictDoUpdate({ target: guildConfigTable.guildId, set: { adminRoleIds: role.id, staffLogChannelId: logs.id, recruitmentChannelId: rec.id, tribeCategoryId: cat.id } });
      return interaction.reply("✅ Overseer Configured.");
    }

    if (interaction.commandName === "lft") {
        const modal = new ModalBuilder().setCustomId("modal_lft").setTitle("Survivor Recruitment");
        modal.addComponents(
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("style").setLabel("Playstyle (PVP/PVE/etc)").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("hours").setLabel("Hours Played").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("desc").setLabel("Skills (Breeding, Raid, etc)").setStyle(TextInputStyle.Paragraph).setRequired(true))
        );
        return interaction.showModal(modal);
    }

    if (interaction.commandName === "post-info") {
        const embed = new EmbedBuilder().setTitle("🛡️ OVERSEER | Initialization").setThumbnail(client.user?.displayAvatarURL() || null).setDescription("Initialize survivor protocols below.").setColor(OVERSEER_COLOR);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("btn_start_register").setLabel("Create Tribe").setStyle(ButtonStyle.Success).setEmoji("📝"),
            new ButtonBuilder().setCustomId("btn_start_join").setLabel("Join Tribe").setStyle(ButtonStyle.Primary).setEmoji("🤝")
        );
        const target: any = interaction.channel;
        await target.send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: "Interface Deployed.", ephemeral: true });
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
            let channelId: string | null = null;
            if (!isJoin) {
                const config = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, interaction.guildId!)).limit(1);
                const chan = await interaction.guild?.channels.create({
                    name: `tribe-${tribeName.toLowerCase().replace(/\s+/g, '-')}`,
                    type: ChannelType.GuildText,
                    parent: config[0]?.tribeCategoryId || undefined,
                    permissionOverwrites: [
                        { id: interaction.guild!.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
                    ]
                });
                channelId = chan?.id || null;
                if (chan) await (chan as any).send(getTribeDashboard(tribeName));
            } else {
                const existing = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.tribeName, tribeName)).limit(1);
                channelId = existing[0]?.channelId || null;
                if (channelId) {
                    const chan: any = await interaction.guild?.channels.fetch(channelId);
                    await chan.permissionOverwrites.create(interaction.user.id, { ViewChannel: true, SendMessages: true });
                }
            }
            await db.insert(tribeRegistrationsTable).values({ tribeName, ign, xboxGamertag: xbox, discordUserId: interaction.user.id, discordUsername: interaction.user.username, channelId, isOwner: !isJoin });
            const member = interaction.member as GuildMember;
            if (member?.manageable) await member.setNickname(`[${tribeName}] ${ign}`);
            await interaction.editReply(`✅ Success! Access <#${channelId}>`);
        } catch (e) { await interaction.editReply("❌ Error. Check registration status."); }
    }

    if (interaction.customId === "modal_lft") {
      const [config] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, interaction.guildId!)).limit(1);
      if (config?.recruitmentChannelId) {
        const recChan: any = await client.channels.fetch(config.recruitmentChannelId);
        const embed = new EmbedBuilder().setTitle("🔎 SURVIVOR LFT").setColor(OVERSEER_COLOR).addFields(
              { name: "Survivor", value: `<@${interaction.user.id}>`, inline: true },
              { name: "Playstyle", value: interaction.fields.getTextInputValue("style"), inline: true },
              { name: "Hours", value: interaction.fields.getTextInputValue("hours"), inline: true },
              { name: "Skills", value: interaction.fields.getTextInputValue("desc") }
          );
        await recChan.send({ embeds: [embed] });
        await interaction.reply({ content: "✅ Profile posted to recruitment channel!", ephemeral: true });
      }
    }

    if (interaction.customId === "modal_task") {
        const [reg] = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, interaction.user.id)).limit(1);
        if (reg) {
            const embed = new EmbedBuilder().setTitle("📋 NEW TASK").setDescription(interaction.fields.getTextInputValue("content")).setColor(Colors.Blue).setFooter({ text: `Posted by ${reg.ign}` });
            await (interaction.channel as any).send({ embeds: [embed] });
            await interaction.reply({ content: "Task added!", ephemeral: true });
        }
    }
  }
});

http.createServer((_, res) => { res.writeHead(200); res.end("Overseer Online"); }).listen(process.env.PORT || 3000);
async function start() {
    const rest = new REST({ version: "10" }).setToken(token!);
    await rest.put(Routes.applicationCommands(applicationId!), { body: commands.map(c => c.toJSON()) });
    await client.login(token);
}
start();
