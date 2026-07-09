import { describe, expect, it } from "vitest";
import { parseResult } from "../src/action/result";

describe("parseResult url extraction", () => {
	it("passes through a plain url", () => {
		const res = parseResult("url", "https://quotes.toscrape.com/page/2/", [], 10);
		expect(res.status).toBe("ok");
		expect(res.url).toBe("https://quotes.toscrape.com/page/2/");
	});

	it("strips markdown bold markers", () => {
		const res = parseResult("url", "**https://quotes.toscrape.com/page/2/**", [], 10);
		expect(res.url).toBe("https://quotes.toscrape.com/page/2/");
	});

	it("strips wrapping backticks", () => {
		const res = parseResult("url", "`https://example.com/path`", [], 10);
		expect(res.url).toBe("https://example.com/path");
	});

	it("strips trailing punctuation", () => {
		const res = parseResult("url", "The current URL is https://example.com/page.", [], 10);
		expect(res.url).toBe("https://example.com/page");
	});
});
