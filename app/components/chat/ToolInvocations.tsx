import { AnimatePresence, motion } from 'framer-motion';
  import { memo, useMemo, useState } from 'react';
  import { classNames } from '~/utils/classNames';
  import {
    TOOL_EXECUTION_APPROVAL,
    TOOL_EXECUTION_DENIED,
    TOOL_EXECUTION_ERROR,
    TOOL_NO_EXECUTE_FUNCTION,
  } from '~/utils/constants';
  import { cubicEasingFn } from '~/utils/easings';
  import { logger } from '~/utils/logger';

  interface ToolInvocationUIPart {
    type: 'tool-invocation';
    toolInvocation: {
      state: 'call' | 'result' | 'partial-call';
      toolCallId: string;
      toolName: string;
      args: any;
      result?: any;
    };
  }

  interface ToolCallAnnotation {
    toolCallId: string;
    serverName?: string;
    toolDescription?: string;
  }

  interface JsonCodeBlockProps {
    className?: string;
    code: string;
  }

  function JsonCodeBlock({ className, code }: JsonCodeBlockProps) {
    let formattedCode = code;

    try {
      if (typeof formattedCode === 'object') {
        formattedCode = JSON.stringify(formattedCode, null, 2);
      } else if (typeof formattedCode === 'string') {
        try {
          const parsed = JSON.parse(formattedCode);
          formattedCode = JSON.stringify(parsed, null, 2);
        } catch {
          // not json, keep as is
        }
      }
    } catch (e) {
      logger.error('Failed to parse JSON', { error: e });
    }

    return (
      <pre
        className={classNames(
          'text-xs rounded-md overflow-auto bg-[#FAFAFA] dark:bg-[#0A0A0A] p-3 text-bolt-elements-textPrimary mcp-tool-invocation-code',
          className,
        )}
      >
        {formattedCode}
      </pre>
    );
  }

  interface ToolInvocationsProps {
    toolInvocations: ToolInvocationUIPart[];
    toolCallAnnotations: ToolCallAnnotation[];
    addToolResult: ({ toolCallId, result }: { toolCallId: string; result: any }) => void;
  }

  export const ToolInvocations = memo(({ toolInvocations, toolCallAnnotations, addToolResult }: ToolInvocationsProps) => {
    const [showDetails, setShowDetails] = useState(false);

    const toolCalls = useMemo(
      () => toolInvocations.filter((inv) => inv.toolInvocation.state === 'call'),
      [toolInvocations],
    );

    const toolResults = useMemo(
      () => toolInvocations.filter((inv) => inv.toolInvocation.state === 'result'),
      [toolInvocations],
    );

    const hasToolCalls = toolCalls.length > 0;
    const hasToolResults = toolResults.length > 0;

    if (!hasToolCalls && !hasToolResults) {
      return null;
    }

    return (
      <div className="tool-invocation border border-bolt-elements-borderColor flex flex-col overflow-hidden rounded-lg w-full transition-border duration-150 mt-4 mb-4">
        <div className="flex">
          <button
            className="flex items-stretch bg-bolt-elements-artifacts-background hover:bg-bolt-elements-artifacts-backgroundHover w-full overflow-hidden"
            onClick={() => setShowDetails((prev) => !prev)}
          >
            <div className="p-2">
              <div className="i-ph:wrench text-xl text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary transition-colors"></div>
            </div>
            <div className="bg-bolt-elements-artifacts-borderColor w-[1px]" />
            <div className="px-5 p-2 w-full text-left">
              <div className="w-full text-bolt-elements-textPrimary font-medium leading-5 text-sm">
                MCP Tool Invocations{' '}
                {hasToolResults && (
                  <span className="text-bolt-elements-textSecondary text-xs mt-0.5">
                    ({toolResults.length} tool{toolResults.length !== 1 ? 's' : ''} used)
                  </span>
                )}
              </div>
            </div>
          </button>
          <div className="bg-bolt-elements-artifacts-borderColor w-[1px]" />
          <AnimatePresence>
            {hasToolResults && (
              <motion.button
                initial={{ width: 0 }}
                animate={{ width: 'auto' }}
                exit={{ width: 0 }}
                transition={{ duration: 0.15, ease: cubicEasingFn }}
                className="bg-bolt-elements-artifacts-background hover:bg-bolt-elements-artifacts-backgroundHover"
                onClick={() => setShowDetails((prev) => !prev)}
              >
                <div className="p-2">
                  <div
                    className={`${showDetails ? 'i-ph:caret-up-bold' : 'i-ph:caret-down-bold'} text-xl text-bolt-elements-textSecondary`}
                  ></div>
                </div>
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        <AnimatePresence>
          {hasToolCalls && (
            <motion.div
              initial={{ height: 0 }}
              animate={{ height: 'auto' }}
              exit={{ height: '0px' }}
              transition={{ duration: 0.15 }}
            >
              <div className="bg-bolt-elements-artifacts-borderColor h-[1px]" />
              <div className="p-5 text-left bg-bolt-elements-actions-background">
                <ToolCallsList
                  toolInvocations={toolCalls}
                  toolCallAnnotations={toolCallAnnotations}
                  addToolResult={addToolResult}
                />
              </div>
            </motion.div>
          )}

          {hasToolResults && showDetails && (
            <motion.div
              initial={{ height: 0 }}
              animate={{ height: 'auto' }}
              exit={{ height: '0px' }}
              transition={{ duration: 0.15 }}
            >
              <div className="bg-bolt-elements-artifacts-borderColor h-[1px]" />
              <div className="p-5 text-left bg-bolt-elements-actions-background">
                <ToolResultsList toolInvocations={toolResults} toolCallAnnotations={toolCallAnnotations} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  });

  interface ToolResultsListProps {
    toolInvocations: ToolInvocationUIPart[];
    toolCallAnnotations: ToolCallAnnotation[];
  }

  const ToolResultsList = memo(({ toolInvocations, toolCallAnnotations }: ToolResultsListProps) => {
    return (
      <div>
        <ul className="list-none space-y-4">
          {toolInvocations.map((tool, index) => {
            if (tool.toolInvocation.state !== 'result') return null;
            const { toolName, toolCallId, args, result } = tool.toolInvocation;
            const annotation = toolCallAnnotations.find((a) => a.toolCallId === toolCallId);
            const isErrorResult = [TOOL_NO_EXECUTE_FUNCTION, TOOL_EXECUTION_DENIED, TOOL_EXECUTION_ERROR].includes(result);

            return (
              <li key={index}>
                <div className="flex items-center gap-1.5 text-xs mb-1">
                  {isErrorResult ? (
                    <div className="text-lg text-bolt-elements-icon-error"><div className="i-ph:x"></div></div>
                  ) : (
                    <div className="text-lg text-bolt-elements-icon-success"><div className="i-ph:check"></div></div>
                  )}
                  <div className="text-bolt-elements-textSecondary text-xs">Server:</div>
                  <div className="text-bolt-elements-textPrimary font-semibold">{annotation?.serverName}</div>
                </div>
                <div className="ml-6 mb-2">
                  <div className="text-bolt-elements-textSecondary text-xs mb-1">
                    Tool: <span className="text-bolt-elements-textPrimary font-semibold">{toolName}</span>
                  </div>
                  <div className="text-bolt-elements-textSecondary text-xs mb-1">
                    Description: <span className="text-bolt-elements-textPrimary font-semibold">{annotation?.toolDescription}</span>
                  </div>
                  <div className="text-bolt-elements-textSecondary text-xs mb-1">Parameters:</div>
                  <JsonCodeBlock code={JSON.stringify(args)} />
                  <div className="text-bolt-elements-textSecondary text-xs mt-3 mb-1">Result:</div>
                  <JsonCodeBlock code={JSON.stringify(result)} />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    );
  });

  interface ToolCallsListProps {
    toolInvocations: ToolInvocationUIPart[];
    toolCallAnnotations: ToolCallAnnotation[];
    addToolResult: ({ toolCallId, result }: { toolCallId: string; result: any }) => void;
  }

  const ToolCallsList = memo(({ toolInvocations, toolCallAnnotations, addToolResult }: ToolCallsListProps) => {
    return (
      <div>
        <ul className="list-none space-y-4">
          {toolInvocations.map((tool, index) => {
            if (tool.toolInvocation.state !== 'call') return null;
            const { toolName, toolCallId, args } = tool.toolInvocation;
            const annotation = toolCallAnnotations.find((a) => a.toolCallId === toolCallId);

            return (
              <li key={index}>
                <div className="ml-6 mb-2">
                  <div className="text-bolt-elements-textPrimary mb-1">Bolt wants to use a tool.</div>
                  <div className="text-bolt-elements-textSecondary text-xs mb-1">
                    Server: <span className="text-bolt-elements-textPrimary font-semibold">{annotation?.serverName}</span>
                  </div>
                  <div className="text-bolt-elements-textSecondary text-xs mb-1">
                    Tool: <span className="text-bolt-elements-textPrimary font-semibold">{toolName}</span>
                  </div>
                  <div className="text-bolt-elements-textSecondary text-xs mb-1">
                    Description: <span className="text-bolt-elements-textPrimary font-semibold">{annotation?.toolDescription}</span>
                  </div>
                  <div className="text-bolt-elements-textSecondary text-xs mb-1">Parameters:</div>
                  <JsonCodeBlock code={JSON.stringify(args)} />
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      className={classNames(
                        'inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors',
                        'bg-purple-500 hover:bg-purple-600 text-white',
                      )}
                      onClick={() => addToolResult({ toolCallId, result: TOOL_EXECUTION_APPROVAL.APPROVE })}
                    >
                      Approve
                    </button>
                    <button
                      className={classNames(
                        'px-3 py-1.5 rounded-lg text-sm flex items-center gap-2 transition-all duration-200',
                        'bg-bolt-elements-background-depth-3 hover:bg-bolt-elements-background-depth-4 text-bolt-elements-textPrimary',
                      )}
                      onClick={() => addToolResult({ toolCallId, result: TOOL_EXECUTION_APPROVAL.REJECT })}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    );
  });
  