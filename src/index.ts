import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, ActionRowBuilder, type ModalActionRowComponentBuilder,
  Events, type Interaction, PermissionFlagsBits, EmbedBuilder, Colors,
  ButtonBuilder, ButtonStyle, ChannelType, ActivityType, GuildMember, ThreadAutoArchiveDuration
} from "discord.js";
import { db, tribeRegistrationsTable, guildConfigTable, alphaClaimsTable, supportTicketsTable } from "./db";
import { eq, and } from "drizzle-orm";
import { logger } from "./lib/logger";
import http from "http";

const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
const OVERSEER_COLOR = 0x00ffff; 

if (!token || !applicationId) process.exit(1);

// --- Helpers ---
async function refreshOverseerStatus(client: Client) {
    try {
        const tribes = await db.select().from(tribeRegistrationsTable);
        const count = [...new Set(tribes.map(t => t.tribeName))].length;
        client.user?.setActivity(`over ${count} Tribes`, { type: ActivityType.Watching });
    } catch (e) { logger.warn("Status update failed"); }
}

async function postToStaffLog(guildId: string, embed: EmbedBuilder, components: any[] = []) {
    try {
        const [config] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, guildId)).limit(1);
        if (!config?.staffLogChannelId) return;
        const channel: any = await client.channels.fetch(config.staffLogChannelId);
        if (channel && typeof channel.send === 'function') await channel.send({ embeds: [embed], components });
    } catch (e) { logger.warn("Log failed"); }
}

// 1. Commands
const commands = [
  new SlashCommandBuilder().setName("help").setDescription("View manual"),
  new SlashCommandBuilder().setName("post-info").setDescription("Deploy Initialization Protocol").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("post-alpha-terminal").setDescription("Deploy Alpha Claim Interface").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("setup").setDescription("Configure Overseer")
    .addRoleOption(o => o.setName("role").setDescription("Admin Role").setRequired(true))
    .addChannelOption(o => o.setName("logs").setDescription("Staff Logs").setRequired(true))
    .addChannelOption(o => o.setName("welcome").setDescription("Welcome").setRequired(true))
    .addChannelOption(o => o.setName("rules").setDescription("Rules").setRequired(true))
    .addChannelOption(o => o.setName("info").setDescription("Info").setRequired(true))
    .addChannelOption(o => o.setName("recruitment").setDescription("Recruit").setRequired(true))
    .addChannelOption(o => o.setName("support").setDescription("Support/Ticket Channel").setRequired(true))
    .addChannelOption(o => o.setName("category").setDescription("Tribe Category").addChannelTypes(ChannelType.GuildCategory).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages] });

