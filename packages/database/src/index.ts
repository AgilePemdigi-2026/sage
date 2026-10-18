import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client.ts";

const state = globalThis as typeof globalThis & { sageDatabase?: PrismaClient };

export function database(): PrismaClient {
  if (!state.sageDatabase) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL wajib diisi.");
    const adapter = new PrismaPg({ connectionString, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
    state.sageDatabase = new PrismaClient({ adapter });
  }
  return state.sageDatabase;
}

export async function disconnectDatabase() {
  await state.sageDatabase?.$disconnect();
  delete state.sageDatabase;
}
