/**
 * The switcher's client-safe shape (D717): what the sidebar — a client
 * component — is handed for each workspace the signed-in person may read.
 * `server/workspaces.ts` is `server-only`, so the row type lives there and this
 * view lives here, the `lib/users-types.ts` idiom. No imports, no mode, no
 * store.
 */
export interface WorkspaceChoiceView {
  workspaceId: string;
  /** The organization's name — at signup, the owner's own name (there is no org-name field). */
  orgName: string;
  /** The person's role in that organization: `owner` for the one signup made, `member` for an accepted invitation. */
  role: string;
}
