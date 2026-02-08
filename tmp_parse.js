const ts = require('typescript');
const fs = require('fs');
const src = fs.readFileSync('src/collections/collections.service.ts', 'utf8');
const sf = ts.createSourceFile('collections.service.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const diags = sf.parseDiagnostics;
console.log(diags.length);
for (const d of diags.slice(0, 10)) {
  const lc = sf.getLineAndCharacterOfPosition(d.start || 0);
  console.log(lc.line + 1, lc.character + 1, ts.flattenDiagnosticMessageText(d.messageText, ' '));
}
