import type { Ctx } from "./db.js";
import { many, one, run } from "./db.js";
import { AppError } from "./errors.js";
import { display, parseRef, PREFIX, type RefKind } from "./ids.js";

export interface NoteRow {
  id: number;
  text: string;
  visibility: string;
  author: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface NoteLink {
  kind: "task" | "goal" | "session" | "experiment";
  ref: string;
}

const LINK_KIND: Record<NoteLink["kind"], { table: string; prefix: keyof typeof PREFIX }> = {
  task: { table: "tasks", prefix: "task" },
  goal: { table: "goals", prefix: "goal" },
  session: { table: "sessions", prefix: "session" },
  experiment: { table: "experiments", prefix: "experiment" },
};

export function addNote(
  ctx: Ctx,
  input: { text: string; links?: NoteLink[]; visibility?: string; author?: string },
) {
  const text = input.text.trim();
  if (!text) throw new AppError("invalid_note", "Note text is required");
  const timestamp = ctx.now().toISOString();
  const noteId = ctx.db.transaction(() => {
    const result = run(
      ctx.db,
      "INSERT INTO notes (text, visibility, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      text,
      input.visibility ?? "private",
      input.author ?? ctx.config.actor,
      timestamp,
      timestamp,
    );
    const id = Number(result.lastInsertRowid);
    run(
      ctx.db,
      "INSERT INTO note_revisions (note_id, revision, text, author, created_at) VALUES (?, 1, ?, ?, ?)",
      id,
      text,
      input.author ?? ctx.config.actor,
      timestamp,
    );
    for (const link of input.links ?? []) {
      const parsed = resolveLink(ctx, link);
      run(
        ctx.db,
        "INSERT INTO note_links (note_id, kind, ref_id) VALUES (?, ?, ?)",
        id,
        link.kind,
        parsed,
      );
    }
    return id;
  })();
  return noteView(ctx, noteId);
}

function resolveLink(ctx: Ctx, link: NoteLink): number {
  const config = LINK_KIND[link.kind];
  if (!config) throw new AppError("invalid_link", `Unknown link type: ${link.kind}`);
  const id = parseRef(link.ref, config.prefix);
  const row = one<{ id: number }>(ctx.db, `SELECT id FROM ${config.table} WHERE id = ?`, id);
  if (!row) throw new AppError("link_not_found", `${link.kind} ${link.ref} was not found`);
  return id;
}

export function getNote(ctx: Ctx, id: number): NoteRow | undefined {
  return one<NoteRow>(ctx.db, "SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL", id);
}

export function requireNote(ctx: Ctx, id: number): NoteRow {
  const note = getNote(ctx, id);
  if (!note) throw new AppError("note_not_found", `Note ${display("note", id)} was not found`);
  return note;
}

export function noteView(ctx: Ctx, id: number) {
  const note = requireNote(ctx, id);
  const links = many<{ kind: RefKind; ref_id: number }>(
    ctx.db,
    "SELECT kind, ref_id FROM note_links WHERE note_id = ? ORDER BY kind, ref_id",
    id,
  );
  const revisions = many<{ revision: number; text: string; author: string; created_at: string }>(
    ctx.db,
    "SELECT revision, text, author, created_at FROM note_revisions WHERE note_id = ? ORDER BY revision",
    id,
  );
  return {
    ...note,
    ref: display("note", id),
    links: links.map((link) => ({
      ...link,
      ref: display(link.kind, link.ref_id),
    })),
    revisions,
  };
}

export function listNotes(ctx: Ctx, limit = 50) {
  return many<NoteRow>(
    ctx.db,
    "SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT ?",
    limit,
  ).map((note) => ({ ...note, ref: display("note", note.id) }));
}

export function updateNote(
  ctx: Ctx,
  id: number,
  input: { text: string; author?: string; visibility?: string },
) {
  const note = requireNote(ctx, id);
  const text = input.text.trim();
  if (!text) throw new AppError("invalid_note", "Note text is required");
  const timestamp = ctx.now().toISOString();
  const lastRevision =
    one<{ revision: number }>(
      ctx.db,
      "SELECT revision FROM note_revisions WHERE note_id = ? ORDER BY revision DESC LIMIT 1",
      id,
    )?.revision ?? 0;
  ctx.db.transaction(() => {
    run(
      ctx.db,
      "INSERT INTO note_revisions (note_id, revision, text, author, created_at) VALUES (?, ?, ?, ?, ?)",
      id,
      lastRevision + 1,
      text,
      input.author ?? ctx.config.actor,
      timestamp,
    );
    run(
      ctx.db,
      "UPDATE notes SET text = ?, visibility = ?, updated_at = ? WHERE id = ?",
      text,
      input.visibility ?? note.visibility,
      timestamp,
      id,
    );
  })();
  return noteView(ctx, id);
}

export function deleteNote(ctx: Ctx, id: number, actor: string) {
  const note = requireNote(ctx, id);
  const timestamp = ctx.now().toISOString();
  ctx.db.transaction(() => {
    run(ctx.db, "DELETE FROM note_links WHERE note_id = ?", id);
    run(ctx.db, "DELETE FROM note_revisions WHERE note_id = ?", id);
    run(ctx.db, "DELETE FROM notes WHERE id = ?", id);
    run(
      ctx.db,
      "INSERT INTO deletions (entity, entity_id, actor, deleted_at) VALUES ('note', ?, ?, ?)",
      id,
      actor,
      timestamp,
    );
  })();
  return {
    deleted: display("note", id),
    text: note.text,
    backup_effect: "Existing backups still contain the old note.",
  };
}
