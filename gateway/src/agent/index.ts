/**
 * Agent module entry
 */

export { runAgentLoop, createAgentLoopRunner, type AgentLoopConfig, type AgentLoopResult } from './loop';
export { createSubAgentExecutor, formatSubAgentReport, type SubAgentConfig } from './subagent';
export { AgentManager, type AgentManagerOptions } from './manager';
export { CollaborationManager, getCollaborationManager, type CollaborationSession, type CollabMessage, type CollabBatchTask, type CollabBatchResult, type CollabWaitAllResult, type CollabAgentInfo, type CollabSessionCompleteCallback } from './collaboration';
export { routeToAgent, type RouteResult } from './router';

// Tool call types use LLMToolCall (exported from llm/provider)
export type { LLMToolCall } from '../llm/provider';
