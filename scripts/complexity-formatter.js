// ESLint formatter that prints a per-function complexity report from the `complexity` rule's
// messages. ESLint only names declared functions and methods, so this recovers names for arrow
// functions and function expressions from the surrounding code (e.g. `const createApp = () =>`).
//
// Usage: eslint --rule '{"complexity":["warn",{"max":0}]}' -f ./scripts/complexity-formatter.js src

import path from 'node:path';
import ts from 'typescript';

const COMPLEXITY_PATTERN = /^(.*) has a complexity of (\d+)\./;

const isFunctionNode = (node) =>
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node) ||
  ts.isConstructorDeclaration(node);

// The innermost function whose text contains the position ESLint reported (the function head).
const findFunctionAt = (node, position) => {
  const child = node
    .getChildren()
    .find((candidate) => candidate.getStart() <= position && position < candidate.getEnd());
  const inner = child ? findFunctionAt(child, position) : null;
  return inner ?? (isFunctionNode(node) ? node : null);
};

const collapseWhitespace = (text) => text.replace(/\s+/g, ' ');

const describeCallback = (call) => {
  const callee = collapseWhitespace(call.expression.getText());
  const firstArgument = call.arguments[0];
  return firstArgument && ts.isStringLiteralLike(firstArgument)
    ? `${callee}('${firstArgument.text}') callback`
    : `${callee} callback`;
};

const nameFunction = (fn) => {
  const parent = fn.parent;
  if (fn.name) {
    return fn.name.getText();
  }
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
    return parent.name.getText();
  }
  if (ts.isCallExpression(parent) && parent.arguments.includes(fn)) {
    return describeCallback(parent);
  }
  return '(anonymous)';
};

const nameFunctionAt = (sourceFile, line, column) => {
  const position = sourceFile.getPositionOfLineAndCharacter(line - 1, column - 1);
  const fn = findFunctionAt(sourceFile, position);
  return fn ? nameFunction(fn) : '(unknown)';
};

const toRows = (result, cwd) => {
  const sourceFile = ts.createSourceFile(result.filePath, result.source ?? '', ts.ScriptTarget.Latest, true);
  const file = path.relative(cwd, result.filePath);
  return result.messages
    .filter((message) => message.ruleId === 'complexity')
    .map((message) => {
      const [, kind, complexity] = COMPLEXITY_PATTERN.exec(message.message) ?? ['', message.message, '0'];
      return {
        complexity: Number(complexity),
        location: `${file}:${message.line}:${message.column}`,
        kind,
        name: result.source === undefined ? '(unknown)' : nameFunctionAt(sourceFile, message.line, message.column),
      };
    });
};

const byComplexityThenLocation = (a, b) =>
  b.complexity - a.complexity || a.location.localeCompare(b.location, undefined, { numeric: true });

const renderTable = (rows) => {
  const headings = { complexity: 'Complexity', location: 'Location', name: 'Function', kind: 'Kind' };
  const columns = ['complexity', 'location', 'name', 'kind'];
  const widths = columns.map((column) =>
    rows.reduce((width, row) => Math.max(width, String(row[column]).length), headings[column].length),
  );
  const renderLine = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ').trimEnd();
  return [renderLine(columns.map((column) => headings[column])), renderLine(widths.map((width) => '-'.repeat(width)))]
    .concat(rows.map((row) => renderLine(columns.map((column) => row[column]))))
    .join('\n');
};

const formatComplexityReport = (results, context) => {
  const rows = results.flatMap((result) => toRows(result, context.cwd)).sort(byComplexityThenLocation);
  return rows.length === 0
    ? 'No complexity results. Run with --rule \'{"complexity":["warn",{"max":0}]}\' to report every function.'
    : `${renderTable(rows)}\n\n${rows.length} functions analyzed.`;
};

export default formatComplexityReport;
