import {
    type Message,
    type DataStreamWriter,
    convertToCoreMessages,
    formatDataStreamPart,
  } from 'ai';
  import { z } from 'zod';
  import type { ToolCallAnnotation } from '~/types/context';
  import {
    TOOL_EXECUTION_APPROVAL,
    TOOL_EXECUTION_DENIED,
    TOOL_EXECUTION_ERROR,
    TOOL_NO_EXECUTE_FUNCTION,
  } from '~/utils/constants';
  import { createScopedLogger } from '~/utils/logger';

  const logger = createScopedLogger('mcp-service');

  // Local ToolSet type (replaces ai's ToolSet which is only in newer versions)
  export type ToolSet = Record<string, {
    description?: string;
    parameters: Record<string, any>;
    execute?: (args: Record<string, unknown>, options: { messages: any[]; toolCallId: string }) => Promise<any>;
  }>;

  export const stdioServerConfigSchema = z
    .object({
      type: z.enum(['stdio']).optional(),
      command: z.string().min(1, 'Command cannot be empty'),
      args: z.array(z.string()).optional(),
      cwd: z.string().optional(),
      env: z.record(z.string()).optional(),
    })
    .transform((data) => ({
      ...data,
      type: 'stdio' as const,
    }));
  export type STDIOServerConfig = z.infer<typeof stdioServerConfigSchema>;

  export const sseServerConfigSchema = z
    .object({
      type: z.enum(['sse']).optional(),
      url: z.string().url('URL must be a valid URL format'),
      headers: z.record(z.string()).optional(),
    })
    .transform((data) => ({
      ...data,
      type: 'sse' as const,
    }));
  export type SSEServerConfig = z.infer<typeof sseServerConfigSchema>;

  export const streamableHTTPServerConfigSchema = z
    .object({
      type: z.enum(['streamable-http']).optional(),
      url: z.string().url('URL must be a valid URL format'),
      headers: z.record(z.string()).optional(),
    })
    .transform((data) => ({
      ...data,
      type: 'streamable-http' as const,
    }));

  export type StreamableHTTPServerConfig = z.infer<typeof streamableHTTPServerConfigSchema>;

  export const mcpServerConfigSchema = z.union([
    stdioServerConfigSchema,
    sseServerConfigSchema,
    streamableHTTPServerConfigSchema,
  ]);
  export type MCPServerConfig = z.infer<typeof mcpServerConfigSchema>;

  export const mcpConfigSchema = z.object({
    mcpServers: z.record(z.string(), mcpServerConfigSchema),
  });
  export type MCPConfig = z.infer<typeof mcpConfigSchema>;

  export type MCPClient = {
    tools: () => Promise<ToolSet>;
    close: () => Promise<void>;
  } & {
    serverName: string;
  };

  export type ToolCall = {
    type: 'tool-call';
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  };

  export type MCPServerTools = Record<string, MCPServer>;

  export type MCPServerAvailable = {
    status: 'available';
    tools: ToolSet;
    client: MCPClient;
    config: MCPServerConfig;
  };
  export type MCPServerUnavailable = {
    status: 'unavailable';
    error: string;
    client: MCPClient | null;
    config: MCPServerConfig;
  };
  export type MCPServer = MCPServerAvailable | MCPServerUnavailable;

  // Parse SSE response body to extract last JSON data event
  async function parseSSEResponse(response: Response): Promise<any> {
    const text = await response.text();
    const lines = text.split('\n');
    let lastData: string | null = null;

    for (const line of lines) {
      if (line.startsWith('data:')) {
        lastData = line.slice(5).trim();
      }
    }

    if (!lastData) {
      throw new Error('No data found in SSE response');
    }

    return JSON.parse(lastData);
  }

  // Native HTTP MCP client (replaces experimental_createMCPClient)
  async function createHTTPMCPClient(
    url: string,
    headers?: Record<string, string>,
  ): Promise<{ tools: () => Promise<ToolSet>; close: () => Promise<void> }> {
    let requestId = 1;

    async function sendRequest(method: string, params?: Record<string, unknown>): Promise<any> {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: requestId++,
        method,
        ...(params !== undefined ? { params } : {}),
      });

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...headers,
        },
        body,
      });

      if (!response.ok) {
        throw new Error(`MCP request failed: ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get('Content-Type') || '';

      if (contentType.includes('text/event-stream')) {
        return parseSSEResponse(response);
      }

      return response.json();
    }

    // Initialize MCP session
    await sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'bolt.diy', version: '1.0.0' },
    });

    // Send initialized notification (fire-and-forget, errors ignored)
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }).catch(() => {});

    return {
      tools: async (): Promise<ToolSet> => {
        const result = await sendRequest('tools/list');

        if (result?.error) {
          throw new Error(result.error.message || 'Failed to list tools');
        }

        const mcpTools: any[] = result?.result?.tools || [];
        const toolSet: ToolSet = {};

        for (const tool of mcpTools) {
          const toolName: string = tool.name;
          const inputSchema = tool.inputSchema || { type: 'object', properties: {} };

          toolSet[toolName] = {
            description: tool.description || '',
            parameters: inputSchema,
            execute: async (args: Record<string, unknown>, options: { messages: any[]; toolCallId: string }) => {
              const callResult = await sendRequest('tools/call', {
                name: toolName,
                arguments: args,
              });

              if (callResult?.error) {
                throw new Error(callResult.error.message || 'Tool call failed');
              }

              return callResult?.result;
            },
          };
        }

        return toolSet;
      },
      close: async () => {
        // HTTP is stateless; nothing to close
      },
    };
  }

  export class MCPService {
    private static _instance: MCPService;
    private _tools: ToolSet = {};
    private _toolsWithoutExecute: ToolSet = {};
    private _mcpToolsPerServer: MCPServerTools = {};
    private _toolNamesToServerNames = new Map<string, string>();
    private _config: MCPConfig = {
      mcpServers: {},
    };

    static getInstance(): MCPService {
      if (!MCPService._instance) {
        MCPService._instance = new MCPService();
      }

      return MCPService._instance;
    }

    private _validateServerConfig(serverName: string, config: any): MCPServerConfig {
      const hasStdioField = config.command !== undefined;
      const hasUrlField = config.url !== undefined;

      if (hasStdioField && hasUrlField) {
        throw new Error(`cannot have "command" and "url" defined for the same server.`);
      }

      if (!config.type && hasStdioField) {
        config.type = 'stdio';
      }

      if (hasUrlField && !config.type) {
        throw new Error(`missing "type" field, only "sse" and "streamable-http" are valid options.`);
      }

      if (!['stdio', 'sse', 'streamable-http'].includes(config.type)) {
        throw new Error(`provided "type" is invalid, only "stdio", "sse" or "streamable-http" are valid options.`);
      }

      if (config.type === 'stdio' && !hasStdioField) {
        throw new Error(`missing "command" field.`);
      }

      if (['sse', 'streamable-http'].includes(config.type) && !hasUrlField) {
        throw new Error(`missing "url" field.`);
      }

      try {
        return mcpServerConfigSchema.parse(config);
      } catch (validationError) {
        if (validationError instanceof z.ZodError) {
          const errorMessages = validationError.errors.map((err) => `${err.path.join('.')}: ${err.message}`).join('; ');
          throw new Error(`Invalid configuration for server "${serverName}": ${errorMessages}`);
        }

        throw validationError;
      }
    }

    async updateConfig(config: MCPConfig) {
      logger.debug('updating config', JSON.stringify(config));
      this._config = config;
      await this._createClients();

      return this._mcpToolsPerServer;
    }

    private async _createHTTPClient(
      serverName: string,
      config: SSEServerConfig | StreamableHTTPServerConfig,
    ): Promise<MCPClient> {
      logger.debug(`Creating HTTP MCP client for ${serverName} with URL: ${config.url}`);
      const client = await createHTTPMCPClient(config.url, config.headers);

      return Object.assign(client, { serverName });
    }

    private async _createStdioClient(_serverName: string, _config: STDIOServerConfig): Promise<MCPClient> {
      throw new Error(
        'STDIO transport is not supported in Cloudflare Workers. Please use type "sse" or "streamable-http" with a URL instead.',
      );
    }

    private _registerTools(serverName: string, tools: ToolSet) {
      for (const [toolName, tool] of Object.entries(tools)) {
        if (this._tools[toolName]) {
          const existingServerName = this._toolNamesToServerNames.get(toolName);

          if (existingServerName && existingServerName !== serverName) {
            logger.warn(`Tool conflict: "${toolName}" from "${serverName}" overrides tool from "${existingServerName}"`);
          }
        }

        this._tools[toolName] = tool;
        this._toolsWithoutExecute[toolName] = { ...tool, execute: undefined };
        this._toolNamesToServerNames.set(toolName, serverName);
      }
    }

    private async _createMCPClient(serverName: string, serverConfig: MCPServerConfig): Promise<MCPClient> {
      const validatedConfig = this._validateServerConfig(serverName, serverConfig);

      if (validatedConfig.type === 'stdio') {
        return await this._createStdioClient(serverName, serverConfig as STDIOServerConfig);
      } else {
        // Both 'sse' and 'streamable-http' use HTTP POST transport
        return await this._createHTTPClient(serverName, serverConfig as SSEServerConfig | StreamableHTTPServerConfig);
      }
    }

    private async _createClients() {
      await this._closeClients();

      const createClientPromises = Object.entries(this._config?.mcpServers || []).map(async ([serverName, config]) => {
        let client: MCPClient | null = null;

        try {
          client = await this._createMCPClient(serverName, config);

          try {
            const tools = await client.tools();

            this._registerTools(serverName, tools);

            this._mcpToolsPerServer[serverName] = {
              status: 'available',
              client,
              tools,
              config,
            };
          } catch (error) {
            logger.error(`Failed to get tools from server ${serverName}:`, error);
            this._mcpToolsPerServer[serverName] = {
              status: 'unavailable',
              error: 'could not retrieve tools from server',
              client,
              config,
            };
          }
        } catch (error) {
          logger.error(`Failed to initialize MCP client for server: ${serverName}`, error);
          this._mcpToolsPerServer[serverName] = {
            status: 'unavailable',
            error: (error as Error).message,
            client,
            config,
          };
        }
      });

      await Promise.allSettled(createClientPromises);
    }

    async checkServersAvailabilities() {
      this._tools = {};
      this._toolsWithoutExecute = {};
      this._toolNamesToServerNames.clear();

      const checkPromises = Object.entries(this._mcpToolsPerServer).map(async ([serverName, server]) => {
        let client = server.client;

        try {
          logger.debug(`Checking MCP server "${serverName}" availability: start`);

          if (!client) {
            client = await this._createMCPClient(serverName, this._config?.mcpServers[serverName]);
          }

          try {
            const tools = await client.tools();

            this._registerTools(serverName, tools);

            this._mcpToolsPerServer[serverName] = {
              status: 'available',
              client,
              tools,
              config: server.config,
            };
          } catch (error) {
            logger.error(`Failed to get tools from server ${serverName}:`, error);
            this._mcpToolsPerServer[serverName] = {
              status: 'unavailable',
              error: 'could not retrieve tools from server',
              client,
              config: server.config,
            };
          }

          logger.debug(`Checking MCP server "${serverName}" availability: end`);
        } catch (error) {
          logger.error(`Failed to connect to server ${serverName}:`, error);
          this._mcpToolsPerServer[serverName] = {
            status: 'unavailable',
            error: 'could not connect to server',
            client,
            config: server.config,
          };
        }
      });

      await Promise.allSettled(checkPromises);

      return this._mcpToolsPerServer;
    }

    private async _closeClients(): Promise<void> {
      const closePromises = Object.entries(this._mcpToolsPerServer).map(async ([serverName, server]) => {
        if (!server.client) {
          return;
        }

        logger.debug(`Closing client for server "${serverName}"`);

        try {
          await server.client.close();
        } catch (error) {
          logger.error(`Error closing client for ${serverName}:`, error);
        }
      });

      await Promise.allSettled(closePromises);
      this._tools = {};
      this._toolsWithoutExecute = {};
      this._mcpToolsPerServer = {};
      this._toolNamesToServerNames.clear();
    }

    isValidToolName(toolName: string): boolean {
      return toolName in this._tools;
    }

    processToolCall(toolCall: ToolCall, dataStream: DataStreamWriter): void {
      const { toolCallId, toolName } = toolCall;

      if (this.isValidToolName(toolName)) {
        const { description = 'No description available' } = this.toolsWithoutExecute[toolName];
        const serverName = this._toolNamesToServerNames.get(toolName);

        if (serverName) {
          dataStream.writeMessageAnnotation({
            type: 'toolCall',
            toolCallId,
            serverName,
            toolName,
            toolDescription: description,
          } satisfies ToolCallAnnotation);
        }
      }
    }

    async processToolInvocations(messages: Message[], dataStream: DataStreamWriter): Promise<Message[]> {
      const lastMessage = messages[messages.length - 1];
      const parts = (lastMessage as any).parts;

      if (!parts) {
        return messages;
      }

      const processedParts = await Promise.all(
        parts.map(async (part: any) => {
          if (part.type !== 'tool-invocation') {
            return part;
          }

          const { toolInvocation } = part;
          const { toolName, toolCallId } = toolInvocation;

          if (!this.isValidToolName(toolName) || toolInvocation.state !== 'result') {
            return part;
          }

          let result;

          if (toolInvocation.result === TOOL_EXECUTION_APPROVAL.APPROVE) {
            const toolInstance = this._tools[toolName];

            if (toolInstance && typeof toolInstance.execute === 'function') {
              logger.debug(`calling tool "${toolName}" with args: ${JSON.stringify(toolInvocation.args)}`);

              try {
                result = await toolInstance.execute(toolInvocation.args, {
                  messages: convertToCoreMessages(messages),
                  toolCallId,
                });
              } catch (error) {
                logger.error(`error while calling tool "${toolName}":`, error);
                result = TOOL_EXECUTION_ERROR;
              }
            } else {
              result = TOOL_NO_EXECUTE_FUNCTION;
            }
          } else if (toolInvocation.result === TOOL_EXECUTION_APPROVAL.REJECT) {
            result = TOOL_EXECUTION_DENIED;
          } else {
            return part;
          }

          dataStream.write(
            formatDataStreamPart('tool_result', {
              toolCallId,
              result,
            }),
          );

          return {
            ...part,
            toolInvocation: {
              ...toolInvocation,
              result,
            },
          };
        }),
      );

      return [...messages.slice(0, -1), { ...lastMessage, parts: processedParts }];
    }

    get tools() {
      return this._tools;
    }

    get toolsWithoutExecute() {
      return this._toolsWithoutExecute;
    }
  }
  