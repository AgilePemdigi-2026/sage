import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AddBaselineModel } from "../packages/documents/src/baseline-add-model.ts";
import { enrichAddNarrative } from "../packages/documents/src/baseline-llm.ts";

const evidence = {
  filePath: "PRIVATE_EVIDENCE_PATH_DO_NOT_SEND.ts",
  fileSha256: "b".repeat(64),
  startByte: 0,
  endByte: 12,
  startLine: 1,
  endLine: 1,
  startColumn: 1,
  endColumn: 13,
  role: "reference" as const,
};

function fixture(): AddBaselineModel {
  return {
    schemaVersion: "sage-add-baseline-v1",
    archimateVersion: "3.2",
    generation: { extractorVersion: "fixture", llmOutcome: "not-requested", llmModel: null },
    snapshot: { repository: "PRIVATE_REPOSITORY_DO_NOT_SEND", branch: "private-branch", commitSha: "c".repeat(40) },
    sourceCkgHash: "d".repeat(64),
    elements: [
      { id: "app:auth", type: "ApplicationComponent", name: "Authentication", description: "RAW_SOURCE_DESCRIPTION_DO_NOT_SEND", origin: "source", featureGroup: "Access", evidence: [evidence], review: "unreviewed" },
      { id: "function:login", type: "ApplicationFunction", name: "Sign in", description: null, origin: "source", featureGroup: "Access", evidence: [evidence], review: "unreviewed" },
      { id: "data:user", type: "DataObject", name: "User record", description: "RAW_SOURCE_CONTENT_DO_NOT_SEND", origin: "source", evidence: [evidence], review: "unreviewed" },
      { id: "interface:session", type: "ApplicationInterface", name: "Session API", description: null, origin: "source", evidence: [evidence], review: "unreviewed" },
    ],
    relationships: [{ id: "relation:serves", type: "ServingRelationship", sourceId: "app:auth", targetId: "interface:session", label: "serves sessions", origin: "source", confidence: "proven", reason: "RAW_RELATIONSHIP_EVIDENCE_DO_NOT_SEND", evidence: [evidence], review: "unreviewed" }],
    catalogs: {
      dataEntities: [{ elementId: "data:user", owner: "owner-metadata-sent", description: "RAW_CATALOG_DESCRIPTION_DO_NOT_SEND" }],
      applicationPortfolio: [{ elementId: "app:auth", planned: false, description: "RAW_APPLICATION_DESCRIPTION_DO_NOT_SEND" }],
      interfaces: [{ elementId: "interface:session", protocol: "protocol-metadata-sent", contract: "RAW_CONTRACT_DO_NOT_SEND" }],
    },
    matrices: { applicationData: [], applicationInteractions: [] },
    views: { dataStructure: { elementIds: ["data:user"], relationshipIds: [] }, applicationCooperation: { elementIds: ["app:auth", "interface:session"], relationshipIds: ["relation:serves"] } },
    narratives: {
      dataBaseline: "Deterministic data narrative.", applicationBaseline: "Deterministic application narrative.",
      dataViewIntroduction: "Data view introduction.", dataViewInterpretation: "Data view interpretation.",
      applicationViewIntroduction: "Application view introduction.", applicationViewInterpretation: "Application view interpretation.",
    },
    limitations: ["RAW_LIMITATION_DO_NOT_SEND"],
  };
}

const llmEnv = { LLM_BASE_URL: "https://llm.example.test/v1", LLM_API_KEY: "fixture-key", LLM_MODEL: "campus-model" };

test("ADD consent is default-off, collected on the ADD page, and absent from Code Knowledge", async () => {
  const addWorkspace = await readFile(new URL("../apps/web/components/add-workspace/add-workspace.tsx", import.meta.url), "utf8");
  const graphWorkspace = await readFile(new URL("../apps/web/components/live-graph/live-graph-client.tsx", import.meta.url), "utf8");

  assert.match(addWorkspace, /id="add-llm-consent" type="checkbox" aria-describedby="add-llm-consent-details" defaultChecked=\{false\}/u);
  assert.match(addWorkspace, /body: JSON\.stringify\(\{ allowLlm: llmConsentInput\.current\?\.checked === true \}\)/u);
  assert.match(addWorkspace, /onClick=\{\(\) => void generateBaseline\(\)\}/u);
  assert.match(addWorkspace, /Generate Phase C baseline/u);
  assert.match(addWorkspace, /With this option unchecked, no LLM request is made\./u);
  assert.match(addWorkspace, /Source code, file contents, repository file paths, evidence ranges, repository URL, commit SHA, and credentials are not sent\./u);
  assert.match(addWorkspace, /Interface names may contain an API route when that route is the extracted interface name\./u);
  assert.doesNotMatch(graphWorkspace, /llmConsent|allowLlm|Generate TOGAF Phase C baseline ADD/u);
  assert.match(graphWorkspace, /Open Architecture Definition Document/u);
});

