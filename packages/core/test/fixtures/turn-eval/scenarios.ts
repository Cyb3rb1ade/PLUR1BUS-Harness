/** Independent N-A2/G1 gold checks and model transcripts, paired in German and English. */
import type { TurnEvalScenario, TurnEvalSkill } from "../../../src/toolcall/turn-eval.ts";

const SKILLS: TurnEvalSkill[] = [
  {
    name: "code-work", category: "code.edit",
    description: "Implement code, fix bugs and test code; programmiere Code und teste Fehler.",
    body: "BODY:code-work Follow the coding checklist before implementing code.",
  },
  {
    name: "web-research", category: "web.research",
    description: "Search current web research and compare sources; suche aktuelle Webquellen.",
    body: "BODY:web-research Search the web and cite the returned source evidence.",
  },
];
const call = (name: string, query = "fixture") => ({ name, args: { query } });
const END = { text: "fixture complete" };

/** Every acceptance criterion is checked independently of the scripted adapter's requested calls. */
export const TURN_EVAL_SCENARIOS: TurnEvalScenario[] = (["en", "de"] as const).flatMap(language => {
  const de = language === "de";
  const code = de ? "Implementiere Code und teste die Datei ./report.txt" : "Implement code and test file ./report.txt";
  const research = de ? "Suche aktuelle Webquellen heute" : "Search current web sources today";
  return [
    {
      id: `file-needed-${language}`, language, tags: ["tool-needed"], turns: [{
        input: de ? "Lies die Datei ./report.txt" : "Read file ./report.txt",
        rounds: [{ calls: [call("file.read")] }, END], requiredTools: ["file.read"], choice: "required",
      }],
    },
    {
      id: `web-needed-${language}`, language, tags: ["tool-needed", "current"], turns: [{
        input: research, rounds: [{ calls: [call("web.search")] }, END],
        requiredTools: ["web.search"], choice: "required",
      }],
    },
    {
      id: `plain-chat-${language}`, language, tags: ["no-tool-needed"], turns: [{
        input: de ? "Hallo!" : "Hello!", rounds: [{ text: de ? "Hallo!" : "Hello!" }],
        choice: "auto", noToolNeeded: true,
      }],
    },
    {
      id: `skill-needed-${language}`, language, tags: ["skill-needed"], skills: SKILLS, turns: [{
        input: code, rounds: [{ calls: [call("file.read")] }, END], requiredTools: ["file.read"],
        requiredSkills: ["code-work"], choice: "required",
      }],
    },
    {
      id: `continuation-${language}`, language, tags: ["skill-needed", "followup", "cache"], skills: SKILLS,
      turns: [
        {
          input: code, rounds: [{ calls: [call("file.read")] }, END], requiredSkills: ["code-work"], choice: "required",
        },
        { input: de ? "Ja, weiter" : "Yes, continue", rounds: [END], requiredSkills: ["code-work"], choice: "auto" },
      ],
    },
    {
      id: `multi-task-${language}`, language, tags: ["multi", "skill-needed"], skills: SKILLS, turns: [{
        input: `${research}; ${code}`, rounds: [{ calls: [call("web.search"), call("file.read")] }, END],
        requiredTools: ["web.search", "file.read"], requiredSkills: ["web-research", "code-work"],
        checklist: [research, code], choice: "required",
      }],
    },
    {
      id: `unknown-recovery-${language}`, language, tags: ["error", "recovery"], turns: [{
        input: de ? "Lies die Datei ./report.txt" : "Read file ./report.txt",
        rounds: [{ calls: [call("missing.tool")] }, { calls: [call("file.read")] }, { text: "recovered" }],
        requiredTools: ["file.read"], errorReturned: "tool-unknown", choice: "required",
      }],
    },
    {
      id: `failure-recovery-${language}`, language, tags: ["error", "recovery"], failToolOnce: "file.read", turns: [{
        input: de ? "Lies die Datei ./report.txt" : "Read file ./report.txt",
        rounds: [{ calls: [call("file.read")] }, { calls: [call("file.read")] }, { text: "recovered" }],
        requiredTools: ["file.read"], errorReturned: "tool-failed", choice: "required",
      }],
    },
    {
      id: `session-tool-growth-${language}`, language, tags: ["cache", "session"], turns: [
        {
          input: de ? "Lies die Datei ./report.txt" : "Read file ./report.txt",
          rounds: [{ calls: [call("file.read")] }, END], requiredTools: ["file.read"], choice: "required",
        },
        {
          input: research, rounds: [{ calls: [call("web.search")] }, END],
          requiredTools: ["web.search"], choice: "required",
        },
      ],
    },
    {
      id: `discovery-${language}`, language, tags: ["discovery"], turns: [{
        input: de ? "Suche aktuelle Webquellen" : "Search current web sources",
        rounds: [{ calls: [call("capabilities.search", "web fetch")] }, { calls: [call("web.fetch")] }, END],
        requiredTools: ["web.fetch"], choice: "required",
      }],
    },
  ];
});
