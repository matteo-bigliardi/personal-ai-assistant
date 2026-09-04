import { z } from "zod";
import type { BriefingService } from "../../domain/briefing/service.js";
import { defineTool, type ToolDefinition } from "../tool-registry.js";

/**
 * Briefing tools.
 *
 * The schedule is settings, not state the user should have to edit in a file
 * and restart for: "mandamelo alle 8" is the natural way to change it, so it is
 * a tool. Changing the time reschedules the job in the same call — a stored
 * value the queue never picked up would be a setting that silently does not
 * apply.
 */
export function createBriefingTools(service: BriefingService, timeZone: string): ToolDefinition[] {
  return [
    defineTool({
      name: "get_briefing_time",
      description:
        "Report the time of day the morning briefing is sent. Use it when the user asks when " +
        "the briefing arrives, or to confirm a change.",
      schema: z.object({}),
      async execute() {
        return { time: await service.getSendAt(), timezone: timeZone };
      },
    }),

    defineTool({
      name: "set_briefing_time",
      description:
        "Change the time of day the morning briefing is sent. The change applies from the " +
        "next briefing onwards; today's, if it has already gone out, is not repeated.",
      schema: z.object({
        time: z
          .string()
          .min(4)
          .max(5)
          .describe(`Local time of day in 24-hour HH:MM, for example 07:30. Timezone ${timeZone}.`),
      }),
      async execute({ time }) {
        return { time: await service.setSendAt(time), timezone: timeZone };
      },
    }),
  ];
}
