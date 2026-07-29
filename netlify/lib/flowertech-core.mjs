export function buildInquiryTask(inquiry, fallbackNow = new Date().toISOString()) {
  const id = `flowertech-inquiry-${inquiry.id}`;
  const createdAt = inquiry.createdAt || fallbackNow;
  return {
    id,
    title: `FlowerTech-Anfrage: ${inquiry.name || inquiry.email || inquiry.id}`,
    description: [
      inquiry.company ? `Unternehmen: ${inquiry.company}` : "",
      inquiry.email ? `E-Mail: ${inquiry.email}` : "",
      inquiry.phone ? `Telefon: ${inquiry.phone}` : "",
      inquiry.service ? `Interesse: ${inquiry.service}` : "",
      "",
      inquiry.message || "",
    ].filter((line, index) => line || index === 4).join("\n"),
    status: "todo",
    priority: 2,
    category: "flowertech",
    projectId: inquiry.projectId || null,
    source: "flowertech-inquiry",
    sourceInquiryId: inquiry.id,
    createdAt,
    updatedAt: inquiry.updatedAt || createdAt,
    tags: ["flowertech", "anfrage"],
  };
}
export function mergeInquiryTasks(current, inquiries, { updatedAt = new Date().toISOString() } = {}) {
  const data = current && typeof current === "object"
    ? current
    : { version: 2, meta: {}, entities: {} };
  data.entities = data.entities || {};
  data.entities.tasks = data.entities.tasks || {};

  const known = new Set(
    Object.values(data.entities.tasks)
      .map((task) => task?.sourceInquiryId)
      .filter(Boolean)
  );
  let createdTasks = 0;
  for (const inquiry of inquiries || []) {
    if (!inquiry?.id || known.has(inquiry.id)) continue;
    const task = buildInquiryTask(inquiry, updatedAt);
    data.entities.tasks[task.id] = task;
    known.add(inquiry.id);
    createdTasks++;
  }

  data.meta = data.meta || {};
  data.meta.updatedAt = updatedAt;
  return { data, createdTasks };
}
