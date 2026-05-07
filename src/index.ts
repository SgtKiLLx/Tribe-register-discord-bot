import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, ActionRowBuilder, type ModalActionRowComponentBuilder,
  Events, type Interaction, PermissionFlagsBits, EmbedBuilder, Colors,
  ButtonBuilder, ButtonStyle, ChannelType, ActivityType, GuildMember, ThreadAutoArchiveDuration
} from "discord.js";
import { db, tribeRegistrationsTable, guildConfigTable, alphaClaimsTable, tribeTasksTable, recruitmentTable } from "./db";
import { eq, and, sql } from "drizzle-orm";
import http from "http";

const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
const OVERSEER_COLOR = 0x00ffff; 

// --- Memory Systems ---
const coinCooldown = new Set();

if (!token || !applicationId) {
    console.error("Missing tokens. Check Environment Variables.");
    process.exit(1);
}

// --- Helper: Dynamic Status ---
async function refreshOverseerStatus(client: Client) {
    try {
        const tribes = await db.select({ name: tribeRegistrationsTable.tribeName }).from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.status, 'verified'));
        const count = new Set(tribes.map(t => t.name)).size;
        const statusText = count > 0 ? `over ${count} Tribes` : "over the server";
        client.user?.setActivity(statusText, { type: ActivityType.Watching });
    } catch (e) { console.error("Status update fail"); }
}

// --- Helper: Staff Check ---
async function isOverseerStaff(interaction: Interaction): Promise<boolean> {
    if (!interaction.guildId || !interaction.member) return false;
    const member = interaction.member as GuildMember;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    const [config] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, interaction.guildId)).limit(1);
    if (!config?.adminRoleIds) return false;
    const allowedRoles = config.adminRoleIds.split(",").map(id => id.trim());
    return member.roles.cache.some(role => allowedRoles.includes(role.id));
}

// --- Helper: Logging ---
async function postToStaffLog(guildId: string, embed: EmbedBuilder, components: any[] = []) {
    try {
        const [config] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, guildId)).limit(1);
        if (!config?.staffLogChannelId) return;
        const channel: any = await client.channels.fetch(config.staffLogChannelId);
        if (channel && typeof channel.send === 'function') await channel.send({ embeds: [embed], components });
    } catch (e) { console.error("Log fail"); }
}

