import { database } from "@sage/database";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await database().$queryRaw`SELECT 1`;
    return Response.json({ status: "ok", service: "web", database: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ status: "unavailable", service: "web" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
