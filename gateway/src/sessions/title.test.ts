import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './store';
import { cleanSessionTitle, generateSessionTitle } from './title';
import type { LLMProvider } from '../llm/provider';

const root = mkdtempSync(join(tmpdir(), 'openflux-title-'));
after(() => rmSync(root, { recursive: true, force: true }));

let sessionCounter = 0;

function freshSession(store: SessionStore): string {
    const id = `session:title-${++sessionCounter}`;
    store.create('default', undefined, undefined, undefined, id);
    return id;
}

function stubLLM(reply: string | Error): LLMProvider {
    return {
        chat: async () => {
            if (reply instanceof Error) throw reply;
            return reply;
        },
    } as unknown as LLMProvider;
}

test('the sidebar gets a title from the user message, without waiting for a reply', () => {
    const store = new SessionStore({ storePath: root });
    const id = freshSession(store);

    store.addMessage(id, { role: 'user', content: '帮我分析这两份销售报表并做成PPT' });

    const meta = store.get(id);
    assert.equal(meta?.title, '帮我分析这两份销售报表并做成PPT');
    assert.equal(meta?.titleSource, 'auto');
});

test('a title change is announced so the Gateway can push it mid-turn', () => {
    const store = new SessionStore({ storePath: root });
    const id = freshSession(store);
    const announced: Array<[string, string]> = [];
    store.onTitleChanged((sessionId, title) => announced.push([sessionId, title]));

    store.addMessage(id, { role: 'user', content: '第一句话' });
    store.refineTitle(id, '摘要标题');

    assert.deepEqual(announced, [[id, '第一句话'], [id, '摘要标题']]);
});

test('a summary replaces the truncated opener it raced', () => {
    const store = new SessionStore({ storePath: root });
    const id = freshSession(store);
    store.addMessage(id, { role: 'user', content: '把这一周的AI新闻整理成一份中英双语的简报演示文稿' });

    assert.equal(store.refineTitle(id, 'AI一周新闻简报PPT'), true);
    assert.equal(store.get(id)?.title, 'AI一周新闻简报PPT');
    assert.equal(store.get(id)?.titleSource, 'summary');
});

test('a summary that lands before the first message still names the session', () => {
    const store = new SessionStore({ storePath: root });
    const id = freshSession(store);

    assert.equal(store.refineTitle(id, '销售数据分析'), true);
    assert.equal(store.get(id)?.title, '销售数据分析');
});

test('a summary never overwrites a name the user chose', () => {
    const store = new SessionStore({ storePath: root });
    const id = freshSession(store);
    store.addMessage(id, { role: 'user', content: '随便问点什么' });
    store.updateTitle(id, '我自己起的名字');

    assert.equal(store.refineTitle(id, '模型起的名字'), false);
    assert.equal(store.get(id)?.title, '我自己起的名字');
});

test('a later turn does not get renamed by a summary', () => {
    const store = new SessionStore({ storePath: root });
    const id = freshSession(store);
    store.addMessage(id, { role: 'user', content: '第一轮提问' });
    store.refineTitle(id, '第一轮主题');
    store.addMessage(id, { role: 'assistant', content: '回答' });
    store.addMessage(id, { role: 'user', content: '换个完全不同的话题' });

    assert.equal(store.get(id)?.title, '第一轮主题');
    assert.equal(store.acceptsTitleSummary(id), false);
});

test('an assistant-first history is still titled, the way older builds did it', () => {
    const store = new SessionStore({ storePath: root });
    const id = freshSession(store);
    // Attachment-only turns carry no string content, so no title is written yet.
    store.addMessage(id, { role: 'user', content: [{ type: 'text', text: 'x' }] as unknown as string });
    assert.equal(store.get(id)?.title, undefined);

    store.addMessage(id, { role: 'assistant', content: '回答' });
    assert.equal(store.get(id)?.title, undefined);
});

test('a model that wraps or announces its label still yields a usable one', () => {
    assert.equal(cleanSessionTitle('标题：AI一周新闻简报'), 'AI一周新闻简报');
    assert.equal(cleanSessionTitle('"Q3 销售数据分析"'), 'Q3 销售数据分析');
    assert.equal(cleanSessionTitle('《会员注册异常排查》'), '会员注册异常排查');
    assert.equal(cleanSessionTitle('  销售报表分析。 '), '销售报表分析');
    assert.equal(cleanSessionTitle('Title: Weekly AI Digest'), 'Weekly AI Digest');
});

test('a model that explains itself instead of naming the task is ignored', () => {
    assert.equal(cleanSessionTitle('好的，我会为你生成一份演示文稿，请稍等。首先我需要了解一下你的需求，然后再开始制作。'), '');
    assert.equal(cleanSessionTitle('标题一\n标题二'), '');
});

test('a long label is cut to something the sidebar can show whole', () => {
    const title = cleanSessionTitle('会员注册异常与Topps销售数据的综合洞察报告');
    assert.equal(title.length, 20);
});

test('naming a session never fails the turn it runs beside', async () => {
    assert.equal(await generateSessionTitle(stubLLM(new Error('model offline')), '任何输入'), undefined);
    assert.equal(await generateSessionTitle(stubLLM(''), '任何输入'), undefined);
    assert.equal(await generateSessionTitle(stubLLM('销售分析'), '   '), undefined);
    assert.equal(await generateSessionTitle(stubLLM('销售分析'), '分析销售数据'), '销售分析');
});
