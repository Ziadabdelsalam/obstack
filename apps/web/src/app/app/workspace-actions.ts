"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { dataMode } from "@/server/data";
import { queryRows } from "@/server/postgres";
import { getSessionContext } from "@/server/session";
import { UnknownWorkspace, parseWorkspaceId, setActiveWorkspace } from "@/server/workspaces";

/**
 * The switcher's one write (D717): record which of the person's workspaces
 * their session reads from now on. Its own module because a `"use server"`
 * file may export nothing but server functions and this one belongs to the
 * shell, not to any page.
 *
 * The gate is the settings gate's (D150/D152): the MODE CHECK COMES FIRST —
 * mock mode has one fictional workspace and renders no switcher, so a post here
 * came from somewhere no visitor can be — and a caller with no session goes to
 * /login. The workspace id is parsed totally (D68) and then judged by the
 * INSERT's own membership join (`server/workspaces.ts`): a workspace the person
 * does not belong to writes nothing.
 *
 * Every exit is a redirect to the overview. The sidebar has no place for a
 * sentence, and it does not need one: the shell re-renders from the store, so
 * the label under the wordmark says which workspace the session reads whether
 * the switch happened or not. A refused switch is logged at warn, because a
 * stale list is not an operator's problem; anything else at error.
 *
 * `revalidatePath("/app", "layout")` before the redirect: every route under
 * the shell was rendered for the workspace this click just left, and the
 * router's client cache must not hand any of it to the workspace arriving —
 * the same tenant-state reasoning the top bar's sign-out applies by dropping
 * the whole document.
 */

const APP_PATH = "/app";

export async function switchWorkspace(formData: FormData): Promise<void> {
  if (dataMode === "mock") {
    console.error("[workspace] switch posted in mock mode — this deployment keeps no accounts");
    redirect(APP_PATH);
  }
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const workspaceId = parseWorkspaceId(formData.get("workspaceId"));
  if (!workspaceId) {
    console.warn("[workspace] switch posted with no workspace id");
    redirect(APP_PATH);
  }

  // Only the write is inside the try: `redirect` signals through a thrown
  // error, so one reached from inside a try would be swallowed by it.
  try {
    await setActiveWorkspace(session.userId, workspaceId, queryRows);
  } catch (error) {
    if (error instanceof UnknownWorkspace) console.warn("[workspace] switch refused:", error.message);
    else console.error("[workspace] switch", error);
    redirect(APP_PATH);
  }
  revalidatePath(APP_PATH, "layout");
  redirect(APP_PATH);
}
