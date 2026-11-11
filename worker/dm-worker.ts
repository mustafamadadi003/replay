import { createDMWorker } from "@/lib/queue/dm-worker";
import { recordWorkerHeartbeat } from "@/lib/ops/worker-health";
import {
  reconcileComments,
  requeueOrphanedPendingComments,
} from "@/lib/polling/comment-reconciler";
import { reconcileFacebookComments } from "@/lib/polling/facebook-comment-reconciler";
import { attachPendingNextReels } from "@/lib/automation/attach-next-reel";
import {
  getAppRateLimitState,
  isMetaAppRateLimitError,
  tripAppRateLimit,
} from "@/lib/meta/app-rate-limit-circuit";
import os from "node:os";

const worker = createDMWorker();
const startedAt = new Date().toISOString();
const HEARTBEAT_INTERVAL_MS = 30_000;
// Polling safety net for comments that webhooks miss. Runs in the worker because
// it must fire every few minutes and Vercel's free crons only run once a day.
const POLL_INTERVAL_MS = Number(
  process.env.COMMENT_POLL_INTERVAL_MS ?? 5 * 60_000
);
// DB requeue must not wait on Meta comment listing — that path can hang or
// soft-trip the circuit and leave PENDING stranded with an empty queue.
const REQUEUE_INTERVAL_MS = Number(
  process.env.PENDING_REQUEUE_INTERVAL_MS ?? 60_000
);

console.log("[DM Worker] Started");

async function heartbeat() {
  try {
    await recordWorkerHeartbeat({
      pid: process.pid,
      hostname: os.hostname(),
      startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Heartbeat failed:", message);
  }
}

void heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);

async function requeueOrphans() {
  try {
    const circuit = await getAppRateLimitState();
    if (circuit.limited) return;
    await requeueOrphanedPendingComments();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Pending requeue failed:", message);
  }
}

async function poll() {
  try {
    const circuit = await getAppRateLimitState();
    if (circuit.limited) {
      console.log(
        `[DM Worker] Poll paused — Meta cool-down ${Math.ceil(circuit.remainingMs / 60_000)} min left`
      );
      return;
    }
    // Drive backlog from DB first (no Meta read cost).
    await requeueOrphanedPendingComments();
    const attached = await attachPendingNextReels();
    if (attached.bound > 0 || attached.failedAccounts > 0) {
      console.log("[DM Worker] Next-reel attachment:", attached);
    }
    await reconcileComments();
    await reconcileFacebookComments();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Comment reconciliation failed:", message);
    if (isMetaAppRateLimitError(error)) {
      await tripAppRateLimit(message);
    }
  }
}

// Kick off one sweep shortly after boot, then on a fixed interval.
setTimeout(() => void poll(), 5_000);
setTimeout(() => void requeueOrphans(), 2_000);
const pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
const requeueTimer = setInterval(() => void requeueOrphans(), REQUEUE_INTERVAL_MS);

async function shutdown(signal: string) {
  console.log(`[DM Worker] ${signal} received, closing worker`);
  clearInterval(heartbeatTimer);
  clearInterval(pollTimer);
  clearInterval(requeueTimer);
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
