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

// --- Memory Systems ---
const coinCooldown = new Set();
const ARK_ASSETS = [
    "Rex (High Level)", "Giganotosaurus", "Carcharodontosaurus", "Wyvern (Lightning)", 
    "Wyvern (Fire)", "Griffin", "Quetzal", "Therizinosaurus", "Rhyniognatha", 
    "Tek Turret Kit", "Heavy Turret Kit", "Ascendant Sniper Kit", "Element (100x)", 
    "Metal Base Kit", "Vault Kit", "Industrial Forge", "Kibble (Extraordinary)"
];

if (!token || !applicationId) process.exit(1);

// --- Helpers ---
async function refreshOverseerStatus(client: Client) {
    try {
        const tribes = await db.select({ name: tribeRegistrationsTable.tribeName }).from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.status, 'verified'));
        const count = new Set(tribes.map(t => t.name)).size;
        client.user?.setActivity(`over ${count} Tribes`, { type: ActivityType.Watching });
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

// 1. Master Command List
const commands = [
  new SlashCommandBuilder().setName("help").setDescription("View the full Overseer manual"),
  new SlashCommandBuilder().setName("register").setDescription("Initialize a new tribe signature"),
  new SlashCommandBuilder().setName("lft").setDescription("Post a recruitment profile"),
  new SlashCommandBuilder().setName("my-tribe").setDescription("View your survivor profile"),
  new SlashCommandBuilder().setName("leave-tribe").setDescription("Exit current tribe"),
  new SlashCommandBuilder().setName("list-tribes").setDescription("View server tribe database"),
  new SlashCommandBuilder().setName("bal").setDescription("Check your current Tek Coin balance"),
  new SlashCommandBuilder().setName("shop").setDescription("Browse the server Tek-Market"),
  new SlashCommandBuilder().setName("buy").setDescription("Purchase an item").addStringOption(o => o.setName("item").setDescription("Item name").setAutocomplete(true).setRequired(true)),
  new SlashCommandBuilder().setName("bounty").setDescription("Place a bounty on a tribe").addStringOption(o => o.setName("tribe").setDescription("Target Tribe").setRequired(true)).addIntegerOption(o => o.setName("amount").setDescription("Coin Amount").setRequired(true)),
  new SlashCommandBuilder().setName("add-item").setDescription("Add item to shop (Staff)").addStringOption(o => o.setName("name").setDescription("Name").setAutocomplete(true).setRequired(true)).addIntegerOption(o => o.setName("price").setDescription("Price").setRequired(true)).addStringOption(o => o.setName("category").setDescription("Category").addChoices({name:'Dino', value:'dino'}, {name:'Item', value:'item'}).setRequired(true)),
  new SlashCommandBuilder().setName("remove-item").setDescription("Remove item from shop (Staff)").addStringOption(o => o.setName("item").setDescription("Item to remove").setAutocomplete(true).setRequired(true)),
  new SlashCommandBuilder().setName("kick-member").setDescription("Remove a survivor (Staff)").addUserOption(o => o.setName("target").setDescription("User to kick").setRequired(true)),
  new SlashCommandBuilder().setName("post-info").setDescription("Deploy Registration Interface").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("post-support").setDescription("Deploy Support Terminal").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("post-alpha-terminal").setDescription("Deploy Alpha Terminal").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("post-recruitment").setDescription("Deploy Recruitment Terminal").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
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
  new SlashCommandBuilder().setName("join").setDescription("Sync with existing tribe").addStringOption(o => o.setName("tribe_name").setDescription("Search Tribe").setAutocomplete(true).setRequired(true)),
];

// 2. Client Setup
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages] });

client.once(Events.ClientReady, async (c) => {
  console.log(`Overseer V1.5 Online: ${c.user.tag}`);
  await refreshOverseerStatus(c);
});