client.once(Events.ClientReady, async (c) => {
  logger.info({ tag: c.user.tag }, "Overseer Online");
  await refreshOverseerStatus(c);
});

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  // --- Buttons ---
  if (interaction.isButton()) {
    // 🆘 Support Ticket Logic
    if (interaction.customId === "btn_open_ticket") {
        await interaction.deferReply({ ephemeral: true });
        const channel = interaction.channel as any;
        if (!channel.threads) return interaction.editReply("Protocol Error: Channel does not support threads.");
        
        const thread = await channel.threads.create({
            name: `ticket-${interaction.user.username}`,
            autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
            type: ChannelType.PrivateThread,
            reason: 'Overseer Support Protocol'
        });

        await thread.members.add(interaction.user.id);
        await thread.send({ content: `**Transmission Received.** <@${interaction.user.id}>, explain your situation. Staff has been alerted.` });
        return interaction.editReply(`✅ Ticket opened: <#${thread.id}>`);
    }

    // 👑 Alpha Claim Logic
    if (interaction.customId === "btn_alpha_claim") {
        const modal = new ModalBuilder().setCustomId("modal_alpha").setTitle("Alpha Status Claim");
        modal.addComponents(
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe").setLabel("Tribe Name").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("coords").setLabel("Base Coordinates (Lat/Lon)").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. 50.2, 70.1")),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("members").setLabel("Total Active Members").setStyle(TextInputStyle.Short).setRequired(true))
        );
        return interaction.showModal(modal);
    }
    
    // Approval Buttons for Staff
    if (interaction.customId.startsWith("alpha_approve:")) {
        const id = interaction.customId.split(":")[1];
        await interaction.reply({ content: `✅ Alpha Status Approved for Entry #${id}`, ephemeral: true });
        // Optional: Logic to give a role could go here
    }

    // Standard buttons
    if (interaction.customId === "btn_start_register") {
        const modal = new ModalBuilder().setCustomId("modal_reg").setTitle("Register New Tribe");
        modal.addComponents(
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe").setLabel("Tribe Name").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("ign").setLabel("Your IGN").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("xbox").setLabel("Xbox Gamertag").setStyle(TextInputStyle.Short).setRequired(true))
        );
        return interaction.showModal(modal);
    }
  }

  // --- Modals ---
  if (interaction.isModalSubmit()) {
    if (interaction.customId === "modal_alpha") {
        const tribe = interaction.fields.getTextInputValue("tribe");
        const coords = interaction.fields.getTextInputValue("coords");
        const count = interaction.fields.getTextInputValue("members");

        await interaction.deferReply({ ephemeral: true });
        try {
            await db.insert(alphaClaimsTable).values({ tribeName: tribe, discordUserId: interaction.user.id, coordinates: coords, memberCount: parseInt(count) || 0 });
            
            const embed = new EmbedBuilder()
                .setTitle("👑 ALPHA STATUS CLAIM")
                .setColor(OVERSEER_COLOR)
                .addFields(
                    { name: "Tribe", value: tribe, inline: true },
                    { name: "Survivor", value: `<@${interaction.user.id}>`, inline: true },
                    { name: "Coordinates", value: coords, inline: true },
                    { name: "Members", value: count, inline: true }
                ).setFooter({ text: "Verify the base location before approving." });

            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(`alpha_approve:${tribe}`).setLabel("Approve").setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`alpha_deny:${tribe}`).setLabel("Deny").setStyle(ButtonStyle.Danger)
            );

            await postToStaffLog(interaction.guildId!, embed, [row]);
            return interaction.editReply("✅ Alpha claim submitted to staff for verification.");
        } catch (e) { return interaction.editReply("❌ Protocol Error."); }
    }

    // Existing modal_reg/join logic remains...
    if (interaction.customId === "modal_reg") {
        // ... (Refer to your previous modal_reg code)
    }
  }

  // --- Chat Commands ---
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "post-info") {
        const embed = new EmbedBuilder().setTitle("🛡️ OVERSEER | INITIALIZATION").setThumbnail(client.user?.displayAvatarURL() || null).setColor(OVERSEER_COLOR).setDescription("Initialize survivor protocols below.");
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("btn_start_register").setLabel("Create Tribe").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("btn_start_join").setLabel("Join Tribe").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("btn_open_ticket").setLabel("Contact Support").setStyle(ButtonStyle.Secondary).setEmoji("🆘")
        );
        await (interaction.channel as any).send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: "Interface Deployed.", ephemeral: true });
    }

    if (interaction.commandName === "post-alpha-terminal") {
        const embed = new EmbedBuilder()
            .setTitle("👑 OVERSEER | ALPHA CLAIM TERMINAL")
            .setColor(0xFFD700) // Gold
            .setDescription("Only the strongest tribes may hold the title of Alpha. If your tribe dominates this sector, submit your claim for verification.")
            .addFields({ name: "📋 REQUIREMENT", value: "You must provide base coordinates and total member count. Staff will verify your claim in-game." });
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("btn_alpha_claim").setLabel("Submit Alpha Claim").setStyle(ButtonStyle.Secondary).setEmoji("👑")
        );
        await (interaction.channel as any).send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: "Alpha Terminal Online.", ephemeral: true });
    }

    if (interaction.commandName === "setup") {
        const o = interaction.options;
        await db.insert(guildConfigTable).values({ 
            guildId: interaction.guildId!, adminRoleIds: o.getRole("role")!.id, staffLogChannelId: o.getChannel("logs")!.id, 
            welcomeChannelId: o.getChannel("welcome")!.id, rulesChannelId: o.getChannel("rules")!.id, 
            infoChannelId: o.getChannel("info")!.id, recruitmentChannelId: o.getChannel("recruitment")!.id, 
            supportChannelId: o.getChannel("support")!.id, tribeCategoryId: o.getChannel("category")!.id 
        }).onConflictDoUpdate({ target: guildConfigTable.guildId, set: { adminRoleIds: o.getRole("role")!.id, staffLogChannelId: o.getChannel("logs")!.id, welcomeChannelId: o.getChannel("welcome")!.id, rulesChannelId: o.getChannel("rules")!.id, infoChannelId: o.getChannel("info")!.id, recruitmentChannelId: o.getChannel("recruitment")!.id, supportChannelId: o.getChannel("support")!.id, tribeCategoryId: o.getChannel("category")!.id } });
        return interaction.reply("✅ Overseer Configured.");
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
