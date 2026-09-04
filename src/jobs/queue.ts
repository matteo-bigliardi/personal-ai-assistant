import { PgBoss } from "pg-boss";
import type { Logger } from "../observability/logger.js";

/**
 * The job queue, owned in one place.
 *
 * pg-boss keeps its own tables in its own schema, so it never collides with the
 * application schema or with Drizzle's migrations. What it must not have is a
 * second instance: reminder delivery and the morning briefing are two workers
 * on one connection pool, not two pools running two maintenance loops over the
 * same tables.
 *
 * Starting and stopping therefore belong here, and the jobs themselves only
 * register their queue and their worker.
 */
export interface JobQueue {
  boss: PgBoss;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createJobQueue(connectionString: string, logger: Logger): JobQueue {
  const boss = new PgBoss({ connectionString, schema: "pgboss" });

  boss.on("error", (error: unknown) => logger.error("jobs.error", { error: String(error) }));

  return {
    boss,
    async start() {
      await boss.start();
    },
    async stop() {
      await boss.stop({ graceful: true });
    },
  };
}
