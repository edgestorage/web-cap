import ts from 'typescript';

export type StaticGotoLoopIssueKind =
  | 'entry_always_returns_goto'
  | 'all_if_else_branches_return_goto'
  | 'infinite_loop_returns_goto'
  | 'same_static_goto_return';

export interface StaticGotoLoopIssue {
  kind: StaticGotoLoopIssueKind;
  message: string;
}

interface ReturnInfo {
  kind: 'goto' | 'other';
  signature?: string;
}

interface FlowSummary {
  returns: ReturnInfo[];
  mayFallThrough: boolean;
}

export function analyzeStaticGotoLoops(code: string): StaticGotoLoopIssue[] {
  const sourceFile = ts.createSourceFile(
    'web-cap-script.js',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const issues: StaticGotoLoopIssue[] = [];
  const entry = readEntryBody(sourceFile);
  const summary = entry
    ? analyzeBody(entry, sourceFile, issues)
    : analyzeStatements(sourceFile.statements, sourceFile, issues);
  const gotoReturns = summary.returns.filter((item) => item.kind === 'goto');

  if (gotoReturns.length > 0 && gotoReturns.length === summary.returns.length && !summary.mayFallThrough) {
    issues.push({
      kind: 'entry_always_returns_goto',
      message: 'The script entry point only returns cap.goto(...) and has no final result branch.',
    });
  }

  const staticSignatures = gotoReturns
    .map((item) => item.signature)
    .filter((signature): signature is string => signature !== undefined);
  if (
    gotoReturns.length > 1 &&
    staticSignatures.length === gotoReturns.length &&
    new Set(staticSignatures).size === 1
  ) {
    issues.push({
      kind: 'same_static_goto_return',
      message: 'Multiple return paths use the same static cap.goto(url, input) continuation.',
    });
  }

  return dedupeIssues(issues);
}

export function assertNoStaticGotoLoops(code: string): void {
  const issues = analyzeStaticGotoLoops(code);
  if (issues.length === 0) {
    return;
  }
  throw new Error(`Script static cap.goto check failed: ${issues.map((issue) => issue.message).join(' ')}`);
}

function analyzeBody(
  body: ts.Block | ts.Expression,
  sourceFile: ts.SourceFile,
  issues: StaticGotoLoopIssue[],
): FlowSummary {
  if (ts.isBlock(body)) {
    return analyzeStatements(body.statements, sourceFile, issues);
  }
  return {
    returns: [readExpressionReturn(body, sourceFile)],
    mayFallThrough: false,
  };
}

function analyzeStatements(
  statements: ts.NodeArray<ts.Statement> | readonly ts.Statement[],
  sourceFile: ts.SourceFile,
  issues: StaticGotoLoopIssue[],
): FlowSummary {
  const returns: ReturnInfo[] = [];
  let mayFallThrough = true;

  for (const statement of statements) {
    if (!mayFallThrough) {
      break;
    }
    const summary = analyzeStatement(statement, sourceFile, issues);
    returns.push(...summary.returns);
    mayFallThrough = summary.mayFallThrough;
  }

  return { returns, mayFallThrough };
}

function analyzeStatement(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
  issues: StaticGotoLoopIssue[],
): FlowSummary {
  if (ts.isReturnStatement(statement)) {
    return {
      returns: [readExpressionReturn(statement.expression, sourceFile)],
      mayFallThrough: false,
    };
  }

  if (ts.isBlock(statement)) {
    return analyzeStatements(statement.statements, sourceFile, issues);
  }

  if (ts.isIfStatement(statement)) {
    const thenSummary = analyzeStatementAsBody(statement.thenStatement, sourceFile, issues);
    const elseSummary = statement.elseStatement
      ? analyzeStatementAsBody(statement.elseStatement, sourceFile, issues)
      : { returns: [], mayFallThrough: true };
    const returns = [...thenSummary.returns, ...elseSummary.returns];
    const mayFallThrough = thenSummary.mayFallThrough || elseSummary.mayFallThrough;
    if (
      statement.elseStatement &&
      returns.length > 0 &&
      returns.every((item) => item.kind === 'goto') &&
      !mayFallThrough
    ) {
      issues.push({
        kind: 'all_if_else_branches_return_goto',
        message: 'Every branch of an if/else returns cap.goto(...) with no final result branch.',
      });
    }
    return { returns, mayFallThrough };
  }

  if (isInfiniteLoopStatement(statement)) {
    const bodySummary = analyzeStatementAsBody(statement.statement, sourceFile, issues);
    if (
      bodySummary.returns.length > 0 &&
      bodySummary.returns.every((item) => item.kind === 'goto') &&
      !bodySummary.mayFallThrough
    ) {
      issues.push({
        kind: 'infinite_loop_returns_goto',
        message: 'An infinite loop returns cap.goto(...) without a final result branch.',
      });
      return { returns: bodySummary.returns, mayFallThrough: false };
    }
    return { returns: bodySummary.returns, mayFallThrough: true };
  }

  return { returns: [], mayFallThrough: true };
}

function analyzeStatementAsBody(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
  issues: StaticGotoLoopIssue[],
): FlowSummary {
  return ts.isBlock(statement)
    ? analyzeStatements(statement.statements, sourceFile, issues)
    : analyzeStatement(statement, sourceFile, issues);
}

function readExpressionReturn(
  expression: ts.Expression | undefined,
  sourceFile: ts.SourceFile,
): ReturnInfo {
  if (!expression) {
    return { kind: 'other' };
  }
  const call = readCapGotoCall(skipExpressionParens(expression));
  if (!call) {
    return { kind: 'other' };
  }
  return {
    kind: 'goto',
    signature: readStaticGotoSignature(call, sourceFile),
  };
}

function readCapGotoCall(expression: ts.Expression): ts.CallExpression | undefined {
  if (!ts.isCallExpression(expression)) {
    return undefined;
  }
  const callee = skipExpressionParens(expression.expression);
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'goto' &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'cap'
  ) {
    return expression;
  }
  if (
    ts.isElementAccessExpression(callee) &&
    ts.isStringLiteral(callee.argumentExpression) &&
    callee.argumentExpression.text === 'goto' &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'cap'
  ) {
    return expression;
  }
  return undefined;
}

