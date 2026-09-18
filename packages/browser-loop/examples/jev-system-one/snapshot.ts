export const VIEWPORT_SNAPSHOT = String.raw`(() => {
	if (!document.body) return null;
	const state = window.__jevLoopSnapshot ||= { ids: new WeakMap(), nodes: new Map(), redacted: new WeakSet(), next: 1 };
	state.redacted ||= new WeakSet();
	const nodeId = (element) => {
		if (!state.ids.has(element)) state.ids.set(element, state.next++);
		const id = state.ids.get(element);
		state.nodes.set(id, element);
		return id;
	};
	for (const [id, element] of state.nodes) if (!element.isConnected) state.nodes.delete(id);

	const roles = new Set([
		'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
		'menuitemradio', 'option', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton',
	]);
	const selector = [
		'a[href]', 'button', 'input', 'textarea', 'select', 'summary', '[contenteditable="true"]',
		...[...roles].map((role) => '[role="' + role + '"]'),
	].join(',');
	const roleOf = (element) => {
		const explicit = element.getAttribute('role');
		if (roles.has(explicit)) return explicit;
		if (element.tagName === 'BUTTON' || element.tagName === 'SUMMARY') return 'button';
		if (element.tagName === 'A') return 'link';
		if (element.tagName === 'SELECT') return 'combobox';
		if (element.tagName === 'TEXTAREA' || element.isContentEditable) return 'textbox';
		if (element.tagName !== 'INPUT') return null;
		if (element.type === 'checkbox' || element.type === 'radio') return element.type;
		if (['button', 'submit', 'reset', 'image'].includes(element.type)) return 'button';
		if (element.type === 'search') return 'searchbox';
		if (element.type === 'number') return 'spinbutton';
		if (['text', 'email', 'password', 'url', 'tel', 'date', 'datetime-local', 'month', 'week', 'time'].includes(element.type)) return 'textbox';
		return null;
	};
	const visible = (element) => {
		if (element.closest('[aria-hidden="true"],[inert]')) return false;
		if (element.checkVisibility && !element.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
		const style = getComputedStyle(element);
		return style.visibility !== 'hidden' && style.display !== 'none';
	};
	const textVisible = (element) => visible(element)
		&& (!element.checkVisibility || element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
		&& Number(getComputedStyle(element).opacity) !== 0;
	const nameOf = (element, seen = new Set()) => {
		if (!element || seen.has(element)) return '';
		seen.add(element);
		const labelled = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
			.map((id) => nameOf(document.getElementById(id), seen)).filter(Boolean).join(' ');
		if (labelled) return labelled;
		const labels = [...(element.labels || [])].map((label) => nameOf(label, seen)).filter(Boolean).join(' ');
		return element.getAttribute('aria-label') || labels
			|| (['button', 'submit', 'reset'].includes(element.type) ? element.value : '')
			|| element.getAttribute('alt')
			|| (element.tagName === 'INPUT' ? '' : [...element.childNodes].map((child) => {
				if (child.nodeType === Node.TEXT_NODE) return child.textContent;
				if (child.nodeType === Node.ELEMENT_NODE && child.getAttribute('aria-hidden') !== 'true') return nameOf(child, seen);
				return '';
			}).join(' ').replace(/\s+/g, ' ').trim())
			|| element.getAttribute('title') || element.getAttribute('placeholder') || '';
	};
	const alwaysSensitive = (element) => element.type === 'password' || (element.autocomplete || '').toLowerCase().split(/\s+/).includes('one-time-code');
	const hasValue = (element, role) => {
		if ('value' in element) return String(element.value ?? '').length > 0;
		if (element.isContentEditable || role === 'combobox') return element.innerText.trim().length > 0;
		return false;
	};
	const valueOf = (element, role) => {
		if (alwaysSensitive(element) || state.redacted.has(element)) return '';
		if ('value' in element) return String(element.value ?? '');
		if (element.isContentEditable || role === 'combobox') return element.innerText.trim();
		return '';
	};
	const stableName = (value) => value.replace(/\s*,\s*(?:(?:from\s+)?[$€£]\s*\d|(?:from\s+)?\d[\d,.]*\s+(?:US\s+)?dollars?).*$/i, '').trim();
	const checkedOf = (element) => {
		if (element.type === 'checkbox' || element.type === 'radio') return element.checked;
		const checked = element.getAttribute('aria-checked');
		return checked === null ? undefined : checked === 'mixed' ? 'mixed' : checked === 'true';
	};
	const guardOf = (element) => {
		if (!element?.isConnected || !visible(element)) return null;
		const role = roleOf(element);
		return JSON.stringify([
			role, stableName(nameOf(element)), alwaysSensitive(element) || state.redacted.has(element) ? hasValue(element, role) : valueOf(element, role), element.checked ?? null, element.selectedIndex ?? null,
			element.readOnly ?? null, element.matches(':disabled'), element.getAttribute('aria-disabled'),
			element.getAttribute('aria-expanded'), element.getAttribute('aria-checked'), element.getAttribute('aria-selected'),
			element.getAttribute('href'),
		]);
	};
	const actionPoint = (element) => {
		if (!element?.isConnected || !visible(element)) return null;
		const rect = element.getBoundingClientRect();
		const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
		if (rect.width <= 0 || rect.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
		const hit = document.elementFromPoint(x, y);
		const receivesInput = element.contains(hit) || [...(element.labels || [])].some((label) => label.contains(hit));
		return receivesInput ? { x, y } : null;
	};
	state.guard = guardOf;
	state.visible = visible;
	state.actionPoint = actionPoint;

	const elements = [];
	let omitted = 0;
	for (const element of document.querySelectorAll(selector)) {
		if (['file', 'hidden'].includes(element.type)) continue;
		if (!visible(element) || element.matches(':disabled') || element.closest('[aria-disabled="true"]')) continue;
		if (element.tagName === 'OPTION' && element.closest('select')) continue;
		const role = roleOf(element);
		if (!role) continue;
		const rect = element.getBoundingClientRect();
		if (!actionPoint(element)) continue;
		if (role === 'gridcell' && element.querySelector('button,[role="button"]')) continue;
		const editable = !element.readOnly && element.getAttribute('aria-readonly') !== 'true'
			&& (['textbox', 'searchbox', 'spinbutton'].includes(role)
				|| (role === 'combobox' && ['INPUT', 'TEXTAREA'].includes(element.tagName)));
		const operations = [];
		const options = [];
		if (element.tagName === 'SELECT') {
			operations.push('SELECT');
			for (const option of element.options) {
				if (!option.disabled && !option.closest('optgroup[disabled]')) {
					options.push({ label: option.label || option.textContent || option.value, value: option.value, selected: option.selected });
				}
			}
		} else {
			if (editable) operations.push('TYPE_TEXT');
			operations.push('CLICK');
		}
		if (elements.length >= 250) {
			omitted += 1;
			continue;
		}
		elements.push({
			id: 'n' + nodeId(element), node: nodeId(element), role, name: nameOf(element) || role,
			value: valueOf(element, role),
			...((alwaysSensitive(element) || state.redacted.has(element)) ? { hasValue: hasValue(element, role), sensitive: alwaysSensitive(element) } : {}),
			operations: alwaysSensitive(element) ? operations.filter((operation) => operation !== 'TYPE_TEXT') : operations, options,
			checked: checkedOf(element),
			selected: element.getAttribute('aria-selected') === null ? undefined : element.getAttribute('aria-selected') === 'true',
			expanded: element.getAttribute('aria-expanded') === null ? undefined : element.getAttribute('aria-expanded') === 'true',
			disabled: false, guard: guardOf(element), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
		});
	}

	const words = [];
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	const range = document.createRange();
	let textLength = 0;
	let textNode;
	while ((textNode = walker.nextNode()) && textLength < 6000) {
		const value = textNode.textContent.trim();
		const parent = textNode.parentElement;
		if (!value || !parent || parent.closest('script,style,noscript,template') || !textVisible(parent)) continue;
		range.selectNodeContents(textNode);
		const rect = range.getBoundingClientRect();
		if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth) {
			words.push(value);
			textLength += value.length;
		}
	}
	const text = words.join('\n').slice(0, 6000);
	const point = { x: Math.max(0, Math.floor(innerWidth / 2)), y: Math.max(0, Math.min(innerHeight - 1, Math.floor(innerHeight * 0.83))) };
	let scrollElement = document.elementFromPoint(point.x, point.y);
	while (scrollElement && scrollElement !== document.body && scrollElement !== document.documentElement) {
		const style = getComputedStyle(scrollElement);
		if (/(auto|scroll)/.test(style.overflowY) && scrollElement.scrollHeight > scrollElement.clientHeight + 2) break;
		scrollElement = scrollElement.parentElement;
	}
	if (!scrollElement || scrollElement === document.body || scrollElement === document.documentElement) {
		scrollElement = document.scrollingElement || document.documentElement;
	}
	const scroll = {
		y: scrollElement.scrollTop, height: scrollElement.scrollHeight, viewport: scrollElement.clientHeight,
		width: innerWidth, x: point.x, pointY: point.y,
	};
	const frames = [];
	const collectFrames = (root) => {
		for (const element of root.querySelectorAll('iframe')) frames.push(element);
		for (const element of root.querySelectorAll('*')) if (element.shadowRoot) collectFrames(element.shadowRoot);
	};
	collectFrames(document);
	const hasVisibleFrame = frames.some((frame) => {
		if (!visible(frame)) return false;
		const rect = frame.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
	});
	const documentId = String(performance.timeOrigin);
	const semantics = elements.map(({ rect, guard, ...element }) => element);
	const marker = JSON.stringify([documentId, location.href, document.title, text, semantics, scroll]);
	return { url: location.href, title: document.title, documentId, text, elements, scroll, marker, omitted, hasVisibleFrame };
})()`;

