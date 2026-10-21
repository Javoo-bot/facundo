export default function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-center text-xl font-semibold text-slate-900">{title}</h1>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}
