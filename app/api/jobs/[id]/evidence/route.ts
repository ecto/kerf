/**
 * GET /api/jobs/:id/evidence — the job's hash-manifested EvidenceBundle
 * (items are manifests: id, sha256, size — Wave 0 has no artifact store
 * for the payloads). 404 when the job is unknown or has no bundle yet.
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
  if (!rec || !rec.evidence) {
    return Response.json(
      { error: `no evidence for job "${id}"` },
      { status: 404 },
    );
  }
  return Response.json(rec.evidence);
}
