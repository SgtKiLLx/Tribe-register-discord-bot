import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, ActionRowBuilder, type ModalActionRowComponentBuilder,
  Events, type Interaction, PermissionFlagsBits, EmbedBuilder, Colors,
  ButtonBuilder, ButtonStyle, ChannelType, ActivityType, GuildMember, ThreadAutoArchiveDuration
} from "discord.js";
import { db, tribeRegistrationsTable, guildConfigTable, alphaClaimsTable, tribeTasksTable, recruitmentTable, bountiesTable, shopItemsTable } from "./db";
import { eq, and, sql } from "drizzle-orm";
import http from "http";
import { startServer } from "./server";

const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
const ArkSentinel_COLOR = 0x00ffff;
const ArkSentinel_EMOJI_ID = "1501961516604330035";

// --- Memory & Asset Data ---
const coinCooldown = new Set();
const ARK_ASSETS = [
    "Rex (High Level)", "Giganotosaurus", "Carcharodontosaurus", "Wyvern (Lightning)", 
    "Wyvern (Fire)", "Griffin", "Quetzal", "Therizinosaurus", "Rhyniognatha", 
    "Tek Turret Kit", "Heavy Turret Kit", "Ascendant Sniper Kit", "Element (100x)", 
    "Metal Base Kit", "Vault Kit", "Industrial Forge", "Kibble (Extraordinary)"
];

if (!token || !applicationId) process.exit(1);

// --- 🧠 Master Helpers ---

async function refreshArkSentinelStatus(client: Client) {
    try {
        const tribes = await db.select({ name: tribeRegistrationsTable.tribeName })
            .from(tribeRegistrationsTable)
            .where(eq(tribeRegistrationsTable.status, 'verified'));
        
        const count = new Set(tribes.map(t => t.name)).size;
        const statusText = count > 0 ? `over ${count} Tribes` : "over the server";

        // Setting a Custom Activity with your Emoji
        client.user?.setPresence({
            activities: [{
                name: "custom",
                type: ActivityType.Custom,
                state: `Watching ${statusText}`,
                emoji: {
                    id: ArkSentinel_EMOJI_ID 
                }
            }]
        });

        console.log(`Status Sync: Watching ${statusText}`);
    } catch (e) { console.error("Status fail"); }
}

async function isArkSentinelStaff(interaction: Interaction): Promise<boolean> {
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
    } catch (e) { console.error("Log Fail"); }
}

