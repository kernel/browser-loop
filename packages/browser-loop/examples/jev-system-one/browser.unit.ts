import assert from "node:assert/strict";
import test from "node:test";
import { launchBrowser, observe } from "./browser";

test("refreshes element ids after visibility and ordering changes", async () => {
	const browser = await launchBrowser();
	try {
		const page = await browser.newPage();
		await page.setContent('<button id="first">First</button><button id="second">Second</button>');
		await observe(page);
		await page.evaluate("document.querySelector('#first').style.display = 'none'; document.body.insertAdjacentHTML('afterbegin', '<button id=added>Added</button>')");
		const observation = await observe(page);
		const ids = observation.elements.map((element) => element.id);
		assert.deepEqual(ids, ["e0", "e1"]);
		assert.equal(await page.locator("[data-jev-id]").count(), observation.elements.length);
		assert.equal(await page.locator("#first[data-jev-id]").count(), 0);
	} finally {
		await browser.close();
	}
});
