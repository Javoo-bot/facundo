import { readFileSync, writeFileSync } from "node:fs";
const data = readFileSync("lifecycle.json", "utf8").replace(/</g, "\u003c");
const out = readFileSync("template.html", "utf8").replace("__AGENTS__", () => readFileSync("agents.html", "utf8")).replace("__DATA__", () => data).replace("__DATE__", process.argv[2]).replace("__BRANCH__", process.argv[3]);
writeFileSync("facundo-system-map.html", out);
