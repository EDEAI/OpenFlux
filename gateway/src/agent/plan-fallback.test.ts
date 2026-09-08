import test from 'node:test';
import assert from 'node:assert/strict';
import { planDocumentFromMarkdown } from './plan-fallback';

const SAMPLE = `当前系统完成度盘点清楚后，后续计划分为 **5 个阶段**：

## 阶段一：前端功能补全（当前最急迫）

**现状**：11 个模块每个只有 1 个 List.vue。

| 优先级 | 模块 | 需补页面 |
|---|---|---|
| P0 | 付款 Payment | 新增付款单、审批 |

## 阶段二：集成对接

接钉钉假勤与发票 OCR。

## 风险

- 旧字段语义不明
- 工资核算偏差

## 验收标准

- 付款单可新增并审批通过
`;

test('headings become steps, keyword sections fill the matching lists', () => {
    const doc = planDocumentFromMarkdown(SAMPLE, '按照这个计划继续');
    assert.equal(doc.title, '当前系统完成度盘点清楚后，后续计划分为 5 个阶段：');
    assert.equal(doc.goal, '按照这个计划继续');
    assert.deepEqual(doc.steps.map(s => s.title), ['阶段一：前端功能补全（当前最急迫）', '阶段二：集成对接']);
    assert.match(doc.steps[0].description, /11 个模块/);
    assert.deepEqual(doc.risks, ['旧字段语义不明', '工资核算偏差']);
    assert.deepEqual(doc.acceptanceCriteria, ['付款单可新增并审批通过']);
    assert.ok(doc.steps.every(s => s.id.startsWith('step-') && s.description));
});

test('numbered lines without headings still yield steps; empty text yields one step', () => {
    const doc = planDocumentFromMarkdown('计划如下：\n1. 搭建骨架\n2. 实现付款模块\n3. 联调验证', '重建系统');
    assert.deepEqual(doc.steps.map(s => s.title), ['搭建骨架', '实现付款模块', '联调验证']);
    assert.equal(doc.title, '计划如下：');
    const empty = planDocumentFromMarkdown('', '目标');
    assert.equal(empty.steps.length, 1);
    assert.equal(empty.title, '实施计划');
    assert.equal(empty.acceptanceCriteria.length, 1);
});
