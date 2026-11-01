import ts from 'typescript';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const output = {};
for (const [path, text] of Object.entries(JSON.parse(input))) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const imports = [];
  const record = node => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      imports.push([node.text, source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1]);
    }
  };
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) record(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) record(node.moduleReference.expression);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) record(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(source);
  output[path] = { imports, invalid: source.parseDiagnostics.length > 0 };
}
process.stdout.write(JSON.stringify(output));