// Passive Income
client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot || !msg.guildId || coinCooldown.has(msg.author.id)) return;
    try {
        await db.update(tribeRegistrationsTable).set({ tekCoins: sql`${tribeRegistrationsTable.tekCoins} + 1` }).where(and(eq(tribeRegistrationsTable.discordUserId, msg.author.id), eq(tribeRegistrationsTable.guildId, msg.guildId)));
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
                const embed = new EmbedBuilder().setTitle("🔵 NEW SURVIVOR DETECTED").setThumbnail(member.user.displayAvatarURL()).setColor(OVERSEER_COLOR).setDescription(`Welcome Survivor <@${member.id}>. Protocols initialized.`)
                    .addFields({ name: "📜 DIRECTIVES", value: `<#${config.rulesChannelId}> | <#${config.infoChannelId}>` }, { name: "🦖 INTEGRATION", value: "Register at the registration channel." });
                await welcomeChan.send({ content: `Welcome Survivor, <@${member.id}>`, embeds: [embed] });
            }
        }
        const dmEmbed = new EmbedBuilder().setTitle("💠 OVERSEER PROTOCOLS").setColor(OVERSEER_COLOR).setDescription("Greeting Survivor. Use `/help` for command list.");
        await member.send({ embeds: [dmEmbed] }).catch(() => null);
    } catch (e) {}
});

