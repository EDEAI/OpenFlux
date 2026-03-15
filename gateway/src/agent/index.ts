/**
 * Agent 模块入口
 */

export { runAgentLoop, createAgentLoopRunner, type AgentLoopConfig, type AgentLoopResult } from './loop';
export { createSubAgentExecutor, formatSubAgentReport, type SubAgentConfig } from './subagent';
export { AgentManager, type AgentManagerOptions } from './manager';
export { CollaborationManager, getCollaborationManager, type CollaborationSession, type CollabMessage, type CollabBatchTask, type CollabBatchResult, type CollabWaitAllResult, type CollabAgentInfo, type CollabSessionCompleteCallback } from './collaboration';
export { routeToAgent, type RouteResult } from './router';

// 工具调用类型统一使用 LLMToolCall（从 llm/provider 导出）
export type { LLMToolCall } from '../llm/provider';