// --- Helper: Dashboard Construction ---
function getTribeDashboard(tribeName: string) {
  const embed = new EmbedBuilder()
    .setTitle(`💠 OVERSEER | HQ: ${tribeName}`)
    .setDescription("Tribe HQ Active. Use protocols below for coordination.")
    .setColor(OVERSEER_COLOR)
    .addFields(
      { name: "🚨 RAID ALERT", value: "Emergency ping for all members.", inline: true },
      { name: "🎁 CLAIM KIT", value: "Request one-time starter kit.", inline: true }
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

// 1. Command Definitions
const commands = [
  new SlashCommandBuilder().setName("help").setDescription("View the Overseer manual"),
  new SlashCommandBuilder().setName("register").setDescription("Initialize a new tribe signature"),
  new SlashCommandBuilder().setName("lft").setDescription("Post a recruitment profile to find a tribe"),
  new SlashCommandBuilder().setName("my-tribe").setDescription("View your current survivor profile"),
  new SlashCommandBuilder().setName("leave-tribe").setDescription("Exit current tribe and revoke access"),
  new SlashCommandBuilder().setName("list-tribes").setDescription("View global server database"),
  new SlashCommandBuilder().setName("bal").setDescription("Check your current Tek Coin balance"),
  new SlashCommandBuilder().setName("post-info").setDescription("Deploy Registration Interface").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("post-support").setDescription("Deploy Support Terminal").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("post-alpha-terminal").setDescription("Deploy Alpha Terminal").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("post-recruitment").setDescription("Deploy Recruitment Terminal").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("kick-member").setDescription("Remove survivor from records (Staff)").addUserOption(o => o.setName("target").setDescription("User to kick").setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  new SlashCommandBuilder().setName("setup").setDescription("Configure Overseer protocols")
    .addRoleOption(o => o.setName("role").setDescription("Staff Role").setRequired(true))
    .addChannelOption(o => o.setName("logs").setDescription("Staff Logs").setRequired(true))
    .addChannelOption(o => o.setName("welcome").setDescription("Welcome").setRequired(true))
    .addChannelOption(o => o.setName("rules").setDescription("Rules").setRequired(true))
    .addChannelOption(o => o.setName("info").setDescription("Info").setRequired(true))
    .addChannelOption(o => o.setName("recruitment").setDescription("Recruit").setRequired(true))
    .addChannelOption(o => o.setName("support").setDescription("Support").setRequired(true))
    .addChannelOption(o => o.setName("category").setDescription("Category").addChannelTypes(ChannelType.GuildCategory).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("join").setDescription("Sync with existing tribe").addStringOption(o => o.setName("tribe_name").setDescription("Search Tribe").setAutocomplete(true).setRequired(true)),
];

// 2. Client Initialization
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ] 
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Overseer Systems Initialized: ${c.user.tag}`);
  await refreshOverseerStatus(c);
});

// --- Passive Economy ---
client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot || !msg.guildId || coinCooldown.has(msg.author.id)) return;
    try {
        await db.update(tribeRegistrationsTable).set({ tekCoins: sql`${tribeRegistrationsTable.tekCoins} + 1` }).where(and(eq(tribeRegistrationsTable.discordUserId, msg.author.id), eq(tribeRegistrationsTable.guildId, msg.guildId)));
        coinCooldown.add(msg.author.id);
        setTimeout(() => coinCooldown.delete(msg.author.id), 120000);
    } catch (e) {}
});

// --- Welcome Intro ---
client.on(Events.GuildMemberAdd, async (member) => {
    try {
        const [config] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, member.guild.id)).limit(1);
        if (!config) return;

        if (config.welcomeChannelId) {
            const welcomeChan: any = await member.guild.channels.fetch(config.welcomeChannelId).catch(() => null);
            if (welcomeChan) {
                const embed = new EmbedBuilder().setTitle("🔵 NEW SURVIVOR DETECTED").setThumbnail(member.user.displayAvatarURL()).setColor(OVERSEER_COLOR).setDescription(`Welcome Survivor <@${member.id}>. Protocols initialized.`)
                    .addFields({ name: "📜 DIRECTIVES", value: `<#${config.rulesChannelId}> | <#${config.infoChannelId}>` }, { name: "🦖 INTEGRATION", value: "Register at the registration channel." });
                await welcomeChan.send({ content: `Welcome Survivor, <@${member.id}>`, embeds: [embed] });
            }
        }

        const dmEmbed = new EmbedBuilder().setTitle("💠 OVERSEER | COMMAND PROTOCOLS").setColor(OVERSEER_COLOR).setDescription("I am the Overseer. Here are your directives:")
            .addFields(
                { name: "📝 Registration", value: "Use buttons in the register channel or `/register` to unlock your Tribe HQ.", inline: false },
                { name: "🤝 Recruitment", value: "Use `/lft` to find a tribe in the recruitment channel.", inline: false }
            );
        await member.send({ embeds: [dmEmbed] }).catch(() => null);
    } catch (e) {}
});

