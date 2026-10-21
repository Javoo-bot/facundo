// Rewrites concierge.golden.txt from the current prompt. Run it after changing
// agents/thinking/concierge.md on purpose, so the prompt change shows in the diff.
import { writeFileSync } from "node:fs";
import { buildSupportPrompt } from "../cxAgent.ts";
import { GOLDEN_INPUT } from "./conciergeGoldenInput.ts";

writeFileSync(new URL("./concierge.golden.txt", import.meta.url), buildSupportPrompt(GOLDEN_INPUT));
console.log("wrote concierge.golden.txt");
