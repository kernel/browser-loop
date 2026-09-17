import { createServer, type Server } from "node:http";
import { once } from "node:events";

function page(title: string, body: string, script = ""): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui;max-width:760px;margin:40px auto}button,input,select{font:inherit;margin:8px;padding:8px}.card{border:1px solid #aaa;padding:12px;margin:8px}.success{color:#087830;font-weight:700}</style></head><body>${body}<script>${script}</script></body></html>`;
}

function route(path: string): string {
	if (path === "/buttons") return page("Button test", `
		<h1>Choose the next action</h1><p>Only continue advances this workflow.</p>
		<button onclick="fail('Deleted')">Delete account</button><button onclick="fail('Saved draft')">Save draft</button><button onclick="ok('Workflow continued')">Continue</button>
		<div id="result"></div>`, helpers());
	if (path === "/contact") return page("Contact form", `
		<h1>Contact details</h1><label>Full name <input name="full_name"></label><label>Work email <input name="work_email" type="email"></label><button type="button" onclick="submitContact()">Submit</button><div id="result"></div>`, `${helpers()}
		function submitContact(){const n=document.querySelector('[name=full_name]').value,e=document.querySelector('[name=work_email]').value;if(n==='Ada Lovelace'&&e==='ada@example.com')ok('Contact saved for Ada Lovelace');else fail('Incorrect contact values: '+n+' / '+e)}`);
	if (path === "/preferences") return page("Preferences", `
		<h1>Preferences</h1><label>Theme <select name="theme"><option value="light">Light</option><option value="dark">Dark</option><option value="system">System</option></select></label>
		<label><input type="checkbox" name="weekly"> Weekly updates</label><button onclick="applyPrefs()">Apply</button><div id="result"></div>`, `${helpers()}
		function applyPrefs(){const t=document.querySelector('[name=theme]').value,w=document.querySelector('[name=weekly]').checked;if(t==='dark'&&w)ok('Dark theme with weekly updates applied');else fail('Wrong preferences')}`);
	if (path === "/catalog") return page("Catalog", `
		<h1>Catalog</h1><div class="card">Atlas Lamp — $39 — in stock <button onclick="pick('Atlas Lamp')">Add Atlas Lamp</button></div>
		<div class="card">Boreal Mug — $12 — out of stock <button onclick="pick('Boreal Mug')">Add Boreal Mug</button></div>
		<div class="card">Cedar Notebook — $18 — in stock <button onclick="pick('Cedar Notebook')">Add Cedar Notebook</button></div><div id="result"></div>`, `${helpers()}
		function pick(name){if(name==='Cedar Notebook')ok('Cedar Notebook added to cart');else fail(name+' was not the least expensive in-stock item')}`);
	if (path === "/wizard") return page("Plan wizard", `<div id="app"><h1>Plan setup</h1><button onclick="step1()">Start setup</button></div>`, `${helpers()}
		function step1(){document.querySelector('#app').innerHTML='<h1>Choose a plan</h1><label><input type="radio" name="plan" value="basic"> Basic</label><label><input type="radio" name="plan" value="pro"> Pro</label><button onclick="step2()">Continue</button>'}
		function step2(){if(!document.querySelector('input[value=pro]').checked)return fail('Wrong plan');document.querySelector('#app').innerHTML='<h1>Confirm</h1><label><input type="checkbox" name="terms"> Accept test terms</label><button onclick="finish()">Finish</button>'}
		function finish(){if(document.querySelector('[name=terms]').checked)ok('Pro setup complete');else fail('Terms not accepted')}`);
	if (path === "/search") return page("Search", `
		<h1>Documentation search</h1><label>Query <input name="query" type="search"></label><button onclick="search()">Search</button><div id="results"></div>`, `${helpers()}
		function search(){const q=document.querySelector('[name=query]').value;document.querySelector('#results').innerHTML=q==='kernel browser'?'<h2>Results</h2><button onclick="openResult(1)">SDK reference</button><button onclick="openResult(2)">Browser Infrastructure</button>':'<p>No results</p>'}
		function openResult(n){if(n===2)ok('Opened Browser Infrastructure');else fail('Wrong result')}`);
	if (path === "/reveal") return page("Reveal", `
		<h1>Region picker</h1><p>The requested region is hidden until details are loaded.</p><button onclick="reveal()">Reveal details</button><div id="details"></div>`, `${helpers()}
		function reveal(){document.querySelector('#details').innerHTML='<p>Available regions</p><button onclick="fail(&quot;East selected&quot;)">East</button><button onclick="ok(&quot;West selected&quot;)">West</button><button onclick="fail(&quot;Central selected&quot;)">Central</button>'}`);
	if (path === "/confirmation") return page("Confirmation", `<h1>Order confirmed</h1><p>Your confirmation code is KRN-48291.</p><p>Keep this code for your records.</p>`);
	if (path === "/article") return page("Short article", `<article><h1>Browser automation notes</h1><p>Deterministic browser tools reduce the action space and prevent invented selectors.</p><p>Fast decision models can choose among grounded actions, but they cannot generate prose outside their predefined answer space.</p><p>A planner is still needed for decomposition and synthesis on open-ended tasks.</p></article>`);
	return page("Not found", "<h1>Not found</h1>");
}

function helpers(): string {
	return `function ok(message){document.body.dataset.success='true';document.querySelector('#result')?.remove();const d=document.createElement('div');d.id='result';d.className='success';d.textContent='SUCCESS: '+message;document.body.appendChild(d)}function fail(message){const d=document.querySelector('#result')||document.body.appendChild(document.createElement('div'));d.id='result';d.textContent='NOT COMPLETE: '+message}`;
}

export async function startFixtureServer(): Promise<{ baseURL: string; close: () => Promise<void> }> {
	const server: Server = createServer((request, response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		response.end(route(new URL(request.url ?? "/", "http://local").pathname));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture server failed to bind");
	return {
		baseURL: `http://127.0.0.1:${address.port}`,
		close: async () => {
			server.close();
			await once(server, "close");
		},
	};
}