function getTribeDashboard(tribeName: string) {
  const embed = new EmbedBuilder().setTitle(`💠 ArkSentinel | HQ: ${tribeName}`).setDescription("Tribe HQ Active. Use protocols for coordination.").setColor(ArkSentinel_COLOR);
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

// --- 🛠️ Command Definitions (21 Protocols) ---

const commands = [
  new SlashCommandBuilder().setName("help").setDescription("View the full ArkSentinel manual"),
  new SlashCommandBuilder().setName("register").setDescription("Initialize a new tribe signature"),
  new SlashCommandBuilder().setName("lft").setDescription("Post a recruitment profile"),
  new SlashCommandBuilder().setName("my-tribe").setDescription("View your survivor profile"),
  new SlashCommandBuilder().setName("leave-tribe").setDescription("Exit current tribe"),
  new SlashCommandBuilder().setName("list-tribes").setDescription("View server tribe database"),
  new SlashCommandBuilder().setName("bal").setDescription("Check your Tek Coin balance"),
  new SlashCommandBuilder().setName("shop").setDescription("Browse the Tek-Market"),
  new SlashCommandBuilder().setName("buy").setDescription("Purchase an item").addStringOption(o => o.setName("item").setDescription("Item name").setAutocomplete(true).setRequired(true)),
  new SlashCommandBuilder().setName("pay").setDescription("Transfer Tek Coins").addUserOption(o => o.setName("target").setDescription("Who to pay").setRequired(true)).addIntegerOption(o => o.setName("amount").setDescription("Amount").setRequired(true)),
  new SlashCommandBuilder().setName("bounty").setDescription("Place bounty").addStringOption(o => o.setName("tribe").setDescription("Target").setRequired(true)).addIntegerOption(o => o.setName("amount").setDescription("Coins").setRequired(true)),
  new SlashCommandBuilder().setName("add-item").setDescription("Add shop item (Staff)").addStringOption(o => o.setName("name").setDescription("Name").setAutocomplete(true).setRequired(true)).addIntegerOption(o => o.setName("price").setDescription("Price").setRequired(true)).addStringOption(o => o.setName("category").setDescription("Type").addChoices({name:'Dino', value:'dino'}, {name:'Item', value:'item'}).setRequired(true)),
  new SlashCommandBuilder().setName("remove-item").setDescription("Remove shop item (Staff)").addStringOption(o => o.setName("item").setDescription("Item name").setAutocomplete(true).setRequired(true)),
  new SlashCommandBuilder().setName("add-coins").setDescription("Grant Tek Coins (Staff)").addUserOption(o => o.setName("target").setDescription("Survivor").setRequired(true)).addIntegerOption(o => o.setName("amount").setDescription("Amount").setRequired(true)),
  new SlashCommandBuilder().setName("kick-member").setDescription("Purge survivor (Staff)").addUserOption(o => o.setName("target").setDescription("Survivor").setRequired(true)),
  new SlashCommandBuilder().setName("post-info").setDescription("Deploy Reg Terminal"),
  new SlashCommandBuilder().setName("post-support").setDescription("Deploy SOS Terminal"),
  new SlashCommandBuilder().setName("post-alpha-terminal").setDescription("Deploy Alpha Terminal"),
  new SlashCommandBuilder().setName("post-recruitment").setDescription("Deploy LFT Terminal"),
  new SlashCommandBuilder().setName("post-shop").setDescription("Deploy Market Terminal"),
  new SlashCommandBuilder().setName("setup").setDescription("Configure ArkSentinel protocols")
    .addRoleOption(o => o.setName("role").setDescription("Staff Role").setRequired(true))
    .addChannelOption(o => o.setName("logs").setDescription("Staff Logs").setRequired(true))
    .addChannelOption(o => o.setName("welcome").setDescription("Welcome").setRequired(true))
    .addChannelOption(o => o.setName("rules").setDescription("Rules").setRequired(true))
    .addChannelOption(o => o.setName("info").setDescription("Info").setRequired(true))
    .addChannelOption(o => o.setName("recruitment").setDescription("Recruit").setRequired(true))
    .addChannelOption(o => o.setName("support").setDescription("Support").setRequired(true))
    .addChannelOption(o => o.setName("category").setDescription("Category").addChannelTypes(ChannelType.GuildCategory).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("join").setDescription("Sync with existing tribe").addStringOption(o => o.setName("tribe_name").setDescription("Search").setAutocomplete(true).setRequired(true)),
];

// --- 🦾 Client Logic ---

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages] });

client.once(Events.ClientReady, async (c) => {
  console.log(`ArkSentinel System Synchronized: ${c.user.tag}`);
  await refreshArkSentinelStatus(c);
  startServer(c);
});

// Passive Income Logic
client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot || !msg.guildId || coinCooldown.has(msg.author.id)) return;
    try {
        await db.update(tribeRegistrationsTable).set({ tekCoins: sql`${tribeRegistrationsTable.tekCoins} + 5` }).where(and(eq(tribeRegistrationsTable.discordUserId, msg.author.id), eq(tribeRegistrationsTable.guildId, msg.guildId)));
        coinCooldown.add(msg.author.id);
        setTimeout(() => coinCooldown.delete(msg.author.id), 120000);
    } catch (e) {}
});

// Welcome logic
client.on(Events.GuildMemberAdd, async (member) => {
    try {
        const [config] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, member.guild.id)).limit(1);
        if (!config) return;
        if (config.welcomeChannelId) {
            const welcomeChan: any = await member.guild.channels.fetch(config.welcomeChannelId).catch(() => null);
            if (welcomeChan) {
                const embed = new EmbedBuilder().setTitle("🔵 NEW SURVIVOR DETECTED").setThumbnail(member.user.displayAvatarURL()).setColor(ArkSentinel_COLOR).setDescription(`Welcome Survivor <@${member.id}>. Protocols initialized.`)
                    .addFields({ name: "📜 DIRECTIVES", value: `<#${config.rulesChannelId || '0'}> | <#${config.infoChannelId || '0'}>` });
                await welcomeChan.send({ content: `Welcome Survivor, <@${member.id}>`, embeds: [embed] });
            }
        }
        const dm = new EmbedBuilder().setTitle("💠 ArkSentinel | DIRECTIVES").setColor(ArkSentinel_COLOR).setDescription("Use `/help` for system documentation.");
        await member.send({ embeds: [dm] }).catch(() => null);
    } catch (e) {}
});

