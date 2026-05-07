import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, ActionRowBuilder, type ModalActionRowComponentBuilder,
  Events, type Interaction, PermissionFlagsBits, EmbedBuilder, Colors,
  ButtonBuilder, ButtonStyle, ChannelType, ActivityType, GuildMember, ThreadAutoArchiveDuration
} from "discord.js";
import { db, tribeRegistrationsTable, guildConfigTable, alphaClaimsTable, tribeTasksTable, recruitmentTable, bountiesTable, shopItemsTable } from "./db";
import { eq, and, sql } from "drizzle-orm";
import http from "http";

const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
const OVERSEER_COLOR = 0x00ffff; 

// --- Economy Memory ---
const coinCooldown = new Set();

if (!token || !applicationId) process.exit(1);

// --- Helpers ---
async function refreshOverseerStatus(client: Client) {
    try {
        const tribes = await db.select({ name: tribeRegistrationsTable.tribeName }).from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.status, 'verified'));
        const count = new Set(tribes.map(t => t.name)).size;
        client.user?.setActivity("over " + count + " Tribes", { type: ActivityType.Watching });
    } catch (e) { console.error("Status fail"); }
}

async function isOverseerStaff(interaction: Interaction): Promise<boolean> {
    if (!interaction.guildId || !interaction.member) return false;
    const member = interaction.member as GuildMember;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    const [config] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, interaction.guildId)).limit(1);
    if (!config?.adminRoleIds) return false;
    const allowedRoles = config.adminRoleIds.split(",").map(id => id.trim());
    return member.roles.cache.some(role => allowedRoles.includes(role.id));
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
  const embed = new EmbedBuilder().setTitle("💠 OVERSEER | HQ: " + tribeName).setDescription("Tribe HQ Active. Use protocols for coordination.").setColor(OVERSEER_COLOR);
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

// 1. Commands
const commands = [
  new SlashCommandBuilder().setName("help").setDescription("View the Overseer manual"),
  new SlashCommandBuilder().setName("post-info").setDescription("Deploy Registration Interface").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("post-support").setDescription("Deploy Support Terminal").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("post-alpha-terminal").setDescription("Deploy Alpha Terminal").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("lft").setDescription("Post recruitment profile"),
  new SlashCommandBuilder().setName("my-tribe").setDescription("View your survivor profile"),
  new SlashCommandBuilder().setName("leave-tribe").setDescription("Exit tribe"),
  new SlashCommandBuilder().setName("bal").setDescription("Check your current Tek Coin balance"),
  new SlashCommandBuilder().setName("bounty").setDescription("Place a Tek Coin bounty on a tribe")
    .addStringOption(o => o.setName("tribe").setDescription("Target Tribe Name").setRequired(true))
    .addIntegerOption(o => o.setName("amount").setDescription("Tek Coin Reward Amount").setRequired(true)),
  new SlashCommandBuilder().setName("list-tribes").setDescription("View global server database"),
  new SlashCommandBuilder().setName("kick-member").setDescription("Remove survivor from records").addUserOption(o => o.setName("target").setDescription("User to kick").setRequired(true)),
  new SlashCommandBuilder().setName("setup").setDescription("Configure Overseer protocols")
    .addRoleOption(o => o.setName("role").setDescription("Staff Role").setRequired(true))
    .addChannelOption(o => o.setName("logs").setDescription("Logs").setRequired(true))
    .addChannelOption(o => o.setName("welcome").setDescription("Welcome").setRequired(true))
    .addChannelOption(o => o.setName("rules").setDescription("Rules").setRequired(true))
    .addChannelOption(o => o.setName("info").setDescription("Info").setRequired(true))
    .addChannelOption(o => o.setName("recruitment").setDescription("Recruit").setRequired(true))
    .addChannelOption(o => o.setName("support").setDescription("Support").setRequired(true))
    .addChannelOption(o => o.setName("category").setDescription("Category").addChannelTypes(ChannelType.GuildCategory).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// 2. Client Setup
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent // Required for Economy
    ] 
});

client.once(Events.ClientReady, async (c) => {
  console.log("Overseer Elite Online: " + c.user.tag);
  await refreshOverseerStatus(c);
});

// --- Feature #5: Passive Economy Logic ---
client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot || !msg.guildId) return;
    if (coinCooldown.has(msg.author.id)) return;

    try {
        await db.update(tribeRegistrationsTable)
            .set({ tekCoins: sql`${tribeRegistrationsTable.tekCoins} + 1` })
            .where(and(eq(tribeRegistrationsTable.discordUserId, msg.author.id), eq(tribeRegistrationsTable.guildId, msg.guildId)));
        
        coinCooldown.add(msg.author.id);
        setTimeout(() => coinCooldown.delete(msg.author.id), 120000); // 2 min cooldown
    } catch (e) { /* User not registered, skip */ }
});

