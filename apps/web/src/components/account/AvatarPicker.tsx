"use client";

import { useRef, useState } from "react";
import { AVATAR_EDGE_PX, AVATAR_MAX_BYTES } from "@/lib/account-types";
import { uploadAvatar } from "@/app/app/account/actions";

/**
 * The upload control (D718): ONE form, posting the file to `uploadAvatar` like
 * every other control on the account page. What the client adds, when it can,
 * is the shrink: a chosen picture is decoded, cover-cropped to a square of
 * `AVATAR_EDGE_PX`, re-encoded as a JPEG, put back into the input through a
 * `DataTransfer`, and the form is submitted — so the bytes that reach the
 * store are a few kilobytes whatever the camera produced. Without JavaScript
 * the same form posts the original, which the server judges against the same
 * cap and the same three types (`server/avatars.ts`); the submit button is
 * there for that path and stays for the other.
 *
 * A picture the browser cannot decode (an HEIC, say) is posted as it was: the
 * server's answer is the store's own refusal, in the section's vocabulary, and
 * nothing here guesses at it first.
 */
async function shrink(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_EDGE_PX;
    canvas.height = AVATAR_EDGE_PX;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    // A JPEG has no alpha: a transparent PNG lands on white rather than black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, AVATAR_EDGE_PX, AVATAR_EDGE_PX);
    ctx.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      AVATAR_EDGE_PX,
      AVATAR_EDGE_PX,
    );
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
    if (!blob) throw new Error("encode failed");
    return new File([blob], "avatar.jpg", { type: "image/jpeg" });
  } finally {
    bitmap.close();
  }
}

export function AvatarPicker() {
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const onChange = async () => {
    const input = inputRef.current;
    const file = input?.files?.[0];
    if (!input || !file) return;
    setBusy(true);
    try {
      const small = await shrink(file).catch(() => file);
      const transfer = new DataTransfer();
      transfer.items.add(small);
      input.files = transfer.files;
      formRef.current?.requestSubmit();
    } finally {
      // The submit navigates away on success; on a refusal the page re-renders
      // with the sentence, and this control is fresh again.
      setBusy(false);
    }
  };

  return (
    <form ref={formRef} action={uploadAvatar} encType="multipart/form-data" className="flex flex-wrap items-center gap-2">
      <label className="cursor-pointer rounded-md border border-line bg-raised px-3 py-1.5 text-[12.5px] text-mid hover:border-line-strong hover:text-ink">
        {busy ? "Preparing…" : "Choose a picture"}
        <input
          ref={inputRef}
          name="avatar"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={onChange}
          className="sr-only"
        />
      </label>
      <button
        type="submit"
        className="rounded-md border border-line bg-raised px-3 py-1.5 text-[12.5px] text-mid hover:border-line-strong hover:text-ink"
      >
        Upload
      </button>
      <span className="font-mono text-[10.5px] text-faint">
        PNG, JPEG or WebP · shrunk to {AVATAR_EDGE_PX}px · under {Math.floor(AVATAR_MAX_BYTES / 1024)} KB
      </span>
    </form>
  );
}
