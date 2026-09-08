import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import {
    UserMessageNavigator,
    distributeMarkerPositions,
    findCurrentUserMessageIndex,
    summarizeUserMessage,
    userMessageIndexRatio,
} from '../../src/chat/user-message-navigator';

test('summarizeUserMessage normalizes whitespace, preserves Unicode characters and applies a fallback', () => {
    assert.equal(summarizeUserMessage('  first\n\t question  ', 72, 'attachment'), 'first question');
    assert.equal(summarizeUserMessage('😀甲乙丙', 3, 'attachment'), '😀甲乙…');
    assert.equal(summarizeUserMessage('恰好四字', 4, 'attachment'), '恰好四字');
    assert.equal(summarizeUserMessage('  \n\t  ', 10, 'attachment'), 'attachment');
});

test('message ratios and current-index lookup cover boundaries and empty input', () => {
    assert.equal(userMessageIndexRatio(0, 4), 0);
    assert.equal(userMessageIndexRatio(1, 4), 1 / 3);
    assert.equal(userMessageIndexRatio(3, 4), 1);
    assert.equal(userMessageIndexRatio(-1, 4), 0);
    assert.equal(userMessageIndexRatio(8, 4), 1);
    assert.equal(userMessageIndexRatio(0, 1), 0.5);
    assert.equal(userMessageIndexRatio(0, 0), 0);

    const tops = [100, 400, 900];
    assert.equal(findCurrentUserMessageIndex([], 100), -1);
    assert.equal(findCurrentUserMessageIndex(tops, 50), 0);
    assert.equal(findCurrentUserMessageIndex(tops, 100), 0);
    assert.equal(findCurrentUserMessageIndex(tops, 399), 0);
    assert.equal(findCurrentUserMessageIndex(tops, 400), 1);
    assert.equal(findCurrentUserMessageIndex(tops, 999), 2);
});

test('marker distribution remains ordered, bounded and separated in a short rail', () => {
    assert.deepEqual(distributeMarkerPositions([], 100, 10), []);
    assert.deepEqual(distributeMarkerPositions([0.1], 100, 10), [50]);
    assert.deepEqual(distributeMarkerPositions([-1, 2], 100, 10), [0, 100]);

    const positions = distributeMarkerPositions([0, 0, 0.25, 0.25, 1], 20, 10);
    assert.equal(positions.length, 5);
    assert.ok(positions[0] >= 0);
    assert.ok(positions.at(-1)! <= 20);
    for (let index = 1; index < positions.length; index += 1) {
        assert.ok(
            positions[index] - positions[index - 1] >= 5,
            'the effective gap should fit all markers without overlap',
        );
    }
});

function cssRuleGroup(
    css: string,
    firstSelectorPattern: string,
): { selectors: string; body: string } {
    const match = css.match(new RegExp(`(${firstSelectorPattern}[^\\{]*)\\{([^}]*)\\}`, 'm'));
    assert.ok(match, `expected CSS rule beginning with ${firstSelectorPattern}`);
    return { selectors: match[1], body: match[2] };
}