// 3. Interaction Listener
client.on(Events.InteractionCreate, async (i: Interaction) => {
  // Autocomplete
  if (i.isAutocomplete() && i.commandName === "join") {
    const tribes = await db.select({ name: tribeRegistrationsTable.tribeName }).from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.guildId, i.guildId!), eq(tribeRegistrationsTable.status, 'verified')));
    const filtered = [...new Set(tribes.map(t => t.name))].filter(n => n.toLowerCase().includes(i.options.getFocused().toLowerCase())).slice(0, 25);
    return i.respond(filtered.map(n => ({ name: n, value: n })));
  }

  // Button Interactions
  if (i.isButton()) {
    const [reg] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
    
    // Gatekeeper Approvals
    if (i.customId.startsWith("gate_accept:") || i.customId.startsWith("gate_deny:")) {
        if (!(await isOverseerStaff(i))) return i.reply({ content: "❌ Staff only.", ephemeral: true });
        const [action, tId] = i.customId.split(":");
        await i.deferReply({ ephemeral: true });
        if (action === "gate_accept") {
            const [p] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, tId), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
            if (!p) return i.editReply("Error.");
            await db.update(tribeRegistrationsTable).set({ status: 'verified' }).where(eq(tribeRegistrationsTable.id, p.id));
            const [cfg] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, i.guildId!)).limit(1);
            const chan = await i.guild?.channels.create({ name: p.tribeName.toLowerCase().replace(/\s+/g, '-'), type: ChannelType.GuildText, parent: cfg?.tribeCategoryId || undefined, permissionOverwrites: [{ id: i.guild!.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }, { id: tId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }, { id: client.user!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }] });
            if (chan) await (chan as any).send(getTribeDashboard(p.tribeName));
            const mem = await i.guild?.members.fetch(tId).catch(() => null);
            if (mem?.manageable) await mem.setNickname(`[${p.tribeName}] ${p.ign}`);
            await i.editReply("✅ Verified.");
        } else {
            await db.delete(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, tId), eq(tribeRegistrationsTable.guildId, i.guildId!)));
            await i.editReply("❌ Denied.");
        }
        return;
    }

    // Support SOS
    if (i.customId === "btn_open_ticket") {
        await i.deferReply({ ephemeral: true });
        const t = await (i.channel as any).threads.create({ name: `ticket-${i.user.username}`, type: ChannelType.PrivateThread, autoArchiveDuration: ThreadAutoArchiveDuration.OneDay });
        await t.members.add(i.user.id);
        await t.send(`**SOS Protocol Active.** <@${i.user.id}>, explain your situation. Staff alerted.`);
        return i.editReply(`✅ SOS Opened: <#${t.id}>`);
    }

    // Start Register/Join/LFT Modals
    if (["btn_start_register", "btn_start_join", "btn_lft_start"].includes(i.customId)) {
        const modalId = i.customId === "btn_start_register" ? "modal_reg" : i.customId === "btn_start_join" ? "modal_join" : "modal_lft";
        const m = new ModalBuilder().setCustomId(modalId).setTitle("Overseer Terminal");
        if (modalId === "modal_lft") {
            m.addComponents(
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("style").setLabel("Playstyle").setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("hours").setLabel("Hours").setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("desc").setLabel("Skills").setStyle(TextInputStyle.Paragraph).setRequired(true))
            );
        } else {
            m.addComponents(
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe").setLabel(i.customId === "btn_start_join" ? "Exact Tribe Name" : "Tribe Name").setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("ign").setLabel("Your IGN").setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("xbox").setLabel("Xbox Gamertag").setStyle(TextInputStyle.Short).setRequired(true))
            );
        }
        return i.showModal(m);
    }

    // Alpha Claim Button
    if (i.customId === "btn_alpha_claim") {
        const m = new ModalBuilder().setCustomId("modal_alpha").setTitle("Alpha Claim Protocol");
        m.addComponents(
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe").setLabel("Tribe").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("coords").setLabel("Coordinates").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("members").setLabel("Member Count").setStyle(TextInputStyle.Short).setRequired(true))
        );
        return i.showModal(m);
    }

    // Tribe HQ Dashboard Handlers
    if (reg && reg.status === 'verified') {
        if (i.customId === "raid_alert") return i.reply({ content: `🚨 **RAID ALERT!** <@${i.user.id}> reports attack! @everyone`, allowedMentions: { parse: ['everyone'] } });
        if (i.customId === "view_roster") {
            const mems = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.tribeName, reg.tribeName), eq(tribeRegistrationsTable.guildId, i.guildId!), eq(tribeRegistrationsTable.status, 'verified')));
            return i.reply({ content: `📜 **${reg.tribeName} Roster:**\n` + mems.map(m => `• ${m.ign}`).join("\n"), ephemeral: true });
        }
        if (i.customId === "claim_kit") {
            if (reg.hasClaimedKit) return i.reply({ content: "❌ Kit already claimed.", ephemeral: true });
            await postToStaffLog(i.guildId!, new EmbedBuilder().setTitle("🎁 Kit Request").setDescription(`<@${i.user.id}> requested a starter kit for **${reg.tribeName}**.`).setColor(Colors.Green));
            await db.update(tribeRegistrationsTable).set({ hasClaimedKit: true }).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!)));
            return i.reply({ content: "✅ Request sent to staff!", ephemeral: true });
        }
        if (i.customId === "add_task") {
            const m = new ModalBuilder().setCustomId("modal_task").setTitle("Add Task");
            m.addComponents(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("content").setLabel("Mission Details").setStyle(TextInputStyle.Paragraph).setRequired(true)));
            return i.showModal(m);
        }
    }
  }

  // Slash Commands Logic
  if (i.isChatInputCommand()) {
    if (i.commandName === "list-tribes") {
        await i.deferReply({ ephemeral: true });
        if (!(await isOverseerStaff(i))) return i.editReply("❌ Staff clearance required.");
        const regs = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.guildId, i.guildId!)).orderBy(tribeRegistrationsTable.tribeName);
        if (regs.length === 0) return i.editReply("No signatures found.");
        const e = new EmbedBuilder().setTitle("🌐 GLOBAL DATABASE").setColor(OVERSEER_COLOR);
        regs.slice(0, 25).forEach(r => e.addFields({ name: `[${r.tribeName}] ${r.ign}`, value: `Xbox: ${r.xboxGamertag} | <@${r.discordUserId}>`, inline: false }));
        return i.editReply({ embeds: [e] });
    }

    if (i.commandName === "help") {
        const e = new EmbedBuilder().setTitle("🔵 OVERSEER | Documentation").setColor(OVERSEER_COLOR).addFields(
            { name: "Survivor", value: "`/register`, `/join`, `/my-tribe`, `/lft`, `/leave-tribe`, `/bal`" },
            { name: "Staff", value: "`/setup`, `/post-info`, `/post-support`, `/post-alpha-terminal`, `/list-tribes`" }
        );
        return i.reply({ embeds: [e], ephemeral: true });
    }

    if (i.commandName === "bal") {
        const [u] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!)));
        return i.reply({ content: `💰 **Bank:** You possess **${u?.tekCoins || 0}** Tek Coins.`, ephemeral: true });
    }

    if (i.commandName === "post-info") {
        const e = new EmbedBuilder().setTitle("🛡️ OVERSEER | INITIALIZATION").setThumbnail(client.user?.displayAvatarURL() || null).setColor(OVERSEER_COLOR).setDescription("Welcome. Initialize signatures below.");
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("btn_start_register").setLabel("Create Tribe").setStyle(ButtonStyle.Success).setEmoji("📝"), new ButtonBuilder().setCustomId("btn_start_join").setLabel("Join Tribe").setStyle(ButtonStyle.Primary).setEmoji("🤝"));
        await (i.channel as any).send({ embeds: [e], components: [row] });
        return i.reply({ content: "Reg Deployed.", ephemeral: true });
    }

    if (i.commandName === "post-support") {
        const e = new EmbedBuilder().setTitle("🆘 OVERSEER | SUPPORT").setColor(OVERSEER_COLOR).setDescription("Click below for staff assistance.");
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("btn_open_ticket").setLabel("Contact Support").setStyle(ButtonStyle.Danger).setEmoji("🆘"));
        await (i.channel as any).send({ embeds: [e], components: [row] });
        return i.reply({ content: "Support Deployed.", ephemeral: true });
    }

    if (i.commandName === "post-alpha-terminal") {
        const e = new EmbedBuilder().setTitle("👑 OVERSEER | ALPHA").setColor(0xFFD700).setDescription("Submit tribe dominance claim.");
        const r = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("btn_alpha_claim").setLabel("Claim Alpha").setStyle(ButtonStyle.Secondary).setEmoji("👑"));
        await (i.channel as any).send({ embeds: [e], components: [r] });
        return i.reply({ content: "Alpha Terminal Deployed.", ephemeral: true });
    }

    if (i.commandName === "post-recruitment") {
        const e = new EmbedBuilder().setTitle("📡 OVERSEER | RECRUITMENT").setColor(OVERSEER_COLOR).setDescription("Looking for a tribe? Click below.");
        const r = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("btn_lft_start").setLabel("Post LFT Profile").setStyle(ButtonStyle.Primary).setEmoji("📝"));
        await (i.channel as any).send({ embeds: [e], components: [r] });
        return i.reply({ content: "Recruit Deployed.", ephemeral: true });
    }

    if (i.commandName === "setup") {
        const o = i.options;
        await db.insert(guildConfigTable).values({ 
            guildId: i.guildId!, adminRoleIds: o.getRole("role")!.id, staffLogChannelId: o.getChannel("logs")!.id, welcomeChannelId: o.getChannel("welcome")!.id, rulesChannelId: o.getChannel("rules")!.id, infoChannelId: o.getChannel("info")!.id, recruitmentChannelId: o.getChannel("recruitment")!.id, supportChannelId: o.getChannel("support")!.id, tribeCategoryId: o.getChannel("category")!.id 
        }).onConflictDoUpdate({ target: guildConfigTable.guildId, set: { adminRoleIds: o.getRole("role")!.id, staffLogChannelId: o.getChannel("logs")!.id, welcomeChannelId: o.getChannel("welcome")!.id, rulesChannelId: o.getChannel("rules")!.id, infoChannelId: o.getChannel("info")!.id, recruitmentChannelId: o.getChannel("recruitment")!.id, supportChannelId: o.getChannel("support")!.id, tribeCategoryId: o.getChannel("category")!.id } });
        return i.reply("✅ Overseer Protocol Configured.");
    }
    
    if (i.commandName === "my-tribe") {
        const [r] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
        if (!r) return i.reply({ content: "No record.", ephemeral: true });
        return i.reply({ embeds: [new EmbedBuilder().setTitle(`👤 ${r.ign}`).addFields({ name: "Tribe", value: r.tribeName }, { name: "Xbox", value: r.xboxGamertag }).setColor(OVERSEER_COLOR)], ephemeral: true });
    }
  }

  // Modal Submissions
  if (i.isModalSubmit()) {
    if (i.customId === "modal_reg" || i.customId === "modal_join") {
        const tN = i.fields.getTextInputValue("tribe").trim();
        const xb = i.fields.getTextInputValue("xbox").trim();
        const ign = i.fields.getTextInputValue("ign").trim();
        await i.deferReply({ ephemeral: true });
        try {
            await db.insert(tribeRegistrationsTable).values({ guildId: i.guildId!, tribeName: tN, ign, xboxGamertag: xb, discordUserId: i.user.id, discordUsername: i.user.username, status: "pending", isOwner: (i.customId === 'modal_reg') });
            const e = new EmbedBuilder().setTitle("🛡️ PENDING SIGNATURE").setDescription(`<@${i.user.id}> -> **${tN}**.`).addFields({ name: "IGN", value: ign, inline: true }, { name: "Xbox", value: xb, inline: true }).setColor(Colors.Orange);
            const r = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gate_accept:" + i.user.id).setLabel("Approve").setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId("gate_deny:" + i.user.id).setLabel("Deny").setStyle(ButtonStyle.Danger));
            await postToStaffLog(i.guildId!, e, [r]);
            await i.editReply("✅ Pending staff approval.");
        } catch (e) { await i.editReply("❌ Error. Signature already initialized."); }
    }
    if (i.customId === "modal_alpha") {
        await db.insert(alphaClaimsTable).values({ guildId: i.guildId!, tribeName: i.fields.getTextInputValue("tribe"), discordUserId: i.user.id, coordinates: i.fields.getTextInputValue("coords"), memberCount: parseInt(i.fields.getTextInputValue("members")) || 0 });
        await postToStaffLog(i.guildId!, new EmbedBuilder().setTitle("👑 ALPHA CLAIM").setDescription(`<@${i.user.id}> claimed Alpha status.`).setColor(Colors.Gold));
        await i.reply({ content: "✅ Claim submitted for verification.", ephemeral: true });
    }
    if (i.customId === "modal_lft") {
        const [cfg] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, i.guildId!)).limit(1);
        if (cfg?.recruitmentChannelId) {
            const c: any = await client.channels.fetch(cfg.recruitmentChannelId);
            await c.send({ embeds: [new EmbedBuilder().setTitle("🔎 SURVIVOR LFT").addFields({ name: "Survivor", value: `<@${i.user.id}>` }, { name: "Hours", value: i.fields.getTextInputValue("hours") }, { name: "Skills", value: i.fields.getTextInputValue("desc") }).setColor(OVERSEER_COLOR)] });
            await i.reply({ content: "✅ Profile posted!", ephemeral: true });
        }
    }
    if (i.customId === "modal_task") {
        const [reg] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
        if (reg) {
            await (i.channel as any).send({ embeds: [new EmbedBuilder().setTitle("📋 NEW TASK").setDescription(i.fields.getTextInputValue("content")).setColor(Colors.Blue).setFooter({ text: "Posted by " + reg.ign })] });
            await i.reply({ content: "Task added!", ephemeral: true });
        }
    }
  }
});

// Pinger Support
http.createServer((_, res) => { res.writeHead(200); res.end("OK"); }).listen(process.env.PORT || 3000);

async function start() {
    try {
        const rest = new REST({ version: "10" }).setToken(token!);
        await rest.put(Routes.applicationCommands(applicationId!), { body: commands.map(c => c.toJSON()) });
        await client.login(token);
    } catch (e) { console.error(e); }
}
start();
