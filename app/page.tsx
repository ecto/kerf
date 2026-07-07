export default function Page() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="max-w-md space-y-3 text-sm leading-relaxed">
        <h1 className="text-lg font-semibold">kerf</h1>
        <p>
          Agents that buy atoms — a durable browser-agent ordering rail with
          fail-closed payment containment.
        </p>
        <p className="opacity-70">
          No public chat surface. Agent rails: eve TUI (Vercel OIDC),
          scheduled canaries, MCP (soon).
        </p>
        <p>
          <a className="underline" href="https://github.com/ecto/kerf">
            github.com/ecto/kerf
          </a>
        </p>
      </div>
    </main>
  );
}
