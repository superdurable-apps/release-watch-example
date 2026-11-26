import { FlowNotActiveOrNotFoundError, type Client } from "@superdurable/dex";

import { HttpError, type Route } from "./http.ts";
import type { ReleaseDigestFlow } from "./release-digest-flow.ts";
import { SCHEDULE_FLOW_ID, type ReleaseWatchScheduleFlow } from "./release-watch-schedule-flow.ts";

const DIGEST_ID = /^release-digest-\d{4}-\d{2}-\d{2}(-run-\d+)?$/;

/** The API of openapi/openapi.yaml: the schedule, one digest, and a manual run. */
export function releaseRoutes(client: Client, scheduleFlow: ReleaseWatchScheduleFlow, digestFlow: ReleaseDigestFlow): Route[] {
  return [
    {
      method: "GET",
      path: "/api/status",
      handle: async () => {
        const schedule = await client.invokeRPC(scheduleFlow.getScheduleStatus, SCHEDULE_FLOW_ID);
        const latest = schedule?.lastDigestId ? await readDigest(client, digestFlow, schedule.lastDigestId) : null;
        return { status: 200, body: { schedule, latest } };
      },
    },
    {
      method: "POST",
      path: "/api/digests",
      handle: async (request) => {
        const reason = typeof (request.body as { reason?: unknown } | undefined)?.reason === "string" ? (request.body as { reason: string }).reason.slice(0, 200) : "manual";
        await client.invokeRPC(scheduleFlow.requestDigestNow, SCHEDULE_FLOW_ID, reason);
        return { status: 202, body: { queued: true } };
      },
    },
    {
      method: "GET",
      path: "/api/digests/{digestId}",
      handle: async (request) => {
        const digestId = request.params.digestId!;
        if (!DIGEST_ID.test(digestId)) {
          throw new HttpError(400, "not a digest ID");
        }
        const digest = await readDigest(client, digestFlow, digestId);
        if (digest === null) {
          throw new HttpError(404, "no such digest");
        }
        return { status: 200, body: digest };
      },
    },
  ];
}

/** A digest's state and releases, also after its run ended; null when it never ran. */
async function readDigest(client: Client, digestFlow: ReleaseDigestFlow, digestId: string) {
  try {
    return await client.invokeRPC(digestFlow.getDigestStatus, digestId);
  } catch (error) {
    if (error instanceof FlowNotActiveOrNotFoundError) {
      return null;
    }
    throw error;
  }
}
