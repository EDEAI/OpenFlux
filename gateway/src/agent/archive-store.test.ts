import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProjectStore } from './project-store';
import { UserAgentStore } from './user-agent-store';
import { SessionStore } from '../sessions/store';

test('archiving a session hides it from normal lists without removing its content', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'openflux-session-archive-'));
    try {
        const sessions = new SessionStore({ storePath: dataDir });
        const kept = sessions.create('main', 'Kept');
        const archived = sessions.create('main', 'Archived');
        sessions.addMessage(archived.id, { role: 'user', content: 'retained content' });

        sessions.archive(archived.id);

        assert.deepEqual(sessions.list('main').map(item => item.id), [kept.id]);
        assert.deepEqual(sessions.listMetadata().map(item => item.id), [kept.id]);
        assert.equal(sessions.listMetadata({ includeDeleted: true }).some(item => item.id === archived.id), true);
        assert.equal(sessions.get(archived.id)?.status, 'archived');
        assert.equal(sessions.getMessages(archived.id)[0]?.content, 'retained content');

        const reopened = new SessionStore({ storePath: dataDir });
        assert.equal(reopened.get(archived.id)?.status, 'archived');
        assert.equal(reopened.getMessages(archived.id)[0]?.content, 'retained content');
    } finally {
        await rm(dataDir, { recursive: true, force: true });
    }
});

test('legacy Agent delete archives the record while the default Agent remains protected', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'openflux-agent-archive-'));
    try {
        const agents = new UserAgentStore(dataDir, 'OpenFlux Assistant', [], false);
        const custom = agents.create({ name: 'Research' });

        assert.equal(agents.delete(custom.id), true);
        assert.equal(agents.get(custom.id), undefined);
        assert.equal(agents.list().some(agent => agent.id === custom.id), false);
        assert.equal(agents.get(custom.id, { includeArchived: true })?.status, 'archived');
        assert.equal(agents.archive('main'), false);
        assert.equal(agents.get('main')?.status, 'active');

        const persisted = JSON.parse(await readFile(join(dataDir, 'user_agents.json'), 'utf-8')) as {
            agents: Array<{ id: string; status?: string }>;
        };
        assert.equal(persisted.agents.find(agent => agent.id === custom.id)?.status, 'archived');
        assert.equal(new UserAgentStore(dataDir, 'OpenFlux Assistant', [], false)
            .get(custom.id, { includeArchived: true })?.status, 'archived');
    } finally {
        await rm(dataDir, { recursive: true, force: true });
    }
});

test('legacy Project delete archives the project and keeps its workspace record', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'openflux-project-archive-'));
    const workspace = await mkdtemp(join(tmpdir(), 'openflux-project-archive-workspace-'));
    try {
        const projects = new ProjectStore(dataDir);
        const project = projects.create({ name: 'Archived project', workspace });

        assert.equal(projects.delete(project.id), true);
        assert.equal(projects.get(project.id), undefined);
        assert.equal(projects.list().some(item => item.id === project.id), false);
        assert.equal(projects.get(project.id, { includeArchived: true })?.status, 'archived');

        const persisted = JSON.parse(await readFile(join(dataDir, 'projects.json'), 'utf-8')) as {
            projects: Array<{ id: string; status?: string; workspace?: string }>;
        };
        const stored = persisted.projects.find(item => item.id === project.id);
        assert.equal(stored?.status, 'archived');
        assert.equal(stored?.workspace, workspace);
        assert.equal(new ProjectStore(dataDir).get(project.id, { includeArchived: true })?.status, 'archived');
    } finally {
        await rm(dataDir, { recursive: true, force: true });
        await rm(workspace, { recursive: true, force: true });
    }
});

test('Gateway accepts explicit archive messages and maps legacy delete handlers to archive operations', async () => {
    const source = await readFile(new URL('../gateway/standalone.ts', import.meta.url), 'utf-8');
    assert.match(source, /\.register\('sessions\.archive', handleSessionsDelete\)/);
    assert.match(source, /case 'agents\.archive':\s*handleAgentsDelete/);
    assert.match(source, /sessions\.archive\(payload\.sessionId\)/);
    assert.match(source, /projectStore\.archive\(payload\.agentId\)/);
    assert.match(source, /userAgentStore\.archive\(payload\.agentId\)/);
    assert.match(source, /rejectInactiveSessionRequest\(client, message, payload\?\.sessionId\)/);
    assert.match(source, /function retireArchivedSessionWork[\s\S]*?executionRegistry\.abortIfCurrent[\s\S]*?turnQueueStore\.clear[\s\S]*?userInputStore\.cancel/);
    assert.match(source, /sessions\.archive\(payload\.sessionId\);\s*retireArchivedSessionWork\(payload\.sessionId\)/);
    assert.match(source, /sessions\.archive\(s\.id\);\s*retireArchivedSessionWork\(s\.id\)/);
    assert.match(source, /定时任务绑定的会话已归档/);

    const clientSource = await readFile(new URL('../../../src/gateway-client.ts', import.meta.url), 'utf-8');
    assert.match(clientSource, /async archiveSession\(sessionId: string\)/);
    assert.match(clientSource, /'sessions\.archive'/);
    assert.match(clientSource, /async archiveAgent\(agentId: string\)/);
    assert.match(clientSource, /'agents\.archive'/);
    assert.match(clientSource, /async deleteSession[\s\S]*?this\.archiveSession\(sessionId\)/);
    assert.match(clientSource, /async deleteAgent[\s\S]*?this\.archiveAgent\(agentId\)/);

    const minimalGatewaySource = await readFile(new URL('../gateway/server.ts', import.meta.url), 'utf-8');
    assert.match(minimalGatewaySource, /case 'sessions\.archive':\s*case 'sessions\.delete':/);
    assert.match(minimalGatewaySource, /sessionStore\.archive\(payload\.sessionId\)/);
    assert.match(minimalGatewaySource, /existing\.status === 'archived'/);
});
