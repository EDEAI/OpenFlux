import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const gatewayUrl = process.env.OPENFLUX_GATEWAY_URL || 'ws://127.0.0.1:18801';
const outputRoot = process.env.OPENFLUX_OUTPUT_ROOT || 'D:\\openflux_output';
const validationRoot = join(outputRoot, '2026-08-27', '长篇PPT验证');

const allScenarios = [
    {
        id: '01-ai-portfolio',
        title: '企业AI投资组合战略验证',
        slideCount: 24,
        outputDir: '2026-08-27/长篇PPT验证/01-AI投资组合',
        filename: '企业AI投资组合战略-24页.pptx',
        prompt: `
请使用独立 Presentation Agent 生成一份严格 24 页的中文 PPTX并同步导出 PDF。

主题：企业 AI 投资组合从试点走向规模化的董事会决策报告。
受众：集团 CEO、CFO、CIO 和业务事业部负责人。
目的：批准未来两个季度的投资重心、停止条件和治理机制。

严格要求：
- brief.requested_slide_count 必须为 24，最终必须恰好 24 页，包含独立封面、3 张章节转场和决策收束页。
- 不要外部搜索，不要生成图片；仅使用排版、可编辑形状和原生图表，用于压力测试当前生成流程。
- 所有数据都是测试数据，在页脚统一标注“模拟数据，仅用于生成质量验证”，不得虚构外部来源。
- 要有明确的长篇叙事：现状与问题 → 投资组合选择 → 运营治理 → 两季度行动与决策。
- 避免连续使用相同卡片墙。相邻页面要有明显轮廓变化，至少覆盖封面、章节、单结论、数据聚焦、编辑长文、比较、流程、时间线、图表证据、索引与收束等轮廓。

必须忠实使用的模拟经营数据：
- 42 个候选需求，17 个活跃试点，9 个稳定运营，治理覆盖率 63%。
- 四个业务域规模化准备度：客户运营 91、供应链 83、知识工作 68、财务 57。
- 六个季度的平均交付周期：12、11、9、8、7、6 周。
- 投入结构：模型服务 28、知识平台 22、工作流 18、治理 14、评估 10、运营 8。
- 两季度资源上限 1200 人天；推荐分配：共享平台 420、客户运营 260、供应链 220、治理与评估 180、预留 120。

必须由数据关系自主选择并生成至少：排名条形图、趋势折线图、投入树图、业务域×能力的热力图、两季度甘特图。树图必须有真实面积分区，甘特图必须表达起点与持续时间。

输出目录：${'2026-08-27/长篇PPT验证/01-AI投资组合'}
文件名：${'企业AI投资组合战略-24页.pptx'}
必须完成 sample → final → 逐页视觉审查 → review 的完整状态机，只在 completion.complete=true 后交付。
        `.trim(),
    },
    {
        id: '02-saas-growth',
        title: 'SaaS增长经营复盘验证',
        slideCount: 22,
        outputDir: '2026-08-27/长篇PPT验证/02-SaaS增长',
        filename: 'SaaS增长经营复盘-22页.pptx',
        prompt: `
请使用独立 Presentation Agent 生成一份严格 22 页的中文 PPTX并同步导出 PDF。

主题：B2B SaaS 从获客到付费的季度增长经营复盘。
受众：CEO、增长负责人、产品负责人和销售负责人。
目的：找出最大流失点，确定下季度的三项增长实验和资源优先级。

严格要求：
- brief.requested_slide_count 必须为 22，最终恰好 22 页，包含独立封面、3 张章节转场和行动收束页。
- 不外部搜索，不生成图片，仅使用排版、可编辑形状与原生图表。
- 页脚统一标注“模拟数据，仅用于生成质量验证”。
- 叙事为：季度结论 → 获客与激活 → 转化与收入 → 实验组合与行动。
- 避免连续卡片墙，长文页不得通过过度缩小字号塞入。要检验至少 12 种明显不同的页面轮廓。

必须忠实使用的漏斗数据，阶段不得增减或合并：
访问 200000 → 注册 72000 → 核心激活 36000 → 产生试用意向 18000 → 付费 8100。
漏斗图必须是真正收窄的漏斗形状，大入口和小出口必须有明显色差，不得用普通条形图代替。

其他模拟数据：
- 连续 6 个月的访问量：148000、156000、169000、178000、189000、200000；付费转化率：3.1%、3.3%、3.5%、3.6%、3.8%、4.05%。
- 获客渠道成本与转化：自然搜索 42/5.1%、内容营销 56/4.8%、伙伴渠道 74/6.2%、付费广告 128/2.9%、线下活动 166/3.4%。
- 六期留存热力矩阵：[[100,61,47,39,34,31],[100,64,50,43,38,0],[100,67,54,47,0,0],[100,69,57,0,0,0],[100,72,0,0,0,0],[100,0,0,0,0,0]]。
- 收入变化瀑布：基线 860万、新增付费 +210万、升级 +95万、降级 -38万、流失 -122万，末期 1005万。
- 客户结构树图：企业版 46%、团队版 31%、专业版 15%、基础版 8%。
- 三项实验：注册流程减步、激活任务导航、销售介入触发器；每项需有假设、主指标、停止条件、负责人与 6 周节奏。

必须根据数据关系生成真正的：漏斗图、留存热力图、客户结构树图、收入瀑布图、趋势图、渠道效率散点或气泡图、6 周实验甘特图。

输出目录：${'2026-08-27/长篇PPT验证/02-SaaS增长'}
文件名：${'SaaS增长经营复盘-22页.pptx'}
必须完成 sample → final → 逐页视觉审查 → review，只在 completion.complete=true 后交付。
        `.trim(),
    },
    {
        id: '03-migration-program',
        title: '核心系统迁移计划验证',
        slideCount: 24,
        outputDir: '2026-08-27/长篇PPT验证/03-系统迁移',
        filename: '核心系统迁移执行计划-24页.pptx',
        prompt: `
请使用独立 Presentation Agent 生成一份严格 24 页的中文 PPTX并同步导出 PDF。

主题：集团核心客户平台的跨部门系统迁移执行计划。
受众：集团管理委员会、业务负责人、技术负责人与风险负责人。
目的：批准 20 周迁移路线、切换门禁、资源分配和事故回退边界。

严格要求：
- brief.requested_slide_count 必须为 24，最终恰好 24 页，包含独立封面、4 张章节转场和管委会决策页。
- 不外部搜索，不生成图片，仅使用可编辑排版、形状与图表。页脚统一标注“模拟数据，仅用于生成质量验证”。
- 叙事为：为什么迁移 → 目标架构与边界 → 分波执行 → 风险与切换 → 决策与行动。
- 这是计划型长篇演示，必须使用多种轮廓表达依赖、时间、责任和风险，不得把所有内容做成统一卡片网格。

必须忠实使用的模拟数据：
- 当前平台有 36 个核心服务、128 个外部接口、8.4 TB 客户数据、16 个业务团队，月均 31 次变更，当前发布失败率 7.8%。
- 目标：发布失败率降至 2%以下，平均恢复时间从 96 分钟降至 25 分钟，接口自动化契约覆盖率由 38% 提至 90%。
- 20 周任务：范围冻结 W1–W2、数据盘点 W1–W4、目标基础设施 W2–W7、接口契约改造 W3–W10、数据迁移演练 W6–W13、业务回归演练 W8–W15、灰度切换 W14–W18、全量切换 W19、稳定观察 W19–W20。
- 五类风险的可能性/影响：数据一致性 4/5、接口兼容 4/4、峰值性能 3/5、业务准备 3/4、回退窗口 2/5。
- 资源：平台工程 18 人、数据工程 10 人、QA 12 人、SRE 8 人、业务验收 24 人、项目治理 6 人；第 14–19 周为资源峰值。
- 切换门禁：数据差异 <0.1%、P95 延迟 <350ms、关键流程通过率 >99.5%、一键回退 <15 分钟、业务负责人签字 100%。

必须根据数据关系生成真正的：20 周甘特图、风险热力图、资源堆叠图、发布质量趋势图、切换门禁指标页；另需清晰表达分波依赖、RACI 责任边界、事故升级与回退流程。甘特图不得退化成普通列表。

输出目录：${'2026-08-27/长篇PPT验证/03-系统迁移'}
文件名：${'核心系统迁移执行计划-24页.pptx'}
必须完成 sample → final → 逐页视觉审查 → review，只在 completion.complete=true 后交付。
        `.trim(),
    },
];

