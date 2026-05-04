import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// Use the connection string from your .env file
const connectionString = process.env.DATABASE_URL!;

// Disable prefetch as it causes issues with some cloud providers
const client = postgres(connectionString, { prepare: false });

export const db = drizzle(client, { schema });

// Export all schema/tables
export * from "./schema";
