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

const coinCooldown = new Set();
const ARK_ASSETS = [
    "Rex (High Level)", "Giganotosaurus", "Carcharodontosaurus", "Wyvern (Lightning)", 
    "Wyvern (Fire)", "Griffin", "Quetzal", "Therizinosaurus", "Rhyniognatha", 
    "Tek Turret Kit", "Heavy Turret Kit", "Ascendant Sniper Kit", "Element (100x)", 
    "Metal Base Kit", "Vault Kit", "Industrial Forge", "Kibble (Extraordinary)"
];

if (!token || !applicationId) process.exit(1);

// --- Helpers ---
async function isOverseerStaff(interaction: Interaction): Promise<boolean> {
    if (!interaction.guildId || !interaction.member) return false;
    const member = interaction.member as GuildMember;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    try {
        const [config] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, interaction.guildId)).limit(1);
        if (!config?.adminRoleIds) return false;
        const allowedRoles = config.adminRoleIds.split(",").map(id => id.trim());
        return member.roles.cache.some(role => allowedRoles.includes(role.id));
    } catch (e) { return false; }
}

async function refreshOverseerStatus(client: Client) {
    try {
        const tribes = await db.select({ name: tribeRegistrationsTable.tribeName }).from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.status, 'verified'));
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
  const embed = new EmbedBuilder().setTitle(`💠 OVERSEER | HQ: ${tribeName}`).setDescription("Tribe HQ Active. Use protocols below for coordination.").setColor(OVERSEER_COLOR);
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
  new SlashCommandBuilder().setName("help").setDescription("View the full Overseer manual"),
  new SlashCommandBuilder().setName("bal").setDescription("Check your Tek Coin balance"),
  new SlashCommandBuilder().setName("shop").setDescription("Browse the server Tek-Market"),
  new SlashCommandBuilder().setName("buy").setDescription("Purchase an item").addStringOption(o => o.setName("item").setDescription("Item name").setAutocomplete(true).setRequired(true)),
  new SlashCommandBuilder().setName("lft").setDescription("Post a recruitment profile"),
  new SlashCommandBuilder().setName("my-tribe").setDescription("View your survivor profile"),
  new SlashCommandBuilder().setName("leave-tribe").setDescription("Exit current tribe"),
  new SlashCommandBuilder().setName("list-tribes").setDescription("View server tribe database"),
  new SlashCommandBuilder().setName("kick-member").setDescription("Remove survivor from records").addUserOption(o => o.setName("target").setDescription("User to kick").setRequired(true)),
  new SlashCommandBuilder().setName("bounty").setDescription("Place a bounty on a tribe").addStringOption(o => o.setName("tribe").setDescription("Target Tribe").setRequired(true)).addIntegerOption(o => o.setName("amount").setDescription("Coin Amount").setRequired(true)),
  new SlashCommandBuilder().setName("add-item").setDescription("Add item to shop (Staff)").addStringOption(o => o.setName("name").setDescription("Name").setAutocomplete(true).setRequired(true)).addIntegerOption(o => o.setName("price").setDescription("Price").setRequired(true)).addStringOption(o => o.setName("category").setDescription("Category").addChoices({name:'Dino', value:'dino'}, {name:'Item', value:'item'}).setRequired(true)),
  new SlashCommandBuilder().setName("remove-item").setDescription("Remove item from shop (Staff)").addStringOption(o => o.setName("item").setDescription("Item to remove").setAutocomplete(true).setRequired(true)),
  new SlashCommandBuilder().setName("post-info").setDescription("Deploy Registration Interface").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("post-support").setDescription("Deploy Support Terminal").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("post-recruitment").setDescription("Deploy Recruitment Terminal").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("post-alpha-terminal").setDescription("Deploy Alpha Terminal").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
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
  new SlashCommandBuilder().setName("register").setDescription("Register a new tribe"),
  new SlashCommandBuilder().setName("join").setDescription("Join an existing tribe").addStringOption(o => o.setName("tribe_name").setDescription("Tribe Name").setAutocomplete(true).setRequired(true)),
];

// 2. Client Setup
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages] });

client.once(Events.ClientReady, async (c) => {
  console.log("Overseer Elite Online: " + c.user.tag);
  await refreshOverseerStatus(c);
});