export const MARK_VISIBLE_FRAMES = String.raw`(() => {
	const state = window.__jevLoopSnapshot;
	if (!state) return [];
	const frames = [];
	const collectFrames = (root) => {
		for (const element of root.querySelectorAll('iframe')) frames.push(element);
		for (const element of root.querySelectorAll('*')) if (element.shadowRoot) collectFrames(element.shadowRoot);
	};
	collectFrames(document);
	state.frameLabels = new Map();
	const labels = [];
	for (const frame of frames) {
		if (!state.visible(frame)) continue;
		const rect = frame.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) continue;
		const label = '__jev_visible_frame_' + labels.length + '__';
		state.frameLabels.set(frame, {
			label: frame.getAttribute('aria-label'),
			labelledby: frame.getAttribute('aria-labelledby'),
		});
		frame.removeAttribute('aria-labelledby');
		frame.setAttribute('aria-label', label);
		labels.push(label);
	}
	return labels;
})()`;

export const RESTORE_FRAME_LABELS = String.raw`(() => {
	const state = window.__jevLoopSnapshot;
	if (!state?.frameLabels) return true;
	for (const [frame, attributes] of state.frameLabels) {
		if (!frame.isConnected) continue;
		if (attributes.label === null) frame.removeAttribute('aria-label');
		else frame.setAttribute('aria-label', attributes.label);
		if (attributes.labelledby === null) frame.removeAttribute('aria-labelledby');
		else frame.setAttribute('aria-labelledby', attributes.labelledby);
	}
	state.frameLabels = null;
	return true;
})()`;

