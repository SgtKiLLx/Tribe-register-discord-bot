import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

// This uses Neon's special HTTP driver which works perfectly on Render
const sql = neon(process.env.DATABASE_URL!);

export const db = drizzle(sql, { schema });

export * from "./schema";
