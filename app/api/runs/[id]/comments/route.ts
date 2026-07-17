import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { getRun, addComment, listComments, deleteComment, updateCommentBody, clearComments } from "@/app/lib/db";

export const dynamic = "force-dynamic";

// List all comments for a run (open + sent), for the review UI.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getRun(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ comments: listComments(id) });
}

// Create a pin/note comment on a phase's deliverable.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getRun(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { state, artifactId, artifactName, anchor, body, image, images, author, parentId } = await req.json();
  const arr = (Array.isArray(images) ? images : (image ? [image] : []))
    .filter((s: unknown): s is string => typeof s === "string" && s.startsWith("data:image/"));
  if (!state || (!body?.trim() && !arr.length)) return NextResponse.json({ error: "a comment or an image is required" }, { status: 400 });
  const who = (author || req.headers.get("x-atelier-user") || "").toString().trim().slice(0, 40) || null;
  const cid = nanoid(10);
  addComment({
    id: cid, run_id: id, state: String(state),
    artifact_id: artifactId ? String(artifactId) : null,
    artifact_name: artifactName ? String(artifactName) : null,
    anchor: JSON.stringify(anchor || { type: "note" }),
    body: String(body || "").trim(),
    image: arr.length ? JSON.stringify(arr) : null, // JSON array of data URLs
    author: who,
    parent_id: parentId ? String(parentId) : null,
  });
  return NextResponse.json({ comments: listComments(id) });
}

// Edit a comment's text.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getRun(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { commentId, body } = await req.json();
  if (!commentId || !body?.trim()) return NextResponse.json({ error: "commentId and body are required" }, { status: 400 });
  updateCommentBody(String(commentId), String(body).trim());
  return NextResponse.json({ comments: listComments(id) });
}

// Delete a single comment, or clear a run's comments (?scope=all | handled).
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getRun(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const q = new URL(req.url).searchParams;
  const commentId = q.get("commentId");
  const scope = q.get("scope");
  if (scope === "all" || scope === "handled") clearComments(id, scope);
  else if (commentId) deleteComment(commentId);
  return NextResponse.json({ comments: listComments(id) });
}