const requestedScenarioIds = new Set(
    String(process.env.PRESENTATION_SCENARIOS || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean),
);
let scenarios = requestedScenarioIds.size
    ? allScenarios.filter(scenario => requestedScenarioIds.has(scenario.id))
    : allScenarios;

const resumeSessionId = String(process.env.PRESENTATION_RESUME_SESSION_ID || '').trim();
if (resumeSessionId) {
    const resumeScenarioId = String(process.env.PRESENTATION_RESUME_SCENARIO || '02-saas-growth').trim();
    const sourceScenario = allScenarios.find(scenario => scenario.id === resumeScenarioId);
    if (!sourceScenario) throw new Error(`Unknown resume scenario: ${resumeScenarioId}`);
    scenarios = [{
        ...sourceScenario,
        id: `${sourceScenario.id}-resume`,
        sessionId: resumeSessionId,
        prompt: String(process.env.PRESENTATION_RESUME_PROMPT || '').trim() || sourceScenario.prompt,
    }];
}

const intermediateTypes = new Set([
    'chat.accepted', 'chat.start', 'chat.progress', 'chat.queue.updated',
    'agent.event', 'tool.approval.request', 'tool.approval.closed',
]);

class GatewayHarness {
    constructor(url) {
        this.url = url;
        this.socket = undefined;
        this.pending = new Map();
        this.progressBySession = new Map();
    }

