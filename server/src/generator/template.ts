import type { EntitySchema } from "../db.ts";
import type { GenerateInput, GenerateResult, Generator } from "./types.ts";

/**
 * Offline generator used when no ANTHROPIC_API_KEY is configured.
 * Scaffolds a working CRUD app around one entity guessed from the prompt so the
 * whole build -> preview -> data -> deploy loop can be exercised without the AI.
 */
const KEYWORDS: [RegExp, string, string][] = [
  [/\b(todo|to-do|task)s?\b/i, "Task", "Tasks"],
  [/\b(crm|customer|client|lead)s?\b/i, "Customer", "Customers"],
  [/\b(contact)s?\b/i, "Contact", "Contacts"],
  [/\b(note)s?\b/i, "Note", "Notes"],
  [/\b(recipe)s?\b/i, "Recipe", "Recipes"],
  [/\b(expense|budget|spending)s?\b/i, "Expense", "Expenses"],
  [/\b(event|booking|appointment)s?\b/i, "Event", "Events"],
  [/\b(inventory|product|stock)s?\b/i, "Product", "Products"],
  [/\b(book|reading)s?\b/i, "Book", "Books"],
  [/\b(habit)s?\b/i, "Habit", "Habits"],
  [/\b(issue|bug|ticket)s?\b/i, "Ticket", "Tickets"],
];

function guessEntity(prompt: string): [string, string] {
  for (const [re, singular, plural] of KEYWORDS) if (re.test(prompt)) return [singular, plural];
  return ["Item", "Items"];
}

export class TemplateGenerator implements Generator {
  readonly mode = "template" as const;

