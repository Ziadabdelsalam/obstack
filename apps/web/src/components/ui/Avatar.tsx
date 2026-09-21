import Image from "next/image";

/**
 * The one way a person is drawn (D718): their picture when they have one, their
 * initials when they do not. No client directive — it holds no state — so the
 * shell, the roster and the account page all render the same thing from
 * either side of the boundary.
 *
 * `unoptimized`, and this is load-bearing: `next/image`'s optimizer fetches
 * the source through `/_next/image` with no cookie, and the source here is
 * `/app/avatar/<id>`, which answers 401 to a request with no session. The
 * bytes are already the size the picker made them (`AVATAR_EDGE_PX`), so
 * there is nothing for the optimizer to do that would be worth a proxy hop.
 */
export function initialsOf(name: string, fallback = ""): string {
  const letters = name
    .trim()
    .split(/[\s@]+/)
    .map((word) => word[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("");
  return (letters || fallback.slice(0, 2) || "?").toUpperCase();
}

export function Avatar({
  src,
  alt,
  initials,
  size,
  className = "",
}: {
  /** `avatarPath` for a stored picture, or null for the initials. */
  src: string | null;
  alt: string;
  initials: string;
  /** The rendered edge in CSS pixels. */
  size: number;
  className?: string;
}) {
  if (src) {
    return (
      <Image
        src={src}
        alt={alt}
        width={size}
        height={size}
        unoptimized
        className={`shrink-0 rounded-full object-cover ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      aria-label={alt}
      className={`flex shrink-0 items-center justify-center rounded-full bg-overlay font-mono text-mid ${className}`}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.38)) }}
    >
      {initials}
    </span>
  );
}
