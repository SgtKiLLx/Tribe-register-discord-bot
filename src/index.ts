import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, ActionRowBuilder, type ModalActionRowComponentBuilder,
  Events, type Interaction, PermissionFlagsBits, EmbedBuilder, Colors,
  ButtonBuilder, ButtonStyle, ChannelType, ActivityType, GuildMember, ThreadAutoArchiveDuration
} from "discord.js";
import { db, tribeRegistrationsTable, guildConfigTable, alphaClaimsTable } from "./db";
import { eq } from "drizzle-orm";
import http from "http";

const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
const OVERSEER_COLOR = 0x00ffff; 

if (!token || !applicationId) process.exit(1);

// --- NEW: Multi-Role Staff Helper ---
async function isOverseerStaff(interaction: Interaction): Promise<boolean> {
    if (!interaction.guildId || !interaction.member) return false;
    
    // 1. Always allow Server Administrators
    const member = interaction.member as GuildMember;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;

    // 2. Check Database for allowed Role IDs
    const [config] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, interaction.guildId)).limit(1);
    if (!config?.adminRoleIds) return false;

    // Split string "ID1,ID2" into array ["ID1", "ID2"]
    const allowedRoles = config.adminRoleIds.split(",").map(id => id.trim());
    return member.roles.cache.some(role => allowedRoles.includes(role.id));
}

async function refreshOverseerStatus(client: Client) {
    try {
        const tribes = await db.select({ name: tribeRegistrationsTable.tribeName }).from(tribeRegistrationsTable);
        const count = new Set(tribes.map(t => t.name)).size;
        client.user?.setActivity(`over ${count} Tribes`, { type: ActivityType.Watching });
    } catch (e) { console.error("Status fail"); }
}

async function postToStaffLog(guildId: string, embed: EmbedBuilder, components: any[] = []) {
    try {
        const [config] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, guildId)).limit(1);
        if (!config?.staffLogChannelId) return;
        const channel: any = await client.channels.fetch(config.staffLogChannelId);
        if (channel && typeof channel.send === 'function') await channel.send({ embeds: [embed], components });
    } catch (e) { console.error("Log fail"); }
}

function getTribeDashboard(tribeName: string) {
  const embed = new EmbedBuilder().setTitle(`💠 OVERSEER | HQ: ${tribeName}`).setDescription("Tribe HQ Active. Use protocols for coordination.").setColor(OVERSEER_COLOR);
  const r1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("raid_alert").setLabel("RAID ALERT").setStyle(ButtonStyle.Danger).setEmoji("🚨"),
    new ButtonBuilder().setCustomId("claim_kit").setLabel("Claim Kit").setStyle(ButtonStyle.Success).setEmoji("🎁")
  );
  const r2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("view_roster").setLabel("Roster").setStyle(ButtonStyle.Secondary).setEmoji("📜"),
    new ButtonBuilder().setCustomId("add_task").setLabel("Add Task").setStyle(ButtonStyle.Primary).setEmoji("📋")
  );
  return { embeds: [embed], components: [r1, r2] };
}

const commands = [
  new SlashCommandBuilder().setName("help").setDescription("View the Overseer manual"),
  new SlashCommandBuilder().setName("post-info").setDescription("Deploy Tribe Registration Interface").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("post-support").setDescription("Deploy Support Ticket Terminal").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("post-alpha-terminal").setDescription("Deploy Alpha Claim Interface").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("post-recruitment").setDescription("Deploy Recruitment Terminal").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("lft").setDescription("Post a recruitment profile"),
  new SlashCommandBuilder().setName("my-tribe").setDescription("View your survivor profile"),
  new SlashCommandBuilder().setName("leave-tribe").setDescription("Exit current tribe"),
  new SlashCommandBuilder().setName("list-tribes").setDescription("View global database"), // Permission handled in code
  new SlashCommandBuilder().setName("kick-member").setDescription("Remove survivor from records").addUserOption(o => o.setName("target").setDescription("User to kick").setRequired(true)), // Permission handled in code
  new SlashCommandBuilder().setName("setup").setDescription("Configure Overseer protocols")
    .addRoleOption(o => o.setName("role").setDescription("Primary Staff Role").setRequired(true))
    .addChannelOption(o => o.setName("logs").setDescription("Logs").setRequired(true))
    .addChannelOption(o => o.setName("welcome").setDescription("Welcome").setRequired(true))
    .addChannelOption(o => o.setName("rules").setDescription("Rules").setRequired(true))
    .addChannelOption(o => o.setName("info").setDescription("Info").setRequired(true))
    .addChannelOption(o => o.setName("recruitment").setDescription("Recruit").setRequired(true))
    .addChannelOption(o => o.setName("support").setDescription("Support").setRequired(true))
    .addChannelOption(o => o.setName("category").setDescription("Category").addChannelTypes(ChannelType.GuildCategory).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages] });

