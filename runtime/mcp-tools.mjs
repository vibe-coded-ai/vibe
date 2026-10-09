// Local mirror of src/services/mcp-extractor.ts's JSDoc-to-schema mapping.
// This file is vendored with the skill, so it cannot import platform code.
function mapType(jsDocType) {
  const nullable = jsDocType.toLowerCase().match(/^(?:\?(string|number|boolean)|(string|number|boolean)\s*\|\s*null)$/);
  if (nullable) return [nullable[1] || nullable[2], 'null'];
  const typeMap = {
    string: 'string',
    number: 'number',
    boolean: 'boolean',
    object: 'object',
    array: 'array',
    'string[]': 'array',
    'number[]': 'array',
    'object[]': 'array',
    '*': 'string',
  };
  return typeMap[jsDocType.toLowerCase()] || 'string';
}

function validateTool(tool) {
  const warnings = [];
  const namePattern = /^[a-z][a-z0-9_]*$/;
  if (!namePattern.test(tool.name)) {
    warnings.push({
      tool: tool.name,
      issue: 'Tool name must be snake_case (lowercase letters, numbers, underscores only)',
      severity: 'error',
    });
  }
  if (!tool.description || tool.description.trim().length === 0) {
    warnings.push({ tool: tool.name, issue: 'Tool description is empty', severity: 'error' });
  }
  const properties = tool.inputSchema.properties;
  const paramNames = Object.keys(properties);
  if (paramNames.length !== new Set(paramNames).size) {
    warnings.push({ tool: tool.name, issue: 'Tool has duplicate parameter names', severity: 'error' });
  }
  for (const required of tool.inputSchema.required || []) {
    if (!properties[required]) {
      warnings.push({
        tool: tool.name,
        issue: `Required parameter '${required}' not found in properties`,
        severity: 'error',
      });
    }
  }
  return warnings;
}

export function extractToolsWithWarnings(workerSource) {
  const tools = [];
  const warnings = [];
  const blockRe = /\/\*\*([\s\S]*?)\*\/\s*(?:export\s+)?async\s+function\s+(\w+)\s*\(([^)]*)\)/g;
  let match;

  while ((match = blockRe.exec(workerSource)) !== null) {
    const [, doc, name, paramsString] = match;
    if (!doc.includes('@mcp-expose')) continue;

    const descMatch = doc.match(/@description\s+(.+)/);
    const description = descMatch ? descMatch[1].trim() : `${name} function`;
    const properties = {};
    const required = [];
    const paramRe = /@param\s+\{(\??\w+(?:\[\])?(?:\s*\|\s*null)?)\}\s+(\[?\w+\]?)\s*-?\s*(.*)/g;
    let paramMatch;

    while ((paramMatch = paramRe.exec(doc)) !== null) {
      const [, jsType, rawName, paramDesc] = paramMatch;
      const isOptional = rawName.startsWith('[') && rawName.endsWith(']');
      const paramName = isOptional ? rawName.slice(1, -1) : rawName;
      if (paramName === 'env') continue;

      properties[paramName] = {
        type: mapType(jsType),
        description: paramDesc.trim() || paramName,
      };

      const hasDefault = paramsString.includes(`${paramName}=`) ||
        paramsString.includes(`${paramName} =`);
      if (!isOptional && !hasDefault) required.push(paramName);
    }

    const inputSchema = { type: 'object', properties };
    if (required.length > 0) inputSchema.required = required;
    const tool = { name, description, inputSchema };
    const toolWarnings = validateTool(tool);
    warnings.push(...toolWarnings);
    if (!toolWarnings.some((warning) => warning.severity === 'error')) tools.push(tool);
  }

  // Keep local startup diagnostics aligned with the platform extractor: an
  // annotation on any other function form is ignored in production.
  const jsDocScan = /\/\*\*([\s\S]*?)\*\/\s*/g;
  const asyncFunctionRe = /^(?:export\s+)?async\s+function\s+\w+/;
  while ((match = jsDocScan.exec(workerSource)) !== null) {
    const [fullMatch, doc] = match;
    if (!doc.includes('@mcp-expose')) continue;

    const afterJsDoc = workerSource.slice(match.index + fullMatch.length);
    if (asyncFunctionRe.test(afterJsDoc)) continue;

    const arrowMatch = afterJsDoc.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/);
    const methodMatch = afterJsDoc.match(/^(?:(?:public|private|protected)\s+)?async\s+(\w+)\s*\(/);
    const nonAsyncFunctionMatch = afterJsDoc.match(/^(?:export\s+)?function\s+(\w+)/);
    const name = arrowMatch?.[1] ?? methodMatch?.[1] ?? nonAsyncFunctionMatch?.[1] ?? '<unknown>';

    let form;
    if (arrowMatch) form = 'arrow/variable assignment (const/let/var = async)';
    else if (methodMatch) form = 'class or object method';
    else if (nonAsyncFunctionMatch) form = 'non-async function';
    else form = 'unsupported form';

    warnings.push({
      tool: name,
      issue: `@mcp-expose on '${name}' (${form}) will not be extracted by the platform. ` +
        `Use 'async function ${name}(...)' or 'export async function ${name}(...)' instead.`,
      severity: 'warning',
    });
  }

  return { tools, warnings };
}

export function extractTools(workerSource) {
  return extractToolsWithWarnings(workerSource).tools;
}
