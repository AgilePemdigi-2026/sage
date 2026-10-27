BEGIN;

ALTER TABLE "GraphBundle"
  ADD COLUMN "storageLayoutVersion" INTEGER NOT NULL DEFAULT 1,
  ALTER COLUMN "nodes" DROP NOT NULL,
  ALTER COLUMN "edges" DROP NOT NULL,
  ADD CONSTRAINT "GraphBundle_storageLayoutVersion_check"
    CHECK (
      "storageLayoutVersion" IN (1, 2)
      AND (
        "storageLayoutVersion" <> 2
        OR (
          "canonicalContent" IS NOT NULL
          AND "nodes" IS NULL
          AND "edges" IS NULL
        )
      )
    );

ALTER TABLE "ArchitectureDocument"
  ADD COLUMN "storageLayoutVersion" INTEGER NOT NULL DEFAULT 1,
  ALTER COLUMN "interfaceCatalog" DROP NOT NULL,
  ALTER COLUMN "softwareEngineeringDiagram" DROP NOT NULL,
  ALTER COLUMN "umlClassDiagram" DROP NOT NULL,
  ADD CONSTRAINT "ArchitectureDocument_storageLayoutVersion_check"
    CHECK (
      "storageLayoutVersion" IN (1, 2)
      AND (
        "storageLayoutVersion" <> 2
        OR (
          "canonicalContent" IS NOT NULL
          AND "interfaceCatalog" IS NULL
          AND "softwareEngineeringDiagram" IS NULL
          AND "umlClassDiagram" IS NULL
        )
      )
    );

COMMIT;
