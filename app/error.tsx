"use client";
import { Button } from "@/components/ui";
export default function Error({ reset }: { reset: () => void }) {
  return (
    <div className="connection-error">
      <h1>Something interrupted your workspace.</h1>
      <p>Your saved commitments are still there. Try loading the page again.</p>
      <Button variant="primary" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
