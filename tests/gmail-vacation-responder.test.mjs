import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const proxy = fs.readFileSync(path.join(root, "netlify", "functions", "gmail-api.mjs"), "utf8");
const shared = fs.readFileSync(path.join(root, "netlify", "lib", "gcal-shared.mjs"), "utf8");
const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");

// Production finding: Gmail already exposed labels, filters and messages, but the
// official VacationSettings endpoint was absent from both the proxy whitelist and
// every client UI. Keep the narrowly-scoped GET/PUT endpoint wired end-to-end.
const allowLine = proxy.split(/\r?\n/).find((line) => line.includes("const ALLOWED_PATH ="));
assert.ok(allowLine, "gmail proxy whitelist is missing");
const literal = allowLine.match(/const ALLOWED_PATH = (\/.*\/);/);
assert.ok(literal, "gmail proxy whitelist regex could not be read");
const allowedPath = Function(`return ${literal[1]}`)();
assert.equal(allowedPath.test("/users/me/settings/vacation"), true, "VacationSettings must be allowed");
assert.equal(allowedPath.test("/users/me/settings/forwardingAddresses"), false, "unrelated Gmail settings must stay blocked");
assert.equal(allowedPath.test("/users/other/settings/vacation"), false, "only the authenticated user may be addressed");
assert.match(proxy, /path === "\/users\/me\/settings\/vacation" && method !== "GET" && method !== "PUT"/, "VacationSettings must reject methods other than GET/PUT");

assert.match(shared, /gmail\.settings\.basic/, "updateVacation requires gmail.settings.basic");
assert.match(index, /gmApi\("GET","\/users\/me\/settings\/vacation"\)/, "desktop must load VacationSettings");
assert.match(index, /gmApi\("PUT","\/users\/me\/settings\/vacation"/, "desktop must save VacationSettings");
assert.match(index, /Automatische Abwesenheitsantwort wirklich aktivieren/, "activation must require a visible confirmation");
assert.match(index, /responseBodyPlainText/, "desktop must preserve a plain-text response body");
assert.match(index, /gmail-vacation-responder/, "desktop build marker must change with index.html");

console.log("gmail vacation responder: proxy, scope, UI and confirmation passed");
