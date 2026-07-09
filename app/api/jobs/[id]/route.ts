/**
 * GET /api/jobs/:id — the JobRecord, sans evidence (the bundle has its own
 * route: /api/jobs/:id/evidence). 404 for unknown ids — including jobs
 * created on another serverless instance; see the MemoryJobStore caveat.
 */

import { checkAuth, jobStore } from "@/lib/kerf-api";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = checkAuth(req);
  if (denied) return denied;

  const { id } = await ctx.params;
  const rec = await jobStore.get(id);
  if (!rec) {
    return Response.json({ error: `unknown job "${id}"` }, { status: 404 });
  }
  const { evidence: _evidence, ...sansEvidence } = rec;
  return Response.json(sansEvidence);
}
