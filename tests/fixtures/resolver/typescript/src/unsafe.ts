if (process.env.SAGE_RESOLVER_CANARY_PATH) {
  require("node:fs").writeFileSync(process.env.SAGE_RESOLVER_CANARY_PATH, "TypeScript source executed");
}
throw new Error("SAGE_RESOLVER_TS_CANARY_MUST_NOT_EXECUTE");