// --- 📡 Interaction Engine ---

client.on(Events.InteractionCreate, async (i: Interaction) => {
  try {
    // A. Autocomplete Logic
    if (i.isAutocomplete()) {
        const focused = i.options.getFocused().toLowerCase();
        if (i.commandName === "join") {
            const tribes = await db.select({ name: tribeRegistrationsTable.tribeName }).from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.guildId, i.guildId!), eq(tribeRegistrationsTable.status, 'verified')));
            const filtered = [...new Set(tribes.map(t => t.name))].filter(n => n.toLowerCase().includes(focused)).slice(0, 25);
            return i.respond(filtered.map(n => ({ name: n, value: n })));
        }
        if (i.commandName === "add-item") {
            const filtered = ARK_ASSETS.filter(a => a.toLowerCase().includes(focused)).slice(0, 25);
            return i.respond(filtered.map(a => ({ name: a, value: a })));
        }
        if (i.commandName === "buy" || i.commandName === "remove-item") {
            const items = await db.select().from(shopItemsTable).where(eq(shopItemsTable.guildId, i.guildId!));
            const filtered = items.filter(it => it.itemName.toLowerCase().includes(focused)).slice(0, 25);
            return i.respond(filtered.map(it => ({ name: `${it.itemName} (${it.price} coins)`, value: it.itemName })));
        }
    }

    // B. Button Logic
    if (i.isButton()) {
        const [reg] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
        
        // Gatekeeper Approvals
        if (i.customId.startsWith("gate_accept:") || i.customId.startsWith("gate_deny:")) {
            if (!(await isArkSentinelStaff(i))) return i.reply({ content: "❌ Staff clearance required.", ephemeral: true });
            const [action, tId] = i.customId.split(":");
            await i.deferReply({ ephemeral: true });
            if (action === "gate_accept") {
                const [p] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, tId), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
                if (!p) return i.editReply("Database error.");
                await db.update(tribeRegistrationsTable).set({ status: 'verified' }).where(eq(tribeRegistrationsTable.id, p.id));
                const [cfg] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, i.guildId!)).limit(1);
                const chan = await i.guild?.channels.create({ name: p.tribeName.toLowerCase().replace(/\s+/g, '-'), type: ChannelType.GuildText, parent: cfg?.tribeCategoryId || undefined, permissionOverwrites: [{ id: i.guild!.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }, { id: tId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }, { id: client.user!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }] });
                if (chan) await (chan as any).send(getTribeDashboard(p.tribeName));
                const mem = await i.guild?.members.fetch(tId).catch(() => null);
                if (mem?.manageable) await mem.setNickname(`[${p.tribeName}] ${p.ign}`);
                await i.editReply("✅ Survivor Authorized.");
                await refreshArkSentinelStatus(client);
            } else {
                await db.delete(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, tId), eq(tribeRegistrationsTable.guildId, i.guildId!)));
                await i.editReply("❌ Signature Purged.");
            }
            return;
        }

        // SOS Tickets
        if (i.customId === "btn_open_ticket") {
        await i.deferReply({ ephemeral: true });
        const chan: any = i.channel;
        
        const thread = await chan.threads.create({ 
            name: `ticket-${i.user.username}`, 
            type: ChannelType.PrivateThread, 
            autoArchiveDuration: ThreadAutoArchiveDuration.OneDay 
        });

        await thread.members.add(i.user.id);

        // Create the Close Button
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId("btn_close_ticket")
                .setLabel("Close Ticket")
                .setStyle(ButtonStyle.Danger)
                .setEmoji("🔒")
        );
        
        await thread.send({ 
            content: `**Transmission Received.** <@${i.user.id}>, please describe the issue. Staff has been notified.`,
            components: [row] 
        });

        return i.editReply(`✅ SOS Protocol Initialized: <#${thread.id}>`);
    }
      // --- SOS: CLOSE TICKET PROTOCOL ---
      if (i.customId === "btn_close_ticket") {
        const thread = i.channel;
        if (!thread || !thread.isThread()) return;

        await i.reply({ content: "🔒 **Closing Protocol Initialized.** This thread is being archived." });
        
        // Lock and Archive the thread
        try {
            await thread.setLocked(true);
            await thread.setArchived(true);
            
            // Log the closure to staff logs
            await postToStaffLog(i.guildId!, new EmbedBuilder()
                .setTitle("🆘 TICKET CLOSED")
                .setDescription(`Ticket <#${thread.id}> was closed by <@${i.user.id}>.`)
                .setColor(Colors.Red)
            );
        } catch (e) {
            console.error("Failed to close thread:", e);
        }
    }

        // Modal Triggers
        if (["btn_start_register", "btn_start_join", "btn_lft_start", "btn_alpha_claim", "btn_shop_view", "btn_bal_check"].includes(i.customId)) {
            if (i.customId === "btn_shop_view") {
                await i.deferReply({ ephemeral: true });
                const its = await db.select().from(shopItemsTable).where(eq(shopItemsTable.guildId, i.guildId!));
                const e = new EmbedBuilder().setTitle("🛒 INVENTORY").setDescription(its.map(x => `• **${x.itemName}**: ${x.price}`).join("\n") || "Empty").setColor(ArkSentinel_COLOR);
                return i.editReply({ embeds: [e] });
            }
            if (i.customId === "btn_bal_check") {
                await i.deferReply({ ephemeral: true });
                return i.editReply("💰 Balance: " + (reg?.tekCoins || 0) + " Tek Coins.");
            }
            const modalId = i.customId === "btn_start_register" ? "modal_reg" : i.customId === "btn_start_join" ? "modal_join" : i.customId === "btn_alpha_claim" ? "modal_alpha" : "modal_lft";
            const m = new ModalBuilder().setCustomId(modalId).setTitle("ArkSentinel Terminal");
            if (modalId === "modal_lft") {
                m.addComponents(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("style").setLabel("Playstyle").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("hours").setLabel("Hours").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("desc").setLabel("Skills").setStyle(TextInputStyle.Paragraph).setRequired(true)));
            } else if (modalId === "modal_alpha") {
                m.addComponents(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe").setLabel("Tribe").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("coords").setLabel("Coords").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("members").setLabel("Members").setStyle(TextInputStyle.Short).setRequired(true)));
            } else {
                m.addComponents(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe").setLabel(i.customId === "btn_start_join" ? "Exact Tribe Name" : "Tribe Name").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("ign").setLabel("Your IGN").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("xbox").setLabel("Xbox Gamertag").setStyle(TextInputStyle.Short).setRequired(true)));
            }
            return i.showModal(m);
        }

        // Dashboard Buttons
        if (reg && reg.status === 'verified') {
            if (i.customId === "raid_alert") return i.reply({ content: `🚨 **RAID ALERT!** <@${i.user.id}> reports attack! @everyone`, allowedMentions: { parse: ['everyone'] } });
            if (i.customId === "view_roster") {
                const mems = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.tribeName, reg.tribeName), eq(tribeRegistrationsTable.guildId, i.guildId!), eq(tribeRegistrationsTable.status, 'verified')));
                return i.reply({ content: `📜 **Roster:**\n` + mems.map(m => `• ${m.ign}`).join("\n"), ephemeral: true });
            }
            if (i.customId === "claim_kit") {
                if (reg.hasClaimedKit) return i.reply({ content: "❌ Protocol Error: Kit already claimed.", ephemeral: true });
                await postToStaffLog(i.guildId!, new EmbedBuilder().setTitle("🎁 Kit Request").setDescription(`<@${i.user.id}> requested kit for **${reg.tribeName}**.`).setColor(Colors.Green));
                await db.update(tribeRegistrationsTable).set({ hasClaimedKit: true }).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!)));
                return i.reply({ content: "✅ Protocol Accepted. Staff notified.", ephemeral: true });
            }
            if (i.customId === "add_task") {
                const m = new ModalBuilder().setCustomId("modal_task").setTitle("Add Mission");
                m.addComponents(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("content").setLabel("Details").setStyle(TextInputStyle.Paragraph).setRequired(true)));
                return i.showModal(m);
            }
        }
    }

    // C. Chat Command Logic
    if (i.isChatInputCommand()) {
        const dbCmds = ["bal", "shop", "buy", "list-tribes", "setup", "kick-member", "bounty", "my-tribe", "add-item", "remove-item", "leave-tribe", "add-coins", "pay"];
        if (dbCmds.includes(i.commandName)) await i.deferReply({ ephemeral: true });
// --- STAFF: ADD SHOP ITEM ---
      if (i.commandName === "add-item") {
        // Security check
        if (!(await isArkSentinelStaff(i))) return i.editReply("❌ Staff clearance required.");
        
        const name = i.options.getString("name", true);
        const price = i.options.getInteger("price", true);
        const cat = i.options.getString("category", true);

        try {
            await db.insert(shopItemsTable).values({ 
                guildId: i.guildId!, 
                itemName: name, 
                price: price, 
                category: cat 
            });
            
            return i.editReply({ content: `✅ **Protocol Success.** Stored **${name}** in the Tek-Market for **${price}** coins.` });
        } catch (e) {
            return i.editReply({ content: "❌ **Database Error.** Could not register item signature." });
        }
    }
        
      if (i.commandName === "bal") {
            const [u] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!)));
            return i.editReply("💰 **Balance:** " + (u?.tekCoins || 0) + " Tek Coins.");
        }
        if (i.commandName === "shop") {
            const its = await db.select().from(shopItemsTable).where(eq(shopItemsTable.guildId, i.guildId!));
            const e = new EmbedBuilder().setTitle("🛒 MARKET").setColor(ArkSentinel_COLOR).addFields({ name: "Items", value: its.map(x => `• **${x.itemName}**: ${x.price}`).join("\n") || "Empty" });
            return i.editReply({ embeds: [e] });
        }
        if (i.commandName === "buy") {
            const n = i.options.getString("item", true);
            const [u] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!)));
            const [it] = await db.select().from(shopItemsTable).where(and(eq(shopItemsTable.itemName, n), eq(shopItemsTable.guildId, i.guildId!))).limit(1);
            if (!it || !u || u.tekCoins < it.price) return i.editReply("❌ Error: Funds low or item missing.");
            await db.update(tribeRegistrationsTable).set({ tekCoins: u.tekCoins - it.price }).where(eq(tribeRegistrationsTable.id, u.id));
            await postToStaffLog(i.guildId!, new EmbedBuilder().setTitle("💰 PURCHASE").setDescription(`<@${i.user.id}> bought **${n}**`).setColor(Colors.Green));
            return i.editReply("✅ Purchase successful. Staff notified.");
        }
        if (i.commandName === "add-coins") {
            if (!(await isArkSentinelStaff(i))) return i.editReply("❌ Staff only.");
            const t = i.options.getUser("target", true);
            const a = i.options.getInteger("amount", true);
            await db.update(tribeRegistrationsTable).set({ tekCoins: sql`${tribeRegistrationsTable.tekCoins} + ${a}` }).where(and(eq(tribeRegistrationsTable.discordUserId, t.id), eq(tribeRegistrationsTable.guildId, i.guildId!)));
            return i.editReply(`✅ Granted ${a} coins to <@${t.id}>.`);
        }
        if (i.commandName === "pay") {
            const t = i.options.getUser("target", true);
            const a = i.options.getInteger("amount", true);
            const [s] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!)));
            const [r] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, t.id), eq(tribeRegistrationsTable.guildId, i.guildId!)));
            if (!s || s.tekCoins < a || a <= 0) return i.editReply("❌ Transaction Failed.");
            if (!r) return i.editReply("❌ Recipient not registered.");
            await db.update(tribeRegistrationsTable).set({ tekCoins: s.tekCoins - a }).where(eq(tribeRegistrationsTable.id, s.id));
            await db.update(tribeRegistrationsTable).set({ tekCoins: r.tekCoins + a }).where(eq(tribeRegistrationsTable.id, r.id));
            return i.editReply(`✅ Transferred ${a} coins.`);
        }
        if (i.commandName === "my-tribe") {
            const [reg] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
            if (!reg) return i.editReply("❌ No signature found.");
            const e = new EmbedBuilder().setTitle(`👤 ${reg.ign}`).addFields({ name: "Tribe", value: reg.tribeName }, { name: "Xbox", value: reg.xboxGamertag }, { name: "Balance", value: reg.tekCoins + " Coins" }).setColor(ArkSentinel_COLOR);
            return i.editReply({ embeds: [e] });
        }
        if (i.commandName === "leave-tribe") {
            const [reg] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
            if (!reg) return i.editReply("❌ No record found.");
            await db.delete(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.id, reg.id));
            if (reg.channelId) {
                const chan: any = await i.guild?.channels.fetch(reg.channelId).catch(() => null);
                if (chan) await chan.permissionOverwrites.delete(i.user.id);
            }
            await refreshArkSentinelStatus(client);
            return i.editReply("✅ Success. Signature removed.");
        }
        if (i.commandName === "list-tribes") {
            if (!(await isArkSentinelStaff(i))) return i.editReply("❌ Staff only.");
            const regs = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.guildId, i.guildId!)).orderBy(tribeRegistrationsTable.tribeName);
            const e = new EmbedBuilder().setTitle("🌐 DB").setColor(ArkSentinel_COLOR);
            regs.slice(0, 25).forEach(r => e.addFields({ name: "[" + r.tribeName + "] " + r.ign, value: `Status: ${r.status}`, inline: false }));
            return i.editReply({ embeds: [e] });
        }
        if (i.commandName === "kick-member") {
            if (!(await isArkSentinelStaff(i))) return i.editReply("❌ Staff only.");
            const t = i.options.getUser("target", true);
            const [r] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, t.id), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
            if (!r) return i.editReply("Not found.");
            await db.delete(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.id, r.id));
            return i.editReply(`✅ Purged <@${t.id}>.`);
        }
        if (i.commandName === "setup") {
            const o = i.options;
            await db.insert(guildConfigTable).values({ guildId: i.guildId!, adminRoleIds: o.getRole("role")!.id, staffLogChannelId: o.getChannel("logs")!.id, welcomeChannelId: o.getChannel("welcome")!.id, rulesChannelId: o.getChannel("rules")!.id, infoChannelId: o.getChannel("info")!.id, recruitmentChannelId: o.getChannel("recruitment")!.id, supportChannelId: o.getChannel("support")!.id, tribeCategoryId: o.getChannel("category")!.id }).onConflictDoUpdate({ target: guildConfigTable.guildId, set: { adminRoleIds: o.getRole("role")!.id, staffLogChannelId: o.getChannel("logs")!.id, welcomeChannelId: o.getChannel("welcome")!.id, rulesChannelId: o.getChannel("rules")!.id, infoChannelId: o.getChannel("info")!.id, recruitmentChannelId: o.getChannel("recruitment")!.id, supportChannelId: o.getChannel("support")!.id, tribeCategoryId: o.getChannel("category")!.id } });
            return i.editReply("✅ Configured.");
        }
        if (["help", "post-info", "post-support", "post-alpha-terminal", "post-recruitment", "post-shop"].includes(i.commandName)) {
            const e = new EmbedBuilder().setColor(ArkSentinel_COLOR);
            let row = new ActionRowBuilder<ButtonBuilder>();
            if (i.commandName === "help") return i.reply({ embeds: [new EmbedBuilder().setTitle("💠 ArkSentinel").addFields({name:'Protocols', value:'/register, /join, /bal, /shop, /pay, /lft, /leave-tribe'})], ephemeral: true });
            if (i.commandName === "post-info") { e.setTitle("🛡️ REGISTRATION"); row.addComponents(new ButtonBuilder().setCustomId("btn_start_register").setLabel("Create Tribe").setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId("btn_start_join").setLabel("Join Tribe").setStyle(ButtonStyle.Primary)); }
            else if (i.commandName === "post-support") { e.setTitle("🆘 SOS").setDescription("Click for support."); row.addComponents(new ButtonBuilder().setCustomId("btn_open_ticket").setLabel("Contact").setStyle(ButtonStyle.Danger)); }
            else if (i.commandName === "post-shop") { e.setTitle("🛒 MARKET").setDescription("View inventory."); row.addComponents(new ButtonBuilder().setCustomId("btn_shop_view").setLabel("View Inventory").setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId("btn_bal_check").setLabel("Check Bank").setStyle(ButtonStyle.Secondary)); }
            else if (i.commandName === "post-alpha-terminal") { e.setTitle("👑 ALPHA").setDescription("Claim status."); row.addComponents(new ButtonBuilder().setCustomId("btn_alpha_claim").setLabel("Claim").setStyle(ButtonStyle.Secondary)); }
            else { e.setTitle("📡 RECRUIT").setDescription("LFT Terminal."); row.addComponents(new ButtonBuilder().setCustomId("btn_lft_start").setLabel("Post LFT").setStyle(ButtonStyle.Primary)); }
            await (i.channel as any).send({ embeds: [e], components: [row] });
            return i.reply({ content: "Deployed.", ephemeral: true });
        }
    }

    // D. Modal Submissions
    if (i.isModalSubmit()) {
        if (i.customId === "modal_reg" || i.customId === "modal_join") {
            const join = i.customId === "modal_join";
            const tN = i.fields.getTextInputValue("tribe").trim();
            const xb = i.fields.getTextInputValue("xbox").trim();
            const ign = i.fields.getTextInputValue("ign").trim();
            await i.deferReply({ ephemeral: true });
            try {
                await db.insert(tribeRegistrationsTable).values({ guildId: i.guildId!, tribeName: tN, ign, xboxGamertag: xb, discordUserId: i.user.id, discordUsername: i.user.username, status: "pending", isOwner: !join });
                const e = new EmbedBuilder().setTitle("🛡️ PENDING").setDescription("<@" + i.user.id + "> -> **" + tN + "**.").setColor(Colors.Orange);
                const r = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`gate_accept:${i.user.id}`).setLabel("Approve").setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`gate_deny:${i.user.id}`).setLabel("Deny").setStyle(ButtonStyle.Danger));
                await postToStaffLog(i.guildId!, e, [r]);
                await i.editReply("✅ Pending staff approval.");
            } catch (e) { await i.editReply("❌ Already registered."); }
        }
        if (i.customId === "modal_task") {
            const [reg] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
            if (reg) {
                await db.insert(tribeTasksTable).values({ guildId: i.guildId!, tribeName: reg.tribeName, taskContent: i.fields.getTextInputValue("content") });
                await (i.channel as any).send({ embeds: [new EmbedBuilder().setTitle("📋 NEW TASK").setDescription(i.fields.getTextInputValue("content")).setColor(Colors.Blue).setFooter({ text: "By " + reg.ign })] });
                await i.reply({ content: "Task added!", ephemeral: true });
            }
        }
        if (i.customId === "modal_alpha") {
            await db.insert(alphaClaimsTable).values({ guildId: i.guildId!, tribeName: i.fields.getTextInputValue("tribe"), discordUserId: i.user.id, coordinates: i.fields.getTextInputValue("coords"), memberCount: parseInt(i.fields.getTextInputValue("members")) || 0 });
            await postToStaffLog(i.guildId!, new EmbedBuilder().setTitle("👑 ALPHA").setDescription("<@" + i.user.id + "> claimed Alpha.").setColor(Colors.Gold));
            await i.reply({ content: "✅ Submitted.", ephemeral: true });
        }
    }
  } catch (err) { console.error("Global Error:", err); }
});

// Server & Start
async function start() {
    try {
        const rest = new REST({ version: "10" }).setToken(token!);
        await rest.put(Routes.applicationCommands(applicationId!), { body: commands.map(c => c.toJSON()) });
        await client.login(token);
    } catch (e) { console.error(e); }
}
start();
