import fetch from 'node-fetch';

export interface ExecutorConfig {
  baseUrl: string;
  authHeader?: string;
  allowedMethods?: string[];
}

export interface ExecutorRequest {
  method: string;
  path: string; // e.g., "/pet/{petId}"
  args: Record<string, any>; // Args coming from the MCP client
}

export async function executeOpenApiTool(req: ExecutorRequest, config: ExecutorConfig, customFetch?: any): Promise<any> {
  const fetcher = customFetch || fetch;
  const { args } = req;
  const method = req.method.toUpperCase();
  let { path } = req;
  const allowedMethods = (config.allowedMethods ?? ['GET']).map(m => m.toUpperCase());
  if (!allowedMethods.includes(method)) {
    throw new Error(`HTTP method ${method} is not allowed by executor policy.`);
  }
  if (/^https?:\/\//i.test(path)) {
    throw new Error('Request path must be relative, not an absolute URL.');
  }
  
  // Clean up base URL
  const baseUrl = new URL(config.baseUrl);

  const queryParams = new URLSearchParams();
  let body: any = undefined;
  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };

  if (config.authHeader) {
    headers['Authorization'] = config.authHeader;
  }

  // Very basic routing of arguments:
  // If the argument name is in the path (e.g. {petId}), replace it in the path.
  // Otherwise, if method is GET, it goes to query parameters.
  // If method is POST/PUT/PATCH, it goes to the body.
  for (const [key, value] of Object.entries(args)) {
    if (path.includes(`{${key}}`)) {
      path = path.replace(`{${key}}`, encodeURIComponent(String(value)));
    } else {
      if (['GET', 'HEAD'].includes(method)) {
        queryParams.append(key, String(value));
      } else {
        if (!body) body = {};
        // If there's an explicit "body" argument from Faz 1, use it. Otherwise mix it in.
        if (key === 'body') {
          body = value;
        } else {
          body[key] = value;
        }
      }
    }
  }

  const url = new URL(baseUrl.toString());
  const basePath = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  const requestPath = path.startsWith('/') ? path : `/${path}`;
  url.pathname = `${basePath}${requestPath}`.replace(/\/{2,}/g, '/');
  for (const [key, value] of queryParams.entries()) {
    url.searchParams.append(key, value);
  }

  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetcher(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let responseData;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    responseData = await res.json();
  } else {
    responseData = await res.text();
  }

  if (!res.ok) {
    throw new Error(`API returned ${res.status}: ${JSON.stringify(responseData)}`);
  }

  return responseData;
}