// Economy Loop
client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot || !msg.guildId || coinCooldown.has(msg.author.id)) return;
    try {
        await db.update(tribeRegistrationsTable).set({ tekCoins: sql`${tribeRegistrationsTable.tekCoins} + 1` }).where(and(eq(tribeRegistrationsTable.discordUserId, msg.author.id), eq(tribeRegistrationsTable.guildId, msg.guildId)));
        coinCooldown.add(msg.author.id);
        setTimeout(() => coinCooldown.delete(msg.author.id), 120000);
    } catch (e) {}
});

// 3. Interaction Listener
client.on(Events.InteractionCreate, async (i: Interaction) => {
  try {
    if (i.isAutocomplete()) {
        const focused = i.options.getFocused(true);
        if (i.commandName === "join") {
            const tribes = await db.select({ name: tribeRegistrationsTable.tribeName }).from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.guildId, i.guildId!), eq(tribeRegistrationsTable.status, 'verified')));
            const filtered = [...new Set(tribes.map(t => t.name))].filter(n => n.toLowerCase().includes(focused.value.toLowerCase())).slice(0, 25);
            return i.respond(filtered.map(n => ({ name: n, value: n })));
        }
        if (i.commandName === "add-item" && focused.name === "name") {
            const filtered = ARK_ASSETS.filter(a => a.toLowerCase().includes(focused.value.toLowerCase())).slice(0, 25);
            return i.respond(filtered.map(a => ({ name: a, value: a })));
        }
        if (i.commandName === "buy" || i.commandName === "remove-item") {
            const items = await db.select().from(shopItemsTable).where(eq(shopItemsTable.guildId, i.guildId!));
            const filtered = items.filter(it => it.itemName.toLowerCase().includes(focused.value.toLowerCase())).slice(0, 25);
            return i.respond(filtered.map(it => ({ name: `${it.itemName} (${it.price} coins)`, value: it.itemName })));
        }
    }

    if (i.isButton()) {
        if (["btn_start_register", "btn_start_join", "btn_lft_start", "btn_alpha_claim", "add_task"].includes(i.customId)) {
            const modalId = i.customId === "btn_start_register" ? "modal_reg" : i.customId === "btn_start_join" ? "modal_join" : i.customId === "btn_alpha_claim" ? "modal_alpha" : i.customId === "add_task" ? "modal_task" : "modal_lft";
            const m = new ModalBuilder().setCustomId(modalId).setTitle("Overseer Terminal");
            if (modalId === "modal_lft") {
                m.addComponents(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("style").setLabel("Playstyle").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("hours").setLabel("Hours").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("desc").setLabel("Skills").setStyle(TextInputStyle.Paragraph).setRequired(true)));
            } else if (modalId === "modal_alpha") {
                m.addComponents(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe").setLabel("Tribe").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("coords").setLabel("Coords").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("members").setLabel("Members").setStyle(TextInputStyle.Short).setRequired(true)));
            } else if (modalId === "modal_task") {
                m.addComponents(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("content").setLabel("Details").setStyle(TextInputStyle.Paragraph).setRequired(true)));
            } else {
                m.addComponents(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe").setLabel("Tribe Name").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("ign").setLabel("IGN").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("xbox").setLabel("Xbox Gamertag").setStyle(TextInputStyle.Short).setRequired(true)));
            }
            return i.showModal(m);
        }

        await i.deferReply({ ephemeral: true }).catch(() => null);

        if (i.customId.startsWith("gate_accept:") || i.customId.startsWith("gate_deny:")) {
            if (!(await isOverseerStaff(i))) return i.editReply("❌ Staff only.");
            const [action, tId] = i.customId.split(":");
            if (action === "gate_accept") {
                const [p] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, tId), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
                if (!p) return i.editReply("Error.");
                await db.update(tribeRegistrationsTable).set({ status: 'verified' }).where(eq(tribeRegistrationsTable.id, p.id));
                const [cfg] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, i.guildId!)).limit(1);
                const chan = await i.guild?.channels.create({ name: p.tribeName.toLowerCase().replace(/\s+/g, '-'), type: ChannelType.GuildText, parent: cfg?.tribeCategoryId || undefined, permissionOverwrites: [{ id: i.guild!.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }, { id: tId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }, { id: client.user!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }] });
                if (chan) await (chan as any).send(getTribeDashboard(p.tribeName));
                const mem = await i.guild?.members.fetch(tId).catch(() => null);
                if (mem?.manageable) await mem.setNickname("[" + p.tribeName + "] " + p.ign);
                await i.editReply("✅ Verified.");
            } else {
                await db.delete(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, tId), eq(tribeRegistrationsTable.guildId, i.guildId!)));
                await i.editReply("❌ Denied.");
            }
            return;
        }

        if (i.customId === "btn_open_ticket") {
            const t = await (i.channel as any).threads.create({ name: "ticket-" + i.user.username, type: ChannelType.PrivateThread, autoArchiveDuration: ThreadAutoArchiveDuration.OneDay });
            await t.members.add(i.user.id);
            await t.send("**SOS Received.** <@" + i.user.id + ">, staff alerted.");
            return i.editReply("✅ Ticket: <#" + t.id + ">");
        }
    }

    if (i.isChatInputCommand()) {
        // ONLY Defer if NOT a Post Command
        if (!["post-info", "post-support", "post-alpha-terminal", "post-recruitment", "register", "lft", "join"].includes(i.commandName)) {
            await i.deferReply({ ephemeral: true }).catch(() => null);
        }

        const isStaff = await isOverseerStaff(i);

        if (i.commandName === "register" || i.commandName === "join") {
            const join = i.commandName === "join";
            const m = new ModalBuilder().setCustomId(join ? "modal_join" : "modal_reg").setTitle("Overseer Terminal");
            m.addComponents(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe").setLabel(join ? "Exact Tribe Name" : "New Tribe Name").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("ign").setLabel("Your IGN").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("xbox").setLabel("Xbox Gamertag").setStyle(TextInputStyle.Short).setRequired(true)));
            return i.showModal(m);
        }
      // --- ECONOMY: CHECK BALANCE (SURVIVOR) ---
    if (i.commandName === "bal") {
        const [userData] = await db.select().from(tribeRegistrationsTable).where(and(
            eq(tribeRegistrationsTable.discordUserId, i.user.id), 
            eq(tribeRegistrationsTable.guildId, i.guildId!)
        )).limit(1);

        const balance = userData?.tekCoins || 0;
        
        const embed = new EmbedBuilder()
            .setTitle("💰 OVERSEER | BANK SIGNATURE")
            .setColor(OVERSEER_COLOR)
            .setDescription("Identity verified. Accessing encrypted coin storage...")
            .addFields({ name: "Current Balance", value: `**${balance}** Tek Coins`, inline: true })
            .setFooter({ text: "Protocol: Financial Security" });

        return i.editReply({ embeds: [embed] });
    }
        // --- TEK-MARKET: ADD ITEM (STAFF) ---
    if (i.commandName === "add-item") {
        if (!(await isOverseerStaff(i))) return i.editReply({ content: "❌ Staff clearance required." });
        
        const name = i.options.getString("name", true);
        const price = i.options.getInteger("price", true);
        const cat = i.options.getString("category", true);

        await db.insert(shopItemsTable).values({ 
            guildId: i.guildId!, 
            itemName: name, 
            price: price, 
            category: cat 
        });
        return i.editReply({ content: `✅ Added **${name}** to the Tek-Market for **${price}** Tek Coins.` });
    }

    // --- TEK-MARKET: REMOVE ITEM (STAFF) ---
    if (i.commandName === "remove-item") {
        if (!(await isOverseerStaff(i))) return i.editReply({ content: "❌ Staff clearance required." });
        
        const itemName = i.options.getString("item", true);
        await db.delete(shopItemsTable).where(and(
            eq(shopItemsTable.itemName, itemName), 
            eq(shopItemsTable.guildId, i.guildId!)
        ));
        return i.editReply({ content: `✅ Successfully purged **${itemName}** from the market database.` });
    }

    // --- TEK-MARKET: BROWSE SHOP (SURVIVOR) ---
    if (i.commandName === "shop") {
        const items = await db.select().from(shopItemsTable).where(eq(shopItemsTable.guildId, i.guildId!));
        
        if (items.length === 0) {
            return i.editReply({ content: "The Tek-Market is currently empty. Staff must populate it using `/add-item`." });
        }

        const embed = new EmbedBuilder()
            .setTitle("🛒 OVERSEER | TEK-MARKET")
            .setColor(OVERSEER_COLOR)
            .setDescription("Use `/buy [item]` to acquire assets. Staff will be alerted for delivery.")
            .setThumbnail(client.user?.displayAvatarURL() || null);

        const dinos = items.filter(it => it.category === 'dino');
        const tools = items.filter(it => it.category === 'item');

        if (dinos.length > 0) embed.addFields({ name: "🦖 CREATURES", value: dinos.map(d => `• **${d.itemName}**: ${d.price} Coins`).join("\n") });
        if (tools.length > 0) embed.addFields({ name: "📦 KITS & ITEMS", value: tools.map(t => `• **${t.itemName}**: ${t.price} Coins`).join("\n") });

if (i.isChatInputCommand()) {
    // 1. Master Deferral Protocol (Prevents "did not respond" crashes)
    const dbCommands = [
        "bal", "shop", "buy", "list-tribes", 
        "setup", "kick-member", "bounty", 
        "my-tribe", "add-item", "remove-item"
    ];

    if (dbCommands.includes(i.commandName)) {
        await i.deferReply({ ephemeral: true });
    }

    // --- ECONOMY: CHECK BALANCE ---
    if (i.commandName === "bal") {
        const [userData] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
        const balance = userData?.tekCoins || 0;
        const e = new EmbedBuilder()
            .setTitle("💰 OVERSEER | BANK SIGNATURE")
            .setColor(OVERSEER_COLOR)
            .setDescription("Accessing encrypted coin storage...")
            .addFields({ name: "Current Balance", value: "**" + balance + "** Tek Coins", inline: true });
        return i.editReply({ embeds: [e] });
    }

    // --- ECONOMY: PLACE BOUNTY ---
    if (i.commandName === "bounty") {
        const target = i.options.getString("tribe", true);
        const amount = i.options.getInteger("amount", true);
        const [u] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
        
        if (!u || u.tekCoins < amount) return i.editReply({ content: "❌ Insufficient Tek Coins for this bounty." });
        
        await db.update(tribeRegistrationsTable).set({ tekCoins: u.tekCoins - amount }).where(eq(tribeRegistrationsTable.id, u.id));
        await db.insert(bountiesTable).values({ guildId: i.guildId!, targetTribe: target, reward: amount, placedBy: i.user.id });

        const e = new EmbedBuilder().setTitle("🚨 BOUNTY INITIALIZED").setDescription("A reward of **" + amount + "** has been placed on tribe **" + target + "**!").setColor(Colors.Red);
        return i.editReply({ embeds: [e] });
    }

    // --- MARKET: VIEW SHOP ---
    if (i.commandName === "shop") {
        const items = await db.select().from(shopItemsTable).where(eq(shopItemsTable.guildId, i.guildId!));
        if (items.length === 0) return i.editReply({ content: "The Tek-Market is currently empty." });

        const e = new EmbedBuilder().setTitle("🛒 OVERSEER | TEK-MARKET").setColor(OVERSEER_COLOR).setDescription("Use `/buy` to acquire assets.");
        const dinos = items.filter(it => it.category === 'dino');
        const tools = items.filter(it => it.category === 'item');
        if (dinos.length > 0) e.addFields({ name: "🦖 CREATURES", value: dinos.map(d => "• **" + d.itemName + "**: " + d.price).join("\n") });
        if (tools.length > 0) e.addFields({ name: "📦 ITEMS", value: tools.map(t => "• **" + t.itemName + "**: " + t.price).join("\n") });
        return i.editReply({ embeds: [e] });
    }

    // --- MARKET: BUY ITEM ---
    if (i.commandName === "buy") {
        const name = i.options.getString("item", true);
        const [u] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!)));
        const [it] = await db.select().from(shopItemsTable).where(and(eq(shopItemsTable.itemName, name), eq(shopItemsTable.guildId, i.guildId!))).limit(1);

        if (!it) return i.editReply("❌ Item not found.");
        if (!u || u.tekCoins < it.price) return i.editReply("❌ Insufficient coins.");

        await db.update(tribeRegistrationsTable).set({ tekCoins: u.tekCoins - it.price }).where(eq(tribeRegistrationsTable.id, u.id));
        await postToStaffLog(i.guildId!, new EmbedBuilder().setTitle("💰 PURCHASE").setDescription("<@" + i.user.id + "> bought **" + name + "**.").setColor(Colors.Green));
        return i.editReply("✅ Purchase successful. Staff notified for delivery.");
    }

    // --- MARKET: ADD ITEM (STAFF) ---
    if (i.commandName === "add-item") {
        if (!(await isOverseerStaff(i))) return i.editReply("❌ Staff clearance required.");
        await db.insert(shopItemsTable).values({ guildId: i.guildId!, itemName: i.options.getString("name", true), price: i.options.getInteger("price", true), category: i.options.getString("category", true) });
        return i.editReply("✅ Item added to Tek-Market.");
    }

    // --- MARKET: REMOVE ITEM (STAFF) ---
    if (i.commandName === "remove-item") {
        if (!(await isOverseerStaff(i))) return i.editReply("❌ Staff clearance required.");
        await db.delete(shopItemsTable).where(and(eq(shopItemsTable.itemName, i.options.getString("item", true)), eq(shopItemsTable.guildId, i.guildId!)));
        return i.editReply("✅ Item removed from Tek-Market.");
    }

    // --- STAFF: LIST TRIBES ---
    if (i.commandName === "list-tribes") {
        if (!(await isOverseerStaff(i))) return i.editReply("❌ Staff clearance required.");
        const regs = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.guildId, i.guildId!)).orderBy(tribeRegistrationsTable.tribeName);
        if (regs.length === 0) return i.editReply("Database empty.");
        const e = new EmbedBuilder().setTitle("🌐 SERVER DATABASE").setColor(OVERSEER_COLOR);
        regs.slice(0, 25).forEach(r => e.addFields({ name: "[" + r.tribeName + "] " + r.ign, value: "Status: " + r.status + " | Xbox: " + r.xboxGamertag, inline: false }));
        return i.editReply({ embeds: [e] });
    }

    // --- STAFF: KICK MEMBER ---
    if (i.commandName === "kick-member") {
        if (!(await isOverseerStaff(i))) return i.editReply("❌ Staff clearance required.");
        const target = i.options.getUser("target", true);
        const [r] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, target.id), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
        if (!r) return i.editReply("Survivor not found.");
        await db.delete(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, target.id), eq(tribeRegistrationsTable.guildId, i.guildId!)));
        if (r.channelId) {
            const chan: any = await i.guild?.channels.fetch(r.channelId).catch(() => null);
            if (chan) await chan.permissionOverwrites.delete(target.id).catch(() => null);
        }
        return i.editReply("✅ Survivor signature purged.");
    }

    // --- ADMIN: SETUP ---
    if (i.commandName === "setup") {
        const o = i.options;
        await db.insert(guildConfigTable).values({ 
            guildId: i.guildId!, adminRoleIds: o.getRole("role")!.id, staffLogChannelId: o.getChannel("logs")!.id, welcomeChannelId: o.getChannel("welcome")!.id, rulesChannelId: o.getChannel("rules")!.id, infoChannelId: o.getChannel("info")!.id, recruitmentChannelId: o.getChannel("recruitment")!.id, supportChannelId: o.getChannel("support")!.id, tribeCategoryId: o.getChannel("category")!.id 
        }).onConflictDoUpdate({ target: guildConfigTable.guildId, set: { adminRoleIds: o.getRole("role")!.id, staffLogChannelId: o.getChannel("logs")!.id, welcomeChannelId: o.getChannel("welcome")!.id, rulesChannelId: o.getChannel("rules")!.id, infoChannelId: o.getChannel("info")!.id, recruitmentChannelId: o.getChannel("recruitment")!.id, supportChannelId: o.getChannel("support")!.id, tribeCategoryId: o.getChannel("category")!.id } });
        return i.editReply("✅ Overseer Protocol Configured.");
    }

    // --- SURVIVOR: MY PROFILE ---
    if (i.commandName === "my-tribe") {
        const [reg] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
        if (!reg) return i.editReply("No record found.");
        const e = new EmbedBuilder().setTitle("👤 " + reg.ign).addFields({ name: "Tribe", value: reg.tribeName }, { name: "Xbox", value: reg.xboxGamertag }).setColor(OVERSEER_COLOR);
        return i.editReply({ embeds: [e] });
    }

    // --- SYSTEM: HELP & POST TERMINALS ---
    if (i.commandName === "help") {
        const e = new EmbedBuilder().setTitle("🔵 OVERSEER | Documentation").setColor(OVERSEER_COLOR).addFields({ name: "Survivor", value: "`/register`, `/join`, `/my-tribe`, `/lft`, `/bal`, `/shop`" }, { name: "Staff", value: "`/setup`, `/post-info`, `/post-support`, `/add-item`, `/list-tribes`" });
        return i.reply({ embeds: [e], ephemeral: true });
    }

    if (["post-info", "post-support", "post-alpha-terminal", "post-recruitment"].includes(i.commandName)) {
        const e = new EmbedBuilder().setColor(OVERSEER_COLOR);
        let row = new ActionRowBuilder<ButtonBuilder>();
        if (i.commandName === "post-info") {
            e.setTitle("🛡️ REGISTRATION").setDescription("Initialize signature below.");
            row.addComponents(new ButtonBuilder().setCustomId("btn_start_register").setLabel("Create Tribe").setStyle(ButtonStyle.Success).setEmoji("📝"), new ButtonBuilder().setCustomId("btn_start_join").setLabel("Join Tribe").setStyle(ButtonStyle.Primary).setEmoji("🤝"));
        } else if (i.commandName === "post-support") {
            e.setTitle("🆘 SUPPORT").setDescription("Click below for SOS transmission.");
            row.addComponents(new ButtonBuilder().setCustomId("btn_open_ticket").setLabel("Contact Support").setStyle(ButtonStyle.Danger).setEmoji("🆘"));
        } else if (i.commandName === "post-alpha-terminal") {
            e.setTitle("👑 ALPHA CLAIM").setDescription("Submit dominance claim.").setColor(Colors.Gold);
            row.addComponents(new ButtonBuilder().setCustomId("btn_alpha_claim").setLabel("Claim Alpha").setStyle(ButtonStyle.Secondary).setEmoji("👑"));
        } else {
            e.setTitle("📡 RECRUITMENT").setDescription("Looking for a tribe?").setEmoji("📝");
            row.addComponents(new ButtonBuilder().setCustomId("btn_lft_start").setLabel("Post LFT Profile").setStyle(ButtonStyle.Primary));
        }
        await (i.channel as any).send({ embeds: [e], components: [row] });
        return i.reply({ content: "Interface Deployed.", ephemeral: true });
    }
  }

    if (i.isModalSubmit()) {
        await i.deferReply({ ephemeral: true }).catch(() => null);
        if (i.customId === "modal_reg" || i.customId === "modal_join") {
            try {
                await db.insert(tribeRegistrationsTable).values({ guildId: i.guildId!, tribeName: i.fields.getTextInputValue("tribe").trim(), ign: i.fields.getTextInputValue("ign").trim(), xboxGamertag: i.fields.getTextInputValue("xbox").trim(), discordUserId: i.user.id, discordUsername: i.user.username, status: "pending" });
                const e = new EmbedBuilder().setTitle("🛡️ PENDING").setDescription("<@" + i.user.id + "> -> **" + i.fields.getTextInputValue("tribe") + "**.");
                const r = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("gate_accept:" + i.user.id).setLabel("Approve").setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId("gate_deny:" + i.user.id).setLabel("Deny").setStyle(ButtonStyle.Danger));
                await postToStaffLog(i.guildId!, e, [r]);
                await i.editReply("✅ Pending approval.");
            } catch (e) { await i.editReply("❌ Error."); }
        }
    }
  } catch (err) { console.error(err); }
});

http.createServer((_, res) => { res.writeHead(200); res.end("OK"); }).listen(process.env.PORT || 3000);
async function start() {
    try {
        const rest = new REST({ version: "10" }).setToken(token!);
        await rest.put(Routes.applicationCommands(applicationId!), { body: commands.map(c => c.toJSON()) });
        await client.login(token);
    } catch (e) { console.error(e); }
}
start();
