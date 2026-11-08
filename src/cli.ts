#!/usr/bin/env node
import { Command } from "commander";
import { registerTaskCommands } from "./commands/tasks.js";
import { registerCalendarCommands } from "./commands/calendar.js";
import { registerGoalCommands } from "./commands/goals.js";
import {
  registerDataCommands,
  registerExperimentCommands,
  registerNoteCommands,
  registerReportCommand,
} from "./commands/content.js";
import { registerDemoCommands, registerTutorialCommand } from "./commands/tutorial.js";
import { registerServiceCommands } from "./commands/service.js";

const program = new Command();
program
  .name("day")
  .description("Day — what should I be doing today?")
  .version("0.1.0")
  .showHelpAfterError();

registerServiceCommands(program);
registerTaskCommands(program);
registerCalendarCommands(program);
registerGoalCommands(program);
registerNoteCommands(program);
registerExperimentCommands(program);
registerReportCommand(program);
registerTutorialCommand(program);
registerDemoCommands(program);
registerDataCommands(program);

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
