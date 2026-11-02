/** Split the TypeScript corpus by measured cost so individual files remain balanced across Core shards. */
import { languageFixtureTests } from "./fixtures/team-support.ts";

languageFixtureTests("typescript", ["ts-calendar"]);