client.once(Events.ClientReady, async (c) => {
  console.log(`Overseer System Online: ${c.user.tag}`);
  await refreshOverseerStatus(c);
});

client.on(Events.InteractionCreate, async (i: Interaction) => {
  if (i.isAutocomplete() && i.commandName === "join") {
    const tribes = await db.select({ name: tribeRegistrationsTable.tribeName }).from(tribeRegistrationsTable);
    const filtered = [...new Set(tribes.map(t => t.name))].filter(n => n.toLowerCase().includes(i.options.getFocused().toLowerCase())).slice(0, 25);
    return i.respond(filtered.map(n => ({ name: n, value: n })));
  }

  if (i.isButton()) {
    const [reg] = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, i.user.id)).limit(1);
    
    if (i.customId === "btn_open_ticket") {
        await i.deferReply({ ephemeral: true });
        const t = await (i.channel as any).threads.create({ name: `ticket-${i.user.username}`, type: ChannelType.PrivateThread, autoArchiveDuration: ThreadAutoArchiveDuration.OneDay });
        await t.members.add(i.user.id);
        await t.send(`**Transmission Received.** <@${i.user.id}>, staff alerted.`);
        return i.editReply(`✅ Ticket opened: <#${t.id}>`);
    }

    if (i.customId === "btn_alpha_claim") {
        const m = new ModalBuilder().setCustomId("modal_alpha").setTitle("Alpha Status Claim");
        m.addComponents(
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe").setLabel("Tribe").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("coords").setLabel("Coordinates").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("members").setLabel("Members").setStyle(TextInputStyle.Short).setRequired(true))
        );
        return i.showModal(m);
    }

    if (i.customId === "btn_start_register") {
      const m = new ModalBuilder().setCustomId("modal_reg").setTitle("Register Tribe Signature");
      m.addComponents(
        new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe").setLabel("Tribe Name").setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("ign").setLabel("IGN").setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("xbox").setLabel("Xbox Gamertag").setStyle(TextInputStyle.Short).setRequired(true))
      );
      return i.showModal(m);
    }

    if (i.customId === "btn_start_join" || i.customId === "btn_lft_start") {
        const lft = i.customId === "btn_lft_start";
        const m = new ModalBuilder().setCustomId(lft ? "modal_lft" : "modal_join").setTitle(lft ? "Survivor Recruitment" : "Join Tribe");
        if (lft) {
            m.addComponents(
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("style").setLabel("Playstyle").setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("hours").setLabel("Hours").setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("desc").setLabel("Skills").setStyle(TextInputStyle.Paragraph).setRequired(true))
            );
        } else {
            m.addComponents(
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe").setLabel("Exact Tribe Name").setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("ign").setLabel("IGN").setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("xbox").setLabel("Xbox Gamertag").setStyle(TextInputStyle.Short).setRequired(true))
            );
        }
        return i.showModal(m);
    }

    if (reg) {
        if (i.customId === "raid_alert") return i.reply({ content: `🚨 **RAID ALERT!** <@${i.user.id}> reports attack! @everyone`, allowedMentions: { parse: ['everyone'] } });
        if (i.customId === "claim_kit") {
            if (reg.hasClaimedKit) return i.reply({ content: "❌ Claimed.", ephemeral: true });
            await postToStaffLog(i.guildId!, new EmbedBuilder().setTitle("🎁 Kit Request").setDescription(`<@${i.user.id}> requested kit.`).setColor(Colors.Green));
            await db.update(tribeRegistrationsTable).set({ hasClaimedKit: true }).where(eq(tribeRegistrationsTable.discordUserId, i.user.id));
            return i.reply({ content: "✅ Requested!", ephemeral: true });
        }
        if (i.customId === "view_roster") {
            const mems = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.tribeName, reg.tribeName));
            return i.reply({ content: `📜 **Roster:**\n${mems.map(m => `• ${m.ign}`).join("\n")}`, ephemeral: true });
        }
        if (i.customId === "add_task") {
            const m = new ModalBuilder().setCustomId("modal_task").setTitle("Add Task");
            m.addComponents(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("content").setLabel("Details").setStyle(TextInputStyle.Paragraph).setRequired(true)));
            return i.showModal(m);
        }
    }
  }

  if (i.isChatInputCommand()) {
    // Check for staff for sensitive commands
    if (i.commandName === "list-tribes" || i.commandName === "kick-member") {
        if (!(await isOverseerStaff(i))) return i.reply({ content: "❌ Access Denied: Staff clearance required.", ephemeral: true });
    }

    if (i.commandName === "list-tribes") {
        await i.deferReply({ ephemeral: true });
        const regs = await db.select().from(tribeRegistrationsTable).orderBy(tribeRegistrationsTable.tribeName);
        const e = new EmbedBuilder().setTitle("🌐 GLOBAL DATABASE").setColor(OVERSEER_COLOR);
        regs.slice(0, 25).forEach(r => e.addFields({ name: `🛡️ [${r.tribeName}] ${r.ign}`, value: `Xbox: ${r.xboxGamertag} | <@${r.discordUserId}>`, inline: false }));
        await i.editReply({ embeds: [e] });
    }
    if (i.commandName === "kick-member") {
        const target = i.options.getUser("target", true);
        const [reg] = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, target.id)).limit(1);
        if (!reg) return i.reply({ content: "Survivor not found.", ephemeral: true });
        await db.delete(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, target.id));
        if (reg.channelId) {
            const chan: any = await i.guild?.channels.fetch(reg.channelId).catch(() => null);
            if (chan?.permissionOverwrites) await chan.permissionOverwrites.delete(target.id);
        }
        return i.reply({ content: `✅ Kicked <@${target.id}> from **${reg.tribeName}**.` });
    }
    // (Other commands stay same...)
    if (i.commandName === "post-info") {
        const e = new EmbedBuilder().setTitle("🛡️ OVERSEER | INITIALIZATION").setThumbnail(client.user?.displayAvatarURL() || null).setColor(OVERSEER_COLOR).setDescription("Welcome. Initialize signatures below.");
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("btn_start_register").setLabel("Create Tribe").setStyle(ButtonStyle.Success).setEmoji("📝"), new ButtonBuilder().setCustomId("btn_start_join").setLabel("Join Tribe").setStyle(ButtonStyle.Primary).setEmoji("🤝"));
        await (i.channel as any).send({ embeds: [e], components: [row] });
        return i.reply({ content: "Reg Deployed.", ephemeral: true });
    }
    if (i.commandName === "post-support") {
        const e = new EmbedBuilder().setTitle("🆘 OVERSEER | SUPPORT").setThumbnail(client.user?.displayAvatarURL() || null).setColor(OVERSEER_COLOR).setDescription("Click below for staff assistance.");
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("btn_open_ticket").setLabel("Contact Support").setStyle(ButtonStyle.Danger).setEmoji("🆘"));
        await (i.channel as any).send({ embeds: [e], components: [row] });
        return i.reply({ content: "Support Deployed.", ephemeral: true });
    }
    if (i.commandName === "setup") {
        const o = i.options;
        await db.insert(guildConfigTable).values({ guildId: i.guildId!, adminRoleIds: o.getRole("role")!.id, staffLogChannelId: o.getChannel("logs")!.id, welcomeChannelId: o.getChannel("welcome")!.id, rulesChannelId: o.getChannel("rules")!.id, infoChannelId: o.getChannel("info")!.id, recruitmentChannelId: o.getChannel("recruitment")!.id, supportChannelId: o.getChannel("support")!.id, tribeCategoryId: o.getChannel("category")!.id }).onConflictDoUpdate({ target: guildConfigTable.guildId, set: { adminRoleIds: o.getRole("role")!.id, staffLogChannelId: o.getChannel("logs")!.id, welcomeChannelId: o.getChannel("welcome")!.id, rulesChannelId: o.getChannel("rules")!.id, infoChannelId: o.getChannel("info")!.id, recruitmentChannelId: o.getChannel("recruitment")!.id, supportChannelId: o.getChannel("support")!.id, tribeCategoryId: o.getChannel("category")!.id } });
        return i.reply("✅ Setup saved.");
    }
    if (i.commandName === "help") {
        const e = new EmbedBuilder().setTitle("🔵 OVERSEER | Documentation").setColor(OVERSEER_COLOR).addFields({ name: "Survivor", value: "`/register`, `/join`, `/my-tribe`, `/lft`" }, { name: "Staff", value: "`/setup`, `/post-info`, `/post-support`, `/kick-member`, `/list-tribes`" });
        return i.reply({ embeds: [e], ephemeral: true });
    }
    if (i.commandName === "my-tribe") {
        const [r] = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, i.user.id)).limit(1);
        if (!r) return i.reply({ content: "No record.", ephemeral: true });
        return i.reply({ embeds: [new EmbedBuilder().setTitle(`👤 ${r.ign}`).addFields({ name: "Tribe", value: r.tribeName }, { name: "Xbox", value: r.xboxGamertag }).setColor(OVERSEER_COLOR)], ephemeral: true });
    }
  }

  if (i.isModalSubmit()) {
    if (i.customId === "modal_reg" || i.customId === "modal_join") {
        const join = i.customId === "modal_join";
        const tN = i.fields.getTextInputValue("tribe").trim();
        const ign = i.fields.getTextInputValue("ign").trim();
        const xbox = i.fields.getTextInputValue("xbox").trim();
        await i.deferReply({ ephemeral: true });
        try {
            let chId: string | null = null;
            if (!join) {
                const [cfg] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, i.guildId!)).limit(1);
                const chan = await i.guild?.channels.create({ name: `tribe-${tN.toLowerCase().replace(/\s+/g, '-')}`, type: ChannelType.GuildText, parent: cfg?.tribeCategoryId || undefined, permissionOverwrites: [{ id: i.guild!.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }, { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }, { id: client.user!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }] });
                chId = chan?.id || null;
                if (chan) await (chan as any).send(getTribeDashboard(tN));
            } else {
                const [ex] = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.tribeName, tN)).limit(1);
                chId = ex?.channelId || null;
                if (chId) {
                    const c: any = await i.guild?.channels.fetch(chId).catch(() => null);
                    if (c) await c.permissionOverwrites.create(i.user.id, { ViewChannel: true, SendMessages: true });
                }
            }
            await db.insert(tribeRegistrationsTable).values({ tribeName: tN, ign, xboxGamertag: xbox, discordUserId: i.user.id, discordUsername: i.user.username, channelId: chId, isOwner: !join });
            if (i.member instanceof GuildMember && i.member.manageable) await i.member.setNickname(`[${tN}] ${ign}`);
            await refreshOverseerStatus(client);
            await i.editReply(`✅ Success. HQ: <#${chId}>`);
        } catch (e) { await i.editReply("❌ Protocol Error."); }
    }
    if (i.customId === "modal_alpha") {
        await db.insert(alphaClaimsTable).values({ tribeName: i.fields.getTextInputValue("tribe"), discordUserId: i.user.id, coordinates: i.fields.getTextInputValue("coords"), memberCount: parseInt(i.fields.getTextInputValue("members")) || 0 });
        await postToStaffLog(i.guildId!, new EmbedBuilder().setTitle("👑 ALPHA CLAIM").setDescription(`<@${i.user.id}> claimed Alpha.`).setColor(OVERSEER_COLOR));
        await i.reply({ content: "✅ Claim submitted.", ephemeral: true });
    }
    if (i.customId === "modal_lft") {
        const [cfg] = await db.select().from(guildConfigTable).limit(1);
        if (cfg?.recruitmentChannelId) {
            const c: any = await client.channels.fetch(cfg.recruitmentChannelId);
            await c.send({ embeds: [new EmbedBuilder().setTitle("🔎 SURVIVOR LFT").addFields({ name: "Survivor", value: `<@${i.user.id}>` }, { name: "Hours", value: i.fields.getTextInputValue("hours") }).setColor(OVERSEER_COLOR)] });
            await i.reply({ content: "✅ Profile posted!", ephemeral: true });
        }
    }
    if (i.customId === "modal_task") {
        const [r] = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.discordUserId, i.user.id)).limit(1);
        if (r) {
            await (i.channel as any).send({ embeds: [new EmbedBuilder().setTitle("📋 NEW TASK").setDescription(i.fields.getTextInputValue("content")).setColor(Colors.Blue).setFooter({ text: `By ${r.ign}` })] });
            await i.reply({ content: "Task added!", ephemeral: true });
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
