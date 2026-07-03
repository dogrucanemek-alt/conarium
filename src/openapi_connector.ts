import fs from 'fs';
import * as yaml from 'js-yaml';
import fetch from 'node-fetch';
import { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * Loads an OpenAPI specification from a URL or a local file path.
 */
async function loadSpec(source: string): Promise<any> {
  let rawText = '';
  
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const res = await fetch(source);
    if (!res.ok) {
      throw new Error(`Failed to fetch OpenAPI spec from ${source}: ${res.statusText}`);
    }
    rawText = await res.text();
  } else {
    rawText = fs.readFileSync(source, 'utf8');
  }

  // Try parsing as JSON first, fallback to YAML
  try {
    return JSON.parse(rawText);
  } catch (err) {
    try {
      return yaml.load(rawText);
    } catch (yamlErr) {
      throw new Error(`Failed to parse OpenAPI spec as JSON or YAML. JSON error: ${err}, YAML error: ${yamlErr}`);
    }
  }
}

/**
 * Resolves $ref in OpenAPI schema
 */
function resolveRef(obj: any, doc: any): any {
  if (!obj || typeof obj !== 'object') return obj;
  if ('$ref' in obj && typeof obj.$ref === 'string') {
    const ref = obj.$ref;
    if (ref.startsWith('#/')) {
      const parts = ref.slice(2).split('/');
      let current = doc;
      for (const part of parts) {
        if (current && typeof current === 'object' && part in current) {
          current = current[part];
        } else {
          return obj;
        }
      }
      return resolveRef(current, doc);
    }
  }
  return obj;
}

/**
 * Converts OpenAPI parameters and requestBody to JSON Schema for MCP inputSchema
 */
function buildInputSchema(operation: any, pathParameters: any[], doc: any): any {
  const schema: any = {
    type: 'object',
    properties: {},
    required: []
  };

  const mergedParams = [...(pathParameters || []), ...(operation.parameters || [])];

  // Handle parameters (query, path, header)
  for (const paramRef of mergedParams) {
    const param = resolveRef(paramRef, doc);
    if (!param || !param.name) continue;

    const paramSchema = resolveRef(param.schema, doc) || { type: 'string' };
    schema.properties[param.name] = {
      ...paramSchema,
      description: param.description || paramSchema.description || `Parameter in ${param.in}`
    };

    if (param.required) {
      schema.required.push(param.name);
    }
  }

  // Handle requestBody
  if (operation.requestBody) {
    const body = resolveRef(operation.requestBody, doc);
    if (body.content) {
      const contentKey = Object.keys(body.content).find(k => k.includes('application/json')) || Object.keys(body.content)[0];
      if (contentKey && body.content[contentKey].schema) {
        const bodySchema = resolveRef(body.content[contentKey].schema, doc);
        
        if (bodySchema.type === 'object' && bodySchema.properties) {
          for (const propName of Object.keys(bodySchema.properties)) {
            const prop = resolveRef(bodySchema.properties[propName], doc);
            schema.properties[propName] = prop;
            
            if (bodySchema.required && Array.isArray(bodySchema.required) && bodySchema.required.includes(propName)) {
              schema.required.push(propName);
            }
          }
        } else {
          schema.properties['body'] = bodySchema;
          if (body.required) {
            schema.required.push('body');
          }
        }
      }
    }
  }

  // If no required properties, we can omit the array to be cleaner
  if (schema.required.length === 0) {
    delete schema.required;
  }

  return schema;
}

/**
 * Parses an OpenAPI spec and returns a list of MCP Tool definitions.
 */
export async function generateMcpToolsFromSpec(source: string): Promise<Tool[]> {
  const doc = await loadSpec(source);
  const paths = doc.paths || {};
  const tools: Tool[] = [];

  for (const path of Object.keys(paths)) {
    const pathItem = paths[path];
    const pathParameters = pathItem.parameters || [];

    for (const method of Object.keys(pathItem)) {
      if (!['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'trace'].includes(method.toLowerCase())) {
        continue;
      }

      const operation = pathItem[method];
      
      // operationId or fallback
      let name = operation.operationId;
      if (!name) {
        name = `${method.toLowerCase()}_${path.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`;
      }

      const summary = operation.summary || operation.description || `Call ${method.toUpperCase()} ${path}`;
      const inputSchema = buildInputSchema(operation, pathParameters, doc);

      tools.push({
        name,
        description: summary,
        inputSchema
      });
    }
  }

  return tools;
}
