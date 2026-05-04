import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is missing! Make sure to add it to your environment variables.");
}

// Disable prefetch as it is not supported by some cloud providers like Supabase/Neon
const client = postgres(connectionString, { prepare: false });
export const db = drizzle(client, { schema });

// Export the tables so they can be imported elsewhere
export { tribeRegistrationsTable, guildConfigTable } from "./schema";