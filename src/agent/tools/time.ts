import { z } from "zod";
import { defineTool, type ToolDefinition } from "../tool-registry.js";
import { TIME_PERIODS, type TimeReport, type TimeService } from "../../domain/time/service.js";
import type { WorkSessionWithProject } from "../../db/repositories/work-sessions.js";
import {
  INSTANT_FORMAT_HINT,
  formatDuration,
  formatInstant,
  parseInstant,
} from "../../domain/datetime.js";

/**
 * Time-tracking tools.
 *
 * Durations are never computed by the model: it names a period or a pair of
 * calendar dates, and the boundaries — including which daylight-saving offset
 * applies to that particular day, and where the week starts — are resolved in
 * the domain.
 */

const projectArg = z.string().min(1).max(120).describe("The project name, as the user says it.");

const noteArg = z.string().max(200).optional().describe("Optional note about what was worked on.");

interface SessionView {
  project: string;
  started_at: string;
  ended_at?: string;
  duration?: string;
  note?: string;
}

function view(session: WorkSessionWithProject, timeZone: string): SessionView {
  const seconds =
    session.endedAt === null
      ? undefined
      : (session.endedAt.getTime() - session.startedAt.getTime()) / 1000;

  return {
    project: session.projectName,
    started_at: formatInstant(session.startedAt, timeZone),
    ...(session.endedAt ? { ended_at: formatInstant(session.endedAt, timeZone) } : {}),
    ...(seconds !== undefined ? { duration: formatDuration(seconds) } : {}),
    ...(session.note ? { note: session.note } : {}),
  };
}

function reportView(report: TimeReport, timeZone: string) {
  return {
    from: report.range.from ? formatInstant(report.range.from, timeZone) : "the beginning",
    // The range is half-open, so the upper bound is the first instant *not*
    // counted. Say so rather than letting it read as an inclusive end.
    until_exclusive: report.range.to ? formatInstant(report.range.to, timeZone) : "now",
    total: formatDuration(report.totalSeconds),
    by_project: report.byProject.map((p) => ({
      project: p.projectName,
      time: formatDuration(p.seconds),
    })),
    ...(report.running
      ? {
          running: {
            project: report.running.projectName,
            since: formatInstant(report.running.startedAt, timeZone),
            // Flagged so the model can say the total is still moving instead of
            // presenting it as final.
            counted_so_far: formatDuration(report.running.countedSeconds),
          },
        }
      : {}),
  };
}

export function createTimeTools(service: TimeService, timeZone: string): ToolDefinition[] {
  return [
    defineTool({
      name: "start_timer",
      description:
        "Start tracking work on a project. Only one timer runs at a time: if another is " +
        "already running this fails and names it, so offer to stop that one first. " +
        "A paused project is fine; a completed or archived one is not.",
      schema: z.object({ project: projectArg, note: noteArg }),
      async execute({ project, note }) {
        const session = await service.start(project, note);
        return { started: view(session, timeZone) };
      },
    }),

    defineTool({
      name: "stop_timer",
      description:
        "Stop the running timer and report how long it ran. " + "Fails if no timer is running.",
      schema: z.object({}),
      async execute() {
        const { session, seconds } = await service.stop();
        return { stopped: view(session, timeZone), duration: formatDuration(seconds) };
      },
    }),

    defineTool({
      name: "add_work_session",
      description:
        "Record work that was already done, when no timer was running at the time. " +
        "Both ends are absolute instants, and the session must have a real duration.",
      schema: z.object({
        project: projectArg,
        started_at: z.string().min(1).max(40).describe(`Start: ${INSTANT_FORMAT_HINT}.`),
        ended_at: z.string().min(1).max(40).describe(`End: ${INSTANT_FORMAT_HINT}.`),
        note: noteArg,
      }),
      async execute({ project, started_at, ended_at, note }) {
        const session = await service.add({
          projectName: project,
          startedAt: parseInstant(started_at),
          endedAt: parseInstant(ended_at),
          ...(note !== undefined ? { note } : {}),
        });
        return { added: view(session, timeZone) };
      },
    }),

    defineTool({
      name: "get_time_spent",
      description:
        "Report time tracked, optionally for one project. Use a named period for " +
        "today, this week or this month; use from/to for anything else, such as a " +
        "single past day or a stretch of days. A running timer is included, counted " +
        "up to now, and reported separately.",
      schema: z
        .object({
          project: projectArg.optional().describe("Only this project. Omit for every project."),
          period: z
            .enum(TIME_PERIODS)
            .optional()
            .describe("A named period. Omit for all time, or use from/to instead."),
          from: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe("First day counted, YYYY-MM-DD. Not to be combined with period."),
          to: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe("Last day counted, YYYY-MM-DD, included in full."),
        })
        .describe("Give either period or from/to, never both."),
      async execute({ project, period, from, to }) {
        const report = await service.report({
          ...(project !== undefined ? { projectName: project } : {}),
          ...(period !== undefined ? { period } : {}),
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
        });
        return reportView(report, timeZone);
      },
    }),
  ];
}
