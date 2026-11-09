import { resolve } from "node:path";
const directory = resolve(
  process.env.SAGE_BDD_REPORT_DIR ?? "artifacts/bdd/sprint2-local",
);
const configuration = {
  paths: ["tests/bdd/sprint2/*.feature"],
  import: ["tests/bdd/sprint2/steps.ts"],
  tags: process.env.SAGE_BDD_BROWSER_CASE
    ? `@sprint2 and @browser_${process.env.SAGE_BDD_BROWSER_CASE}`
    : process.env.SAGE_BDD_CONTRACTS_ONLY === "1"
      ? "@sprint2 and @contract"
      : process.env.SAGE_BDD_BROWSER_ONLY === "1"
        ? "@sprint2 and @application_browser"
        : "@sprint2",
  parallel: 0,
  retry: 0,
  strict: true,
  format: [
    "progress",
    `html:${directory}/cucumber.html`,
    `json:${directory}/cucumber.json`,
  ],
};

export default configuration;
