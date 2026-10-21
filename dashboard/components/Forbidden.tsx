import Link from "next/link";

export default function Forbidden({ reason }: { reason: string }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-8 text-center shadow-sm">
        <h1 className="text-base font-semibold text-ink">Not available for your role</h1>
        <p className="mt-2 text-sm text-ink-soft">{reason}</p>
        <Link href="/" className="mt-4 inline-block text-sm font-medium text-accent hover:underline">
          Back to home
        </Link>
      </div>
    </div>
  );
}
