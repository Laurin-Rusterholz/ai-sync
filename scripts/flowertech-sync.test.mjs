import assert from "node:assert/strict";
import { buildInquiryTask, mergeInquiryTasks } from "../netlify/lib/flowertech-core.mjs";

const inquiry = {
  id: "inq_test_1",
  name: "Test KMU",
  email: "kontakt@example.ch",
  company: "Beispiel AG",
  message: "Wir benötigen eine neue Web-App.",
  createdAt: "2026-07-29T08:30:00.000Z",
};

const task = buildInquiryTask(inquiry);
assert.equal(task.sourceInquiryId, inquiry.id);
assert.equal(task.category, "flowertech");
assert.equal(task.status, "todo");
assert.match(task.description, /Beispiel AG/);

const initial = {
  version: 2,
  meta: {},
  entities: {
    projects: {
      p1: { id: "p1", title: "Bestehendes Projekt", projectType: "flowertech" },
    },
    tasks: {},
  },
};
const first = mergeInquiryTasks(initial, [inquiry], { updatedAt: "2026-07-29T09:00:00.000Z" });
assert.equal(first.createdTasks, 1);
assert.equal(Object.keys(first.data.entities.tasks).length, 1);
assert.equal(first.data.entities.projects.p1.projectType, "flowertech");

const second = mergeInquiryTasks(first.data, [inquiry], { updatedAt: "2026-07-29T09:05:00.000Z" });
assert.equal(second.createdTasks, 0);
assert.equal(Object.keys(second.data.entities.tasks).length, 1);

console.log("flowertech-sync: Deduplizierung und Projekterhalt bestanden");
