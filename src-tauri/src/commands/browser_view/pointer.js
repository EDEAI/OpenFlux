// Synthetic hover/scroll affects only this document. It cannot establish
// browser CSS :hover state, and every event remains visibly untrusted.
(params) => {
    const result = { inputMode: 'dom', isTrusted: false };
    try {
        const x = params.x ?? 0;
        const y = params.y ?? 0;
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
            throw new Error('DOM pointer coordinates must be inside the browser viewport');
        }
        let target = document.elementFromPoint(x, y) || document.scrollingElement;
        while (target?.shadowRoot?.elementFromPoint) {
            const inner = target.shadowRoot.elementFromPoint(x, y);
            if (!inner || inner === target) break;
            target = inner;
        }
        if (!target || /^(IFRAME|OBJECT|EMBED)$/.test(target.tagName)) {
            throw new Error('DOM pointer needs an accessible element in the current document');
        }
        const init = { view: window, bubbles: true, cancelable: true, composed: true,
            clientX: x, clientY: y, screenX: screenX + x, screenY: screenY + y,
            button: -1, buttons: 0 };
        if (params.operation === 'hover') {
            const slot = Symbol.for('openflux.embedded.dom-hover');
            const stored = window[slot]?.deref();
            const previous = stored?.isConnected ? stored : null;
            const ancestors = (element) => {
                const chain = [];
                while (element) {
                    chain.push(element);
                    element = element.assignedSlot || element.parentElement || element.getRootNode()?.host;
                }
                return chain;
            };
            const pointer = (el, type, extra) => el.dispatchEvent(new PointerEvent(type, {
                ...init, pointerId: 2147483001, pointerType: 'mouse', isPrimary: true, ...extra,
            }));
            const mouse = (el, type, extra) => el.dispatchEvent(new MouseEvent(type, { ...init, ...extra }));
            if (previous !== target) {
                const before = ancestors(previous);
                const after = ancestors(target);
                const shared = before.find((element) => after.includes(element));
                const boundary = (relatedTarget) => ({ bubbles: false, cancelable: false, composed: false, relatedTarget });
                if (previous) {
                    pointer(previous, 'pointerout', { relatedTarget: target });
                    mouse(previous, 'mouseout', { relatedTarget: target });
                    for (const element of before) {
                        if (element === shared) break;
                        pointer(element, 'pointerleave', boundary(target));
                        mouse(element, 'mouseleave', boundary(target));
                    }
                }
                pointer(target, 'pointerover', { relatedTarget: previous || null });
                mouse(target, 'mouseover', { relatedTarget: previous || null });
                const entering = after.slice(0, shared ? after.indexOf(shared) : after.length).reverse();
                for (const element of entering) {
                    pointer(element, 'pointerenter', boundary(previous));
                    mouse(element, 'mouseenter', boundary(previous));
                }
                window[slot] = new WeakRef(target);
            }
            pointer(target, 'pointermove', {});
            mouse(target, 'mousemove', {});
            return JSON.stringify({ ...result, cssHover: false });
        }
        if (params.operation !== 'scroll') throw new Error('Unknown DOM pointer operation');
        const dx = params.deltaX ?? 0;
        const dy = params.deltaY ?? 0;
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error('Scroll deltas must be finite');
        const wheel = new WheelEvent('wheel', { ...init, deltaX: dx, deltaY: dy, deltaMode: 0 });
        if (!target.dispatchEvent(wheel)) {
            return JSON.stringify({ ...result, defaultPrevented: true });
        }
        const scrollingRoot = document.scrollingElement;
        const visited = new Set();
        let current = target;
        while (current && !visited.has(current)) {
            visited.add(current);
            const style = getComputedStyle(current);
            const root = current === scrollingRoot;
            const allowX = root ? !/^(hidden|clip)$/.test(style.overflowX) : /^(auto|scroll|overlay)$/.test(style.overflowX);
            const allowY = root ? !/^(hidden|clip)$/.test(style.overflowY) : /^(auto|scroll|overlay)$/.test(style.overflowY);
            const beforeX = current.scrollLeft;
            const beforeY = current.scrollTop;
            const left = allowX && current.scrollWidth > current.clientWidth ? dx : 0;
            const top = allowY && current.scrollHeight > current.clientHeight ? dy : 0;
            if (left || top) {
                current.scrollBy({ left, top, behavior: 'instant' });
                if (current.scrollLeft !== beforeX || current.scrollTop !== beforeY) {
                    return JSON.stringify({ ...result, scrolled: true });
                }
                if (style.overscrollBehaviorX === 'contain' || style.overscrollBehaviorY === 'contain'
                    || style.overscrollBehaviorX === 'none' || style.overscrollBehaviorY === 'none') break;
            }
            current = current.parentElement || current.getRootNode()?.host || (!visited.has(scrollingRoot) ? scrollingRoot : null);
        }
        return JSON.stringify({ ...result, scrolled: false, boundary: true });
    } catch (error) {
        return JSON.stringify({ ...result, error: String(error?.message || error) });
    }
}