    async connect() {
        await new Promise((resolve, reject) => {
            const socket = new WebSocket(this.url);
            this.socket = socket;
            const timer = setTimeout(() => reject(new Error('Gateway welcome timed out')), 15_000);
            socket.on('error', reject);
            socket.on('message', data => {
                const message = JSON.parse(String(data));
                if (message.type === 'welcome') {
                    clearTimeout(timer);
                    if (message.payload?.requireAuth) {
                        reject(new Error('This validation harness requires a local Gateway without token authentication.'));
                    } else {
                        resolve();
                    }
                    return;
                }
                this.onMessage(message);
            });
        });
    }

    onMessage(message) {
        const sessionId = message.payload?.sessionId;
        if (sessionId && (message.type === 'chat.progress' || message.type === 'agent.event')) {
            const stats = this.progressBySession.get(sessionId) || { toolStarts: 0, toolResults: 0, last: '' };
            if (message.type === 'chat.progress' && message.payload?.type === 'tool_start') stats.toolStarts++;
            if (message.type === 'chat.progress' && message.payload?.type === 'tool_result') stats.toolResults++;
            stats.last = message.payload?.item?.title || message.payload?.message || message.payload?.type || message.type;
            this.progressBySession.set(sessionId, stats);
        }

        if (!message.id || !this.pending.has(message.id) || intermediateTypes.has(message.type)) return;
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.type.endsWith('.error') || message.type === 'error') {
            pending.reject(new Error(message.payload?.message || `Gateway request failed: ${message.type}`));
        } else {
            pending.resolve(message.payload);
        }
    }

    request(type, payload, timeoutMs = 120_000) {
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.socket.send(JSON.stringify({ type, id, payload }));
            if (timeoutMs > 0) {
                setTimeout(() => {
                    if (!this.pending.has(id)) return;
                    this.pending.delete(id);
                    reject(new Error(`${type} timed out after ${timeoutMs}ms`));
                }, timeoutMs);
            }
        });
    }

    close() {
        this.socket?.close();
    }
}

