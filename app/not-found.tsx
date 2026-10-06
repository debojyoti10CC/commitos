import Link from "next/link";
export default function NotFound() {
  return (
    <div className="connection-error">
      <span className="eyebrow">404</span>
      <h1>This page wandered off.</h1>
      <p>Your commitments haven't. Let's get back to your day.</p>
      <Link className="button button-primary" href="/dashboard">
        Open workspace
      </Link>
    </div>
  );
}