// 3. Main Interaction Listener
client.on(Events.InteractionCreate, async (i: Interaction) => {
  try {
    // --- Autocomplete ---
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

    // --- Buttons ---
    if (i.isButton()) {
        const [reg] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
        
        if (i.customId.startsWith("gate_accept:") || i.customId.startsWith("gate_deny:")) {
            if (!(await isOverseerStaff(i))) return i.reply({ content: "❌ Staff only.", ephemeral: true });
            const [action, tId] = i.customId.split(":");
            await i.deferReply({ ephemeral: true });
            if (action === "gate_accept") {
                const [p] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, tId), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
                if (!p) return i.editReply("Record Error.");
                await db.update(tribeRegistrationsTable).set({ status: 'verified' }).where(eq(tribeRegistrationsTable.id, p.id));
                const [cfg] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, i.guildId!)).limit(1);
                const chan = await i.guild?.channels.create({ name: p.tribeName.toLowerCase().replace(/\s+/g, '-'), type: ChannelType.GuildText, parent: cfg?.tribeCategoryId || undefined, permissionOverwrites: [{ id: i.guild!.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }, { id: tId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }, { id: client.user!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }] });
                if (chan) await (chan as any).send(getTribeDashboard(p.tribeName));
                const mem = await i.guild?.members.fetch(tId).catch(() => null);
                if (mem?.manageable) await mem.setNickname(`[${p.tribeName}] ${p.ign}`);
                await i.editReply("✅ Verified.");
                await refreshOverseerStatus(client);
            } else {
                await db.delete(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, tId), eq(tribeRegistrationsTable.guildId, i.guildId!)));
                await i.editReply("❌ Signature Denied.");
            }
            return;
        }

        if (i.customId === "btn_open_ticket") {
            await i.deferReply({ ephemeral: true });
            const t = await (i.channel as any).threads.create({ name: `ticket-${i.user.username}`, type: ChannelType.PrivateThread, autoArchiveDuration: ThreadAutoArchiveDuration.OneDay });
            await t.members.add(i.user.id);
            await t.send(`**Transmission Received.** <@${i.user.id}>, staff alerted.`);
            return i.editReply(`✅ Ticket: <#${t.id}>`);
        }

        if (["btn_start_register", "btn_start_join", "btn_lft_start", "btn_alpha_claim"].includes(i.customId)) {
            const id = i.customId === "btn_start_register" ? "modal_reg" : i.customId === "btn_start_join" ? "modal_join" : i.customId === "btn_alpha_claim" ? "modal_alpha" : "modal_lft";
            const m = new ModalBuilder().setCustomId(id).setTitle("Overseer Terminal");
            if (id === "modal_lft") {
                m.addComponents(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("style").setLabel("Playstyle").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("hours").setLabel("Hours").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("desc").setLabel("Skills").setStyle(TextInputStyle.Paragraph).setRequired(true)));
            } else if (id === "modal_alpha") {
                m.addComponents(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe").setLabel("Tribe").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("coords").setLabel("Coords").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("members").setLabel("Members").setStyle(TextInputStyle.Short).setRequired(true)));
            } else {
                m.addComponents(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("tribe").setLabel("Tribe Name").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("ign").setLabel("IGN").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("xbox").setLabel("Xbox Gamertag").setStyle(TextInputStyle.Short).setRequired(true)));
            }
            return i.showModal(m);
        }

        if (reg && reg.status === 'verified') {
            if (i.customId === "raid_alert") return i.reply({ content: `🚨 **RAID ALERT!** <@${i.user.id}> reports attack! @everyone`, allowedMentions: { parse: ['everyone'] } });
            if (i.customId === "claim_kit") {
                if (reg.hasClaimedKit) return i.reply({ content: "❌ Already claimed.", ephemeral: true });
                await postToStaffLog(i.guildId!, new EmbedBuilder().setTitle("🎁 Kit Request").setDescription(`<@${i.user.id}> requested kit for **${reg.tribeName}**.`).setColor(Colors.Green));
                await db.update(tribeRegistrationsTable).set({ hasClaimedKit: true }).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!)));
                return i.reply({ content: "✅ Requested!", ephemeral: true });
            }
            if (i.customId === "view_roster") {
                const mems = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.tribeName, reg.tribeName), eq(tribeRegistrationsTable.guildId, i.guildId!), eq(tribeRegistrationsTable.status, 'verified')));
                return i.reply({ content: `📜 **Roster:**\n` + mems.map(m => `• ${m.ign}`).join("\n"), ephemeral: true });
            }
            if (i.customId === "add_task") {
                const m = new ModalBuilder().setCustomId("modal_task").setTitle("Add Task");
                m.addComponents(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(new TextInputBuilder().setCustomId("content").setLabel("Details").setStyle(TextInputStyle.Paragraph).setRequired(true)));
                return i.showModal(m);
            }
        }
    }

    // --- Commands ---
    if (i.isChatInputCommand()) {
        const dbCmds = ["bal", "shop", "buy", "list-tribes", "setup", "kick-member", "bounty", "my-tribe", "add-item", "remove-item"];
        if (dbCmds.includes(i.commandName)) await i.deferReply({ ephemeral: true });

        if (i.commandName === "bal") {
            const [u] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!)));
            return i.editReply({ content: "💰 **Bank Balance:** " + (u?.tekCoins || 0) + " Tek Coins." });
        }
        if (i.commandName === "shop") {
            const its = await db.select().from(shopItemsTable).where(eq(shopItemsTable.guildId, i.guildId!));
            if (its.length === 0) return i.editReply("Shop is empty.");
            const e = new EmbedBuilder().setTitle("🛒 MARKET").setColor(OVERSEER_COLOR).addFields({ name: "Items", value: its.map(x => `• **${x.itemName}**: ${x.price}`).join("\n") });
            return i.editReply({ embeds: [e] });
        }
        if (i.commandName === "buy") {
            const n = i.options.getString("item", true);
            const [u] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!)));
            const [it] = await db.select().from(shopItemsTable).where(and(eq(shopItemsTable.itemName, n), eq(shopItemsTable.guildId, i.guildId!))).limit(1);
            if (!it) return i.editReply("❌ Item not found.");
            if (!u || u.tekCoins < it.price) return i.editReply("❌ Not enough coins.");
            await db.update(tribeRegistrationsTable).set({ tekCoins: u.tekCoins - it.price }).where(eq(tribeRegistrationsTable.id, u.id));
            await postToStaffLog(i.guildId!, new EmbedBuilder().setTitle("💰 PURCHASE").setDescription(`<@${i.user.id}> bought **${n}** for ${it.price}`).setColor(Colors.Green));
            return i.editReply("✅ Success. Staff notified.");
        }
        if (i.commandName === "add-item") {
            if (!(await isOverseerStaff(i))) return i.editReply("❌ Staff only.");
            await db.insert(shopItemsTable).values({ guildId: i.guildId!, itemName: i.options.getString("name", true), price: i.options.getInteger("price", true), category: i.options.getString("category", true) });
            return i.editReply("✅ Added to shop.");
        }
        if (i.commandName === "remove-item") {
            if (!(await isOverseerStaff(i))) return i.editReply("❌ Staff only.");
            await db.delete(shopItemsTable).where(and(eq(shopItemsTable.itemName, i.options.getString("item", true)), eq(shopItemsTable.guildId, i.guildId!)));
            return i.editReply("✅ Removed.");
        }
        if (i.commandName === "list-tribes") {
            if (!(await isOverseerStaff(i))) return i.editReply("❌ Staff only.");
            const regs = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.guildId, i.guildId!)).orderBy(tribeRegistrationsTable.tribeName);
            const e = new EmbedBuilder().setTitle("🌐 DB").setColor(OVERSEER_COLOR);
            regs.slice(0, 25).forEach(r => e.addFields({ name: `[${r.tribeName}] ${r.ign}`, value: `Xbox: ${r.xboxGamertag} | Status: ${r.status}`, inline: false }));
            return i.editReply({ embeds: [e] });
        }
        if (i.commandName === "kick-member") {
            if (!(await isOverseerStaff(i))) return i.editReply("❌ Staff only.");
            const target = i.options.getUser("target", true);
            const [r] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, target.id), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
            if (!r) return i.editReply("Not found.");
            await db.delete(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, target.id), eq(tribeRegistrationsTable.guildId, i.guildId!)));
            return i.editReply(`✅ Purged <@${target.id}>.`);
        }
        if (i.commandName === "bounty") {
            const t = i.options.getString("tribe", true);
            const a = i.options.getInteger("amount", true);
            const [u] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
            if (!u || u.tekCoins < a) return i.editReply("❌ Not enough coins.");
            await db.update(tribeRegistrationsTable).set({ tekCoins: u.tekCoins - a }).where(eq(tribeRegistrationsTable.id, u.id));
            await db.insert(bountiesTable).values({ guildId: i.guildId!, targetTribe: t, reward: a, placedBy: i.user.id });
            return i.editReply({ embeds: [new EmbedBuilder().setTitle("🚨 BOUNTY").setDescription(`Reward of **${a}** on tribe **${t}**!`).setColor(Colors.Red)] });
        }
        if (i.commandName === "setup") {
            const o = i.options;
            await db.insert(guildConfigTable).values({ guildId: i.guildId!, adminRoleIds: o.getRole("role")!.id, staffLogChannelId: o.getChannel("logs")!.id, welcomeChannelId: o.getChannel("welcome")!.id, rulesChannelId: o.getChannel("rules")!.id, infoChannelId: o.getChannel("info")!.id, recruitmentChannelId: o.getChannel("recruitment")!.id, supportChannelId: o.getChannel("support")!.id, tribeCategoryId: o.getChannel("category")!.id }).onConflictDoUpdate({ target: guildConfigTable.guildId, set: { adminRoleIds: o.getRole("role")!.id, staffLogChannelId: o.getChannel("logs")!.id, welcomeChannelId: o.getChannel("welcome")!.id, rulesChannelId: o.getChannel("rules")!.id, infoChannelId: o.getChannel("info")!.id, recruitmentChannelId: o.getChannel("recruitment")!.id, supportChannelId: o.getChannel("support")!.id, tribeCategoryId: o.getChannel("category")!.id } });
            return i.editReply("✅ Configured.");
        }
        if (["post-info", "post-support", "post-alpha-terminal", "post-recruitment"].includes(i.commandName)) {
            const e = new EmbedBuilder().setColor(OVERSEER_COLOR);
            let row = new ActionRowBuilder<ButtonBuilder>();
            if (i.commandName === "post-info") { e.setTitle("🛡️ REG").setDescription("Initialize below."); row.addComponents(new ButtonBuilder().setCustomId("btn_start_register").setLabel("Create Tribe").setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId("btn_start_join").setLabel("Join Tribe").setStyle(ButtonStyle.Primary)); }
            else if (i.commandName === "post-support") { e.setTitle("🆘 SOS").setDescription("SOS link."); row.addComponents(new ButtonBuilder().setCustomId("btn_open_ticket").setLabel("Contact").setStyle(ButtonStyle.Danger)); }
            else if (i.commandName === "post-alpha-terminal") { e.setTitle("👑 ALPHA").setDescription("Claim status."); row.addComponents(new ButtonBuilder().setCustomId("btn_alpha_claim").setLabel("Claim").setStyle(ButtonStyle.Secondary)); }
            else { e.setTitle("📡 RECRUIT").setDescription("LFT link."); row.addComponents(new ButtonBuilder().setCustomId("btn_lft_start").setLabel("Post LFT").setStyle(ButtonStyle.Primary)); }
            await (i.channel as any).send({ embeds: [e], components: [row] });
            return i.reply({ content: "Deployed.", ephemeral: true });
        }
        if (i.commandName === "help") {
            const e = new EmbedBuilder().setTitle("🔵 MANUAL").addFields({name:'Commands', value:'/register, /join, /bal, /shop, /bounty'}).setColor(OVERSEER_COLOR);
            return i.reply({ embeds: [e], ephemeral: true });
        }
        if (i.commandName === "my-tribe") {
            const [reg] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
            if (!reg) return i.editReply("No record.");
            return i.editReply({ embeds: [new EmbedBuilder().setTitle(`👤 ${reg.ign}`).addFields({ name: "Tribe", value: reg.tribeName }, { name: "Xbox", value: reg.xboxGamertag }).setColor(OVERSEER_COLOR)] });
        }
    }

    // --- Modals ---
    if (i.isModalSubmit()) {
        if (i.customId === "modal_reg" || i.customId === "modal_join") {
            const tN = i.fields.getTextInputValue("tribe").trim();
            const xb = i.fields.getTextInputValue("xbox").trim();
            const ign = i.fields.getTextInputValue("ign").trim();
            await i.deferReply({ ephemeral: true });
            try {
                await db.insert(tribeRegistrationsTable).values({ guildId: i.guildId!, tribeName: tN, ign, xboxGamertag: xb, discordUserId: i.user.id, discordUsername: i.user.username, status: "pending", isOwner: (i.customId === 'modal_reg') });
                const e = new EmbedBuilder().setTitle("🛡️ PENDING").setDescription(`<@${i.user.id}> -> **${tN}**.`).setColor(Colors.Orange);
                const r = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`gate_accept:${i.user.id}`).setLabel("Approve").setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`gate_deny:${i.user.id}`).setLabel("Deny").setStyle(ButtonStyle.Danger));
                await postToStaffLog(i.guildId!, e, [r]);
                await i.editReply("✅ Pending approval.");
            } catch (e) { await i.editReply("❌ Already registered."); }
        }
        if (i.customId === "modal_alpha") {
            await db.insert(alphaClaimsTable).values({ guildId: i.guildId!, tribeName: i.fields.getTextInputValue("tribe"), discordUserId: i.user.id, coordinates: i.fields.getTextInputValue("coords"), memberCount: parseInt(i.fields.getTextInputValue("members")) || 0 });
            await postToStaffLog(i.guildId!, new EmbedBuilder().setTitle("👑 ALPHA CLAIM").setDescription(`<@${i.user.id}> claimed Alpha.`).setColor(OVERSEER_COLOR));
            await i.reply({ content: "✅ Submitted.", ephemeral: true });
        }
        if (i.customId === "modal_lft") {
            const [cfg] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, i.guildId!)).limit(1);
            if (cfg?.recruitmentChannelId) {
                const c: any = await client.channels.fetch(cfg.recruitmentChannelId);
                await db.insert(recruitmentTable).values({ guildId: i.guildId!, discordUserId: i.user.id, playstyle: i.fields.getTextInputValue("style"), hours: i.fields.getTextInputValue("hours"), description: i.fields.getTextInputValue("desc") });
                await c.send({ embeds: [new EmbedBuilder().setTitle("🔎 SURVIVOR LFT").addFields({ name: "Survivor", value: `<@${i.user.id}>` }, { name: "Hours", value: i.fields.getTextInputValue("hours") }).setColor(OVERSEER_COLOR)] });
                await i.reply({ content: "✅ Profile posted!", ephemeral: true });
            }
        }
        if (i.customId === "modal_task") {
            const [r] = await db.select().from(tribeRegistrationsTable).where(and(eq(tribeRegistrationsTable.discordUserId, i.user.id), eq(tribeRegistrationsTable.guildId, i.guildId!))).limit(1);
            if (r) {
                await db.insert(tribeTasksTable).values({ guildId: i.guildId!, tribeName: r.tribeName, taskContent: i.fields.getTextInputValue("content") });
                await (i.channel as any).send({ embeds: [new EmbedBuilder().setTitle("📋 NEW TASK").setDescription(i.fields.getTextInputValue("content")).setColor(Colors.Blue).setFooter({ text: `By ${r.ign}` })] });
                await i.reply({ content: "Task added!", ephemeral: true });
            }
        }
    }
  } catch (err) {
      console.error("GLOBAL INTERACTION ERROR:", err);
  }
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
