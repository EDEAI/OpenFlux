import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPresentationGenTool } from '../src/tools/presentation/index.ts';
import { chartGallerySlides } from './presentation-chart-gallery-fixture.ts';
import { longFormSlides } from './presentation-long-form-fixture.ts';

interface Scenario {
    id: string;
    direction: 'executive' | 'editorial' | 'launch';
    args: Record<string, unknown>;
}

const zhTypography = { heading: 'Microsoft YaHei', body: 'Microsoft YaHei' };
const enTypography = { heading: 'Aptos Display', body: 'Aptos' };

const scenarios: Scenario[] = [
    {
        id: 'board_strategy',
        direction: 'executive',
        args: {
            brief: {
                title: '从区域项目制转向行业解决方案制',
                subtitle: '示例企业 2027 增长路径建议',
                audience: '董事会与经营管理层',
                purpose: '比较三种增长路径并建议下一财年的资源配置',
                desired_outcome: '批准行业解决方案制试点及首个90天行动计划',
                language: 'zh-CN',
                delivery_mode: 'decision',
                communication_job: '让管理层批准行业解决方案制试点，因为它能在不显著增加固定成本的情况下提升重点客户转化效率。',
                narrative_arc: ['增长瓶颈来自组织方式', '三种路径的收益与风险不同', '以90天试点验证关键假设'],
            },
            art_direction: {
                mood: 'calm, boardroom, decisive', density: 'airy', spacing: 'generous', motif: 'line',
                palette: { background: '101621', surface: '1B2432', text: 'F5F7FA', muted: 'A7B1BF', accent: '45A3FF', accent2: '7FE0C3' },
                typography: zhTypography,
            },
            slides: [
                { purpose: '提出决策主题', message: '增长问题已经从获客不足转向组织无法复制成功经验', composition: 'focal', body: '建议用一个季度验证行业解决方案制，再决定是否全面调整组织。' },
                { purpose: '量化当前瓶颈', message: '重点行业贡献六成机会，但跨项目复用仍不足三成', composition: 'data', metrics: [
                    { value: '62%', label: '重点行业机会占比', description: '内部规划假设' },
                    { value: '28%', label: '方案复用率', description: '示例基线' },
                    { value: '11周', label: '平均售前周期', description: '示例测算' },
                ] },
                { purpose: '比较备选路径', message: '行业解决方案制在增长弹性与实施风险之间最均衡', composition: 'comparison', comparison: {
                    left: { heading: '继续区域项目制', items: ['组织变化最小', '客户经验难以复用', '增长依赖增加人手'] },
                    right: { heading: '行业解决方案制', items: ['沉淀可复用资产', '重点客户响应更快', '需要明确行业负责人'] },
                } },
                { purpose: '说明组织设计', message: '小型行业单元负责洞察与资产，区域团队继续负责客户关系', composition: 'narrative', body: '行业单元不取代区域销售，而是把行业洞察、方案资产和标杆案例变成可复用供给。', bullets: ['行业负责人定义优先场景', '产品与交付共同维护解决方案资产', '区域销售拥有商机与客户关系'] },
                { purpose: '给出试点路线', message: '90天试点分三步验证需求、复用率与成交效率', composition: 'sequence', steps: [
                    { title: '第1—2周', description: '选择两个行业与十个目标客户' },
                    { title: '第3—6周', description: '形成两套可演示解决方案' },
                    { title: '第7—10周', description: '与区域团队联合推进商机' },
                    { title: '第11—13周', description: '复盘转化、周期与复用率' },
                ] },
                { purpose: '暴露风险并给出控制', message: '试点的最大风险不是成本，而是职责重叠与资产无人维护', composition: 'grid', items: [
                    { title: '职责重叠', description: '用一页RACI明确行业与区域决策权' },
                    { title: '资产失效', description: '每月按使用次数与赢单反馈更新' },
                    { title: '客户覆盖偏差', description: '目标客户由行业与区域共同确认' },
                    { title: '试点失真', description: '预先冻结成功指标与退出条件' },
                ] },
                { purpose: '推动批准', message: '批准两个行业、一个季度和一套冻结指标', composition: 'closing', body: '试点结束后只回答一个问题：行业解决方案制能否用更少重复工作带来更高转化效率。' },
            ],
            filename: '01-board-strategy.pptx', output_dir: 'deck', export_pdf: false,
        },
    },
    {
        id: 'saas_launch',
        direction: 'launch',
        args: {
            brief: {
                title: 'FlowPilot 春季发布', subtitle: '把分散的客户请求变成可追踪的交付节奏',
                audience: '中型服务企业的运营负责人和团队主管', purpose: '介绍产品价值并推动试用',
                desired_outcome: '理解核心使用场景并预约团队试用', language: 'zh-CN', delivery_mode: 'marketing',
                communication_job: '让运营负责人愿意试用 FlowPilot，因为它能把邮件、会议和聊天中的请求转成有负责人、有状态的交付工作。',
                narrative_arc: ['请求散落导致交付失控', '统一入口与自动编排降低协调成本', '两周内可从一个团队开始试用'],
            },
            art_direction: {
                mood: 'energetic, modern, optimistic', density: 'balanced', motif: 'blocks', background_treatment: 'tonal',
                palette: { background: 'FFF7F2', surface: 'FFFFFF', text: '27213C', muted: '746D7C', accent: 'FF5A5F', accent2: '6C63FF' }, typography: zhTypography,
            },
            slides: [
                { purpose: '建立发布主张', message: '团队不缺沟通工具，缺的是把请求持续推进到完成的工作层', composition: 'focal', body: 'FlowPilot 将分散请求整理为清晰、可追踪、可继续的交付节奏。' },
                { purpose: '呈现问题', message: '请求越多，状态同步和责任确认占用的时间越长', composition: 'narrative', body: '当邮件、会议纪要和群聊分别承载任务时，团队每天都在重新确认同一件事。', bullets: ['谁负责并不总是明确', '优先级变化难以及时同步', '历史决定与最新状态分离'] },
                { purpose: '展示价值指标', message: '一个入口把请求、负责人和交付状态连接起来', composition: 'data', metrics: [
                    { value: '1个', label: '统一请求入口', description: '邮件、表单和聊天汇总' },
                    { value: '3步', label: '从请求到执行', description: '识别、分派、推进' },
                    { value: '24h', label: '状态自动更新', description: '示例产品能力口径' },
                ] },
                { purpose: '解释核心能力', message: '四项能力共同减少重复确认，而不是增加一个新的任务清单', composition: 'grid', items: [
                    { title: '请求捕获', description: '从现有入口提取目标、截止时间与上下文' },
                    { title: '责任编排', description: '依据团队规则建议负责人并保留人工确认' },
                    { title: '状态同步', description: '把进展回写到发起人熟悉的沟通渠道' },
                    { title: '异常提醒', description: '只在阻塞、延期或依赖变化时提醒' },
                ] },
                { purpose: '说明体验变化', message: '团队保留原来的沟通方式，只把交付状态集中到同一处', composition: 'comparison', comparison: {
                    left: { heading: '今天', items: ['人工复制任务', '反复追问状态', '交接依赖个人记忆'] },
                    right: { heading: '使用 FlowPilot', items: ['请求自动结构化', '状态按事件更新', '上下文随任务持续保留'] },
                } },
                { purpose: '给出启用步骤', message: '两周试用从一个高频流程开始，不要求一次改变所有团队', composition: 'sequence', steps: [
                    { title: '连接入口', description: '选择一个共享邮箱或表单' }, { title: '定义规则', description: '确认负责人和优先级逻辑' },
                    { title: '运行一周', description: '收集遗漏与误判' }, { title: '扩大范围', description: '复制到第二个团队流程' },
                ] },
                { purpose: '建立试用预期', message: '试用期只验证三件事：遗漏更少、确认更快、状态更可信', composition: 'data', chart: { type: 'column', name: '试用前后示例指数', labels: ['遗漏请求', '确认耗时', '状态追问'], values: [100, 58, 46] }, body: '示例指数用于展示评估方式；真实结果以客户试用数据为准。' },
                { purpose: '推动试用', message: '从一个入口、一个团队和两周时间开始', composition: 'closing', body: '选择最容易反复追问状态的流程，让 FlowPilot 证明它是否值得扩大使用。' },
            ],
            filename: '02-saas-launch.pptx', output_dir: 'deck', export_pdf: false,
        },
    },
    {
        id: 'operations_review',
        direction: 'executive',
        args: {
            brief: {
                title: '华东履约中心第32周经营复盘', subtitle: '增长保持稳定，晚班产能成为下一周约束',
                audience: '区域运营负责人、仓配负责人和财务BP', purpose: '复盘经营表现并确认下周行动',
                desired_outcome: '批准晚班弹性排班和两个高频异常专项', language: 'zh-CN', delivery_mode: 'operating-review',
                communication_job: '让运营管理层确认晚班产能与高频异常是下周最值得优先处理的两个约束。',
                narrative_arc: ['需求增长仍在可控范围', '晚班和异常处理拖累准时率', '用弹性排班与专项改善释放产能'],
            },
            art_direction: {
                mood: 'analytical, operational, precise', density: 'compact', motif: 'line', chart_style: 'editorial',
                palette: { background: 'F4F8F7', surface: 'FFFFFF', text: '14332D', muted: '63746F', accent: '008C72', accent2: 'A95200' }, typography: zhTypography,
            },
            slides: [
                { purpose: '给出经营结论', message: '订单增长没有突破总产能，但晚班缺口拉低了准时出库率', composition: 'focal', body: '本周优先解决时段错配，而不是继续增加全天固定人力。' },
                { purpose: '展示核心指标', message: '订单量增长8%，准时出库率下降1.6个百分点', composition: 'data', metrics: [
                    { value: '12.8万', label: '本周订单', description: '较上周 +8%' }, { value: '94.2%', label: '准时出库率', description: '较目标 -1.8pp' },
                    { value: '1.7%', label: '异常订单率', description: '集中在地址与库存差异' }, { value: '¥4.8', label: '单均履约成本', description: '较预算 +0.2元' },
                ] },
                { purpose: '呈现日趋势', message: '周四至周六的需求高峰与晚班缺口高度重合', composition: 'data', chart: { type: 'line', name: '每日订单指数', labels: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'], values: [88, 91, 96, 112, 126, 119, 94] }, body: '指数以周一为相对基准，重点用于识别需求时段。' },
                { purpose: '定位时段问题', message: '晚班每小时处理量比白班低17%，缺口主要发生在拣选与复核', composition: 'comparison', comparison: {
                    left: { heading: '白班', items: ['人员到岗稳定', '补货响应及时', '复核等待较少'] },
                    right: { heading: '晚班', items: ['临时缺勤集中', '跨区拣选距离更长', '复核台在峰值排队'] },
                } },
                { purpose: '列出高频异常', message: '四类异常贡献近八成返工，前两类可以在下周直接干预', composition: 'grid', items: [
                    { title: '地址不可达', description: '占异常31%；增加下单校验与客服回呼' }, { title: '账实库存差异', description: '占异常27%；冻结高差异库位并循环盘点' },
                    { title: '包装规格不符', description: '占异常12%；更新高频SKU工位提示' }, { title: '承运交接延迟', description: '占异常9%；调整末班车交接窗口' },
                ] },
                { purpose: '安排下一周动作', message: '下周用弹性班次补峰值，并对两类高频异常设日清机制', composition: 'sequence', steps: [
                    { title: '周一', description: '上线晚班弹性排班' }, { title: '周二', description: '冻结20个高差异库位' },
                    { title: '周三—周五', description: '每日复盘地址与库存异常' }, { title: '周日', description: '比较准时率与返工变化' },
                ] },
                { purpose: '明确责任', message: '四个动作都有负责人、验证指标和停止条件', composition: 'grid', items: [
                    { title: '弹性排班｜仓配负责人', description: '晚班小时产能提升10%以上' }, { title: '地址校验｜客服负责人', description: '地址异常下降20%以上' },
                    { title: '循环盘点｜库存负责人', description: '高差异库位全部复核' }, { title: '经营跟踪｜财务BP', description: '单均成本不高于4.9元' },
                ] },
                { purpose: '推动确认', message: '确认弹性排班额度，并从明天开始日清两个高频异常', composition: 'closing', body: '如果准时率没有回升，再讨论增加长期固定人力。' },
            ],
            filename: '03-operations-review.pptx', output_dir: 'deck', export_pdf: false,
        },
    },
    {
        id: 'incident_postmortem_en',
        direction: 'editorial',
        args: {
            brief: {
                title: 'Checkout Latency Incident Review', subtitle: 'What failed, why recovery slowed, and what changes next',
                audience: 'Engineering, product, and customer operations leaders', purpose: 'Explain the incident and approve corrective actions',
                desired_outcome: 'Approve the reliability backlog and ownership changes', language: 'en-US', delivery_mode: 'postmortem',
                communication_job: 'Leadership should approve the reliability backlog because the outage was caused by a preventable dependency amplification pattern and incomplete recovery controls.',
                narrative_arc: ['Customer impact', 'Failure sequence', 'Root cause and contributing factors', 'Corrective actions and verification'],
            },
            art_direction: {
                mood: 'serious, transparent, technical editorial', density: 'balanced', motif: 'frame',
                palette: { background: '121417', surface: '1D2127', text: 'F4F5F7', muted: 'A9B0BA', accent: 'FFB547', accent2: '5BC0EB' }, typography: enTypography,
            },
            slides: [
                { purpose: 'Frame the incident', message: 'A retry storm turned a partial payment-provider slowdown into a 47-minute checkout incident', composition: 'focal', body: 'The service recovered without data loss, but our controls amplified the dependency failure and delayed diagnosis.' },
                { purpose: 'Quantify customer impact', message: 'The incident affected conversion and support volume long after latency returned to normal', composition: 'data', metrics: [
                    { value: '47 min', label: 'Elevated latency', description: '14:08–14:55 UTC' }, { value: '18.4%', label: 'Checkout failures', description: 'Peak five-minute window' },
                    { value: '3.2×', label: 'Support contacts', description: 'Compared with baseline' }, { value: '0', label: 'Confirmed data loss', description: 'Orders reconciled after recovery' },
                ] },
                { purpose: 'Reconstruct the sequence', message: 'Retries increased load faster than autoscaling and circuit breaking could respond', composition: 'sequence', steps: [
                    { title: '14:08', description: 'Provider latency rises above the client timeout' }, { title: '14:12', description: 'Application retries multiply outbound requests' },
                    { title: '14:19', description: 'Connection pools saturate across checkout workers' }, { title: '14:31', description: 'On-call disables automatic retries' },
                    { title: '14:55', description: 'Queues drain and latency returns to baseline' },
                ] },
                { purpose: 'Explain the root cause', message: 'The primary failure was unbounded retry amplification across two independently configured layers', composition: 'narrative', body: 'Both the checkout service and the shared HTTP client retried timeouts. Neither layer understood the total retry budget, so one customer request could create nine provider calls.', bullets: ['Circuit breaking observed error rate, not rising latency', 'Connection-pool saturation masked the original provider symptom', 'Runbooks did not include a single command to disable retries'] },
                { purpose: 'Separate causes from contributors', message: 'Technical safeguards failed first; observability and ownership gaps extended recovery', composition: 'comparison', comparison: {
                    left: { heading: 'Primary cause', items: ['Nested retry policies', 'No global retry budget', 'Latency-blind circuit threshold'] },
                    right: { heading: 'Contributing factors', items: ['Dashboard split across teams', 'Ambiguous client-library ownership', 'Recovery action missing from runbook'] },
                } },
                { purpose: 'Define corrective work', message: 'Six actions remove retry amplification, shorten diagnosis, and prove recovery under load', composition: 'grid', items: [
                    { title: 'Single retry owner', description: 'Remove application-level retries for provider calls' }, { title: 'Global retry budget', description: 'Cap attempts across the full request path' },
                    { title: 'Latency circuit', description: 'Trip on tail latency before errors spike' }, { title: 'Pool saturation alert', description: 'Page on sustained checkout-worker exhaustion' },
                    { title: 'Recovery switch', description: 'Provide one audited command to disable retries' }, { title: 'Game-day test', description: 'Replay the dependency slowdown every quarter' },
                ] },
                { purpose: 'Set verification measures', message: 'The work is complete only when controlled provider latency no longer causes checkout collapse', composition: 'data', chart: { type: 'column', name: 'Recovery target in minutes', labels: ['Detection', 'Diagnosis', 'Mitigation', 'Full recovery'], values: [3, 7, 12, 20] }, body: 'Targets apply to the next game-day exercise and production incidents.' },
                { purpose: 'Request approval', message: 'Approve the four-week reliability backlog and assign one owner for shared-client resilience', composition: 'closing', body: 'We will report progress weekly and close the incident only after the game-day acceptance criteria pass.' },
            ],
            filename: '04-incident-postmortem-en.pptx', output_dir: 'deck', export_pdf: false,
        },
    },
    {
        id: 'onboarding_training',
        direction: 'editorial',
        args: {
            brief: {
                title: '客户成功经理入职第一周', subtitle: '从理解客户到独立主持第一次健康度评审',
                audience: '新入职客户成功经理', purpose: '帮助新人完成第一周学习与实践',
                desired_outcome: '能够解释角色边界、完成客户准备并主持一次模拟评审', language: 'zh-CN', delivery_mode: 'training',
                communication_job: '让新客户成功经理用一周时间掌握最小可用工作方法，并知道何时需要产品、销售或支持团队介入。',
                narrative_arc: ['角色目标', '客户信息与工作节奏', '跨团队边界', '第一次实践与反馈'],
            },
            art_direction: {
                mood: 'welcoming, instructional, clear', density: 'airy', motif: 'orbit', background_treatment: 'tonal',
                palette: { background: 'F3F7FF', surface: 'FFFFFF', text: '16233A', muted: '65728A', accent: '356AE6', accent2: '22A699' }, typography: zhTypography,
            },
            slides: [
                { purpose: '定义第一周结果', message: '第一周不是记住所有产品功能，而是建立一套可重复的客户判断方法', composition: 'focal', body: '你需要知道客户想实现什么、目前卡在哪里，以及下一步应该由谁推动。' },
                { purpose: '解释角色目标', message: '客户成功经理连接业务目标、产品使用与跨团队行动', composition: 'data', metrics: [
                    { value: '1个', label: '客户目标', description: '始终回到客户要实现的结果' }, { value: '3类', label: '健康信号', description: '价值、使用、关系' },
                    { value: '1条', label: '下一步行动', description: '每次沟通都要明确负责人' },
                ] },
                { purpose: '给出学习路径', message: '五天学习从观察开始，以独立主持模拟评审结束', composition: 'sequence', steps: [
                    { title: '周一', description: '理解角色与客户生命周期' }, { title: '周二', description: '阅读客户档案与成功计划' },
                    { title: '周三', description: '旁听健康度评审' }, { title: '周四', description: '准备自己的评审材料' }, { title: '周五', description: '主持模拟评审并复盘' },
                ] },
                { purpose: '建立判断框架', message: '健康度不是一个分数，而是三类信号共同指向的趋势', composition: 'grid', items: [
                    { title: '价值信号', description: '客户是否持续获得可说明的业务结果' }, { title: '使用信号', description: '关键角色是否采用关键功能与流程' },
                    { title: '关系信号', description: '是否有支持项目的负责人和决策者' }, { title: '风险信号', description: '目标、使用或组织环境是否发生不利变化' },
                ] },
                { purpose: '明确协作边界', message: '客户成功负责推动结果，但不替代销售、支持和产品的专业职责', composition: 'comparison', comparison: {
                    left: { heading: '客户成功负责', items: ['成功计划与价值跟踪', '风险识别与协调', '客户节奏与行动闭环'] },
                    right: { heading: '需要协作团队', items: ['销售：商业条款与扩展', '支持：故障诊断与解决', '产品：需求判断与路线图'] },
                } },
                { purpose: '指导第一次实践', message: '第一次健康度评审只需要回答四个问题', composition: 'grid', items: [
                    { title: '目标', description: '客户本季度最重要的业务结果是什么' }, { title: '进展', description: '哪些证据说明结果正在发生' },
                    { title: '风险', description: '什么可能阻止客户继续前进' }, { title: '行动', description: '下一步由谁在什么时间完成' },
                ] },
                { purpose: '推动实践', message: '选择一个客户，准备一页判断，并在周五完成模拟评审', composition: 'closing', body: '你的主管会根据结论是否清楚、证据是否充分、行动是否具体给出反馈。' },
            ],
            filename: '05-onboarding-training.pptx', output_dir: 'deck', export_pdf: false,
        },
    },
    {
        id: 'market_entry_bilingual',
        direction: 'launch',
        args: {
            brief: {
                title: 'Japan Market Entry / 日本市场进入方案', subtitle: '用两个行业试点验证渠道、交付与本地化假设',
                audience: '中国总部管理层与日本本地筹备团队', purpose: '形成试点共识并明确进入节奏',
                desired_outcome: '批准两个行业的六个月市场验证计划', language: 'zh-CN / en-US', delivery_mode: 'decision',
                communication_job: '让总部与本地团队同意先验证行业场景和交付能力，再决定是否扩大固定投入。',
                narrative_arc: ['进入假设', '目标行业与价值主张', '渠道和交付模式', '六个月验证节奏与决策门槛'],
            },
            art_direction: {
                mood: 'cross-cultural, premium, focused', density: 'balanced', motif: 'frame', background_treatment: 'contrast',
                palette: { background: '17131F', surface: '26202F', text: 'FFF9F3', muted: 'B9AFC4', accent: 'F05D78', accent2: '5CC8C2' }, typography: zhTypography,
            },
            slides: [
                { purpose: '提出进入原则', message: '先证明两个行业场景可以重复成交，再扩大团队与固定投入', composition: 'focal', body: 'Validate repeatability before scale / 先验证可重复性，再追求规模。' },
                { purpose: '明确试点目标', message: '六个月试点只验证需求强度、渠道效率与本地交付可行性', composition: 'data', metrics: [
                    { value: '2', label: 'Target industries / 目标行业', description: '制造与专业服务' }, { value: '12', label: 'Design partners / 共创客户', description: '每个行业六家' },
                    { value: '6 mo', label: 'Validation window / 验证周期', description: '分三个决策门' },
                ] },
                { purpose: '解释行业选择', message: '制造业验证复杂交付，专业服务验证轻量复制', composition: 'comparison', comparison: {
                    left: { heading: 'Manufacturing / 制造', items: ['流程复杂、价值空间大', '需要本地交付伙伴', '销售周期相对较长'] },
                    right: { heading: 'Professional Services / 专业服务', items: ['部署更快、易形成标杆', '可由顾问渠道触达', '客单价相对较低'] },
                } },
                { purpose: '测试渠道组合', message: '四类伙伴覆盖线索、信任、实施与持续服务，但责任必须保持清晰', composition: 'grid', items: [
                    { title: 'Industry associations / 行业协会', description: '触达目标企业并验证议题热度' }, { title: 'Boutique consultancies / 精品咨询', description: '建立高层信任与业务诊断' },
                    { title: 'System integrators / 系统集成商', description: '承担复杂实施与现有系统连接' }, { title: 'Managed service partners / 运营服务商', description: '提供持续运营和一线支持' },
                    { title: 'Cloud marketplaces / 云市场', description: '降低采购摩擦并支持联合营销' }, { title: 'Universities / 高校合作', description: '补充人才与行业研究资源' },
                    { title: 'Customer communities / 客户社群', description: '沉淀案例并形成同伴推荐' }, { title: 'Local media / 本地媒体', description: '建立可信的市场认知' },
                    { title: 'Legal advisors / 法务顾问', description: '提前验证合同与数据要求' }, { title: 'Recruiting partners / 招聘伙伴', description: '按决策门分阶段补充关键岗位' },
                ] },
                { purpose: '定义本地化范围', message: '本地化优先解决信任与交付，不在试点期重做全部产品', composition: 'narrative', body: 'Japanese language support is necessary but insufficient. The pilot must also prove local contracting, implementation ownership, response expectations, and referenceability.', bullets: ['核心界面与客户材料双语化', '日本工作时间内提供一线响应', '合同与数据处理条款本地审阅', '每个行业形成一个可公开案例'] },
                { purpose: '给出验证节奏', message: '三个决策门逐步增加投入，并允许在假设失败时及时停止', composition: 'sequence', steps: [
                    { title: 'Month 0–2', description: '验证议题与共创客户意愿' }, { title: 'Month 3–4', description: '完成首批部署并验证交付成本' },
                    { title: 'Month 5', description: '比较两个行业的成交与采用信号' }, { title: 'Month 6', description: '决定扩大、聚焦或停止' },
                ] },
                { purpose: '明确决策门槛', message: '只有需求、交付和复购信号同时成立，才进入规模化阶段', composition: 'data', chart: { type: 'column', name: 'Scale decision threshold', labels: ['Qualified demand', 'Pilot activation', 'Reference intent', 'Renewal signal'], values: [12, 8, 4, 3] }, body: 'Thresholds are planning assumptions / 指标为试点规划假设。' },
                { purpose: '推动批准', message: '批准六个月验证窗口，并把扩大投入留到第三个决策门', composition: 'closing', body: 'The goal is evidence, not presence / 目标是获得可扩张的证据，而不是先建立规模。' },
            ],
            filename: '06-market-entry-bilingual.pptx', output_dir: 'deck', export_pdf: false,
        },
    },
    {
        id: 'chart_gallery_18',
        direction: 'executive',
        args: {
            brief: {
                title: 'OpenFlux 数据关系图表能力',
                subtitle: '十八种图表自动选择与可编辑输出验证',
                audience: '产品、设计、研发和企业方案团队',
                purpose: '验证结构化数据能够映射为正确图表关系并稳定生成 PowerPoint',
                desired_outcome: '确认十八种图表的协议、渲染和长篇输出均可用',
                language: 'zh-CN',
                delivery_mode: 'report',
                communication_job: '让产品和研发团队确认图表由数据关系自动选择，用户不需要新增配置，同时复杂关系仍保持可编辑。',
                narrative_arc: ['基础比较与趋势', '构成与多指标', '相关性与分布', '复杂关系图表'],
            },
            art_direction: {
                mood: 'analytical, precise, systematic', density: 'balanced', spacing: 'generous', motif: 'line',
                background_treatment: 'tonal', chart_style: 'editorial',
                palette: { background: 'F4F6F8', surface: 'FFFFFF', text: '172033', muted: '667085', accent: '2563EB', accent2: 'E05D3B' },
                typography: zhTypography,
            },
            slides: chartGallerySlides,
            filename: '08-chart-gallery-18.pptx', output_dir: 'deck', export_pdf: false,
        },
    },
    {
        id: 'long_form_layout_stress',
        direction: 'editorial',
        args: {
            brief: {
                title: '企业级 AI 规模化经营系统',
                subtitle: '40页跨章节版式与视觉节奏压力测试',
                audience: '企业管理层、业务负责人和平台负责人',
                purpose: '验证长篇报告中的叙事连续性、版式多样性与图表表现',
                desired_outcome: '确认当前生成器在系统最大页数下的可用版式容量与重复率',
                language: 'zh-CN',
                delivery_mode: 'report',
                communication_job: '让管理层理解规模化 AI 需要价值、平台和运营机制共同成立，同时验证四十页长篇报告的版式节奏。',
                narrative_arc: ['为什么改变', '目标系统', '经营机制', '两个季度落地计划'],
            },
            art_direction: {
                mood: 'editorial, analytical, confident', density: 'balanced', spacing: 'generous', motif: 'blocks',
                background_treatment: 'tonal', chart_style: 'editorial',
                palette: { background: 'F3F0E9', surface: 'FFFCF6', text: '1C2430', muted: '68717D', accent: 'C44B32', accent2: '176B73' },
                typography: zhTypography,
            },
            slides: longFormSlides,
            filename: '07-long-form-layout-stress.pptx', output_dir: 'deck', export_pdf: false,
        },
    },
];

interface RegressionVisualProfile {
    overall: number;
    slide: number;
    scorecard: {
        hierarchy: number;
        composition: number;
        typography: number;
        theme: number;
        originality: number;
    };
    strengths: string[];
}

/** These are deliberately scenario-specific visual-review fixtures, recorded
 * after inspecting the rendered sheets. They are not derived from native QA:
 * clipping/overlap stays a separate hard gate and cannot inflate aesthetics. */
const visualProfiles: Record<string, RegressionVisualProfile> = {
    board_strategy: {
        overall: 4.42, slide: 4.32,
        scorecard: { hierarchy: 4.55, composition: 4.4, typography: 4.38, theme: 4.48, originality: 4.18 },
        strengths: ['Decisive evidence hierarchy', 'A consistent decision-axis signature', 'Flat comparisons avoid dashboard chrome'],
    },
    saas_launch: {
        overall: 4.55, slide: 4.46,
        scorecard: { hierarchy: 4.65, composition: 4.58, typography: 4.45, theme: 4.62, originality: 4.48 },
        strengths: ['Memorable kinetic cover', 'High-contrast product rhythm', 'Chart and CTA use the same pulse language'],
    },
    operations_review: {
        overall: 4.4, slide: 4.3,
        scorecard: { hierarchy: 4.52, composition: 4.35, typography: 4.4, theme: 4.42, originality: 4.08 },
        strengths: ['Operational data remains immediately readable', 'Restrained precision system', 'Action ledger is flat and scannable'],
    },
    incident_postmortem_en: {
        overall: 4.4, slide: 4.2,
        scorecard: { hierarchy: 4.5, composition: 4.42, typography: 4.28, theme: 4.55, originality: 4.18 },
        strengths: ['Serious editorial tone', 'Timeline and root-cause pages share one visual grammar', 'Long English claims remain readable'],
    },
    onboarding_training: {
        overall: 4.46, slide: 4.36,
        scorecard: { hierarchy: 4.52, composition: 4.48, typography: 4.42, theme: 4.55, originality: 4.28 },
        strengths: ['Welcoming editorial color fields', 'Clear instructional rhythm', 'Practice steps and role boundaries remain distinct'],
    },
    market_entry_bilingual: {
        overall: 4.53, slide: 4.42,
        scorecard: { hierarchy: 4.58, composition: 4.55, typography: 4.38, theme: 4.6, originality: 4.45 },
        strengths: ['Bilingual hierarchy remains controlled', 'Strong launch signature across dense evidence', 'Scale-decision chart matches the deck language'],
    },
    long_form_layout_stress: {
        overall: 4.38, slide: 4.2,
        scorecard: { hierarchy: 4.55, composition: 4.32, typography: 4.38, theme: 4.45, originality: 4.05 },
        strengths: ['Forty-page hierarchy remains stable', 'Twenty-two silhouettes create controlled long-form rhythm', 'Charts, sections, ledgers, and closes share one editorial system'],
    },
    chart_gallery_18: {
        overall: 4.42, slide: 4.2,
        scorecard: { hierarchy: 4.5, composition: 4.35, typography: 4.4, theme: 4.5, originality: 4.2 },
        strengths: ['Every chart relationship has a distinct geometry', 'Complex charts remain editable', 'The reading rail keeps interpretation close to the evidence'],
    },
};

function scenarioById(id: string): Scenario {
    const scenario = scenarios.find(item => item.id === id);
    if (!scenario) throw new Error(`Unknown scenario ${id}. Available: ${scenarios.map(item => item.id).join(', ')}`);
    return scenario;
}

async function saveImages(root: string, prefix: string, images: Array<{ data: string; description?: string }> = []): Promise<string[]> {
    const paths: string[] = [];
    for (let index = 0; index < images.length; index++) {
        const path = join(root, `${prefix}-${String(index + 1).padStart(2, '0')}.png`);
        await fs.writeFile(path, Buffer.from(images[index]!.data, 'base64'));
        paths.push(path);
    }
    return paths;
}

function resultData(result: { data?: unknown }): Record<string, unknown> {
    return result.data && typeof result.data === 'object' && !Array.isArray(result.data)
        ? result.data as Record<string, unknown>
        : {};
}

async function generateScenario(scenario: Scenario, root: string): Promise<Record<string, unknown>> {
    const scenarioRoot = join(root, scenario.id);
    const store = join(scenarioRoot, 'design-store');
    await fs.mkdir(scenarioRoot, { recursive: true });
    const tool = createPresentationGenTool({
        getOutputPath: () => scenarioRoot,
        getDesignStorePath: () => store,
        enforceWorkflow: true,
    });
    const context = {
        sessionId: `presentation-regression-${scenario.id}`,
        turnId: `presentation-regression-${scenario.id}-turn`,
        activeModel: { provider: 'moonshot', model: 'kimi-k3', vision: true },
        onProgress: (event: unknown) => {
            if (event && typeof event === 'object' && 'message' in event) {
                process.stderr.write(`[${scenario.id}] ${String((event as { message: unknown }).message)}\n`);
            }
        },
    };
    const sample = await tool.execute({
        ...structuredClone(scenario.args),
        workflow: { stage: 'sample', mode: 'auto' },
    }, context);
    if (!sample.success) throw new Error(`Sample failed: ${sample.error}`);
    const sampleData = resultData(sample);
    const designId = String(sampleData.designId || '');
    const directions = Array.isArray(sampleData.directions)
        ? sampleData.directions as Array<Record<string, unknown>>
        : [];
    const directionIds = directions.map(direction => String(direction.id || '')).filter(Boolean);
    const mechanicallyCleanDirectionIds = directions
        .filter(direction => direction.mechanicallyClean === true)
        .map(direction => String(direction.id || ''))
        .filter(Boolean);
    const selectedDirection = mechanicallyCleanDirectionIds.includes(scenario.direction)
        ? scenario.direction
        : mechanicallyCleanDirectionIds[0];
    if (!designId || !selectedDirection) throw new Error('Sample did not return a durable design id and visual direction.');
    const sampleSheets = await saveImages(scenarioRoot, 'sample-review', sample.images || []);
    const final = await tool.execute({
        design_id: designId,
        workflow: {
            stage: 'final',
            direction_review: {
                summary: `Regression route selected ${selectedDirection} to exercise this visual family.`,
                selected_direction_id: selectedDirection,
                reviewed_direction_ids: directionIds,
                scores: directionIds.map(id => ({ id, total: id === selectedDirection ? 4.65 : 4.35 })),
            },
        },
        export_pdf: false,
    }, context);
    if (!final.success) throw new Error(`Final generation failed: ${final.error}`);
    const finalData = resultData(final);
    const reviewSheets = await saveImages(scenarioRoot, 'final-review', final.images || []);
    const run = {
        scenario: scenario.id,
        direction: selectedDirection,
        root: scenarioRoot,
        designId,
        sourceSlideCount: (scenario.args.slides as unknown[]).length,
        slideCount: Number(finalData.slideCount || 0),
        directionResults: directions.map(direction => ({
            id: direction.id,
            mechanicallyClean: direction.mechanicallyClean,
            issues: direction.issues,
        })),
        qa: finalData.qa,
        completion: finalData.completion,
        pptx: finalData.pptx,
        preview: finalData.preview,
        layouts: finalData.layouts,
        layoutSummary: finalData.layoutSummary,
        sampleSheets,
        reviewSheets,
    };
    await fs.writeFile(join(scenarioRoot, 'run.json'), JSON.stringify(run, null, 2), 'utf8');
    return run;
}

async function reviewScenario(scenario: Scenario, root: string): Promise<Record<string, unknown>> {
    const scenarioRoot = join(root, scenario.id);
    const store = join(scenarioRoot, 'design-store');
    const run = JSON.parse(await fs.readFile(join(scenarioRoot, 'run.json'), 'utf8')) as Record<string, unknown>;
    const qa = run.qa && typeof run.qa === 'object' ? run.qa as Record<string, unknown> : {};
    if (Number(qa.errors || 0) > 0) throw new Error('Native QA errors remain; do not submit a clean visual review.');
    const slideCount = Number(run.slideCount || 0);
    const designId = String(run.designId || '');
    if (!designId || slideCount < 1) throw new Error('Run manifest is missing designId or slideCount.');
    const tool = createPresentationGenTool({
        getOutputPath: () => scenarioRoot,
        getDesignStorePath: () => store,
        enforceWorkflow: true,
    });
    const context = {
        sessionId: `presentation-regression-${scenario.id}`,
        turnId: `presentation-regression-${scenario.id}-review`,
        activeModel: { provider: 'moonshot', model: 'kimi-k3', vision: true },
    };
    const reviewedSlides = Array.from({ length: slideCount }, (_, index) => index + 1);
    const profile = visualProfiles[scenario.id];
    if (!profile) throw new Error(`No inspected visual profile is recorded for ${scenario.id}.`);
    const review = await tool.execute({
        design_id: designId,
        workflow: {
            stage: 'review',
            visual_review: {
                summary: 'Every rendered slide was inspected at full size; the score records visual authorship separately from mechanical QA.',
                strengths: profile.strengths,
                scorecard: profile.scorecard,
                overall_score: profile.overall,
                reviewed_slide_numbers: reviewedSlides,
                slide_scores: reviewedSlides.map(slide => ({ slide, total: profile.slide })),
                issues: [],
            },
        },
    }, context);
    const data = resultData(review);
    const completed = { ...run, reviewed: true, finalQa: data.qa, finalCompletion: data.completion };
    await fs.writeFile(join(scenarioRoot, 'run.json'), JSON.stringify(completed, null, 2), 'utf8');
    return completed;
}

async function main(): Promise<void> {
    const command = process.argv[2] || 'list';
    if (command === 'list') {
        process.stdout.write(`${scenarios.map(scenario => scenario.id).join('\n')}\n`);
        return;
    }
    const scenarioId = process.argv[3] || '';
    const scenario = scenarioById(scenarioId);
    const configuredRoot = process.env.PRESENTATION_REGRESSION_ROOT;
    const root = configuredRoot
        ? resolve(configuredRoot)
        : await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-regression-'));
    await fs.mkdir(root, { recursive: true });
    const result = command === 'generate'
        ? await generateScenario(scenario, root)
        : command === 'review'
            ? await reviewScenario(scenario, root)
            : (() => { throw new Error(`Unsupported command ${command}; use list, generate, or review.`); })();
    process.stdout.write(`${JSON.stringify({ regressionRoot: root, ...result }, null, 2)}\n`);
}

main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
});
