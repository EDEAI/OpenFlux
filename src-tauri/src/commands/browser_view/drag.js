// DOM-only drag fallback. AppKit's ordinary NSEvents obtain `buttons` from
// physical hardware state, so they cannot represent a held virtual pointer.
// These events are intentionally untrusted; callers must inspect page state.
(params) => {
    const result = { inputMode: 'dom', isTrusted: false };
    const restores = [];
    let captured = null;
    let pointerTarget = null;
    let pointerIsDown = false;
    let currentX = params.x;
    let currentY = params.y;
    const pointerId = 2147483000;
    const at = (x, y) => {
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
            throw new Error('DOM drag coordinates must be inside the browser viewport');
        }
        let element = document.elementFromPoint(x, y);
        while (element?.shadowRoot?.elementFromPoint) {
            const inner = element.shadowRoot.elementFromPoint(x, y);
            if (!inner || inner === element) break;
            element = inner;
        }
        if (!element || /^(IFRAME|OBJECT|EMBED)$/.test(element.tagName)) {
            throw new Error('DOM drag needs an accessible element in the current document');
        }
        return element;
    };
    const init = (x, y, buttons) => ({
        view: window, bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, screenX: screenX + x, screenY: screenY + y,
        button: 0, buttons,
    });
    const pointer = (target, type, x, y, buttons) => target.dispatchEvent(new PointerEvent(type, {
        ...init(x, y, buttons), pointerId, pointerType: 'mouse', isPrimary: true,
        width: 1, height: 1, pressure: buttons ? 0.5 : 0,
    }));
    const mouse = (target, type, x, y, buttons) => target.dispatchEvent(new MouseEvent(type, init(x, y, buttons)));
    try {
        const start = at(params.x, params.y);
        at(params.x2, params.y2);
        // Synthetic pointers have no native active-pointer entry. Scope capture
        // emulation to our ID and restore every method before returning.
        for (const name of ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture']) {
            const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, name);
            if (!descriptor?.configurable || typeof descriptor.value !== 'function') {
                throw new Error(`DOM drag cannot provide ${name} on this page`);
            }
            const original = descriptor.value;
            const replacement = function (id) {
                if (id !== pointerId) return original.call(this, id);
                if (name === 'hasPointerCapture') return captured === this;
                if (name === 'setPointerCapture') {
                    if (!this.isConnected || this.ownerDocument !== document) throw new Error('DOM drag capture target is detached');
                    captured = this;
                } else if (captured === this) captured = null;
            };
            Object.defineProperty(Element.prototype, name, { ...descriptor, value: replacement });
            restores.push(() => {
                // Preserve a change made by the page's own event handler.
                if (Object.getOwnPropertyDescriptor(Element.prototype, name)?.value === replacement) {
                    Object.defineProperty(Element.prototype, name, descriptor);
                }
            });
        }
        pointerTarget = start;
        pointerIsDown = true;
        const pointerAccepted = pointer(start, 'pointerdown', params.x, params.y, 1);
        if (pointerAccepted) mouse(start, 'mousedown', params.x, params.y, 1);

        const draggable = start.closest('[draggable="true"]') || (start.draggable ? start : null);
        const transfer = draggable ? new DataTransfer() : null;
        const drag = (target, type, x, y, buttons = 1) => target.dispatchEvent(new DragEvent(type, {
            ...init(x, y, buttons), dataTransfer: transfer,
        }));
        if (draggable && !drag(draggable, 'dragstart', params.x, params.y)) {
            throw new Error('The page canceled DOM dragstart');
        }
        let previous = start;
        let dropAccepted = false;
        for (let step = 1; step <= 16; step++) {
            currentX = params.x + (params.x2 - params.x) * step / 16;
            currentY = params.y + (params.y2 - params.y) * step / 16;
            const hit = at(currentX, currentY);
            const target = captured || hit;
            if (!target.isConnected) throw new Error('DOM drag target was removed during the operation');
            pointerTarget = target;
            pointer(target, 'pointermove', currentX, currentY, 1);
            if (pointerAccepted) mouse(target, 'mousemove', currentX, currentY, 1);
            if (draggable) {
                drag(draggable, 'drag', currentX, currentY);
                if (hit !== previous) {
                    drag(previous, 'dragleave', currentX, currentY);
                    drag(hit, 'dragenter', currentX, currentY);
                }
                dropAccepted = !drag(hit, 'dragover', currentX, currentY);
            }
            previous = hit;
        }
        if (draggable) {
            if (dropAccepted) drag(previous, 'drop', currentX, currentY, 0);
            drag(draggable, 'dragend', currentX, currentY, 0);
        }
        pointer(pointerTarget, 'pointerup', currentX, currentY, 0);
        pointerIsDown = false;
        if (pointerAccepted) mouse(pointerTarget, 'mouseup', currentX, currentY, 0);
        if (draggable && !dropAccepted) throw new Error('The page did not accept the DOM drop target');
        return JSON.stringify(result);
    } catch (error) {
        return JSON.stringify({ ...result, error: String(error?.message || error) });
    } finally {
        try {
            if (pointerIsDown && pointerTarget?.isConnected) {
                pointer(pointerTarget, 'pointercancel', currentX, currentY, 0);
            }
        } finally {
            let failure;
            for (const restore of restores.reverse()) {
                try { restore(); } catch (error) { failure ||= error; }
            }
            if (failure) throw failure;
        }
    }
}
