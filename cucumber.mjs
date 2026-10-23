import { resolve } from "node:path";

const reportDirectory = resolve(process.env.SAGE_BDD_REPORT_DIR ?? "artifacts/bdd/local");

const configuration = {
  paths: ["tests/bdd/features/**/*.feature"],
  import: ["tests/bdd/support/**/*.ts", "tests/bdd/steps/**/*.ts"],
  tags: "@sprint1",
  parallel: 0,
  retry: 0,
  strict: true,
  format: ["progress", `html:${reportDirectory}/cucumber.html`, `json:${reportDirectory}/cucumber.json`],
  formatOptions: { snippetInterface: "async-await" },
};

export default configuration;
