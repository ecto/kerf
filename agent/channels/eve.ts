import { eveChannel } from "eve/channels/eve";
import { localDev, vercelOidc } from "eve/channels/auth";

export default eveChannel({
  auth: [
    // Lets the eve TUI and your Vercel deployments reach the deployed agent.
    vercelOidc(),
    // Open on localhost for `eve dev` and the REPL; ignored in production.
    localDev(),
    // NO catch-all: production browser requests 401. The public chat surface
    // is shut down for Wave 0 (no paid deployment protection needed). Rails:
    // eve TUI over Vercel OIDC, scheduled canaries, and (soon) MCP. Chat
    // returns behind real app auth (Auth.js/Clerk) when kerf is multi-user.
  ],
});
