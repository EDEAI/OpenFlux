/** Domain-neutral chart relationship gallery used by the presentation regression harness. */

export const chartGallerySlides: Array<Record<string, unknown>> = [
    {
        purpose: '建立图表能力测试边界',
        message: '十八种数据关系必须自动选择正确图形并保持可编辑',
        composition: 'focal',
        body: '测试数据只用于验证图形语义、可读性和 PowerPoint 输出，不代表真实经营结论。',
    },
    {
        purpose: '验证类别排名', message: '水平条形图适合比较名称较长的类别', composition: 'data', information_role: 'ranking',
        chart: { type: 'bar', name: '业务准备度', labels: ['客户运营', '供应链协同', '财务分析', '人才发展'], values: [88, 76, 63, 52] },
        body: '条形长度直接表达不同类别的相对高低。',
    },
    {
        purpose: '验证类别规模', message: '垂直柱状图突出离散周期之间的规模变化', composition: 'data',
        chart: { type: 'column', name: '季度采用团队数', labels: ['Q1', 'Q2', 'Q3', 'Q4'], values: [12, 21, 35, 48] },
        body: '类别较短且强调幅度时优先使用柱状图。',
    },
    {
        purpose: '验证时间趋势', message: '折线图揭示连续周期的方向和转折', composition: 'data',
        chart: { type: 'line', name: '月度采用率', labels: ['1月', '2月', '3月', '4月', '5月', '6月'], values: [18, 24, 31, 29, 42, 56] },
        body: '时间序列保留顺序，重点观察趋势而非单点装饰。',
    },
    {
        purpose: '验证整体构成', message: '饼图只用于少量、互斥且合计为整体的组成项', composition: 'data',
        chart: { type: 'pie', name: '工作负载构成', labels: ['标准任务', '复杂任务', '人工复核', '异常处置'], values: [52, 24, 16, 8] },
        body: '四个部分共同组成全部工作负载。',
    },
    {
        purpose: '验证横向堆叠构成', message: '堆叠条形图同时比较总量和组成结构', composition: 'data',
        chart: {
            type: 'stacked-bar', labels: ['业务甲', '业务乙', '业务丙'],
            series: [
                { name: '自动完成', values: [56, 43, 68] },
                { name: '人工复核', values: [24, 32, 18] },
                { name: '退回处理', values: [20, 25, 14] },
            ],
        },
        body: '每个业务的构成项口径保持一致。',
    },
    {
        purpose: '验证纵向堆叠构成', message: '堆叠柱状图展示构成随周期发生的变化', composition: 'data',
        chart: {
            type: 'stacked-column', labels: ['Q1', 'Q2', 'Q3', 'Q4'],
            series: [
                { name: '自助使用', values: [18, 26, 38, 51] },
                { name: '专家协助', values: [12, 15, 17, 18] },
                { name: '平台运营', values: [8, 9, 11, 13] },
            ],
        },
        body: '总量与组成份额可以在同一视图中比较。',
    },
    {
        purpose: '验证累计趋势', message: '面积图强调连续趋势及其累计规模感', composition: 'data',
        chart: { type: 'area', name: '累计复用次数', labels: ['1月', '2月', '3月', '4月', '5月'], values: [22, 39, 67, 104, 158] },
        body: '填充面积用于强调增长积累，不用于离散排名。',
    },
    {
        purpose: '验证带中心信息的构成', message: '环形图为整体构成保留中心摘要空间', composition: 'data',
        chart: { type: 'doughnut', name: '投入构成', labels: ['模型', '平台', '数据', '运营'], values: [34, 28, 22, 16] },
        body: '组成项必须互斥，并控制在易比较的数量范围内。',
    },
    {
        purpose: '验证双尺度关系', message: '组合图同时表达规模变化和效率变化', composition: 'data',
        chart: {
            type: 'combo', labels: ['Q1', 'Q2', 'Q3', 'Q4'],
            series: [
                { name: '处理量', values: [120, 180, 255, 340] },
                { name: '合格率', values: [82, 86, 91, 94] },
            ],
        },
        body: '柱形承载规模，折线承载另一量纲的变化方向。',
    },
    {
        purpose: '验证增减贡献', message: '瀑布图解释各因素如何共同形成最终变化', composition: 'data',
        chart: { type: 'waterfall', name: '季度价值变化', labels: ['基线', '采用增长', '复用收益', '质量损失', '运营投入'], values: [42, 18, 11, -6, -9] },
        body: '正负贡献保持同一累计基线，便于解释变化来源。',
    },
    {
        purpose: '验证二维相关性', message: '散点图判断投入与结果之间是否存在关系', composition: 'data',
        chart: { type: 'scatter', name: '投入与采用', labels: ['A', 'B', 'C', 'D', 'E', 'F'], x_values: [12, 18, 24, 31, 38, 46], values: [22, 29, 35, 51, 58, 69] },
        body: '横纵轴均为连续数值，点位表示观测对象。',
    },
    {
        purpose: '验证第三变量', message: '气泡图在相关性之外增加规模维度', composition: 'data',
        chart: { type: 'bubble', name: '价值、复杂度与规模', labels: ['场景A', '场景B', '场景C', '场景D', '场景E'], x_values: [18, 34, 46, 61, 75], values: [72, 58, 83, 66, 91], sizes: [12, 28, 19, 36, 24] },
        body: '位置表示两个连续变量，气泡大小表示第三个量级。',
    },
    {
        purpose: '验证多维轮廓', message: '雷达图比较同一对象在多个统一量纲上的能力轮廓', composition: 'data',
        chart: { type: 'radar', name: '平台能力轮廓', labels: ['质量', '速度', '成本', '治理', '复用', '体验'], values: [88, 76, 69, 84, 73, 81] },
        body: '各维度必须经过同尺度归一化，避免误导。',
    },
    {
        purpose: '验证分布形态', message: '直方图显示观测值集中在哪些区间', composition: 'data',
        chart: { type: 'histogram', name: '任务耗时分布', labels: ['0–2', '2–4', '4–6', '6–8', '8–10', '10+'], values: [8, 21, 34, 18, 11, 5] },
        body: '横轴为连续区间，柱高表示每个区间中的观测数量。',
    },
    {
        purpose: '进入关系型图表测试', message: '四种复杂关系使用可编辑形状保持数据语义', composition: 'focal',
        layout: { archetype: 'section', variant: 'banded' },
    },
    {
        purpose: '验证二维强度', message: '热力图快速定位两个维度交叉后的高低区域', composition: 'data',
        chart: {
            type: 'heatmap', name: '团队与能力使用强度',
            row_labels: ['销售', '运营', '研发', '财务'], column_labels: ['检索', '分析', '写作', '自动化', '复核'],
            matrix: [[7, 5, 8, 3, 4], [4, 8, 6, 9, 7], [6, 7, 4, 8, 6], [3, 9, 5, 4, 8]],
        },
        body: '颜色强度表达同一量纲，行列标签表达两个分类维度。',
    },
    {
        purpose: '验证带权层级', message: '树图用面积展示层级中各节点的相对权重', composition: 'data',
        chart: { type: 'treemap', name: '能力投入结构', labels: ['模型服务', '知识平台', '工作流', '治理', '评估', '运营'], values: [28, 22, 18, 14, 10, 8], parents: ['技术底座', '技术底座', '产品能力', '可信治理', '可信治理', '经营机制'] },
        body: '面积只编码正值权重；父子关系用于组织层级。',
    },
    {
        purpose: '验证阶段转化', message: '漏斗图显示有顺序的阶段如何逐步收窄', composition: 'data',
        chart: { type: 'funnel', name: '场景筛选漏斗', labels: ['候选需求', '完成评估', '进入试点', '稳定上线', '规模复用'], values: [120, 78, 42, 25, 16] },
        body: '阶段必须有明确顺序，数值通常单调减少。',
    },
    {
        purpose: '验证任务起止关系', message: '甘特图把任务起点、持续时间和并行关系放在同一时间轴', composition: 'data', information_role: 'timeline',
        chart: { type: 'gantt', name: '六周交付计划', labels: ['范围冻结', '数据准备', '能力配置', '业务试运行', '质量复核', '上线决策'], start_values: [0, 1, 2, 3, 4, 5], values: [1, 2, 2, 2, 1, 1] },
        body: 'start_values 表示起点，values 表示持续时间。',
    },
    {
        purpose: '完成图表能力验证', message: '图表类型由数据关系自动决定，用户无需增加任何配置', composition: 'closing',
        body: '十八种图表覆盖比较、趋势、构成、相关性、分布、层级、阶段和任务时间。',
    },
];
