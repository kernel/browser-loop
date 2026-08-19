export interface BrowserScenario {
	name: string;
	prompt: string;
}

export const SCENARIOS: BrowserScenario[] = [
	{
		name: "example-link-and-url",
		prompt: [
			"Use browser tools for exactly these steps:",
			"1) goto https://example.com",
			"2) read current url",
			"3) click the More information link",
			"4) read current url",
			"5) capture a screenshot",
		].join("\n"),
	},
	{
		name: "hn-url-and-screenshot",
		prompt: [
			"Use browser tools for exactly these steps:",
			"1) goto https://news.ycombinator.com",
			"2) scroll slightly",
			"3) read current url",
			"4) capture a screenshot",
		].join("\n"),
	},
	{
		name: "wikipedia-search",
		prompt: [
			"Use browser tools for exactly these steps:",
			"1) goto https://www.wikipedia.org",
			"2) click the search input",
			"3) type kernel",
			"4) press Enter",
			"5) read current url",
		].join("\n"),
	},
];
