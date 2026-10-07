import Link from "next/link";
export function Brand() {
  return (
    <Link href="/" className="brand" aria-label="Meridian home">
      <span className="brand-symbol" aria-hidden="true">
        m<span>·</span>
      </span>
      <span>meridian</span>
    </Link>
  );
}