function readStaticGotoSignature(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
): string | undefined {
  const url = readStaticLiteralValue(call.arguments[0], sourceFile);
  const input = call.arguments[1]
    ? readStaticLiteralValue(call.arguments[1], sourceFile)
    : '{}';
  if (url === undefined || input === undefined) {
    return undefined;
  }
  return `${url}\n${input}`;
}

function readStaticLiteralValue(
  node: ts.Node | undefined,
  sourceFile: ts.SourceFile,
): string | undefined {
  if (!node) {
    return undefined;
  }
  const value = skipExpressionParens(node as ts.Expression);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return JSON.stringify(value.text);
  }
  if (ts.isNumericLiteral(value)) {
    return value.text;
  }
  if (value.kind === ts.SyntaxKind.TrueKeyword) {
    return 'true';
  }
  if (value.kind === ts.SyntaxKind.FalseKeyword) {
    return 'false';
  }
  if (value.kind === ts.SyntaxKind.NullKeyword) {
    return 'null';
  }
  if (ts.isArrayLiteralExpression(value)) {
    const items = value.elements.map((item) => readStaticLiteralValue(item, sourceFile));
    if (items.some((item) => item === undefined)) {
      return undefined;
    }
    return `[${items.join(',')}]`;
  }
  if (ts.isObjectLiteralExpression(value)) {
    const entries: Array<[string, string]> = [];
    for (const property of value.properties) {
      if (!ts.isPropertyAssignment(property)) {
        return undefined;
      }
      const key = readStaticPropertyName(property.name);
      const item = readStaticLiteralValue(property.initializer, sourceFile);
      if (key === undefined || item === undefined) {
        return undefined;
      }
      entries.push([key, item]);
    }
    return `{${entries
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${item}`)
      .join(',')}}`;
  }
  return undefined;
}

function readStaticPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function readEntryBody(sourceFile: ts.SourceFile): ts.Block | ts.Expression | undefined {
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.body &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
      hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
    ) {
      return statement.body;
    }
    if (ts.isExportAssignment(statement)) {
      const expression = skipExpressionParens(statement.expression);
      if (isFunctionLikeWithBody(expression)) {
        return expression.body;
      }
      if (ts.isIdentifier(expression)) {
        const resolved = findTopLevelFunctionBody(sourceFile, expression.text);
        if (resolved) {
          return resolved;
        }
      }
    }
  }

  const firstStatement = sourceFile.statements[0];
  if (firstStatement && ts.isFunctionDeclaration(firstStatement) && firstStatement.body) {
    return firstStatement.body;
  }
  if (firstStatement && ts.isExpressionStatement(firstStatement)) {
    const expression = skipExpressionParens(firstStatement.expression);
    if (isFunctionLikeWithBody(expression)) {
      return expression.body;
    }
  }
  return undefined;
}

function findTopLevelFunctionBody(
  sourceFile: ts.SourceFile,
  name: string,
): ts.Block | ts.Expression | undefined {
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body) {
      return statement.body;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === name &&
          declaration.initializer
        ) {
          const initializer = skipExpressionParens(declaration.initializer);
          if (isFunctionLikeWithBody(initializer)) {
            return initializer.body;
          }
        }
      }
    }
  }
  return undefined;
}

function isFunctionLikeWithBody(
  node: ts.Expression,
): node is ts.FunctionExpression | ts.ArrowFunction {
  return (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && node.body !== undefined;
}

function isInfiniteLoopStatement(
  statement: ts.Statement,
): statement is ts.WhileStatement | ts.ForStatement {
  if (ts.isWhileStatement(statement)) {
    return statement.expression.kind === ts.SyntaxKind.TrueKeyword;
  }
  return ts.isForStatement(statement) && statement.condition === undefined;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

function skipExpressionParens(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function dedupeIssues(issues: StaticGotoLoopIssue[]): StaticGotoLoopIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.kind}\n${issue.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
