/**
 * Agent eval harness.
 *
 * Runs synthetic conversations through the real agent loop, the real tool
 * definitions and the real model, with the domain services replaced by fakes
 * (see `fakes.ts`). Nothing is written anywhere: an eval run cannot touch the
 * database, the calendar or anyone's data.
 *
 *   npx tsx --env-file-if-exists=.env evals/run.ts [--case <id>] [--out <file>]
 *
 * It calls the model, so it costs API credits and is not part of `npm test`.
 *
 * Three numbers come out, the ones spec §13 asks for:
 *
 *   tool-selection accuracy   the expected tool was called
 *   argument correctness      of the arguments checked, how many matched
 *   task success rate         the step passed completely
 *
 * The clock is frozen so that "Friday" has one right answer. Every case is
 * written against Wednesday 2026-09-09, 08:00 Europe/Rome.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent } from "../src/agent/agent.js";
import { createAnthropicProvider } from "../src/agent/providers/anthropic.js";
import { createToolRegistry, type ToolContext } from "../src/agent/tool-registry.js";
import { createBriefingTools } from "../src/agent/tools/briefing.js";
import { createCalendarTools } from "../src/agent/tools/calendar.js";
import { createProjectTools } from "../src/agent/tools/projects.js";
import { createReminderTools } from "../src/agent/tools/reminders.js";
import { createTaskTools } from "../src/agent/tools/tasks.js";
import { createTimeTools } from "../src/agent/tools/time.js";
import type { ToolCall, ToolResult } from "../src/agent/providers/types.js";
import { loadConfig } from "../src/config/index.js";
import { createLogger } from "../src/observability/logger.js";
import { fakeServices } from "./fakes.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TZ = "Europe/Rome";
/** Wednesday 2026-09-09, 08:00 local. Every case is written against it. */
const NOW = new Date("2026-09-09T06:00:00Z");

interface Expectation {
  /** The tool the model should call in this step. */
  tool?: string;
  /** Arguments to check. A `~` prefix means "contains", case-insensitively. */
  args?: Record<string, string | number>;
  /** These arguments must not be present — usually a date that was not given. */
  argsAbsent?: string[];
  /** The step should end with no tool call at all. */
  noTool?: boolean;
  /** This specific tool must not be called. */
  noToolNamed?: string;
  /** The call must come back with this error code instead of running. */
  refused?: string;
  /**
   * How many times each named tool actually ran, refusals excluded. This is how
   * a confirmation case is stated: the point is that nothing was deleted, not
   * which route the model took to avoid deleting it.
   */
  ran?: Record<string, number>;
}

interface Step {
  message: string;
  expect?: Expectation;
}

interface EvalCase {
  id: string;
  area: string;
  note?: string;
  steps: Step[];
  /**
   * Checked once over every tool call the whole case made, rather than per
   * step. Some requests are answered in one turn by one model run and after a
   * volunteered "confirm?" by the next, and a case that pinned the route would
   * fail on the behaviour rather than on the outcome.
   */
  expectFinal?: Expectation;
}

interface StepResult {
  message: string;
  /** Kept for diagnosis: a failure is usually explained by what was said. */
  reply: string;
  toolsCalled: string[];
  toolCorrect: boolean | null;
  argsChecked: number;
  argsCorrect: number;
  failures: string[];
  passed: boolean;
}

interface CaseResult {
  id: string;
  area: string;
  passed: boolean;
  steps: StepResult[];
  finalFailures?: string[];
}

/** Records what the model asked for, and whether the registry let it through. */
interface Observation {
  call: ToolCall;
  errorCode?: string;
  ran: boolean;
}

function argMatches(expected: string | number, actual: unknown): boolean {
  if (typeof expected === "number") return Number(actual) === expected;
  const value = String(actual ?? "");
  if (expected.startsWith("~")) {
    return value.toLowerCase().includes(expected.slice(1).toLowerCase());
  }
  // A bare date matches any instant on that day: the case cares that the model
  // picked the right day, not how it chose to express midnight.
  if (/^\d{4}-\d{2}-\d{2}$/.test(expected)) return value.startsWith(expected);
  // Instants are compared as instants. "2026-09-11T15:00:00+02:00" and
  // "2026-09-11T13:00:00Z" are the same moment, and a case that failed on the
  // difference would be testing the model's formatting, not its arithmetic.
  const expectedAt = Date.parse(expected);
  const actualAt = Date.parse(value);
  if (!Number.isNaN(expectedAt) && !Number.isNaN(actualAt)) return expectedAt === actualAt;
  return value.toLowerCase() === expected.toLowerCase();
}

