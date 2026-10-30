const configuration = {
  paths: ["tests/bdd/semantic/*.feature"],
  import: ["tests/bdd/semantic/steps.ts"],
  tags: "@semantic",
  parallel: 0,
  retry: 0,
  strict: true,
  format: ["progress"],
};

export default configuration;
