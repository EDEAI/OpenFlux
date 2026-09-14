/**
 * Opt-in, paid-model behavioral evaluation. Never imported by the app or npm test.
 * Run from gateway: tsx scripts/user-input-model-eval.ts --repeats 1
 * --dry-run validates configuration and prints cases without contacting a model.
 * --model overrides only this evaluation's model name; saved configuration is never written.
 * Expectations are evaluated locally; none are appended to the model's prompts.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OpenFluxConfig } from '../src/config/schema';
import type { LLMConfig, LLMMessage, LLMProvider, LLMToolDefinition, ChatWithToolsResponse } from '../src/llm/provider';
import type { Tool } from '../src/tools/types';
import type { PlanQuestion, PlanQuestionAnswer } from '../src/work/types';
import type { UserInputRequest } from '../src/work/user-input-types';
import { assessFollowUpQuestions, countAnswerMessages, finalQuestions, questionTopics, toolErrorSummary } from './user-input-eval-report';

interface Options { config?: string; serverConfig?: string; agent: string; model?: string; repeats: number; timeoutMs: number; dryRun: boolean; caseIds?: string[] }
interface EvalCase { id: string; input: string; expected: 'clarify_material_requirement' | 'direct_answer'; answer: string; history?: Array<{ role: 'user' | 'assistant'; content: string }> }
const cases: EvalCase[] = [
    {
        id: 'guitar_original', input: '我现在要做一个电吉他训练的工具 你有什么好的建议', expected: 'clarify_material_requirement',
        answer: '给我自己每天练电吉他用，不做给其他人使用的产品。我有一年基础，每天20分钟，主要想提高节奏稳定性和换把准确度。先做Windows浏览器里使用的网页，技术栈由你决定。请据此给出三个首版功能建议。',
    },
    {
        id: 'guitar_sufficient', input: '给自己每天练琴用的电吉他训练工具，我有一年基础，每天20分钟，重点练节奏和换把。先做Windows浏览器里的网页，技术栈由你选。请建议三个首版功能。', expected: 'direct_answer',
        answer: '上述用途、水平、时间和练习目标已明确，技术栈由你决定，请直接给三个首版功能建议。',
    },
    { id: 'arithmetic', input: '2+2等于多少？', expected: 'direct_answer', answer: '按普通十进制整数加法回答。' },
    { id: 'guitar_delegate', input: '我想做一个电吉他训练工具，所有尚未确定的产品取舍由你自行选择一个合理方案，不用问我。请给出三个首版功能建议。', expected: 'direct_answer', answer: '请按我已经给你的授权自行决定。' },
    { id: 'guitar_brainstorm', input: '我只想为电吉他训练工具做广泛脑暴，暂时不限定受众、不做具体实施方案。请列出五种不同的产品方向供我参考，不用定制个人方案。', expected: 'direct_answer', answer: '只要广泛脑暴，不需要决定受众。' },
    {
        id: 'guitar_answered', input: '根据刚才已经说明的用途和目标，给我三个首版功能建议。', expected: 'direct_answer',
        answer: '我已经回答用途和目标了，请按已有信息直接给建议。',
        history: [
            { role: 'user', content: '我现在要做一个电吉他训练的工具 你有什么好的建议' },
            { role: 'assistant', content: '这个工具主要给谁使用，最希望改善什么？用途会影响首版功能重点。' },
            { role: 'user', content: '只给我自己每天练琴用，不面向其他用户。我有一年基础，每天20分钟，想提高节奏稳定性和换把准确度。' },
        ],
    },
];

function options(argv: string[]): Options {
    const result: Options = { agent: 'coder', repeats: 1, timeoutMs: 120_000, dryRun: false };
    for (let index = 0; index < argv.length; index++) {
        const flag = argv[index];
        if (flag === '--dry-run') { result.dryRun = true; continue; }
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error('invalid_arguments');
        if (flag === '--config') result.config = resolve(value);
        else if (flag === '--server-config') result.serverConfig = resolve(value);
        else if (flag === '--agent') result.agent = value;
        else if (flag === '--model') result.model = value;
        else if (flag === '--repeats') result.repeats = Number(value);
        else if (flag === '--timeout-ms') result.timeoutMs = Number(value);
        else if (flag === '--case') result.caseIds = value.split(',').map(id => id.trim());
        else throw new Error('invalid_arguments');
    }
    if (!Number.isInteger(result.repeats) || result.repeats < 1 || result.repeats > 10
        || !Number.isInteger(result.timeoutMs) || result.timeoutMs < 1_000 || result.timeoutMs > 600_000) throw new Error('invalid_arguments');
    if (result.caseIds?.some(id => !cases.some(fixture => fixture.id === id))) throw new Error('invalid_arguments');
    return result;
}

interface ModelObservation {
    offeredTools: string[];
    returnedTools: string[];
    publicTextChars: number;
}
interface TurnObservation {
    status: string;
    modelCalls: ModelObservation[];
    auxiliaryModelCalls: number;
    executedTools: Array<{ name: string; success: boolean; errorSummary?: { code?: string; message?: string } }>;
    publicCharsBeforeQuestion: number | null;
    questionCount: number;
    questions: Array<{ id: string; prompt: string; optionLabels: string[]; topics: string[] }>;
    outputChars: number;
    outputSummary: string;
    tailQuestionsHeuristic: string[];
    error?: { name: string; category: string };
}

const originalAppData = process.env.APPDATA;
const originalCwd = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), 'openflux-user-input-eval-'));
const print = console.log.bind(console);
const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
const originals = Object.fromEntries(consoleMethods.map(method => [method, console[method]]));
for (const method of consoleMethods) console[method] = () => undefined;
// Logger construction creates its directory even when messages are suppressed.
// Keep that, transcripts, and every durable test record outside user data.
process.env.APPDATA = scratch;
const secretValues = new Set<string>();
function rememberSecrets(value: unknown, sensitive = false): void {
    if (typeof value === 'string') { if (sensitive && value.length >= 6) secretValues.add(value); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) rememberSecrets(child, sensitive || /api.?key|token|password|secret|authorization|extraheaders/i.test(key));
}
function safe(value: string, limit = 360): string {
    let text = value;
    for (const secret of secretValues) text = text.split(secret).join('[redacted]');
    return text.replace(/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}/gi, '[redacted]').slice(0, limit);
}

try {
    const args = options(process.argv.slice(2));
    const selectedCases = args.caseIds ? cases.filter(fixture => args.caseIds!.includes(fixture.id)) : cases;
    const { Logger } = await import('../src/utils/logger');
    for (const method of ['info', 'warn', 'error', 'debug'] as const) Logger.prototype[method] = () => undefined;
    const { loadConfig } = await import('../src/config/loader');
    const { OpenFluxConfigSchema } = await import('../src/config/schema');
    const { parse: parseYaml } = await import('yaml');
    const config = args.config
        ? OpenFluxConfigSchema.parse(parseYaml(readFileSync(args.config, 'utf8')))
        : await loadConfig();
    const dataRoot = originalAppData || process.env.HOME || homedir();
    const workspace = config.brandLock?.dataDir ? join(dataRoot, config.brandLock.dataDir)
        : config.workspace ? resolve(originalCwd, config.workspace) : join(dataRoot, 'OpenFlux');
    const savedPath = args.serverConfig || join(workspace, 'server-config.json');
    if (args.serverConfig && !existsSync(savedPath)) throw new Error('missing_server_config');
    const saved = existsSync(savedPath) ? JSON.parse(readFileSync(savedPath, 'utf8')) : {};
    rememberSecrets(config); rememberSecrets(saved);
    if (saved._llmSource && saved._llmSource !== 'local') throw new Error('managed_model_requires_runtime_adapter');
    const agent = config.agents?.list.find(item => item.id === args.agent)
        || (args.agent === 'coder' ? { id: 'coder', name: 'Coding Assistant', tools: { profile: 'coding' as const } } : undefined);
    if (!agent) throw new Error('agent_not_found');
    const agentOverride = saved.agents?.agentModels?.find((item: { id?: string }) => item.id === agent.id)?.model || agent.model;
    const model = { ...config.llm.orchestration, ...(saved.llm?.orchestration || {}), ...(agentOverride || {}) };
    const providerSettings = { ...(config.providers?.[model.provider] || {}), ...(saved.providers?.[model.provider] || {}) };
    const envKeys: Record<string, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', moonshot: 'MOONSHOT_API_KEY', deepseek: 'DEEPSEEK_API_KEY', zhipu: 'ZHIPU_API_KEY', dashscope: 'DASHSCOPE_API_KEY', google: 'GOOGLE_API_KEY' };
    const modelConfig: LLMConfig = {
        ...model,
        ...(args.model ? { model: args.model } : {}),
        apiKey: (agentOverride?.apiKey || providerSettings.apiKey || model.apiKey || process.env[envKeys[model.provider]] || ''),
        baseUrl: agentOverride?.baseUrl || providerSettings.baseUrl || model.baseUrl,
    };
    rememberSecrets(modelConfig);
    const identity = { provider: safe(modelConfig.provider, 80), model: safe(modelConfig.model, 150), agent: safe(agent.id, 100), source: 'local', agentModelOverride: Boolean(agentOverride), evaluationModelOverride: Boolean(args.model) };
    if (args.dryRun) {
        print(JSON.stringify({ dryRun: true, model: identity, repeats: args.repeats, cases: selectedCases.map(({ id, input, expected, history }) => ({ id, input, expected, priorHistoryMessages: history?.length || 0 })), allowedTools: ['project_search', 'request_user_input'], externalEffects: 'model API only when not dry-run' }, null, 2));
    } else {
        process.chdir(scratch);
        const { createLLMProvider } = await import('../src/llm/factory');
        const { ToolRegistry } = await import('../src/tools/registry');
        const { createRequestUserInputTool } = await import('../src/tools/user-input');
        const { UserInputStore } = await import('../src/work/user-input-store');
        const { UserInputCoordinator } = await import('../src/gateway/user-input-coordinator');
        const { SessionStore } = await import('../src/sessions/store');
        const { AgentManager } = await import('../src/agent/manager');
        const { runWithAgentExecutionContext } = await import('../src/runtime/execution-context');
        const realProvider = createLLMProvider(modelConfig);
        const allowedTools = new Set(['project_search', 'request_user_input']);
        class EvaluationRegistry extends ToolRegistry {
            override register(tool: Tool): void { if (allowedTools.has(tool.name)) super.register(tool); }
            override filter(...input: Parameters<InstanceType<typeof ToolRegistry>['filter']>): InstanceType<typeof ToolRegistry> {
                const filtered = super.filter(...input);
                const isolated = new EvaluationRegistry();
                for (const tool of filtered.getAllTools()) isolated.register(tool);
                return isolated;
            }
        }
        const results: unknown[] = [];
        for (let repeat = 1; repeat <= args.repeats; repeat++) for (const fixture of selectedCases) {
            const caseRoot = join(scratch, `${fixture.id}-${repeat}`);
            const sessions = new SessionStore({ storePath: caseRoot });
            const store = new UserInputStore({ directory: join(caseRoot, 'inputs') });
            const sessionId = `eval-${randomUUID()}`;
            sessions.create(agent.id, fixture.id, undefined, undefined, sessionId);
            for (const message of fixture.history || []) sessions.addMessage(sessionId, message);
            let observation: TurnObservation;
            let publicChars = 0;
            let continuation: { input: string; request: UserInputRequest } | undefined;
            const coordinator = new UserInputCoordinator({
                store, pauseSession() {},
                ensureMessage(id, message) {
                    if (!sessions.getMessages(id).some(existing => existing.metadata?.kind === message.metadata.kind && existing.metadata?.requestId === message.metadata.requestId)) sessions.addMessage(id, message);
                },
                async enqueueContinuation(request, _answer, input) { continuation = { input, request }; },
            });
            const observeRequest = (tools: LLMToolDefinition[]): ModelObservation => {
                const call = { offeredTools: tools.map(tool => tool.name), returnedTools: [], publicTextChars: 0 };
                observation.modelCalls.push(call);
                return call;
            };
            const observeResponse = (call: ModelObservation, response: ChatWithToolsResponse): void => {
                call.returnedTools = response.toolCalls.map(tool => safe(tool.name, 80));
                call.publicTextChars = response.content.length;
                publicChars += response.content.length;
            };
            const measuredProvider: LLMProvider = {
                getConfig: () => realProvider.getConfig(),
                chat: (messages, opts) => { observation.auxiliaryModelCalls++; return realProvider.chat(messages, opts); },
                chatStream: (messages, callback, opts) => { observation.auxiliaryModelCalls++; return realProvider.chatStream(messages, callback, opts); },
                embed: text => realProvider.embed(text), embedBatch: texts => realProvider.embedBatch(texts),
                async chatWithTools(messages, tools, opts) {
                    const call = observeRequest(tools);
                    const response = await realProvider.chatWithTools(messages, tools, opts);
                    observeResponse(call, response); return response;
                },
                ...(realProvider.chatWithToolsStream ? { async chatWithToolsStream(messages, tools, callbacks, opts) {
                    const call = observeRequest(tools);
                    const response = await realProvider.chatWithToolsStream!(messages, tools, callbacks, opts);
                    observeResponse(call, response); return response;
                } } : {}),
            };
            const registry = new EvaluationRegistry();
            registry.register(createRequestUserInputTool());
            registry.register({
                name: 'project_search', description: 'Read-only search of supplied evaluation fixture notes. This tool never reads files or accesses the network.',
                parameters: { query: { type: 'string', required: true, description: 'Search within the supplied notes.' } },
                async execute() { return { success: true, data: { source: 'supplied_notes', notes: fixture.input, additionalUserRequirementsAvailable: false } }; },
            });
            // The chosen agent and ordinary production prompts remain intact.
            // Fix its provider to our observed instance and remove unrelated routing.
            const evalConfig: OpenFluxConfig = {
                ...config,
                workspace: caseRoot,
                agents: {
                    list: [{ ...agent, model: undefined }],
                    globalAgentName: saved.agents?.globalAgentName ?? config.agents?.globalAgentName,
                    globalSystemPrompt: saved.agents?.globalSystemPrompt ?? config.agents?.globalSystemPrompt,
                    skills: saved.agents?.skills ?? config.agents?.skills,
                },
            };
            const manager = new AgentManager({ config: evalConfig, tools: registry, defaultLLM: measuredProvider, sessions });
            async function run(input: string, skipUserMessage = false): Promise<TurnObservation> {
                observation = { status: 'running', modelCalls: [], auxiliaryModelCalls: 0, executedTools: [], publicCharsBeforeQuestion: null, questionCount: 0, questions: [], outputChars: 0, outputSummary: '', tailQuestionsHeuristic: [] };
                publicChars = 0;
                const turnId = randomUUID(); const runId = randomUUID();
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(new Error('evaluation_timeout')), args.timeoutMs);
                try {
                    const result = await runWithAgentExecutionContext({ sessionId, turnId, runId }, () => manager.run(
                        input, agent.id, sessionId,
                        event => {
                            if (event.type === 'tool_result') observation.executedTools.push({
                                name: safe(event.tool || '', 80), success: !event.failed,
                                ...(event.failed ? { errorSummary: toolErrorSummary(event.result, safe) } : {}),
                            });
                        },
                        undefined, undefined, undefined, controller.signal,
                        { turnId, workMode: 'normal', approvalMode: 'full_access', skipUserMessage, iterationBudget: 4,
                            userInputControl: { async requestInput(questions, context) {
                                observation.publicCharsBeforeQuestion = publicChars;
                                const request = await coordinator.requestInput({ sessionId, turnId, runId, questions, context: { input, agentId: context?.agentId, approvalMode: 'full_access' } });
                                observation.questions = request.questions.map(question => ({ id: safe(question.id, 100), prompt: safe(question.prompt, 220), optionLabels: question.options.map(option => safe(option.label, 120)), topics: questionTopics(question) }));
                                observation.questionCount = request.questions.length;
                                return { requestId: request.id };
                            } },
                        },
                    ));
                    observation.status = result.status;
                    observation.outputChars = result.output.length;
                    observation.outputSummary = safe(result.output);
                    observation.tailQuestionsHeuristic = finalQuestions(result.output).map(line => safe(line, 220));
                } catch (error) {
                    observation.status = 'error';
                    observation.error = { name: safe(error instanceof Error ? error.name : 'Error', 60), category: controller.signal.aborted ? 'timeout' : 'model_or_runtime_error' };
                } finally { clearTimeout(timeout); }
                return structuredClone(observation);
            }
            const first = await run(fixture.input);
            const followUps: Array<TurnObservation & { repeatedTopicsHeuristic: string[]; routineFollowUpOffersHeuristic: string[]; exactRepeatedQuestions: string[] }> = [];
            const answeredTopics = new Set<string>(); const answeredPrompts = new Set<string>();
            for (let followUp = 0; followUp < 2; followUp++) {
                const pending = store.getPending(sessionId);
                if (!pending) break;
                for (const question of pending.questions) { questionTopics(question).forEach(topic => answeredTopics.add(topic)); answeredPrompts.add(question.prompt.trim()); }
                // A deliberate fixture answer, never automatically choosing a recommended option.
                const answers: PlanQuestionAnswer[] = pending.questions.map(question => ({ questionId: question.id, optionIds: [], other: fixture.answer }));
                continuation = undefined;
                await coordinator.resolve(sessionId, pending.id, randomUUID(), answers);
                if (!continuation) throw new Error('missing_continuation');
                const next = await run(continuation.input, true);
                const nextPending = store.getPending(sessionId);
                followUps.push({ ...next, ...assessFollowUpQuestions(next, answeredTopics), exactRepeatedQuestions: (nextPending?.questions || []).filter(question => answeredPrompts.has(question.prompt.trim())).map(question => safe(question.prompt, 220)) });
            }
            const pending = store.getPending(sessionId);
            if (pending) await coordinator.cancel(sessionId, pending.id);
            const checks = {
                toolAdvertised: first.modelCalls.some(call => call.offeredTools.includes('request_user_input')),
                expectedInitialBehavior: fixture.expected === 'direct_answer' ? first.status === 'completed' && first.questionCount === 0 && first.tailQuestionsHeuristic.length === 0 : first.status === 'waiting_input' && first.questionCount > 0,
                askedPurpose: first.questions.some(question => question.topics.includes('audience_purpose')),
                conciseBeforeQuestion: first.publicCharsBeforeQuestion === null ? null : first.publicCharsBeforeQuestion <= 400,
                noFinalTailQuestionHeuristic: first.tailQuestionsHeuristic.length === 0,
                continuationExercised: followUps.length > 0,
                resumedToCompletion: followUps.length ? followUps.at(-1)!.status === 'completed' : null,
                noRepeatedAnsweredTopicHeuristic: followUps.length ? followUps.every(turn => turn.repeatedTopicsHeuristic.length === 0 && turn.exactRepeatedQuestions.length === 0) : null,
                noRoutineFollowUpOfferHeuristic: followUps.length ? followUps.every(turn => turn.routineFollowUpOffersHeuristic.length === 0) : null,
                noFollowUpFinalTailQuestionHeuristic: followUps.length ? followUps.every(turn => turn.tailQuestionsHeuristic.length === 0) : null,
                answerMessages: countAnswerMessages(sessions.getMessages(sessionId)),
            };
            results.push({ id: fixture.id, repeat, input: fixture.input, expected: fixture.expected, initial: first, followUps, checks });
        }
        print(JSON.stringify({ version: 2, model: identity, repeats: args.repeats, allowedTools: [...allowedTools], notes: ['Production prompts are used without case-specific instructions to ask a question.', 'Only the configured model API is contacted; tools and session storage are isolated.', 'Topic repetition, routine follow-up offers and final-tail questions are separate heuristics requiring human review.', 'Each case has at most 4 model iterations per turn and 2 answered continuations.'], cases: results }, null, 2));
    }
} catch (error) {
    const known = new Set(['invalid_arguments', 'missing_server_config', 'managed_model_requires_runtime_adapter', 'agent_not_found', 'missing_continuation']);
    print(JSON.stringify({ error: known.has((error as Error)?.message) ? (error as Error).message : 'configuration_or_evaluation_failed', name: safe(error instanceof Error ? error.name : 'Error', 60) }));
    process.exitCode = 1;
} finally {
    const loggers = (globalThis as unknown as { __openflux_loggers__?: Set<{ close(): void }> }).__openflux_loggers__;
    for (const logger of loggers || []) logger.close();
    await new Promise(resolve => setTimeout(resolve, 30));
    process.chdir(originalCwd);
    if (originalAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = originalAppData;
    // Scope the only recursive removal to the exact directory created above.
    const target = resolve(scratch);
    if (dirname(target) === resolve(tmpdir()) && basename(target).startsWith('openflux-user-input-eval-') && target !== resolve(tmpdir()) && !target.endsWith(sep)) {
        rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    for (const method of consoleMethods) console[method] = originals[method] as typeof console[typeof method];
}
