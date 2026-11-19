import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalizeCkg, type CcmSnapshot } from "@sage/contracts";
import type { SnapshotFile } from "../apps/worker/src/snapshot/archive.ts";
import { analyzeSnapshotSources } from "../apps/worker/src/source-analysis.ts";
import { buildAddBaseline } from "../packages/documents/src/baseline-add.ts";
import { buildSemanticModel, semanticModelHash } from "../packages/documents/src/semantic/build.ts";
import { extractDataArtifacts } from "../packages/documents/src/semantic/data-artifacts.ts";

const snapshot: CcmSnapshot = {
  repository: "fixture/phase-c-prisma",
  branch: "main",
  commitSha: "9".repeat(40),
};
const configurationHash = "a".repeat(64);

function file(relativePath: string, text: string | Uint8Array): SnapshotFile {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : new Uint8Array(text);
  return { relativePath, bytes, byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const prismaSchema = `// model Fake { id String @id }
/*
model AlsoFake {
  id String @id
}
*/
enum Status { OPEN CLOSED }

model User {
  id    String @id
  posts Post[]
}

model Post {
  id       String @id
  authorId String
  author   User   @relation(fields: [authorId], references: [id])
  status   Status?
}
`;

function project(files: SnapshotFile[], sourceSnapshot = snapshot) {
  const analyzed = analyzeSnapshotSources({ snapshot: sourceSnapshot, files });
  return analyzed.then(result => {
    assert.ok(result.ccm, "supported source creates a canonical CCM");
    const sources = Object.fromEntries(files.map(item => [item.relativePath, item.bytes]));
    const ckg = canonicalizeCkg(result.ccm, sources, configurationHash);
    assert.ok(ckg.ok, "source evidence passes CKG validation");
    const semantic = buildSemanticModel({ ccm: result.ccm, sourceCkgHash: ckg.sha256, sources, documentationSources: sources,
      snapshotPaths: Object.keys(sources) });
    const add = buildAddBaseline({ ccm: result.ccm, semantic, sourceCkgHash: ckg.sha256 });
    return { analyzed: result, semantic, add };
  });
}

test("Prisma schema models and explicit relation fields become evidence-backed ADD data objects", async () => {
  const files = [
    file("src/app/api/posts/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n"),
    file("prisma/schema.prisma", prismaSchema),
  ];
  const { analyzed, semantic, add } = await project(files);
  const schemaBytes = files.find(item => item.relativePath === "prisma/schema.prisma")!.bytes;
  const stores = semantic.nodes.filter(item => item.kind === "store");
  assert.deepEqual(stores.map(item => item.label).sort(), ["Post", "User"]);
  assert.ok(semantic.frameworks.includes("Prisma schema"));
  assert.ok(analyzed.ccm?.snapshot.commitSha === snapshot.commitSha);
  assert.equal(add.snapshot.commitSha, snapshot.commitSha);
  assert.equal(add.generation.extractorVersion, semantic.extractorVersion);
  assert.equal(add.catalogs.dataEntities.length, 2);
  assert.ok(add.catalogs.dataEntities.every(item => item.owner === null), "source schema does not establish enterprise data ownership");
  assert.equal(add.matrices.applicationInteractions.length, 0, "one repository schema does not prove cross-application integration");
  assert.equal(add.matrices.applicationData.length, 0, "schema declarations alone do not prove CRUD operations");

  const post = stores.find(item => item.label === "Post")!;
  const user = stores.find(item => item.label === "User")!;
  const relation = semantic.edges.find(item => item.source === post.id && item.target === user.id);
  assert.ok(relation, "Post.author explicitly references User");
  assert.equal(relation.confidence, "proven");
  assert.match(relation.reason, /Prisma model fields/iu);
  assert.equal(relation.evidence.length, 2, "reciprocal Prisma fields are grouped but retain both evidence spans");
  const span = relation.evidence.find(item => item.startLine === 17)!;
  assert.equal(span.filePath, "prisma/schema.prisma");
  assert.equal(span.fileSha256, createHash("sha256").update(schemaBytes).digest("hex"));
  assert.equal(new TextDecoder().decode(schemaBytes.slice(span.startByte, span.endByte)), "User");
  assert.equal(span.startLine, 17);
});

test("Prisma extraction ignores commented models and enum/scalar fields as relationships", () => {
  const source = file("prisma/schema.prisma", prismaSchema);
  const fragment = extractDataArtifacts({ ccm: {} as never, sourceCkgHash: "b".repeat(64), sources: { [source.relativePath]: source.bytes } });
  assert.deepEqual(fragment.nodes.map(item => item.label).sort(), ["Post", "User"]);
  assert.equal(fragment.edges.length, 1, "reciprocal fields describe one data association");
  assert.equal(fragment.edges[0]?.evidence.length, 2, "both relation field declarations remain evidence");
  assert.ok(fragment.edges.every(edge => edge.reason.includes("Prisma model fields")));
});

test("Prisma self-relations are reported as a limitation instead of silently disappearing", () => {
  const source = file("prisma/schema.prisma", `model User {\n  id Int @id\n  managerId Int?\n  manager User? @relation("Hierarchy", fields: [managerId], references: [id])\n  reports User[] @relation("Hierarchy")\n}\n`);
  const fragment = extractDataArtifacts({ ccm: {} as never, sourceCkgHash: "b".repeat(64), sources: { [source.relativePath]: source.bytes } });
  assert.equal(fragment.nodes.length, 1);
  assert.equal(fragment.edges.length, 0);
  assert.equal(fragment.limitations.length, 2);
  assert.ok(fragment.limitations.every(item => /Self-referential Prisma relation/u.test(item.reason)));
});

test("pinned SAGE route and Prisma source flow through analysis into the ADD baseline", async () => {
  const fixtureRoot = "../tests/fixtures/semantic/sage-pinned";
  const metadata = JSON.parse(readFileSync(new URL(`${fixtureRoot}/.snapshot.json`, import.meta.url), "utf8")) as {
    repository: string; commit: string;
  };
  const path = "packages/database/prisma/schema.prisma";
  const schemaBytes = new Uint8Array(readFileSync(new URL(`${fixtureRoot}/${path}`, import.meta.url)));
  const routePath = "apps/web/app/api/health/route.ts";
  const routeBytes = new Uint8Array(readFileSync(new URL(`${fixtureRoot}/${routePath}`, import.meta.url)));
  const expectedCommit = "c2dc3d84b220c572fb5b2ce85dd3605e89b11a73";
  const expectedFileSha = "965d35ca15a9e933417e3b1b26d530abb294bc3fcf8a81b2b35c3809e9be6ce7";
  const expectedRouteSha = "ae9efdca562ab19102032e934ec0d67664dbd5f6c6e2d30e82439fe6cf43118f";
  assert.equal(metadata.repository, "AgilePemdigi-2026/sage");
  assert.equal(metadata.commit, expectedCommit);
  assert.equal(createHash("sha256").update(schemaBytes).digest("hex"), expectedFileSha, "the schema fixture remains pinned to its source artifact");
  assert.equal(createHash("sha256").update(routeBytes).digest("hex"), expectedRouteSha, "the route fixture remains pinned to its source artifact");

  const { analyzed, semantic, add } = await project([
    file(path, schemaBytes), file(routePath, routeBytes),
  ], { repository: metadata.repository, branch: "pinned", commitSha: metadata.commit });
  assert.ok(analyzed.ccm);
  assert.equal(add.snapshot.repository, metadata.repository);
  assert.equal(add.snapshot.commitSha, expectedCommit);
  assert.equal(add.generation.extractorVersion, "0.6.5");
  assert.equal(semantic.sourceCkgHash, add.sourceCkgHash);
  assert.equal(add.catalogs.dataEntities.length, 17, "all source-declared Prisma models appear in the ADD data catalog");
  assert.ok(add.relationships.some(edge => edge.type === "AssociationRelationship"), "declared model references reach the Data Structure relationships");
  assert.ok(add.elements.some(element => element.type === "ApplicationInterface"), "the pinned route reaches the Application Architecture model");
  assert.equal(add.catalogs.dataEntities.every(item => item.owner === null), true, "Prisma does not establish business ownership");
  assert.equal(add.matrices.applicationInteractions.length, 0, "a repository snapshot does not establish cross-application integration");
  assert.equal(add.matrices.applicationData.length, 0, "schema declarations alone do not prove CRUD operations");

  const sourceMap = new Map([[path, schemaBytes], [routePath, routeBytes]]);
  const evidence = [...add.elements.flatMap(element => element.evidence), ...add.relationships.flatMap(edge => edge.evidence)];
  for (const span of evidence) {
    const bytes = sourceMap.get(span.filePath);
    assert.ok(bytes, `evidence path is in the pinned test input: ${span.filePath}`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), span.fileSha256);
    assert.ok(span.startByte >= 0 && span.startByte < span.endByte && span.endByte <= bytes.byteLength);
  }
});

test("source order does not change the pinned model hash, ADD hash, or evidence", async () => {
  const files = [
    file("src/app/api/posts/route.ts", "export async function GET() { return Response.json({ ok: true }); }\n"),
    file("prisma/schema.prisma", prismaSchema),
  ];
  const first = await project(files);
  const reversed = await project([...files].reverse());
  assert.equal(first.add.snapshot.commitSha, reversed.add.snapshot.commitSha);
  assert.equal(semanticModelHash(first.semantic), semanticModelHash(reversed.semantic));
  assert.equal(createHash("sha256").update(JSON.stringify(first.add)).digest("hex"),
    createHash("sha256").update(JSON.stringify(reversed.add)).digest("hex"));
});