test("consented LLM receives bounded ADD facts without source, evidence, repository, or commit data", async () => {
  const model = fixture();
  let sentBody = "";
  const result = await enrichAddNarrative({ model, env: llmEnv, fetcher: async (_input, init) => {
    sentBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      dataBaseline: "Reviewed data narrative.", applicationBaseline: "Reviewed application narrative.",
      dataViewIntroduction: "Reviewed data introduction.", dataViewInterpretation: "Reviewed data interpretation.",
      applicationViewIntroduction: "Reviewed application introduction.", applicationViewInterpretation: "Reviewed application interpretation.",
    }) } }] }), { status: 200 });
  } });

  assert.equal(result.outcome, "used");
  assert.equal(result.model.generation.llmOutcome, "used");
  assert.equal(result.model.generation.llmModel, "campus-model");
  const request = JSON.parse(sentBody) as { messages: Array<{ role: string; content: string }> };
  const userMessage = request.messages.find(message => message.role === "user");
  assert.ok(userMessage);
  const sent = JSON.parse(userMessage.content) as { facts: Record<string, unknown>; coreViews: Record<string, unknown>; omitted: Record<string, unknown>; viewCounts: Record<string, unknown> };
  assert.deepEqual(Object.keys(sent.facts).sort(), ["application", "dataObjects", "functions", "interfaces", "relationships"]);
  assert.deepEqual(Object.keys(sent.viewCounts).sort(), ["applicationCooperation", "dataStructure"]);
  assert.equal((sent.viewCounts.applicationCooperation as { relationships: number }).relationships, 0, "LLM receives the actual stakeholder diagram projection, which excludes interface-level links");
  assert.equal((sent.coreViews.applicationCooperation as { relationships: unknown[] }).relationships.length, 0);
  assert.equal((sent.facts.relationships as Array<{ view: string }>)[0]?.view, "applicationCooperation");
  assert.equal((sent.facts.application as string[])[0], "Authentication");
  assert.equal((sent.facts.dataObjects as Array<{ owner: string }>)[0]?.owner, "owner-metadata-sent");
  assert.equal((sent.facts.interfaces as Array<{ protocol: string }>)[0]?.protocol, "protocol-metadata-sent");
  for (const marker of [
    "PRIVATE_REPOSITORY_DO_NOT_SEND", "private-branch", "c".repeat(40), "d".repeat(64), evidence.filePath,
    evidence.fileSha256, "RAW_SOURCE_DESCRIPTION_DO_NOT_SEND", "RAW_SOURCE_CONTENT_DO_NOT_SEND",
    "RAW_RELATIONSHIP_EVIDENCE_DO_NOT_SEND", "RAW_CATALOG_DESCRIPTION_DO_NOT_SEND", "RAW_CONTRACT_DO_NOT_SEND", "RAW_LIMITATION_DO_NOT_SEND",
  ]) assert.ok(!sentBody.includes(marker), `sensitive source marker was sent: ${marker}`);
});

test("LLM can change only six bounded narratives, records its outcome, and preserves deterministic fallback", async () => {
  const model = fixture();
  const result = await enrichAddNarrative({ model, env: llmEnv, fetcher: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    dataBaseline: "LLM data narrative.", applicationBaseline: "LLM application narrative.",
    dataViewIntroduction: "LLM data introduction.", dataViewInterpretation: "LLM data interpretation.",
    applicationViewIntroduction: "LLM application introduction.", applicationViewInterpretation: "LLM application interpretation.",
  }) } }] }), { status: 200 }) });
  assert.equal(result.outcome, "used");
  assert.equal(result.model.narratives.dataBaseline, "LLM data narrative.");
  assert.equal(result.model.narratives.applicationBaseline, "LLM application narrative.");
  assert.equal(result.model.narratives.dataViewIntroduction, "LLM data introduction.");
  assert.equal(result.model.narratives.dataViewInterpretation, "LLM data interpretation.");
  assert.equal(result.model.narratives.applicationViewIntroduction, "LLM application introduction.");
  assert.equal(result.model.narratives.applicationViewInterpretation, "LLM application interpretation.");
  const expected = structuredClone(model);
  expected.narratives = result.model.narratives;
  expected.generation = { ...expected.generation, llmOutcome: "used", llmModel: "campus-model" };
  assert.deepEqual(result.model, expected, "all non-narrative architecture facts must remain unchanged");

  const notConfigured = await enrichAddNarrative({ model, env: {} });
  assert.equal(notConfigured.outcome, "not-configured");
  assert.deepEqual(notConfigured.model, model);

  const invalid = await enrichAddNarrative({ model, env: llmEnv, fetcher: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ dataBaseline: "Injected", applicationBaseline: "Text", relationships: [] }) } }] }), { status: 200 }) });
  assert.equal(invalid.outcome, "unavailable");
  assert.deepEqual(invalid.model, model, "extra model fields are rejected and deterministic narratives remain intact");

  const unavailable = await enrichAddNarrative({ model, env: llmEnv, fetcher: async () => new Response("unavailable", { status: 503 }) });
  assert.equal(unavailable.outcome, "unavailable");
  assert.deepEqual(unavailable.model, model, "failed LLM enrichment must keep deterministic narratives and source facts");
});
