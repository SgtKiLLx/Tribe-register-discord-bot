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
} from "discord.js";
import { db, tribeRegistrationsTable, guildConfigTable } from "./db";
import { eq, and } from "drizzle-orm";
import { logger } from "./lib/logger";
import http from "http";

const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;

if (!token || !applicationId) throw new Error("Missing Tokens");

// 1. Commands
const commands = [
  new SlashCommandBuilder().setName("setup-category").setDescription("Set the category where tribe channels will be created").addChannelOption(opt => opt.setName("category").setDescription("The Category").addChannelTypes(ChannelType.GuildCategory).setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("register").setDescription("Register a new tribe"),
  new SlashCommandBuilder().setName("join").setDescription("Join an existing tribe").addStringOption(opt => opt.setName("tribe_name").setDescription("Tribe name").setAutocomplete(true).setRequired(true)),
  new SlashCommandBuilder().setName("my-tribe").setDescription("View your tribe profile"),
  new SlashCommandBuilder().setName("post-info").setDescription("Post registration buttons").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("setup").setDescription("Setup admin roles and logs").setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addRoleOption(o => o.setName("role").setRequired(true)).addChannelOption(o => o.setName("channel").setRequired(true)),
];

// 2. Dashboard Helper
function getTribeDashboard(tribeName: string) {
    const embed = new EmbedBuilder()
        .setTitle(`🏰 Tribe Dashboard: ${tribeName}`)
        .setDescription("Welcome to your private tribe channel! Use the buttons below to manage your roster.")
        .setColor(Colors.DarkGold);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`view_roster:${tribeName}`).setLabel("View Roster").setStyle(ButtonStyle.Secondary).setEmoji("📜"),
        new ButtonBuilder().setCustomId(`leave_tribe`).setLabel("Leave Tribe").setStyle(ButtonStyle.Danger).setEmoji("🚪")
    );

    return { embeds: [embed], components: [row] };
}

// 3. Client Setup
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  // --- Autocomplete ---
  if (interaction.isAutocomplete()) {
    const tribes = await db.selectDistinct({ name: tribeRegistrationsTable.tribeName }).from(tribeRegistrationsTable);
    const filtered = tribes.map(t => t.name).filter(n => n.toLowerCase().includes(interaction.options.getFocused().toLowerCase())).slice(0, 25);
    return interaction.respond(filtered.map(n => ({ name: n, value: n })));
  }

  // --- Buttons ---
  if (interaction.isButton()) {
    if (interaction.customId === "btn_start_register") {
        const modal = new ModalBuilder().setCustomId("tribe_register_modal").setTitle("Register New Tribe");
        modal.addComponents(
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe_name").setLabel("Tribe Name").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("ign").setLabel("IGN").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("xbox").setLabel("Xbox Gamertag").setStyle(TextInputStyle.Short).setRequired(true))
        );
        return interaction.showModal(modal);
    }
    
    if (interaction.customId === "btn_start_join") {
        const modal = new ModalBuilder().setCustomId("btn_join_modal").setTitle("Join Tribe");
        modal.addComponents(
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe_name").setLabel("Exact Tribe Name").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("ign").setLabel("IGN").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("xbox").setLabel("Xbox").setStyle(TextInputStyle.Short).setRequired(true))
        );
        return interaction.showModal(modal);
    }

    if (interaction.customId.startsWith("view_roster:")) {
        const tribeName = interaction.customId.split(":")[1];
        const members = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.tribeName, tribeName));
        const list = members.map(m => `• **${m.ign}** (<@${m.discordUserId}>) - ${m.xboxGamertag}`).join("\n");
        return interaction.reply({ content: `**${tribeName} Roster:**\n${list}`, ephemeral: true });
    }

    if (interaction.customId === "leave_tribe") {
        await db.delete(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, interaction.user.id));
        const channel = interaction.channel as any;
        if (channel && channel.permissionOverwrites) {
            await channel.permissionOverwrites.delete(interaction.user.id);
        }
        return interaction.reply({ content: "You have left the tribe and lost access to this channel.", ephemeral: true });
    }
  }

  // --- Chat Commands ---
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "setup-category") {
        const category = interaction.options.getChannel("category", true);
        await db.insert(guildConfigTable).values({ guildId: interaction.guildId!, tribeCategoryId: category.id }).onConflictDoUpdate({ target: guildConfigTable.guildId, set: { tribeCategoryId: category.id } });
        return interaction.reply(`✅ Tribe channels will now be created in **${category.name}**`);
    }

    if (interaction.commandName === "post-info") {
        const embed = new EmbedBuilder().setTitle("🦖 Tribe Registration").setDescription("Click below to get started!").setColor(Colors.Green);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("btn_start_register").setLabel("Create Tribe").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("btn_start_join").setLabel("Join Tribe").setStyle(ButtonStyle.Primary)
        );
        const target: any = interaction.channel;
        await target.send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: "Posted!", ephemeral: true });
    }
  }

  // --- Modals ---
  if (interaction.isModalSubmit()) {
    const isJoin = interaction.customId === "btn_join_modal" || interaction.customId.startsWith("join_modal:");
    const tribeName = isJoin ? interaction.fields.getTextInputValue("tribe_name").trim() : interaction.fields.getTextInputValue("tribe_name").trim();
    const ign = interaction.fields.getTextInputValue("ign").trim();
    const xbox = interaction.fields.getTextInputValue("xbox").trim();

    await interaction.deferReply({ ephemeral: true });

    try {
        let channelId: string | null = null;
        
        if (!isJoin) {
            // CREATING A NEW TRIBE
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
            // JOINING AN EXISTING TRIBE
            const existing = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.tribeName, tribeName)).limit(1);
            channelId = existing[0]?.channelId || null;
            if (channelId) {
                const channel = await interaction.guild?.channels.fetch(channelId);
                if (channel && 'permissionOverwrites' in channel) {
                    await (channel as any).permissionOverwrites.create(interaction.user.id, { ViewChannel: true, SendMessages: true });
                }
            }
        }

        await db.insert(tribeRegistrationsTable).values({
            tribeName, ign, xboxGamertag: xbox, discordUserId: interaction.user.id, discordUsername: interaction.user.username,
            channelId, isOwner: !isJoin
        });

        await interaction.editReply(`✅ Successfully ${isJoin ? 'joined' : 'created'} **${tribeName}**! Check <#${channelId}>`);
    } catch (e) {
        logger.error(String(e));
        await interaction.editReply("❌ Error. Ensure you aren't already registered or the tribe name is correct.");
    }
  }
});

// Start
http.createServer((req, res) => { res.writeHead(200); res.end("OK"); }).listen(process.env.PORT || 3000);
async function start() {
    const rest = new REST({ version: "10" }).setToken(token!);
    await rest.put(Routes.applicationCommands(applicationId!), { body: commands.map(c => c.toJSON()) });
    await client.login(token);
}
start();
