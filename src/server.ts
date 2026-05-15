import http from "http";
import { Client, EmbedBuilder, Colors } from "discord.js";
import { db, tribeRegistrationsTable, guildConfigTable } from "./db";
import { eq } from "drizzle-orm";

export function startServer(client: Client) {
  const server = http.createServer(async (req, res) => {
    // 1. Pinger Protocol (Keep-Alive)
    if (req.method === "GET" || req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("Sentinel Online");
    }

    // 2. Broadcast Protocol (Web -> Discord)
    if (req.method === "POST" && req.url === "/broadcast") {
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const data = JSON.parse(body);

          // Security Verification
          if (data.key !== process.env.BROADCAST_KEY) {
            res.writeHead(403);
            return res.end("Unauthorized: Invalid Key");
          }

          const { message, guildId } = data;

          // A. Fetch Tribe Channels for this server
          const tribes = await db.select().from(tribeRegistrationsTable).where(eq(tribeRegistrationsTable.guildId, guildId));
          const channels = [...new Set(tribes.map(t => t.channelId).filter(Boolean))];

          // B. Fetch News Channel from Config
          const [config] = await db.select().from(guildConfigTable).where(eq(guildConfigTable.guildId, guildId)).limit(1);

          const alertEmbed = new EmbedBuilder()
            .setTitle("📡 ARKSENTINEL | GLOBAL BROADCAST")
            .setColor(0xff0000) // Priority Red
            .setThumbnail(client.user?.displayAvatarURL() || null)
            .setDescription(message)
            .setFooter({ text: "Priority Transmission | Authorized by Admin" })
            .setTimestamp();

          // C. Execute Blasting Protocol
          
          // Blast to every Tribe HQ
          for (const chanId of channels) {
            const chan = await client.channels.fetch(chanId as string).catch(() => null) as any;
            if (chan && typeof chan.send === 'function') await chan.send({ embeds: [alertEmbed] });
          }

          // Blast to News Channel 
          // FIX: Changed newsChannelId to infoChannelId to match your DB schema!
          if (config?.infoChannelId) {
            const newsChan = await client.channels.fetch(config.infoChannelId).catch(() => null) as any;
            if (newsChan && typeof newsChan.send === 'function') {
                await newsChan.send({ content: "@everyone", embeds: [alertEmbed] });
            }
          }

          res.writeHead(200);
          res.end("Broadcast Complete");
        } catch (e) {
          console.error("Broadcast Error:", e);
          res.writeHead(500);
          res.end("Internal System Error");
        }
      });
    }
  });

  // FIX: Updated base port to 10000
  const PORT = process.env.PORT || 10000;
  server.listen(PORT, () => {
    console.log(`Sentinel Uplink established on port ${PORT}`);
  });
}