  async generate(input: GenerateInput): Promise<GenerateResult> {
    if (input.current) {
      return {
        files: input.current.files,
        entities: input.current.entities,
        summary:
          "BuildIT is running in template mode (no ANTHROPIC_API_KEY is set), so it can't apply free-form changes. " +
          "Edit the files directly in the Code tab, or set ANTHROPIC_API_KEY and restart the server to enable AI edits.",
        source: "template",
      };
    }
    const [entity, plural] = guessEntity(input.prompt);
    const appName = `${entity} Tracker`;
    const schema: EntitySchema = {
      name: entity,
      description: `A ${entity.toLowerCase()} managed by ${appName}`,
      fields: {
        title: { type: "string", required: true },
        notes: { type: "string" },
        status: { type: "string", enum: ["todo", "in_progress", "done"] },
        due_date: { type: "date" },
        attachment_url: { type: "string", description: "URL returned by BuildIt.files.upload" },
        attachment_name: { type: "string" },
      },
    };
    return {
      name: appName,
      entities: [schema],
      summary: `Created ${appName}: a ${plural.toLowerCase()} tracker with create, edit, status filters and delete, backed by the ${entity} entity. (Template mode - set ANTHROPIC_API_KEY for AI-generated apps.)`,
      source: "template",
      files: [
        { path: "index.html", content: indexHtml(appName, plural) },
        { path: "styles.css", content: STYLES },
        { path: "app.js", content: appJs(entity, plural) },
      ],
    };
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function indexHtml(appName: string, plural: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(appName)}</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <main class="wrap">
    <header>
      <h1>${esc(appName)}</h1>
      <p class="muted">Keep track of your ${esc(plural.toLowerCase())}.</p>
    </header>
    <form id="create" class="card">
      <label>Title <input name="title" required maxlength="200" placeholder="What needs tracking?" /></label>
      <div class="row">
        <label>Status
          <select name="status">
            <option value="todo">To do</option>
            <option value="in_progress">In progress</option>
            <option value="done">Done</option>
          </select>
        </label>
        <label>Due <input type="date" name="due_date" /></label>
      </div>
      <label>Notes <textarea name="notes" rows="2"></textarea></label>
      <label>Attachment <input type="file" name="attachment" /></label>
      <button type="submit">Add</button>
    </form>
    <nav class="filters" id="filters">
      <button data-f="" class="on">All</button>
      <button data-f="todo">To do</button>
      <button data-f="in_progress">In progress</button>
      <button data-f="done">Done</button>
    </nav>
    <p id="error" class="error" hidden></p>
    <ul id="list" class="list" aria-live="polite"></ul>
  </main>
  <script type="module" src="./app.js"></script>
</body>
</html>
`;
}

function appJs(entity: string, plural: string) {
  return `const store = window.BuildIt.entities.${entity};
const list = document.getElementById("list");
const errorEl = document.getElementById("error");
const form = document.getElementById("create");
let filter = "";

const LABELS = { todo: "To do", in_progress: "In progress", done: "Done" };

function showError(e) {
  errorEl.textContent = e ? (e.message || String(e)) : "";
  errorEl.hidden = !e;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}

async function refresh() {
  list.replaceChildren(el("li", { className: "muted" }, "Loading…"));
  try {
    const items = filter
      ? await store.filter({ status: filter }, { sort: "-created_at" })
      : await store.list({ sort: "-created_at" });
    showError(null);
    if (!items.length) {
      list.replaceChildren(el("li", { className: "empty" }, "No ${plural.toLowerCase()} yet. Add your first one above."));
      return;
    }
    list.replaceChildren(...items.map(renderItem));
  } catch (e) {
    list.replaceChildren();
    showError(e);
  }
}

function renderItem(item) {
  const status = el("select", { ariaLabel: "Status" });
  for (const [v, label] of Object.entries(LABELS)) status.append(el("option", { value: v, selected: item.status === v }, label));
  status.onchange = async () => {
    try { await store.update(item.id, { status: status.value }); refresh(); } catch (e) { showError(e); }
  };
  const del = el("button", { className: "ghost", ariaLabel: "Delete" }, "Delete");
  del.onclick = async () => {
    if (!confirm("Delete this item?")) return;
    try { await store.delete(item.id); refresh(); } catch (e) { showError(e); }
  };
  return el("li", { className: "card item " + (item.status || "todo") },
    el("div", {},
      el("strong", {}, item.title),
      item.due_date ? el("span", { className: "muted" }, " · due " + item.due_date) : null,
      item.notes ? el("p", { className: "muted" }, item.notes) : null,
      item.attachment_url ? renderAttachment(item) : null,
    ),
    el("div", { className: "actions" }, status, del),
  );
}

function renderAttachment(item) {
  const link = el("a", { href: item.attachment_url, target: "_blank", rel: "noreferrer", className: "attachment" });
  if (/\\.(png|jpe?g|gif|webp|avif)$/i.test(item.attachment_name || "")) {
    link.append(el("img", { src: item.attachment_url, alt: item.attachment_name }));
  } else {
    link.append("📎 " + (item.attachment_name || "Attachment"));
  }
  return link;
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  if (!data.title.trim()) return;
  if (!data.due_date) delete data.due_date;
  const file = data.attachment;
  delete data.attachment;
  const btn = form.querySelector("button");
  btn.disabled = true;
  try {
    if (file && file.size) {
      const uploaded = await window.BuildIt.files.upload(file);
      data.attachment_url = uploaded.url;
      data.attachment_name = uploaded.name;
    }
    await store.create(data);
    form.reset();
    refresh();
  } catch (e) {
    showError(e);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("filters").addEventListener("click", (ev) => {
  const b = ev.target.closest("button");
  if (!b) return;
  filter = b.dataset.f;
  document.querySelectorAll("#filters button").forEach((x) => x.classList.toggle("on", x === b));
  refresh();
});

refresh();
`;
}

const STYLES = `:root {
  --bg: #f6f7fb; --card: #fff; --text: #1d2033; --muted: #6b7083; --accent: #5b5bf7; --border: #e3e5ee; --danger: #c93a3a;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #12131a; --card: #1b1d27; --text: #eceef6; --muted: #9aa0b4; --border: #2b2e3c; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
.wrap { max-width: 720px; margin: 0 auto; padding: 32px 16px; }
h1 { margin: 0 0 4px; font-size: 28px; }
.muted { color: var(--muted); margin: 4px 0 0; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
form.card { display: grid; gap: 12px; margin: 24px 0 16px; }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
label { display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
input, select, textarea { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
button { font: inherit; border: 0; border-radius: 8px; padding: 9px 14px; background: var(--accent); color: #fff; cursor: pointer; }
button:disabled { opacity: .6; }
button.ghost { background: transparent; color: var(--danger); }
.filters { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.filters button { background: var(--card); color: var(--text); border: 1px solid var(--border); }
.filters button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
.list { list-style: none; padding: 0; display: grid; gap: 10px; }
.item { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
.item.done strong { text-decoration: line-through; color: var(--muted); }
.actions { display: flex; gap: 6px; align-items: center; }
.empty { text-align: center; color: var(--muted); padding: 32px; }
.error { color: var(--danger); }
.attachment { display: inline-block; margin-top: 6px; color: var(--accent); font-size: 13px; }
.attachment img { display: block; max-width: 160px; max-height: 120px; border-radius: 8px; border: 1px solid var(--border); }
@media (max-width: 520px) { .row { grid-template-columns: 1fr; } .item { flex-direction: column; align-items: stretch; } }
`;
