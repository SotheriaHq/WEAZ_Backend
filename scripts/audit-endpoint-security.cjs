const fs = require('node:fs'),
  path = require('node:path'),
  ts = require('typescript');
const root = path.resolve(__dirname, '../src');
const files = [];
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.controller.ts')) files.push(p);
  }
}
walk(root);
const decs = (n) => (ts.canHaveDecorators(n) ? ts.getDecorators(n) : []) || [];
const call = (d, name) =>
  ts.isCallExpression(d.expression) &&
  d.expression.expression.getText() === name;
const guards = (n) =>
  decs(n)
    .filter((d) => call(d, 'UseGuards'))
    .flatMap((d) => d.expression.arguments.map((a) => a.getText()));
const has = (n, name) => decs(n).some((d) => call(d, name));
const route = (n) =>
  decs(n)
    .filter(
      (d) =>
        ts.isCallExpression(d.expression) &&
        /^(Get|Post|Put|Patch|Delete|Head|Options|All)$/.test(
          d.expression.expression.getText(),
        ),
    )
    .map((d) => ({
      verb: d.expression.expression.getText().toUpperCase(),
      path: d.expression.arguments[0]?.getText() || "''",
    }));
const rows = [];
for (const f of files) {
  const source = ts.createSourceFile(
    f,
    fs.readFileSync(f, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const cls of source.statements.filter(ts.isClassDeclaration)) {
    if (!has(cls, 'Controller')) continue;
    const prefix =
      decs(cls)
        .find((d) => call(d, 'Controller'))
        .expression.arguments[0]?.getText() || "''";
    for (const m of cls.members.filter(ts.isMethodDeclaration)) {
      for (const r of route(m)) {
        rows.push({
          file: path.relative(root, f).replaceAll('\\', '/'),
          line: source.getLineAndCharacterOfPosition(m.getStart()).line + 1,
          class: cls.name?.getText(),
          method: m.name.getText(),
          prefix,
          ...r,
          guards: [...guards(cls), ...guards(m)],
          public: has(m, 'IsPublic') || has(cls, 'IsPublic'),
          throttle: has(m, 'Throttle') || has(cls, 'Throttle'),
          skipThrottle: has(m, 'SkipThrottle') || has(cls, 'SkipThrottle'),
        });
      }
    }
  }
}
console.log(JSON.stringify(rows, null, 2));