test('navigation rail CSS uses solid OpenFlux dots and accessibility fallbacks', () => {
    const css = readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8');
    const rail = cssRuleGroup(css, String.raw`\.user-message-rail\s*`);
    const defaultDot = cssRuleGroup(css, String.raw`\.user-message-rail-dot\s*`);
    const currentDot = cssRuleGroup(
        css,
        String.raw`\.user-message-rail-marker\.is-current\s+\.user-message-rail-dot\s*`,
    );
    const focusedDot = cssRuleGroup(
        css,
        String.raw`\.user-message-rail-marker:hover\s+\.user-message-rail-dot\s*`,
    );

    assert.match(rail.body, /left\s*:\s*6px\s*;/);
    assert.doesNotMatch(rail.body, /calc\(\s*50%/);
    assert.match(defaultDot.body, /width\s*:\s*5px\s*;/);
    assert.match(defaultDot.body, /height\s*:\s*5px\s*;/);
    assert.match(defaultDot.body, /border-radius\s*:\s*50%\s*;/);
    assert.match(currentDot.body, /background\s*:\s*var\(--color-primary,\s*#737373\)\s*;/);
    assert.match(currentDot.body, /opacity\s*:\s*1\s*;/);
    assert.doesNotMatch(currentDot.body, /transform|box-shadow|\b(?:width|height)\s*:/);
    assert.match(focusedDot.selectors, /\.user-message-rail-marker:hover\s+\.user-message-rail-dot/);
    assert.match(focusedDot.selectors, /\.user-message-rail-marker:focus-visible\s+\.user-message-rail-dot/);
    assert.match(focusedDot.body, /scale\(1\.8\)/);
    assert.match(focusedDot.body, /background\s*:\s*var\(--color-primary,\s*#737373\)\s*;/);
    assert.match(focusedDot.body, /opacity\s*:\s*1\s*;/);
    assert.doesNotMatch(focusedDot.body, /box-shadow/);

    const adjacentOne = cssRuleGroup(
        css,
        String.raw`\.user-message-rail-marker:has\(\+\s+\.user-message-rail-marker:hover\)\s+\.user-message-rail-dot\s*`,
    );
    assert.match(adjacentOne.selectors, /:has\(\+\s+\.user-message-rail-marker:hover\)/);
    assert.match(adjacentOne.selectors, /:has\(\+\s+\.user-message-rail-marker:focus-visible\)/);
    assert.match(adjacentOne.selectors, /:hover\s+\+\s+\.user-message-rail-marker\s+\.user-message-rail-dot/);
    assert.match(adjacentOne.selectors, /:focus-visible\s+\+\s+\.user-message-rail-marker\s+\.user-message-rail-dot/);
    assert.match(adjacentOne.body, /scale\(1\.4\)/);

    const adjacentTwo = cssRuleGroup(
        css,
        String.raw`\.user-message-rail-marker:has\(\+\s+\.user-message-rail-marker\s+\+\s+\.user-message-rail-marker:hover\)\s+\.user-message-rail-dot\s*`,
    );
    assert.match(
        adjacentTwo.selectors,
        /:has\(\+\s+\.user-message-rail-marker\s+\+\s+\.user-message-rail-marker:hover\)/,
    );
    assert.match(
        adjacentTwo.selectors,
        /:hover\s+\+\s+\.user-message-rail-marker\s+\+\s+\.user-message-rail-marker\s+\.user-message-rail-dot/,
    );
    assert.match(adjacentTwo.body, /scale\(1\.22\)/);

    const adjacentThree = cssRuleGroup(
        css,
        String.raw`\.user-message-rail-marker:has\(\+\s+\.user-message-rail-marker\s+\+\s+\.user-message-rail-marker\s+\+\s+\.user-message-rail-marker:hover\)\s+\.user-message-rail-dot\s*`,
    );
    assert.match(
        adjacentThree.selectors,
        /:has\(\+\s+\.user-message-rail-marker\s+\+\s+\.user-message-rail-marker\s+\+\s+\.user-message-rail-marker:hover\)/,
    );
    assert.match(
        adjacentThree.selectors,
        /:hover\s+\+\s+\.user-message-rail-marker\s+\+\s+\.user-message-rail-marker\s+\+\s+\.user-message-rail-marker\s+\.user-message-rail-dot/,
    );
    assert.match(adjacentThree.body, /scale\(1\.08\)/);

    assert.match(
        css,
        /@container\s*\(max-width:\s*480px\)\s*\{\s*\.user-message-rail\s*\{\s*display\s*:\s*none\s*!important\s*;\s*\}\s*\}/m,
    );
    assert.match(
        css,
        /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.user-message-rail-dot\s*,\s*\.user-message-rail-preview\s*\{\s*transition\s*:\s*none\s*;\s*\}\s*\.message\.user\.conversation-index-target\s+\.message-bubble\s*\{\s*animation\s*:\s*none\s*;\s*\}\s*\}/m,
    );
});

interface NavigatorHarness {
    dom: JSDOM;
    messages: HTMLElement;
    rail: HTMLElement;
    scrollCalls: ScrollToOptions[];
    flushAnimationFrames: () => void;
    setMessageGeometry: () => void;
    cleanup: () => void;
}

function createNavigatorHarness(): NavigatorHarness {
    const dom = new JSDOM(`<!doctype html><body>
        <div id="messages">
            <div class="message user" data-message-id="user-1" data-test-top="100">
                <div class="message-bubble"><div class="markdown-body">  First\n question  </div></div>
            </div>
            <div class="message assistant" data-message-id="assistant-1" data-test-top="300">
                <div class="message-bubble"><div class="markdown-body">Assistant answer</div></div>
            </div>
            <div class="message user" data-message-id="user-2" data-test-top="500">
                <div class="message-bubble"><div class="markdown-body">Second question</div></div>
            </div>
            <div class="message user" data-message-id="user-3" data-test-top="900">
                <div class="message-bubble"><span class="msg-attach-name">plan.png</span></div>
            </div>
        </div>
        <nav id="rail"></nav>
    </body>`, {
        pretendToBeVisual: true,
        url: 'http://localhost/',
    });

    const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
    const animationFrames = new Map<number, FrameRequestCallback>();
    let nextAnimationFrameId = 1;
    const requestFrame = (callback: FrameRequestCallback): number => {
        const id = nextAnimationFrameId++;
        animationFrames.set(id, callback);
        return id;
    };
    const cancelFrame = (id: number): void => {
        animationFrames.delete(id);
    };
    const globals: Record<string, unknown> = {
        window: dom.window,
        document: dom.window.document,
        Element: dom.window.Element,
        HTMLElement: dom.window.HTMLElement,
        MutationObserver: dom.window.MutationObserver,
        ResizeObserver: undefined,
        requestAnimationFrame: requestFrame,
        cancelAnimationFrame: cancelFrame,
    };
    for (const [key, value] of Object.entries(globals)) {
        previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, {
            configurable: true,
            writable: true,
            value,
        });
    }

    const messages = dom.window.document.getElementById('messages') as HTMLElement;
    const rail = dom.window.document.getElementById('rail') as HTMLElement;
    Object.defineProperty(messages, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(messages, 'scrollHeight', { configurable: true, value: 1_200 });
    messages.getBoundingClientRect = () => ({
        x: 0,
        y: 0,
        top: 0,
        right: 800,
        bottom: 400,
        left: 0,
        width: 800,
        height: 400,
        toJSON: () => ({}),
    });

    const scrollCalls: ScrollToOptions[] = [];
    Object.defineProperty(messages, 'scrollTo', {
        configurable: true,
        value: (options: ScrollToOptions) => {
            scrollCalls.push(options);
            if (typeof options.top === 'number') messages.scrollTop = options.top;
        },
    });

    const setMessageGeometry = (): void => {
        messages.querySelectorAll<HTMLElement>('.message[data-test-top]').forEach(message => {
            const absoluteTop = Number(message.dataset.testTop);
            message.getBoundingClientRect = () => {
                const top = absoluteTop - messages.scrollTop;
                return {
                    x: 0,
                    y: top,
                    top,
                    right: 600,
                    bottom: top + 80,
                    left: 0,
                    width: 600,
                    height: 80,
                    toJSON: () => ({}),
                };
            };
        });
    };
    setMessageGeometry();

    return {
        dom,
        messages,
        rail,
        scrollCalls,
        setMessageGeometry,
        flushAnimationFrames: () => {
            while (animationFrames.size > 0) {
                const pending = [...animationFrames.entries()];
                animationFrames.clear();
                for (const [, callback] of pending) callback(0);
            }
        },
        cleanup: () => {
            animationFrames.clear();
            dom.window.close();
            for (const [key, descriptor] of previousGlobals.entries()) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else delete (globalThis as Record<string, unknown>)[key];
            }
        },
    };
}

test('navigator builds only user markers, stays idempotent, tracks current messages and navigates', () => {
    const harness = createNavigatorHarness();
    let navigateCalls = 0;
    const navigator = new UserMessageNavigator(harness.messages, harness.rail, {
        previewMaxChars: 24,
        minimumMessages: 2,
        scrollBehavior: 'smooth',
        onNavigate: () => { navigateCalls += 1; },
    });

    try {
        harness.flushAnimationFrames();
        const markers = () => Array.from(
            harness.rail.querySelectorAll<HTMLButtonElement>('.user-message-rail-marker'),
        );

        assert.deepEqual(markers().map(marker => marker.dataset.messageId), [
            'user-1',
            'user-2',
            'user-3',
        ]);
        assert.equal(markers().every(marker => !!marker.querySelector('.user-message-rail-dot')), true);
        assert.equal(harness.rail.querySelector('.user-message-rail-line'), null);
        assert.equal(markers()[0].dataset.summary, 'First question');
        assert.equal(markers()[2].dataset.summary, 'plan.png');
        assert.equal(harness.rail.classList.contains('hidden'), false);

        navigator.refresh();
        navigator.refresh();
        harness.flushAnimationFrames();
        assert.equal(markers().length, 3);
        assert.equal(new Set(markers().map(marker => marker.dataset.messageId)).size, 3);

        assert.equal(navigator.updateCurrent(520), 1);
        assert.equal(markers()[1].classList.contains('is-current'), true);
        assert.equal(markers()[1].getAttribute('aria-current'), 'location');
        assert.equal(markers()[0].hasAttribute('aria-current'), false);
        assert.equal(markers()[2].hasAttribute('aria-current'), false);

        markers()[1].click();
        assert.equal(navigateCalls, 1);
        assert.deepEqual(harness.scrollCalls, [{ top: 484, behavior: 'smooth' }]);

        // At the absolute bottom, the final user turn owns the current marker
        // even when its top sits below the normal 28% viewport anchor.
        const finalMessage = harness.messages.querySelector<HTMLElement>('[data-message-id="user-3"]')!;
        finalMessage.dataset.testTop = '1100';
        harness.messages.scrollTop = 800;
        harness.setMessageGeometry();
        assert.equal(navigator.updateCurrent(), 2);
        assert.equal(markers()[2].classList.contains('is-current'), true);
        assert.equal(markers()[1].classList.contains('is-current'), false);

        harness.messages.innerHTML = `
            <div class="message user" data-message-id="user-2" data-test-top="200">
                <div class="message-bubble"><div class="markdown-body">Updated second question</div></div>
            </div>
            <div class="message assistant" data-message-id="assistant-2" data-test-top="400"></div>
            <div class="message user" data-message-id="user-4" data-test-top="700">
                <div class="message-bubble"><div class="markdown-body">Fourth question</div></div>
            </div>`;
        harness.messages.scrollTop = 0;
        harness.setMessageGeometry();
        navigator.refresh();
        harness.flushAnimationFrames();

        assert.deepEqual(markers().map(marker => marker.dataset.messageId), ['user-2', 'user-4']);
        assert.deepEqual(markers().map(marker => marker.dataset.summary), [
            'Updated second question',
            'Fourth question',
        ]);
    } finally {
        navigator.destroy();
        harness.cleanup();
    }
});