export const SETTLE_AFTER_INPUT = String.raw`(async () => {
	await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	await new Promise((resolve) => setTimeout(resolve, 50));
	return true;
})()`;

export function targetFreshnessCode(input: { documentId: string; node: number; guard: string }): string {
	return `(() => {
		const state = window.__jevLoopSnapshot;
		if (!state || String(performance.timeOrigin) !== ${JSON.stringify(input.documentId)}) return false;
		const element = state.nodes.get(${input.node});
		return state.guard(element) === ${JSON.stringify(input.guard)} && state.actionPoint(element) !== null;
	})()`;
}

export function targetPointCode(input: { documentId: string; node: number; guard: string }): string {
	return `(() => {
		const state = window.__jevLoopSnapshot;
		if (!state || String(performance.timeOrigin) !== ${JSON.stringify(input.documentId)}) return null;
		const element = state.nodes.get(${input.node});
		if (state.guard(element) !== ${JSON.stringify(input.guard)}) return null;
		return state.actionPoint(element);
	})()`;
}

export function selectOptionCode(input: { documentId: string; node: number; guard: string; value: string }): string {
	return `(() => {
		const state = window.__jevLoopSnapshot;
		if (!state || String(performance.timeOrigin) !== ${JSON.stringify(input.documentId)}) return false;
		const element = state.nodes.get(${input.node});
		if (state.guard(element) !== ${JSON.stringify(input.guard)} || element?.tagName !== 'SELECT') return false;
		const option = [...element.options].find((candidate) => candidate.value === ${JSON.stringify(input.value)} && !candidate.disabled && !candidate.closest('optgroup[disabled]'));
		if (!option) return false;
		element.value = option.value;
		element.dispatchEvent(new Event('input', { bubbles: true }));
		element.dispatchEvent(new Event('change', { bubbles: true }));
		return true;
	})()`;
}
