import { chromium, type Browser, type Page } from "playwright-core";
import type { BrowserAction, Observation } from "./types";

const CHROMIUM_PATHS = [
	process.env.CHROMIUM_PATH,
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/usr/bin/google-chrome",
].filter((path): path is string => Boolean(path));

export async function launchBrowser(): Promise<Browser> {
	let lastError: unknown;
	for (const executablePath of CHROMIUM_PATHS) {
		try {
			return await chromium.launch({
				executablePath,
				headless: true,
				args: ["--no-sandbox", "--disable-dev-shm-usage"],
			});
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(`Could not launch Chromium: ${String(lastError)}`);
}

export async function observe(page: Page): Promise<Observation> {
	return page.evaluate(`(() => {
		const nodes = Array.from(document.querySelectorAll("a[href],button,input,select,textarea,[role='button']"))
			.filter((element) => {
				const style = getComputedStyle(element);
				const rect = element.getBoundingClientRect();
				return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
			})
			.slice(0, 120);
		const elements = nodes.map((element, index) => {
			const id = "e" + index;
			element.dataset.jevId = id;
			const labels = element.labels ? Array.from(element.labels).map((label) => label.innerText).join(" ") : "";
			const name = [element.getAttribute("aria-label"), labels, element.innerText, element.placeholder, element.name]
				.find((value) => value && value.trim()) || "unnamed";
			return {
				id,
				tag: element.tagName.toLowerCase(),
				role: element.getAttribute("role") || "",
				name: name.trim().slice(0, 180),
				type: element.type || "",
				value: element.type === "checkbox" || element.type === "radio" ? String(element.checked) : (element.value || ""),
				options: element.tagName === "SELECT" ? Array.from(element.options).map((option) => option.value + " (" + option.text + ")") : undefined,
			};
		});
		return {
			url: location.href,
			title: document.title,
			text: (document.body?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 8000),
			elements,
		};
	})()`) as Promise<Observation>;
}

export async function execute(page: Page, action: BrowserAction): Promise<void> {
	if (action.kind === "finish" || action.kind === "fail") return;
	if (action.kind === "back") {
		await page.goBack({ waitUntil: "domcontentloaded", timeout: 10_000 });
		return;
	}
	const locator = page.locator(`[data-jev-id="${action.elementId}"]`);
	if (action.kind === "fill") await locator.fill(action.value);
	if (action.kind === "select") await locator.selectOption(action.value);
	if (action.kind === "click") await locator.click();
	await page.waitForTimeout(40);
}