// --- Welcome Event ---
client.on(Events.GuildMemberAdd, async (m) => {
    try {
        const [cfg] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, m.guild.id)).limit(1);
        if (!cfg || !cfg.welcomeChannelId) return;
        const c: any = await m.guild.channels.fetch(cfg.welcomeChannelId);
        const e = new EmbedBuilder().setTitle("🔵 NEW SURVIVOR DETECTED").setThumbnail(m.user.displayAvatarURL()).setColor(OVERSEER_COLOR).setDescription("Welcome, <@" + m.id + ">.").addFields({ name: "📜 DIRECTIVES", value: "<#" + (cfg.rulesChannelId || "0") + "> | <#" + (cfg.infoChannelId || "0") + ">" });
        await c.send({ content: "Welcome, <@" + m.id + ">", embeds: [e] });
    } catch (e) { console.error("Welcome fail"); }
});

// 3. Interaction Listener
client.on(Events.InteractionCreate, async (i: Interaction) => {
  if (i.isAutocomplete() && i.commandName === "join") {
    const tribes = await db.select({ name: tribeRegistrationsTable.tribeName }).from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.guildId, i.guildId!), eq(tribeRegistrationsTable.status, 'verified')));
    const filtered = [...new Set(tribes.map(t => t.name))].filter(n => n.toLowerCase().includes(i.options.getFocused().toLowerCase())).slice(0, 25);
    return i.respond(filtered.map(n => ({ name: n, value: n })));
  }

  if (i.isButton()) {
    const [reg] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
    
    // --- Feature #7: GATEKEEPER APPROVAL LOGIC ---
    if (i.customId.startsWith("gate_accept:") || i.customId.startsWith("gate_deny:")) {
        if (!(await isOverseerStaff(i))) return i.reply({ content: "❌ Authorized staff only.", ephemeral: true });
        
        const [action, targetId] = i.customId.split(":");
        await i.deferReply({ ephemeral: true });

        if (action === "gate_accept") {
            const [pReg] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, targetId), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
            if (!pReg) return i.editReply("Record missing.");

            await db.update(tribeRegistrationsTable).set({ status: 'verified' }).where(eq(tribeRegistrationsTable.id, pReg.id));
            
            // Execute Infrastructure (Create Channel)
            const [cfg] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, i.guildId!)).limit(1);
            const chan = await i.guild?.channels.create({ name: pReg.tribeName.toLowerCase().replace(/\s+/g, '-'), type: ChannelType.GuildText, parent: cfg?.tribeCategoryId || undefined, permissionOverwrites: [{ id: i.guild!.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }, { id: targetId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }, { id: client.user!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }] });
            if (chan) await (chan as any).send(getTribeDashboard(pReg.tribeName));

            const member = await i.guild?.members.fetch(targetId).catch(() => null);
            if (member?.manageable) await member.setNickname("[" + pReg.tribeName + "] " + pReg.ign);

            await i.editReply("✅ Survivor Verified.");
            await member?.send("💠 **Overseer Protocol:** Your tribe signature for **" + pReg.tribeName + "** is verified. Access HQ: <#" + chan?.id + ">").catch(() => null);
        } else {
            await db.delete(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, targetId), eq(tribeRegistrationsTable.guildId, i.guildId!)));
            await i.editReply("❌ Signature Purged.");
        }
        return;
    }

    if (i.customId === "btn_open_ticket") {
        await i.deferReply({ ephemeral: true });
        const t = await (i.channel as any).threads.create({ name: "ticket-" + i.user.username, type: ChannelType.PrivateThread, autoArchiveDuration: ThreadAutoArchiveDuration.OneDay });
        await t.members.add(i.user.id);
        await t.send("**Transmission Received.** <@" + i.user.id + ">, staff alerted.");
        return i.editReply("✅ Ticket opened: <#" + t.id + ">");
    }

    if (i.customId === "btn_start_register" || i.customId === "btn_start_join") {
        const join = i.customId === "btn_start_join";
        const m = new ModalBuilder().setCustomId(join ? "modal_join" : "modal_reg").setTitle(join ? "Join Tribe" : "Register Tribe");
        m.addComponents(
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe").setLabel(join ? "Exact Tribe Name" : "New Tribe Name").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("ign").setLabel("Your IGN").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("xbox").setLabel("Xbox Gamertag").setStyle(TextInputStyle.Short).setRequired(true))
        );
        return i.showModal(m);
    }

    if (reg && reg.status === 'verified') {
        if (i.customId === "raid_alert") return i.reply({ content: "🚨 **RAID ALERT!** <@" + i.user.id + "> reports attack! @everyone", allowedMentions: { parse: ['everyone'] } });
        if (i.customId === "claim_kit") {
            if (reg.hasClaimedKit) return i.reply({ content: "❌ Already claimed.", ephemeral: true });
            await postToStaffLog(i.guildId!, new EmbedBuilder().setTitle("🎁 Kit Request").setDescription("<@" + i.user.id + "> requested kit for **" + reg.tribeName + "**.").setColor(Colors.Green));
            await db.update(tribeRegistrationsTable).set({ hasClaimedKit: true }).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!)));
            return i.reply({ content: "✅ Requested!", ephemeral: true });
        }
        if (i.customId === "view_roster") {
            const mems = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.tribeName, reg.tribeName), eq(tribeRegistrationsTable.guildId, i.guildId!), eq(tribeRegistrationsTable.status, 'verified')));
            return i.reply({ content: "📜 **Roster:**\n" + mems.map(m => "• " + m.ign).join("\n"), ephemeral: true });
        }
    }
  }

  if (i.isChatInputCommand()) {
    // --- 1. ECONOMY: CHECK BALANCE ---
    if (i.commandName === "bal") {
        const [userData] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
        return i.reply({ content: "💰 **Overseer Bank:** You currently possess **" + (userData?.tekCoins || 0) + "** Tek Coins.", ephemeral: true });
    }

    // --- 2. ECONOMY: PLACE BOUNTY ---
    if (i.commandName === "bounty") {
        const target = i.options.getString("tribe", true);
        const amount = i.options.getInteger("amount", true);
        const [userData] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
        
        if (!userData || userData.tekCoins < amount) return i.reply({ content: "❌ Insufficient funds in bank signature.", ephemeral: true });
        
        await db.update(tribeRegistrationsTable).set({ tekCoins: userData.tekCoins - amount }).where(eq(tribeRegistrationsTable.id, userData.id));
        await db.insert(bountiesTable).values({ guildId: i.guildId!, targetTribe: target, reward: amount, placedBy: i.user.id });

        const e = new EmbedBuilder().setTitle("🚨 BOUNTY INITIALIZED").setDescription("A reward of **" + amount + " Tek Coins** has been placed on tribe **" + target + "**!").setColor(Colors.Red).setFooter({ text: "Protocol: Most Wanted" });
        return i.reply({ embeds: [e] });
    }

    // --- 3. SYSTEM: HELP MANUAL ---
    if (i.commandName === "help") {
        const e = new EmbedBuilder().setTitle("🔵 OVERSEER | v1.4").setColor(OVERSEER_COLOR).addFields(
            { name: "Survivor", value: "`/register`, `/join`, `/my-tribe`, `/lft`, `/leave-tribe`, `/bal`" },
            { name: "Staff", value: "`/list-tribes`, `/kick-member`, `/post-info`, `/post-support`, `/setup`" }
        );
        return i.reply({ embeds: [e], ephemeral: true });
    }

    // --- 4. STAFF: LIST ALL TRIBES (WITH DEFER FIX) ---
    if (i.commandName === "list-tribes") {
        await i.deferReply({ ephemeral: true }); // Tell Discord to wait
        if (!(await isOverseerStaff(i))) return i.editReply("❌ Staff clearance required.");

        const regs = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.guildId, i.guildId!)).orderBy(tribeRegistrationsTable.tribeName);
        if (regs.length === 0) return i.editReply("No signatures found for this sector.");

        const e = new EmbedBuilder().setTitle("🌐 SERVER DATABASE").setColor(OVERSEER_COLOR);
        regs.slice(0, 25).forEach(r => {
            const status = r.status === 'verified' ? "✅" : "⏳";
            e.addFields({ name: `${status} [${r.tribeName}] ${r.ign}`, value: `Xbox: ${r.xboxGamertag} | <@${r.discordUserId}>`, inline: false });
        });
        return i.editReply({ embeds: [e] });
    }

    // --- 5. STAFF: KICK MEMBER ---
    if (i.commandName === "kick-member") {
        if (!(await isOverseerStaff(i))) return i.reply({ content: "❌ Staff clearance required.", ephemeral: true });
        const target = i.options.getUser("target", true);
        const [r] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, target.id), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
        if (!r) return i.reply({ content: "Survivor not found.", ephemeral: true });
        
        await db.delete(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, target.id), eq(tribeRegistrationsTable.guildId, i.guildId!)));
        if (r.channelId) {
            const chan: any = await i.guild?.channels.fetch(r.channelId).catch(() => null);
            if (chan?.permissionOverwrites) await chan.permissionOverwrites.delete(target.id);
        }
        return i.reply({ content: `✅ Successfully purged <@${target.id}> from the database.` });
    }

    // --- 6. DEPLOY: REGISTRATION INTERFACE ---
    if (i.commandName === "post-info") {
        const e = new EmbedBuilder().setTitle("🛡️ OVERSEER | INITIALIZATION").setThumbnail(client.user?.displayAvatarURL() || null).setColor(OVERSEER_COLOR).setDescription("Welcome Survivor. Initialize signature below.");
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("btn_start_register").setLabel("Create Tribe").setStyle(ButtonStyle.Success).setEmoji("📝"),
            new ButtonBuilder().setCustomId("btn_start_join").setLabel("Join Tribe").setStyle(ButtonStyle.Primary).setEmoji("🤝")
        );
        await (i.channel as any).send({ embeds: [e], components: [row] });
        return i.reply({ content: "Interface Deployed.", ephemeral: true });
    }

    // --- 7. DEPLOY: SUPPORT TERMINAL ---
    if (i.commandName === "post-support") {
        const e = new EmbedBuilder().setTitle("🆘 OVERSEER | SUPPORT").setColor(OVERSEER_COLOR).setDescription("Click below to open a private SOS thread with staff.");
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("btn_open_ticket").setLabel("Contact Support").setStyle(ButtonStyle.Danger).setEmoji("🆘")
        );
        await (i.channel as any).send({ embeds: [e], components: [row] });
        return i.reply({ content: "Support Terminal Deployed.", ephemeral: true });
    }

    // --- 8. SURVIVOR: MY PROFILE ---
    if (i.commandName === "my-tribe") {
        const [reg] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
        if (!reg) return i.reply({ content: "No record found.", ephemeral: true });
        const e = new EmbedBuilder().setTitle(`👤 ${reg.ign}`).addFields({ name: "Tribe", value: reg.tribeName, inline: true }, { name: "Xbox", value: reg.xboxGamertag, inline: true }).setColor(OVERSEER_COLOR);
        return i.reply({ embeds: [e], ephemeral: true });
    }

    // --- 9. ADMIN: MASTER SETUP ---
    if (i.commandName === "setup") {
        const o = i.options;
        await db.insert(guildConfigTable).values({ 
            guildId: i.guildId!, adminRoleIds: o.getRole("role")!.id, staffLogChannelId: o.getChannel("logs")!.id, welcomeChannelId: o.getChannel("welcome")!.id, rulesChannelId: o.getChannel("rules")!.id, infoChannelId: o.getChannel("info")!.id, recruitmentChannelId: o.getChannel("recruitment")!.id, supportChannelId: o.getChannel("support")!.id, tribeCategoryId: o.getChannel("category")!.id 
        }).onConflictDoUpdate({ target: guildConfigTable.guildId, set: { adminRoleIds: o.getRole("role")!.id, staffLogChannelId: o.getChannel("logs")!.id, welcomeChannelId: o.getChannel("welcome")!.id, rulesChannelId: o.getChannel("rules")!.id, infoChannelId: o.getChannel("info")!.id, recruitmentChannelId: o.getChannel("recruitment")!.id, supportChannelId: o.getChannel("support")!.id, tribeCategoryId: o.getChannel("category")!.id } });
        return i.reply("✅ Overseer Protocol Configured.");
    }
  }

  if (i.isModalSubmit()) {
    if (i.customId === "modal_reg" || i.customId === "modal_join") {
        const tN = i.fields.getTextInputValue("tribe").trim();
        const ign = i.fields.getTextInputValue("ign").trim();
        const xb = i.fields.getTextInputValue("xbox").trim();
        await i.deferReply({ ephemeral: true });
        
        try {
            // Save as PENDING (Feature #7)
            await db.insert(tribeRegistrationsTable).values({ 
                guildId: i.guildId!, tribeName: tN, ign, xboxGamertag: xb, discordUserId: i.user.id, discordUsername: i.user.username, status: "pending", isOwner: (i.customId === 'modal_reg') 
            });

            const staffEmbed = new EmbedBuilder().setTitle("🛡️ GATEKEEPER | PENDING SIGNATURE").setDescription("<@" + i.user.id + "> wishes to " + (i.customId === 'modal_reg' ? 'create' : 'join') + " **" + tN + "**.").addFields({ name: "IGN", value: ign, inline: true }, { name: "Xbox", value: xb, inline: true }).setColor(Colors.Orange);
            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gate_accept:" + i.user.id).setLabel("Approve").setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId("gate_deny:" + i.user.id).setLabel("Deny").setStyle(ButtonStyle.Danger));

            await postToStaffLog(i.guildId!, staffEmbed, [row]);
            await i.editReply("✅ **Protocol Received.** Signature is pending staff approval. Access will be granted upon verification.");
        } catch (e) { await i.editReply("❌ Protocol Error. Already registered."); }
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
