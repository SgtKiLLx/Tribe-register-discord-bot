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
import { eq } from "drizzle-orm";
import { logger } from "./lib/logger";
import http from "http";

const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;

if (!token || !applicationId) {
  console.error("Missing Environment Variables");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName("setup-category")
    .setDescription("Set the category for tribe channels")
    .addChannelOption(opt => opt.setName("category").setDescription("The Category").addChannelTypes(ChannelType.GuildCategory).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("register").setDescription("Register a new tribe"),
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join an existing tribe")
    .addStringOption(opt => opt.setName("tribe_name").setDescription("Tribe name").setAutocomplete(true).setRequired(true)),
  new SlashCommandBuilder().setName("my-tribe").setDescription("View your tribe profile"),
  new SlashCommandBuilder().setName("post-info").setDescription("Post registration buttons").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Setup admin roles and logs")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(o => o.setName("role").setDescription("Admin Role").setRequired(true))
    .addChannelOption(o => o.setName("channel").setDescription("Log Channel").setRequired(true)),
];

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
    .setTitle(`🏰 Tribe Dashboard: ${tribeName}`)
    .setDescription("Welcome! Use the buttons below to manage your roster.")
    .setColor(Colors.DarkGold);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`view_roster:${tribeName}`).setLabel("View Roster").setStyle(ButtonStyle.Secondary).setEmoji("📜"),
    new ButtonBuilder().setCustomId(`leave_tribe`).setLabel("Leave Tribe").setStyle(ButtonStyle.Danger).setEmoji("🚪")
  );
  return { embeds: [embed], components: [row] };
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (interaction.isAutocomplete()) {
    try {
      const tribes = await db.select({ name: tribeRegistrationsTable.tribeName }).from(tribeRegistrationsTable).groupBy(tribeRegistrationsTable.tribeName);
      const focusedValue = interaction.options.getFocused().toLowerCase();
      const filtered = tribes.map(t => t.name).filter(n => n.toLowerCase().includes(focusedValue)).slice(0, 25);
      await interaction.respond(filtered.map(n => ({ name: n, value: n })));
    } catch (e) { console.error(e); }
    return;
  }

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
      const list = members.map(m => `• **${m.ign}** (<@${m.discordUserId}>)`).join("\n") || "No members.";
      return interaction.reply({ content: `**${tribeName} Roster:**\n${list}`, ephemeral: true });
    }
    if (interaction.customId === "leave_tribe") {
        await db.delete(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, interaction.user.id));
        return interaction.reply({ content: "You left the tribe records. Ask an admin to remove you from the channel.", ephemeral: true });
    }
  }

  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "setup-category") {
      const category = interaction.options.getChannel("category", true);
      await db.insert(guildConfigTable).values({ guildId: interaction.guildId!, tribeCategoryId: category.id }).onConflictDoUpdate({ target: guildConfigTable.guildId, set: { tribeCategoryId: category.id } });
      return interaction.reply(`✅ Tribe channels linked to **${category.name}**`);
    }
    if (interaction.commandName === "post-info") {
      const embed = new EmbedBuilder().setTitle("🦖 Tribe Registration").setDescription("Click below to register!").setColor(Colors.Green);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("btn_start_register").setLabel("Create Tribe").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("btn_start_join").setLabel("Join Tribe").setStyle(ButtonStyle.Primary)
      );
      const target: any = interaction.channel;
      await target.send({ embeds: [embed], components: [row] });
      return interaction.reply({ content: "Posted!", ephemeral: true });
    }
    if (interaction.commandName === "setup") {
        const role = interaction.options.getRole("role", true);
        const channel = interaction.options.getChannel("channel", true);
        await db.insert(guildConfigTable).values({ guildId: interaction.guildId!, adminRoleIds: role.id, staffLogChannelId: channel.id }).onConflictDoUpdate({ target: guildConfigTable.guildId, set: { adminRoleIds: role.id, staffLogChannelId: channel.id } });
        return interaction.reply("✅ Setup saved!");
    }
  }

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
      await interaction.editReply(`✅ Success! Joined **${tribeName}**. ${channelId ? `Go to <#${channelId}>` : ''}`);
      const log = new EmbedBuilder().setTitle("New Reg").setDescription(`<@${interaction.user.id}> ${isJoin ? 'joined' : 'created'} **${tribeName}**`).setColor(Colors.Green);
      await postToStaffLog(interaction.guildId!, log);
    } catch (e) {
      console.error(e);
      await interaction.editReply("❌ Error. Check if you are already registered.");
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
