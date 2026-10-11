import { Pool } from "pg";

let pool;

export function database() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is required.");
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}