async function collectFiles(root, modifiedAfter) {
    const found = [];
    async function walk(dir) {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) await walk(fullPath);
            else if (['.pptx', '.pdf', '.png'].includes(extname(entry.name).toLowerCase())) {
                const info = await stat(fullPath);
                if (info.mtimeMs >= modifiedAfter) found.push({ path: fullPath, size: info.size, mtimeMs: info.mtimeMs });
            }
        }
    }
    await walk(root);
    return found.sort((a, b) => a.path.localeCompare(b.path));
}

async function saveDeliverableArtifacts(client, sessionId, files, completionOutput) {
    const referencedFiles = files.filter(item => (
        ['.pptx', '.pdf'].includes(extname(item.path).toLowerCase())
        && String(completionOutput || '').includes(item.path)
    ));
    for (const file of referencedFiles) {
        await client.request('sessions.artifacts.save', {
            sessionId,
            artifact: {
                type: 'file',
                path: file.path,
                filename: basename(file.path),
                size: file.size,
                timestamp: file.mtimeMs,
            },
        });
    }
}

async function runScenario(client, scenario) {
    let sessionId = scenario.sessionId;
    if (!sessionId) {
        const created = await client.request('sessions.create', {
            title: `长篇PPT验证｜${scenario.title}`,
            agentId: 'presentation',
            approvalMode: 'full_access',
        });
        sessionId = created.session.id;
    }
    const startedAt = Date.now();
    process.stdout.write(`\n[${scenario.id}] session=${sessionId} slides=${scenario.slideCount}\n`);
    const completion = await client.request('chat', {
        input: scenario.prompt,
        sessionId,
        agentId: 'presentation',
        approvalMode: 'full_access',
        source: 'desktop',
        delivery: 'new',
        submissionId: randomUUID(),
    }, 0);
    const outputDir = join(outputRoot, ...scenario.outputDir.split('/'));
    const files = await collectFiles(outputDir, startedAt - 5_000);
    const messages = await client.request('sessions.messages', { sessionId });
    const logs = await client.request('sessions.logs', { sessionId });
    const events = await client.request('sessions.events', { sessionId, limit: 1000 });
    const terminalEvent = [...(events.events || [])]
        .reverse()
        .find(event => event.type === 'turn.completed' || event.type === 'turn.failed');
    const completed = terminalEvent?.type === 'turn.completed'
        && /completion\.complete\s*=\s*true|stage\s*=\s*completed|任务完成|交付完成/.test(completion?.output || '');
    if (completed) await saveDeliverableArtifacts(client, sessionId, files, completion?.output || '');
    const result = {
        ...scenario,
        prompt: undefined,
        sessionId,
        startedAt,
        completedAt: Date.now(),
        elapsedMs: Date.now() - startedAt,
        completionOutput: completion?.output || '',
        completed,
        terminalEvent: terminalEvent?.type,
        progress: client.progressBySession.get(sessionId) || {},
        files,
        messageCount: messages.messages?.length || 0,
        logCount: logs.logs?.length || 0,
        eventCount: events.events?.length || 0,
    };
    await mkdir(validationRoot, { recursive: true });
    await writeFile(join(validationRoot, `${scenario.id}-run.json`), JSON.stringify(result, null, 2), 'utf8');
    process.stdout.write(`[${scenario.id}] complete files=${files.length} elapsed=${Math.round(result.elapsedMs / 1000)}s\n`);
    return result;
}

async function main() {
    await mkdir(validationRoot, { recursive: true });
    const client = new GatewayHarness(gatewayUrl);
    await client.connect();
    const results = [];
    try {
        for (const scenario of scenarios) results.push(await runScenario(client, scenario));
    } finally {
        client.close();
    }
    const manifest = {
        generatedAt: Date.now(),
        gatewayUrl,
        outputRoot,
        results,
    };
    await writeFile(join(validationRoot, 'batch-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    process.stdout.write(`\n${JSON.stringify({ manifest: join(validationRoot, 'batch-manifest.json'), sessions: results.map(item => item.sessionId) }, null, 2)}\n`);
}

main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
});