function checkStep(step: Step, observed: Observation[], reply: string): StepResult {
  const expect = step.expect ?? {};
  const failures: string[] = [];
  const toolsCalled = observed.map((o) => o.call.name);
  let toolCorrect: boolean | null = null;
  let argsChecked = 0;
  let argsCorrect = 0;

  if (expect.noTool) {
    if (observed.length > 0) failures.push(`expected no tool, got ${toolsCalled.join(", ")}`);
  }
  if (expect.noToolNamed && toolsCalled.includes(expect.noToolNamed)) {
    failures.push(`must not call ${expect.noToolNamed}`);
  }

  const match = expect.tool ? observed.find((o) => o.call.name === expect.tool) : undefined;
  if (expect.tool) {
    toolCorrect = match !== undefined;
    if (!match) failures.push(`expected ${expect.tool}, got ${toolsCalled.join(", ") || "none"}`);
  }

  if (match && expect.args) {
    const input = (match.call.input ?? {}) as Record<string, unknown>;
    for (const [name, expected] of Object.entries(expect.args)) {
      argsChecked++;
      if (argMatches(expected, input[name])) argsCorrect++;
      else
        failures.push(`${name}: expected ${String(expected)}, got ${JSON.stringify(input[name])}`);
    }
  }
  if (match && expect.argsAbsent) {
    const input = (match.call.input ?? {}) as Record<string, unknown>;
    for (const name of expect.argsAbsent) {
      argsChecked++;
      if (input[name] === undefined) argsCorrect++;
      else failures.push(`${name}: should be absent, got ${JSON.stringify(input[name])}`);
    }
  }

  if (expect.refused) {
    const refused = observed.some((o) => o.errorCode === expect.refused);
    if (!refused) failures.push(`expected a ${expect.refused} refusal`);
  }
  for (const [name, times] of Object.entries(expect.ran ?? {})) {
    const actual = observed.filter((o) => o.ran && o.call.name === name).length;
    if (actual !== times) failures.push(`${name} ran ${actual} times, expected ${times}`);
  }

  return {
    message: step.message,
    reply,
    toolsCalled,
    toolCorrect,
    argsChecked,
    argsCorrect,
    failures,
    passed: failures.length === 0,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = args.includes("--case") ? args[args.indexOf("--case") + 1] : undefined;
  const outFlag = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;

  const config = loadConfig();
  // The harness reports its own numbers; the app's log lines would drown them.
  const logger = createLogger("error");
  const services = fakeServices();

  const cases = JSON.parse(readFileSync(resolve(HERE, "cases/v1.json"), "utf8")) as EvalCase[];
  const selected = only ? cases.filter((c) => c.id === only) : cases;
  if (selected.length === 0) {
    console.error(`No case matches "${only ?? ""}".`);
    process.exit(1);
  }

  const results: CaseResult[] = [];

  for (const testCase of selected) {
    // A fresh registry and agent per case: conversational memory and pending
    // confirmations must not leak from one case into the next.
    const registry = createToolRegistry(
      [
        ...createProjectTools(services.projects, TZ),
        ...createTaskTools(services.tasks, TZ),
        ...createTimeTools(services.time, TZ),
        ...createReminderTools(services.reminders, TZ),
        ...createCalendarTools(services.calendar, TZ),
        ...createBriefingTools(services.briefing, TZ),
      ],
      logger,
    );

    let observed: Observation[] = [];
    const watched = {
      ...registry,
      async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
        const result = await registry.execute(call, context);
        const parsed = JSON.parse(result.content) as { error?: { code?: string } };
        observed.push({
          call,
          ...(parsed.error?.code ? { errorCode: parsed.error.code } : {}),
          ran: result.isError !== true,
        });
        return result;
      },
    };

    const agent = createAgent({
      provider: createAnthropicProvider({
        apiKey: config.ANTHROPIC_API_KEY,
        model: config.ANTHROPIC_MODEL,
      }),
      tools: watched,
      logger,
      timeZone: TZ,
      now: () => NOW,
    });

    const steps: StepResult[] = [];
    const everything: Observation[] = [];
    for (const step of testCase.steps) {
      observed = [];
      const reply = await agent.handleMessage({
        chatId: `eval-${testCase.id}`,
        text: step.message,
      });
      everything.push(...observed);
      steps.push(checkStep(step, observed, reply));
    }

    const final = testCase.expectFinal
      ? checkStep({ message: "(whole case)", expect: testCase.expectFinal }, everything, "")
      : undefined;
    if (final) {
      steps.push(final);
    }

    const passed = steps.every((s) => s.passed);
    results.push({
      id: testCase.id,
      area: testCase.area,
      passed,
      steps,
      ...(final ? { finalFailures: final.failures } : {}),
    });
    console.log(`${passed ? "PASS" : "FAIL"}  ${testCase.id}`);
    for (const step of steps) {
      for (const failure of step.failures) console.log(`        ${failure}`);
    }
  }

  const allSteps = results.flatMap((r) => r.steps);
  const toolSteps = allSteps.filter((s) => s.toolCorrect !== null);
  const argsChecked = allSteps.reduce((n, s) => n + s.argsChecked, 0);
  const argsCorrect = allSteps.reduce((n, s) => n + s.argsCorrect, 0);

  const summary = {
    model: config.ANTHROPIC_MODEL,
    ranAt: new Date().toISOString(),
    cases: results.length,
    toolSelectionAccuracy: ratio(toolSteps.filter((s) => s.toolCorrect).length, toolSteps.length),
    argumentCorrectness: ratio(argsCorrect, argsChecked),
    taskSuccessRate: ratio(results.filter((r) => r.passed).length, results.length),
  };

  console.log("");
  console.log(`model                    ${summary.model}`);
  console.log(
    `tool-selection accuracy  ${pct(summary.toolSelectionAccuracy)} (${toolSteps.length} steps)`,
  );
  console.log(
    `argument correctness     ${pct(summary.argumentCorrectness)} (${argsChecked} arguments)`,
  );
  console.log(`task success rate        ${pct(summary.taskSuccessRate)} (${results.length} cases)`);

  // Results carry synthetic data only, but they are still a model's output on a
  // given day: they go under results/local/, which is git-ignored, unless a
  // destination is named explicitly.
  const out = outFlag ?? resolve(HERE, "results/local/latest.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ summary, results }, null, 2) + "\n");
  console.log(`\nwritten to ${out}`);

  process.exit(results.every((r) => r.passed) ? 0 : 1);
}

const ratio = (n: number, d: number): number => (d === 0 ? 1 : n / d);
const pct = (r: number): string => `${(r * 100).toFixed(1)}%`;

await main();
