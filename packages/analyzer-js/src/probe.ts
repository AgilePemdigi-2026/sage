import ts from "typescript";

// Compatibility probe only; CCM and symbol resolution belong to ANA-03/ANA-05.
export function parseSource(source: string, fileName: string) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  return {
    parserVersion: ts.version,
    valid: diagnostics.length === 0,
    diagnostics: diagnostics.map((item) => ({ code: item.code, message: ts.flattenDiagnosticMessageText(item.messageText, "\n") })),
    statementKinds: file.statements.map((statement) => ts.SyntaxKind[statement.kind]),
  };
}
